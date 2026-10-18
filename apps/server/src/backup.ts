// Backups of what the factory must keep: the ledger (a consistent SQLite copy,
// without sign-in sessions), the audit log (copied between appends) and the
// evidence store, with a manifest of every file's SHA-256. verifyBackup checks
// each digest, the audit chain, the evidence names and the ledger;
// restoreBackup does that first, then copies into an empty folder for
// SF_DATA_DIR. Keys (runtime.key, signing/) never go into a backup: a restored
// factory makes new ones.
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { audit, canonicalJson, copyAuditLog, sha256, verifyAuditText } from "./audit.js";
import { Forbidden, requireRole, Unauthenticated } from "./auth.js";
import { evidenceRoot, verifyEvidence } from "./autopilot/evidence-store.js";

export interface BackupManifest {
  kind: "software-factory/backup";
  schemaVersion: 1;
  createdAt: string;
  files: { path: string; sha256: string; bytes: number }[];
  audit: { events: number; checkpoint: { seq: number; hash: string } };
}

const LEDGER = "autopilot.db";
const AUDIT = "audit.jsonl";
const EVIDENCE = "evidence";
const MANIFEST = "manifest.json";

const digestOf = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Every file under `dir`, as relative paths with forward slashes. */
function walk(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
  );
}

/** Copies a file; evidence stays read-only. */
function copy(from: string, to: string, readOnly: boolean) {
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
  chmodSync(to, readOnly ? 0o444 : 0o644);
}

/** A backup in a new folder under `out`. Refused while the audit chain or stored evidence doesn't verify. */
export async function createBackup(input: { ledger: { snapshot(file: string): void }; evidence: string; out: string }) {
  const changed = verifyEvidence(input.evidence).changed;
  if (changed.length) throw new Error(`Stored evidence has changed since it was written: ${changed.slice(0, 5).join(", ")}. Investigate before backing up.`);
  const createdAt = new Date().toISOString();
  const dir = path.join(input.out, createdAt.replace(/[:.]/g, "-"));
  mkdirSync(input.out, { recursive: true });
  mkdirSync(dir);
  // The ledger: one consistent copy, without anyone's sign-in session.
  input.ledger.snapshot(path.join(dir, LEDGER));
  const db = new DatabaseSync(path.join(dir, LEDGER));
  db.exec("PRAGMA journal_mode = DELETE; DELETE FROM sessions; VACUUM;");
  db.close();
  const log = await copyAuditLog(path.join(dir, AUDIT));
  if (!log.ok) throw new Error(`The audit chain is broken${log.brokenAt ? ` at event ${log.brokenAt}` : ""} (${log.reason}). Repair it before backing up.`);
  for (const file of walk(input.evidence)) copy(path.join(input.evidence, file), path.join(dir, EVIDENCE, file), true);
  const manifest: BackupManifest = {
    kind: "software-factory/backup",
    schemaVersion: 1,
    createdAt,
    files: walk(dir).map((p) => ({ path: p, sha256: digestOf(path.join(dir, p)), bytes: statSync(path.join(dir, p)).size })),
    audit: { events: log.checked, checkpoint: log.checkpoint },
  };
  writeFileSync(path.join(dir, MANIFEST), canonicalJson(manifest));
  return { dir, manifest, digest: sha256(canonicalJson(manifest)) };
}

