// Work orders are Backlog.md tasks: one markdown file each in backlog/tasks.
// We read the files directly (fast, and it works with no Backlog server running),
// and make changes through the `backlog` CLI so the file format stays correct.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, watch } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { audit, auditFor, listAudit, sha256, type AuditEvent } from "./audit.js";
import { WORKSPACE } from "./config.js";
import { broadcast } from "./events.js";
import { childEnv, tools } from "./tools.js";

const BACKLOG_DIR = path.join(WORKSPACE, "backlog");
const TASKS_DIR = path.join(BACKLOG_DIR, "tasks");
const COMPLETED_DIR = path.join(BACKLOG_DIR, "completed");

export interface WorkOrder {
  id: string;
  title: string;
  status: string;
  assignee: string[];
  labels: string[];
  dependencies: string[];
  priority?: string;
  milestone?: string;
  createdDate?: string;
  updatedDate?: string;
  description: string;
  acceptanceCriteria: { index: number; text: string; done: boolean }[];
  plan?: string;
  notes?: string;
  finalSummary?: string;
  file: string;
  /** Who moved it to the final status from the factory, if anyone. */
  approval?: { by: string; at: string };
  /** It reached the final status without a person approving it here (an agent or a hand edit did it). */
  doneWithoutApproval: boolean;
  /** Canvas conversations started for this work order. */
  conversations: { id: string; agent: string; by: string; at: string }[];
}

function section(body: string, marker: string): string | undefined {
  const m = body.match(new RegExp(`<!-- ${marker}:BEGIN -->([\\s\\S]*?)<!-- ${marker}:END -->`));
  return m?.[1]?.trim();
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value) return [value];
  return [];
}

function parseTask(file: string): WorkOrder | null {
  try {
    const { data, content } = matter(readFileSync(file, "utf8"));
    if (!data.id) return null;
    const ac = (section(content, "AC") ?? "")
      .split("\n")
      .map((line) => line.match(/^- \[( |x)\] #(\d+) (.*)$/i))
      .filter((m): m is RegExpMatchArray => Boolean(m))
      .map((m) => ({ index: Number(m[2]), text: m[3] ?? "", done: m[1]?.toLowerCase() === "x" }));
    return {
      id: String(data.id),
      title: String(data.title ?? ""),
      status: String(data.status ?? ""),
      assignee: list(data.assignee),
      labels: list(data.labels),
      dependencies: list(data.dependencies),
      priority: data.priority ? String(data.priority) : undefined,
      milestone: data.milestone ? String(data.milestone) : undefined,
      createdDate: data.created_date ? String(data.created_date) : undefined,
      updatedDate: data.updated_date ? String(data.updated_date) : undefined,
      description: section(content, "SECTION:DESCRIPTION") ?? "",
      acceptanceCriteria: ac,
      plan: section(content, "SECTION:PLAN"),
      notes: section(content, "SECTION:NOTES"),
      finalSummary: section(content, "SECTION:FINAL_SUMMARY"),
      file: path.relative(WORKSPACE, file).replaceAll("\\", "/"),
      doneWithoutApproval: false,
      conversations: [],
    };
  } catch {
    return null;
  }
}

function taskFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => path.join(dir, f));
}

export function statuses(): string[] {
  const config = path.join(BACKLOG_DIR, "config.yml");
  if (existsSync(config)) {
    const line = readFileSync(config, "utf8").match(/^statuses:\s*(\[.*\])\s*$/m)?.[1];
    if (line) {
      try {
        return JSON.parse(line) as string[];
      } catch {
        /* fall through */
      }
    }
  }
  return ["To Do", "In Progress", "Done"];
}

const idNumber = (id: string) => Number(id.match(/(\d+)$/)?.[1] ?? 0);

/** The last status is the one a person has to approve (normally "Done"). */
export const finalStatus = () => statuses().at(-1) ?? "Done";

/** Fill in approval, flags and linked conversations from the audit log. */
function withGovernance(wo: WorkOrder, events: AuditEvent[] = auditFor(wo.id)): WorkOrder {
  const final = finalStatus();
  const conversations = events
    .filter((e) => e.action === "work_order.conversation_started")
    .map((e) => ({ id: String(e.data.conversationId), agent: String(e.data.agent ?? ""), by: e.actor, at: e.at }))
    .reverse();
  if (wo.status !== final) return { ...wo, conversations };
  // Find the most recent move into the final status, and whether a person made it.
  const lastApproval = events.findLast((e) => e.action === "work_order.approved");
  const lastUnapproved = events.findLast((e) => e.action === "work_order.done_without_approval");
  const approved = lastApproval && (!lastUnapproved || lastApproval.seq > lastUnapproved.seq);
  return {
    ...wo,
    conversations,
    approval: approved ? { by: lastApproval.actor, at: lastApproval.at } : undefined,
    doneWithoutApproval: !approved,
  };
}

function readWorkOrders(): WorkOrder[] {
  return [...taskFiles(TASKS_DIR), ...taskFiles(COMPLETED_DIR)]
    .map(parseTask)
    .filter((t): t is WorkOrder => Boolean(t))
    .sort((a, b) => idNumber(a.id) - idNumber(b.id));
}

