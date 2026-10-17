// Append-only, hash-chained audit log in data/audit.jsonl.
// Each line's hash covers the previous line's hash, so editing, deleting or
// reordering any line breaks the chain, and `verifyAudit()` finds where.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./config.js";
import { broadcast } from "./events.js";

export interface AuditEvent {
  seq: number;
  at: string;
  actor: string; // "user:sumit", "filesystem", "system"
  action: string; // "work_order.status_changed", "work_order.conversation_started", ...
  subject: string; // what it is about: "WO-3", "change:add-x", "openspec"
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

const FILE = path.join(DATA_DIR, "audit.jsonl");
const GENESIS = "0".repeat(64);

/** JSON with sorted keys, so the same data always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function hashOf(e: Omit<AuditEvent, "hash">): string {
  const { prevHash, ...rest } = e;
  return sha256(`${prevHash}\n${canonicalJson(rest)}`);
}

function readAll(): AuditEvent[] {
  if (!existsSync(FILE)) return [];
  return readFileSync(FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuditEvent);
}

let last: { seq: number; hash: string } | undefined;
let queue: Promise<unknown> = Promise.resolve();

/** Append one event. Writes are queued so the chain stays in order. */
export function audit(actor: string, action: string, subject: string, data: Record<string, unknown> = {}) {
  const job = queue.then(async () => {
    if (!last) {
      mkdirSync(DATA_DIR, { recursive: true });
      const all = readAll();
      const tail = all.at(-1);
      last = { seq: tail?.seq ?? 0, hash: tail?.hash ?? GENESIS };
    }
    const base = { seq: last.seq + 1, at: new Date().toISOString(), actor, action, subject, data, prevHash: last.hash };
    const event: AuditEvent = { ...base, hash: hashOf(base) };
    await appendFile(FILE, `${JSON.stringify(event)}\n`, "utf8");
    last = { seq: event.seq, hash: event.hash };
    broadcast({ type: "audit.appended", seq: event.seq });
    return event;
  });
  queue = job.catch((err) => console.error("[audit] write failed", err));
  return job;
}

export function listAudit(limit = 500): AuditEvent[] {
  return readAll().slice(-limit).reverse();
}

/** Every event about one subject (a work order, a change), oldest first. */
export function auditFor(subject: string): AuditEvent[] {
  const key = subject.toLowerCase();
  return readAll().filter((e) => e.subject.toLowerCase() === key);
}

export function verifyAudit(): { ok: boolean; checked: number; brokenAt?: number; reason?: string } {
  const all = readAll();
  let prev = GENESIS;
  for (const e of all) {
    const { hash, ...rest } = e;
    if (e.prevHash !== prev) return { ok: false, checked: all.length, brokenAt: e.seq, reason: "previous hash does not match" };
    if (hashOf(rest) !== hash) return { ok: false, checked: all.length, brokenAt: e.seq, reason: "contents were changed" };
    prev = hash;
  }
  return { ok: true, checked: all.length };
}