/** Whether a backup is whole and unchanged: `expect` is the manifest digest recorded when it was made (the audit log has it). */
export function verifyBackup(dir: string, expect?: string): { ok: boolean; problems: string[]; manifest: BackupManifest | null } {
  let text: string;
  let manifest: BackupManifest;
  try {
    text = readFileSync(path.join(dir, MANIFEST), "utf8");
    manifest = JSON.parse(text) as BackupManifest;
  } catch {
    return { ok: false, problems: [`${MANIFEST} is missing or isn't JSON.`], manifest: null };
  }
  const problems: string[] = [];
  if (manifest.kind !== "software-factory/backup" || !Array.isArray(manifest.files)) return { ok: false, problems: ["This isn't a factory backup."], manifest: null };
  if (expect && sha256(text) !== expect) problems.push(`The manifest's digest isn't ${expect}.`);
  const listed = new Set<string>();
  for (const f of manifest.files) {
    // Only plain relative paths inside the backup: a manifest can't send a restore elsewhere.
    if (typeof f.path !== "string" || f.path.split("/").some((s) => !s || s === "." || s === "..") || path.isAbsolute(f.path) || f.path.includes("\\") || f.path.includes(":")) {
      problems.push(`${String(f.path)} isn't a path inside the backup.`);
      continue;
    }
    listed.add(f.path);
    const file = path.join(dir, f.path);
    if (!existsSync(file)) problems.push(`${f.path} is missing.`);
    else if (digestOf(file) !== f.sha256) problems.push(`${f.path} has changed.`);
  }
  for (const p of walk(dir)) if (p !== MANIFEST && !listed.has(p)) problems.push(`${p} isn't in the manifest.`);
  for (const needed of [LEDGER, AUDIT]) if (!listed.has(needed)) problems.push(`The backup has no ${needed}.`);
  if (existsSync(path.join(dir, AUDIT))) {
    const log = verifyAuditText(readFileSync(path.join(dir, AUDIT), "utf8"));
    if (!log.ok) problems.push(`The audit chain is broken${log.brokenAt ? ` at event ${log.brokenAt}` : ""} (${log.reason}).`);
    else if (log.checkpoint.seq !== manifest.audit?.checkpoint?.seq || log.checkpoint.hash !== manifest.audit.checkpoint.hash) problems.push("The audit log doesn't end where the manifest says.");
  }
  for (const file of verifyEvidence(path.join(dir, EVIDENCE)).changed) problems.push(`${EVIDENCE}/${file} doesn't match its digest.`);
  if (existsSync(path.join(dir, LEDGER))) {
    try {
      const db = new DatabaseSync(path.join(dir, LEDGER), { readOnly: true });
      const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
      db.close();
      if (row?.integrity_check !== "ok") problems.push(`The ledger isn't sound: ${row?.integrity_check ?? "no answer"}.`);
    } catch (err) {
      problems.push(`The ledger can't be opened: ${(err as Error).message}`);
    }
  }
  return { ok: problems.length === 0, problems, manifest };
}

/** Verifies the backup, then copies it into `target`, which must be empty (or not exist yet). */
export function restoreBackup(dir: string, target: string, expect?: string) {
  const check = verifyBackup(dir, expect);
  if (!check.ok || !check.manifest) throw new Error(`The backup doesn't verify:\n- ${check.problems.join("\n- ")}`);
  if (existsSync(target) && readdirSync(target).length) throw new Error(`${target} isn't empty. Restore into a new, empty folder, then point SF_DATA_DIR at it.`);
  mkdirSync(target, { recursive: true });
  for (const f of check.manifest.files) copy(path.join(dir, f.path), path.join(target, f.path), f.path.startsWith(`${EVIDENCE}/`));
  return { files: check.manifest.files.length, manifest: check.manifest };
}

/** POST /admin/backup: admins make a backup in SF_BACKUP_DIR (<data>/backups by default), audited with its manifest digest. */
export function createAdminRoutes(deps: { ledger: { snapshot(file: string): void }; dataDir: string }) {
  const app = new Hono();
  app.onError((err, c) => c.json({ error: err.message }, err instanceof Unauthenticated ? 401 : err instanceof Forbidden ? 403 : 400));
  app.post("/backup", async (c) => {
    const actor = requireRole(c, "admin").actor;
    const backup = await createBackup({ ledger: deps.ledger, evidence: evidenceRoot(deps.dataDir), out: process.env.SF_BACKUP_DIR ?? path.join(deps.dataDir, "backups") });
    const answer = { folder: path.basename(backup.dir), manifestSha256: backup.digest, files: backup.manifest.files.length, auditCheckpoint: backup.manifest.audit.checkpoint };
    await audit(actor, "factory.backup_created", "backup", answer);
    return c.json(answer);
  });
  return app;
}