export function listWorkOrders() {
  // Read the audit log once and group it by work order, oldest first.
  const bySubject = new Map<string, AuditEvent[]>();
  for (const e of listAudit(Number.MAX_SAFE_INTEGER).reverse()) {
    const key = e.subject.toLowerCase();
    const list = bySubject.get(key);
    if (list) list.push(e);
    else bySubject.set(key, [e]);
  }
  return {
    initialized: existsSync(BACKLOG_DIR),
    statuses: statuses(),
    finalStatus: finalStatus(),
    workOrders: readWorkOrders().map((wo) => withGovernance(wo, bySubject.get(wo.id.toLowerCase()) ?? [])),
  };
}

export function getWorkOrder(id: string): WorkOrder {
  assertWorkOrderId(id);
  const wo = readWorkOrders().find((w) => w.id.toLowerCase() === id.toLowerCase());
  if (!wo) throw new Error(`No work order ${id}`);
  return withGovernance(wo);
}

function assertWorkOrderId(id: string) {
  if (!/^[a-z]+-\d+$/i.test(id)) throw new Error(`Invalid work order id "${id}"`);
}

export function runBacklog(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [tools.backlog.script, ...args],
      { cwd: WORKSPACE, env: childEnv({ BACKLOG_CWD: WORKSPACE }), windowsHide: true },
      (error, stdout, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout)),
    );
  });
}

// Status changes made here, so the file watcher knows a person made them.
const expectedStatus = new Map<string, string>();

/**
 * Change a work order's status. Moving it to the final status is an approval,
 * and only happens when the caller says so explicitly.
 */
export async function setStatus(id: string, status: string, actor: string, opts: { approve?: boolean; note?: string } = {}) {
  assertWorkOrderId(id);
  if (!statuses().includes(status)) throw new Error(`Unknown status "${status}"`);
  const before = getWorkOrder(id);
  const isApproval = status === finalStatus();
  if (isApproval && !opts.approve) throw new Error(`Moving a work order to "${status}" is an approval. Use "Approve" instead.`);
  if (before.status === status && (!isApproval || before.approval)) return;
  if (before.status !== status) expectedStatus.set(before.id.toLowerCase(), status);
  const args = ["task", "edit", before.id, "--status", status, "--plain"];
  if (opts.note) args.push("--comment", opts.note, "--comment-author", actor.replace(/^user:/, ""));
  await runBacklog(args);
  await audit(actor, isApproval ? "work_order.approved" : "work_order.status_changed", before.id, {
    from: before.status,
    to: status,
    ...(opts.note ? { note: opts.note } : {}),
  });
}

/** Record that a Canvas conversation was started for a work order. */
export async function linkConversation(id: string, conversationId: string, agent: string, actor: string) {
  const wo = getWorkOrder(id);
  if (!/^[\w-]{1,100}$/.test(conversationId)) throw new Error("Invalid conversation id");
  await audit(actor, "work_order.conversation_started", wo.id, { conversationId, agent, status: wo.status });
  broadcast({ type: "workorders.changed" });
}

/** Watch backlog/ so the board updates live while an agent creates or edits work orders. */
export function watchBacklog() {
  const seen = new Map<string, { hash: string; status?: string }>();
  for (const f of [...taskFiles(TASKS_DIR), ...taskFiles(COMPLETED_DIR)]) {
    seen.set(f, { hash: sha256(readFileSync(f, "utf8")), status: parseTask(f)?.status });
  }
  let timer: NodeJS.Timeout | undefined;

  const rescan = () => {
    const now = new Set<string>();
    for (const f of [...taskFiles(TASKS_DIR), ...taskFiles(COMPLETED_DIR)]) {
      now.add(f);
      const hash = sha256(readFileSync(f, "utf8"));
      const prev = seen.get(f);
      if (prev?.hash !== hash) {
        const task = parseTask(f);
        seen.set(f, { hash, status: task?.status });
        const subject = task?.id ?? path.basename(f);
        // The file hash is evidence of exactly what the work order said at this moment.
        void audit("filesystem", prev ? "work_order.file_changed" : "work_order.file_created", subject, {
          file: path.relative(WORKSPACE, f).replaceAll("\\", "/"),
          sha256: hash,
          status: task?.status,
        });
        // Reaching the final status is a person's call. If the file got there any
        // other way (an agent ran the CLI, someone edited the file), flag it.
        const final = finalStatus();
        if (task && task.status === final && prev?.status !== final) {
          const key = task.id.toLowerCase();
          if (expectedStatus.get(key) === final) expectedStatus.delete(key);
          else void audit("filesystem", "work_order.done_without_approval", task.id, { from: prev?.status ?? null, to: final });
        }
      }
    }
    for (const f of [...seen.keys()]) if (!now.has(f)) seen.delete(f);
    broadcast({ type: "workorders.changed" });
  };

  const start = () => {
    try {
      watch(BACKLOG_DIR, { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(rescan, 200);
      });
      return true;
    } catch {
      return false;
    }
  };
  // backlog/ may not exist yet; retry until it does.
  if (!start()) {
    const retry = setInterval(() => start() && clearInterval(retry), 3000);
  }
}
