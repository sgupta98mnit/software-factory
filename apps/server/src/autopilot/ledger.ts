// Autopilot's run ledger: every run, work order, agent attempt, gate check and
// inbox item lives in one SQLite file (node:sqlite, no extra dependency). The
// orchestrator reads its state from here before each step and writes the new
// state after it, so the factory can stop at any moment and pick up where it
// left off after a restart.
//
// Costs are derived, never stored twice: an attempt holds its conversation's
// latest accumulated cost, and work-order and run costs are sums over attempts.
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";

export type Autonomy = "suggest" | "supervised" | "autonomous";
export type RunState =
  | "spec"
  | "critic"
  | "awaiting_spec_approval"
  | "awaiting_answers"
  | "awaiting_plan_approval"
  | "building"
  | "delivering"
  | "done"
  | "paused"
  | "failed"
  | "cancelled";
export type WorkOrderState =
  | "pending"
  | "building"
  | "verifying"
  | "reviewing"
  | "ready"
  | "awaiting_merge_approval"
  | "awaiting_control_approval"
  | "merging"
  | "merged"
  | "needs_attention"
  | "skipped"
  | "cancelled";
export type AttemptRole = "spec" | "critic" | "builder" | "reviewer" | "validator";
export type AttemptState = "starting" | "running" | "finished" | "error" | "stuck" | "paused" | "cancelled";
export type InboxKind =
  | "spec_approval"
  | "plan_approval"
  | "questions"
  | "spec_failed"
  | "merge_approval"
  | "work_order_failed"
  | "budget_reached"
  | "run_paused"
  | "error"
  | "release"
  | "undelivered"
  | "delivery"
  | "control_approval";
export type Risk = "low" | "medium" | "high";
export type Severity = "critical" | "high" | "medium" | "low";

export interface InboxOption {
  id: string;
  label: string;
  tone?: "primary" | "danger" | "default";
  needsNote?: boolean;
}

/** One problem found by a gate, the reviewer, a hidden test, the integrator, the critic or the agent itself. */
export interface Finding {
  source: "gate" | "review" | "hidden" | "integration" | "critic" | "agent";
  severity: Severity;
  title: string;
  detail: string;
  file?: string | null;
  criterion?: number | null;
  scenario?: string | null;
}

export interface Run {
  id: string; // "ap-" + 8 hex
  goal: string;
  change: string; // OpenSpec change name
  autonomy: Autonomy;
  budgetUsd: number | null; // null = policy default
  baseBranch: string;
  integrationBranch: string; // "autopilot/<change>"
  integrationDir: string | null; // worktree of the integration branch
  state: RunState;
  resumeState: RunState | null; // where to go back to after "paused"
  pausedReason: string | null;
  policyHash: string | null;
  policy: unknown; // the effective policy pinned for the run, null until set
  verification: unknown; // Verification (orchestrator.ts): the pinned checks and hidden tests; null for runs from before it
  delivery: unknown; // Delivery (orchestrator.ts): the pushed branch, pull request and CI; null unless the policy delivers
  release: unknown; // Release (orchestrator.ts): the release decision and its envelope; null until one is asked for
  specConversation: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkOrder {
  id: string; // "<runId>/WO-<seq>"
  runId: string;
  seq: number; // task group number N from "## N. Title"
  title: string;
  acceptance: string[];
  controls: string[];
  dependsOn: number[]; // seqs
  wave: number;
  risk: Risk;
  riskScore: number;
  state: WorkOrderState;
  resumeState: WorkOrderState | null;
  branch: string | null;
  worktree: string | null;
  baseSha: string | null; // integration sha the branch was created from / last synced with
  preMergeSha: string | null; // integration sha before the current merge, for the revert
  findings: Finding[] | null; // what triggered the latest repair
  budgetExtraUsd: number;
  mergedBy: string | null; // "policy@<hash>" or "user:<name>"
  source: "plan" | "ci" | "review"; // tasks.md, or a fix the delivered pull request needs
  updatedAt: string;
}

export interface Attempt {
  id: number;
  runId: string;
  workOrderId: string | null; // null for spec, critic and validator
  role: AttemptRole;
  conversationId: string; // generated before the agent server is called, so a restart can start it again
  agentProfile: string | null;
  state: AttemptState;
  turns: number; // user messages sent; 1 = the initial brief
  seenRunning: boolean; // saw status "running" since the last message
  lastSentAt: string;
  costUsd: number; // the conversation's latest accumulated cost
  result: unknown;
  runtime: unknown; // ExecutionFacts (execution.ts): where it ran; null for attempts from before isolation
  progressAt: string | null; // the last time its cost, state or conversation events moved (the watchdog)
  lastEvent: string | null; // the newest event id seen in its conversation
  startedAt: string;
  finishedAt: string | null;
}

export interface Check {
  id: number;
  runId: string;
  workOrderId: string | null;
  stage: "spec" | "build" | "integrate";
  name: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number | null;
  output: string; // the tail, at most OUTPUT_LIMIT chars
  runner: "local" | "container" | null; // where the gate ran; null for checks from before isolation
  sha: string | null; // the commit it checked; null for checks from before commit binding
  meta: unknown; // what else a check records (a scanner's version and database, result digests); no secrets
  at: string;
}

export interface InboxItem {
  id: number;
  runId: string;
  workOrderId: string | null;
  kind: InboxKind;
  title: string;
  body: string; // markdown
  options: InboxOption[];
  state: "open" | "decided" | "dismissed";
  decision: string | null;
  note: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  notifiedAt: string | null;
  ref: string | null; // what the item is about beyond its run and work order, like "command:12"
}

/**
 * pending: waiting to be sent (or to retry); sending: handed to the agent server, answer not yet recorded;
 * ambiguous: it may or may not have arrived; delivered; quarantined: nobody can tell, a person decides;
 * failed: the agent server refused it; cancelled.
 */
export type CommandState = "pending" | "sending" | "ambiguous" | "delivered" | "quarantined" | "failed" | "cancelled";

/** A follow-up message to an agent, written before it is sent (the outbox). */
export interface Command {
  id: number;
  runId: string;
  attemptId: number;
  kind: "send";
  reason: string; // repair, validate, critic, answer, revise, unreadable_verdict, no_tests
  text: string; // kept to deliver it; never audited
  state: CommandState;
  tries: number;
  nextAt: string; // not before then (backoff)
  generation: number | null; // the scheduler lease generation that wrote it
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A write by a process that has lost the scheduler lease to another one. */
export class StaleWorker extends Error {}

export type NewRun = Pick<Run, "goal" | "change" | "autonomy" | "baseBranch" | "integrationBranch" | "createdBy"> &
  Partial<Omit<Run, "createdAt" | "updatedAt">>;
export type NewWorkOrder = Pick<WorkOrder, "seq" | "title" | "acceptance" | "controls" | "dependsOn" | "wave" | "risk"> &
  Partial<Omit<WorkOrder, "id" | "runId" | "updatedAt">>;
export type NewAttempt = Pick<Attempt, "runId" | "role" | "conversationId"> & Partial<Omit<Attempt, "id">>;
export type NewCheck = Pick<Check, "runId" | "stage" | "name" | "ok"> &
  Partial<Pick<Check, "workOrderId" | "exitCode" | "durationMs" | "output" | "runner" | "sha" | "meta">>;
export type NewInboxItem = Pick<InboxItem, "runId" | "kind" | "title" | "body" | "options"> &
  Partial<Pick<InboxItem, "workOrderId" | "ref">>;
export type NewCommand = Pick<Command, "runId" | "attemptId" | "reason" | "text"> & Partial<Pick<Command, "state" | "nextAt" | "generation">>;

export const OUTPUT_LIMIT = 8000;

const SCHEMA_V1 = `
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  change TEXT NOT NULL,
  autonomy TEXT NOT NULL,
  budget_usd REAL,
  base_branch TEXT NOT NULL,
  integration_branch TEXT NOT NULL,
  integration_dir TEXT,
  state TEXT NOT NULL,
  resume_state TEXT,
  paused_reason TEXT,
  policy_hash TEXT,
  policy TEXT,
  spec_conversation TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE work_orders (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  acceptance TEXT NOT NULL,
  controls TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  wave INTEGER NOT NULL,
  risk TEXT NOT NULL,
  risk_score INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  resume_state TEXT,
  branch TEXT,
  worktree TEXT,
  base_sha TEXT,
  pre_merge_sha TEXT,
  findings TEXT,
  budget_extra_usd REAL NOT NULL DEFAULT 0,
  merged_by TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, seq)
);
CREATE TABLE attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  work_order_id TEXT REFERENCES work_orders(id),
  role TEXT NOT NULL,
  conversation_id TEXT NOT NULL UNIQUE,
  agent_profile TEXT,
  state TEXT NOT NULL,
  turns INTEGER NOT NULL DEFAULT 1,
  seen_running INTEGER NOT NULL DEFAULT 0,
  last_sent_at TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  result TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  work_order_id TEXT,
  stage TEXT NOT NULL,
  name TEXT NOT NULL,
  ok INTEGER NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER,
  output TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL
);
CREATE TABLE inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  work_order_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  options TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  decision TEXT,
  note TEXT,
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  notified_at TEXT
);
`;

type Table = "runs" | "work_orders" | "attempts" | "checks" | "inbox" | "commands";
const TABLES: Table[] = ["runs", "work_orders", "attempts", "checks", "inbox", "commands"];

// v2: where each attempt and gate ran (isolated execution).
const SCHEMA_V2 = `
ALTER TABLE attempts ADD COLUMN runtime TEXT;
ALTER TABLE checks ADD COLUMN runner TEXT;
`;

// v3: trusted verification: what each check checked, and the run's pinned checks.
const SCHEMA_V3 = `
ALTER TABLE checks ADD COLUMN sha TEXT;
ALTER TABLE checks ADD COLUMN meta TEXT;
ALTER TABLE runs ADD COLUMN verification TEXT;
`;

// v4: durable commands: the outbox, the scheduler lease, remembered requests, and what the watchdog watches.
const SCHEMA_V4 = `
CREATE TABLE commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  attempt_id INTEGER NOT NULL REFERENCES attempts(id),
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  text TEXT NOT NULL,
  state TEXT NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  generation INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX commands_by_run ON commands (run_id, state);
CREATE TABLE leases (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  generation INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE requests (
  key TEXT PRIMARY KEY,
  route TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL
);
ALTER TABLE attempts ADD COLUMN progress_at TEXT;
ALTER TABLE attempts ADD COLUMN last_event TEXT;
ALTER TABLE inbox ADD COLUMN ref TEXT;
`;

// v5: delivery: the run's pull request and CI, and work orders that fix them.
const SCHEMA_V5 = `
ALTER TABLE runs ADD COLUMN delivery TEXT;
ALTER TABLE work_orders ADD COLUMN source TEXT NOT NULL DEFAULT 'plan';
`;

// v6: governance: signed-in sessions, small settings (a day's raised budget, a sent digest) and a run's release.
const SCHEMA_V6 = `
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  issuer TEXT NOT NULL,
  name TEXT NOT NULL,
  roles TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
ALTER TABLE runs ADD COLUMN release TEXT;
`;

// Fields are the columns in camelCase. JSON columns are parsed; 0/1 flags become booleans.
const JSON_COLUMNS = new Set(["policy", "acceptance", "controls", "depends_on", "findings", "result", "options", "runtime", "meta", "verification", "delivery", "release"]);
const FLAG_COLUMNS = new Set(["seen_running", "ok"]);
const toColumn = (field: string) => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const toField = (column: string) => column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function encode(column: string, value: unknown): SQLInputValue {
  if (JSON_COLUMNS.has(column)) return value == null ? null : JSON.stringify(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  return value as SQLInputValue;
}

function decode<T>(row: Record<string, SQLOutputValue>): T {
  const out: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) {
    if (JSON_COLUMNS.has(column) && typeof value === "string") out[toField(column)] = JSON.parse(value);
    else if (FLAG_COLUMNS.has(column)) out[toField(column)] = value === 1;
    else out[toField(column)] = value;
  }
  return out as T;
}

const now = () => new Date().toISOString();

/** Drops fields set to undefined, so `{ state: undefined }` keeps the default instead of overwriting it. */
const defined = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** Opens (and creates or migrates) the ledger. `":memory:"` gives a throwaway one for tests. */
export function openLedger(file: string) {
  const inMemory = file === ":memory:";
  if (!inMemory) mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { timeout: 5000, enableForeignKeyConstraints: true });
  if (!inMemory) db.exec("PRAGMA journal_mode = WAL");

  /** Runs `fn` (synchronous) in one transaction; nested calls join the outer one. */
  function transaction<T>(fn: () => T): T {
    if (db.isTransaction) return fn();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  // Schema version in PRAGMA user_version. A later change adds `if (version < 2)` with ALTER TABLE.
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (version < 1) transaction(() => db.exec(`${SCHEMA_V1}\nPRAGMA user_version = 1;`));
  if (version < 2) transaction(() => db.exec(`${SCHEMA_V2}\nPRAGMA user_version = 2;`));
  if (version < 3) transaction(() => db.exec(`${SCHEMA_V3}\nPRAGMA user_version = 3;`));
  if (version < 4) transaction(() => db.exec(`${SCHEMA_V4}\nPRAGMA user_version = 4;`));
  if (version < 5) transaction(() => db.exec(`${SCHEMA_V5}\nPRAGMA user_version = 5;`));
  if (version < 6) transaction(() => db.exec(`${SCHEMA_V6}\nPRAGMA user_version = 6;`));

  // Fencing: once a process holds the scheduler lease, every write checks it still does.
  let fenceToken: { name: string; owner: string; generation: number } | null = null;
  function guard() {
    if (!fenceToken) return;
    const row = db.prepare("SELECT owner, generation FROM leases WHERE name = $name").get({ name: fenceToken.name });
    if (!row || row.owner !== fenceToken.owner || Number(row.generation) !== fenceToken.generation) {
      throw new StaleWorker(`Another factory process (${String(row?.owner ?? "unknown")}) took over this ledger.`);
    }
  }

  const columns = new Map(
    TABLES.map((t) => [t, new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => String(c.name)))]),
  );

  /** camelCase fields -> named parameters keyed by column, refusing anything that isn't a column. */
  function params(table: Table, fields: Record<string, unknown>): Record<string, SQLInputValue> {
    const out: Record<string, SQLInputValue> = {};
    for (const [field, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      const column = toColumn(field);
      if (!columns.get(table)?.has(column)) throw new Error(`${table} has no column for "${field}"`);
      out[column] = encode(column, value);
    }
    return out;
  }

  function insert(table: Table, fields: Record<string, unknown>): number {
    guard();
    const p = params(table, fields);
    const cols = Object.keys(p);
    const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => `$${c}`).join(", ")})`;
    return Number(db.prepare(sql).run(p).lastInsertRowid);
  }

  function update(table: Table, id: string | number, fields: Record<string, unknown>) {
    guard();
    const p = params(table, fields);
    const sets = Object.keys(p).map((c) => `${c} = $${c}`);
    if (sets.length === 0) return;
    const { changes } = db.prepare(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = $where_id`).run({ ...p, where_id: id });
    if (!changes) throw new Error(`No ${table} row "${id}"`);
  }

  function one<T>(sql: string, p: Record<string, SQLInputValue> = {}): T | undefined {
    const row = db.prepare(sql).get(p);
    return row && decode<T>(row);
  }

  function all<T>(sql: string, p: Record<string, SQLInputValue> = {}): T[] {
    return db.prepare(sql).all(p).map((row) => decode<T>(row));
  }

  function count(sql: string, p: Record<string, SQLInputValue>): number {
    return Number(db.prepare(sql).get(p)?.n ?? 0);
  }

  // Runs

  function createRun(input: NewRun): Run {
    const at = now();
    const id = input.id ?? `ap-${randomBytes(4).toString("hex")}`;
    insert("runs", { state: "spec", createdAt: at, updatedAt: at, ...defined(input), id });
    return getRun(id) as Run;
  }

  function getRun(id: string): Run | undefined {
    return one<Run>("SELECT * FROM runs WHERE id = $id", { id });
  }

  /** Newest first. */
  function listRuns(): Run[] {
    return all<Run>("SELECT * FROM runs ORDER BY created_at DESC, rowid DESC");
  }

  function updateRun(id: string, patch: Partial<Omit<Run, "id" | "createdAt" | "updatedAt">>): Run {
    update("runs", id, { ...patch, updatedAt: now() });
    return getRun(id) as Run;
  }

  // Work orders

  function addWorkOrders(runId: string, rows: NewWorkOrder[]): WorkOrder[] {
    transaction(() => {
      for (const row of rows) {
        insert("work_orders", { state: "pending", updatedAt: now(), ...defined(row), id: `${runId}/WO-${row.seq}`, runId });
      }
    });
    return listWorkOrders(runId);
  }

  /** In plan order: by wave, then task group number. */
  function listWorkOrders(runId: string): WorkOrder[] {
    return all<WorkOrder>("SELECT * FROM work_orders WHERE run_id = $runId ORDER BY wave, seq", { runId });
  }

  function getWorkOrder(id: string): WorkOrder | undefined {
    return one<WorkOrder>("SELECT * FROM work_orders WHERE id = $id", { id });
  }

  function updateWorkOrder(id: string, patch: Partial<Omit<WorkOrder, "id" | "runId" | "seq" | "updatedAt">>): WorkOrder {
    update("work_orders", id, { ...patch, updatedAt: now() });
    return getWorkOrder(id) as WorkOrder;
  }

  /** Drops a run's work orders to plan again after the spec changed. Refused (foreign key) once any has an attempt. */
  function deleteWorkOrders(runId: string): number {
    guard();
    return Number(db.prepare("DELETE FROM work_orders WHERE run_id = $runId").run({ runId }).changes);
  }

  // Attempts (one agent conversation each)

  /** Write-ahead: record the attempt (state "starting") before asking the agent server to start it. */
  function addAttempt(attempt: NewAttempt): Attempt {
    const at = now();
    return getAttempt(insert("attempts", { state: "starting", lastSentAt: at, startedAt: at, ...defined(attempt) })) as Attempt;
  }

  function getAttempt(id: number): Attempt | undefined {
    return one<Attempt>("SELECT * FROM attempts WHERE id = $id", { id });
  }

  function getAttemptByConversation(conversationId: string): Attempt | undefined {
    return one<Attempt>("SELECT * FROM attempts WHERE conversation_id = $conversationId", { conversationId });
  }

  function updateAttempt(id: number, patch: Partial<Omit<Attempt, "id" | "runId">>): Attempt {
    update("attempts", id, patch);
    return getAttempt(id) as Attempt;
  }

  /** Oldest first. */
  function listAttempts(filter: { runId: string; workOrderId?: string; role?: AttemptRole }): Attempt[] {
    return all<Attempt>(
      `SELECT * FROM attempts WHERE run_id = $runId
         AND ($workOrderId IS NULL OR work_order_id = $workOrderId)
         AND ($role IS NULL OR role = $role)
       ORDER BY id`,
      { runId: filter.runId, workOrderId: filter.workOrderId ?? null, role: filter.role ?? null },
    );
  }

  /** Conversations the scheduler should poll. */
  function activeAttempts(): Attempt[] {
    return all<Attempt>("SELECT * FROM attempts WHERE state IN ('starting', 'running') ORDER BY id");
  }

  /** Attempts whose container hasn't been removed yet. */
  function liveRuntimes(): Attempt[] {
    return all<Attempt>(
      "SELECT * FROM attempts WHERE json_extract(runtime, '$.provider') = 'container' AND json_extract(runtime, '$.released') IS NOT 1 ORDER BY id",
    );
  }

  /** Whether any attempt ever ran in a container (so there can be containers to sweep). */
  function usedContainers(): boolean {
    return count("SELECT COUNT(*) AS n FROM attempts WHERE json_extract(runtime, '$.provider') = 'container'", {}) > 0;
  }

  // Checks (gate results)

  function addCheck(check: NewCheck): Check {
    const id = insert("checks", { at: now(), ...check, output: (check.output ?? "").slice(-OUTPUT_LIMIT) });
    return one<Check>("SELECT * FROM checks WHERE id = $id", { id }) as Check;
  }

  /** Oldest first. */
  function listChecks(filter: { runId: string; workOrderId?: string }): Check[] {
    return all<Check>(
      "SELECT * FROM checks WHERE run_id = $runId AND ($workOrderId IS NULL OR work_order_id = $workOrderId) ORDER BY id",
      { runId: filter.runId, workOrderId: filter.workOrderId ?? null },
    );
  }

  // Inbox (what needs a person)

  /** Opens an item, unless one of the same kind is already open for the same run and work order: then returns that one unchanged. */
  function openInbox(item: NewInboxItem): InboxItem {
    return transaction(() => {
      const existing = one<InboxItem>(
        "SELECT * FROM inbox WHERE state = 'open' AND run_id = $runId AND work_order_id IS $workOrderId AND kind = $kind",
        { runId: item.runId, workOrderId: item.workOrderId ?? null, kind: item.kind },
      );
      return existing ?? (getInbox(insert("inbox", { ...item, state: "open", createdAt: now() })) as InboxItem);
    });
  }

  function getInbox(id: number): InboxItem | undefined {
    return one<InboxItem>("SELECT * FROM inbox WHERE id = $id", { id });
  }

  /** Newest first. "decided" lists decided items only; dismissed ones show under "all". */
  function listInbox(filter: { state?: "open" | "decided" | "all"; runId?: string } = {}): InboxItem[] {
    return all<InboxItem>(
      "SELECT * FROM inbox WHERE ($state = 'all' OR state = $state) AND ($runId IS NULL OR run_id = $runId) ORDER BY id DESC",
      { state: filter.state ?? "open", runId: filter.runId ?? null },
    );
  }

  /** Records a person's decision. Throws when the item isn't open, so nothing is decided twice. */
  function decideInbox(id: number, d: { decision: string; note?: string | null; by: string }): InboxItem {
    guard();
    const { changes } = db
      .prepare(
        `UPDATE inbox SET state = 'decided', decision = $decision, note = $note, decided_by = $by, decided_at = $at
         WHERE id = $id AND state = 'open'`,
      )
      .run({ id, decision: d.decision, note: d.note ?? null, by: d.by, at: now() });
    if (!changes) throw new Error(`Inbox item ${id} is not open`);
    return getInbox(id) as InboxItem;
  }

  /** Closes every open item of a run (when it's cancelled). Returns how many. */
  function dismissInbox(filter: { runId: string }): number {
    guard();
    const { changes } = db
      .prepare("UPDATE inbox SET state = 'dismissed', decided_at = $at WHERE run_id = $runId AND state = 'open'")
      .run({ runId: filter.runId, at: now() });
    return Number(changes);
  }

  /** Items a notification went out for: never posted again. */
  function markNotified(ids: number[]) {
    guard();
    const at = now();
    transaction(() => {
      for (const id of ids) db.prepare("UPDATE inbox SET notified_at = $at WHERE id = $id").run({ id, at });
    });
  }

  function openInboxCount(): number {
    return count("SELECT COUNT(*) AS n FROM inbox WHERE state = 'open'", {});
  }

  // Commands (the outbox of follow-up messages)

  function addCommand(c: NewCommand): Command {
    const at = now();
    return getCommand(insert("commands", { kind: "send", state: "pending", nextAt: at, createdAt: at, updatedAt: at, ...defined(c) })) as Command;
  }

  function getCommand(id: number): Command | undefined {
    return one<Command>("SELECT * FROM commands WHERE id = $id", { id });
  }

  function updateCommand(id: number, patch: Partial<Omit<Command, "id" | "runId" | "attemptId" | "createdAt" | "updatedAt">>): Command {
    update("commands", id, { ...patch, updatedAt: now() });
    return getCommand(id) as Command;
  }

  /** Oldest first. */
  function listCommands(filter: { runId?: string; attemptId?: number; states?: CommandState[] }): Command[] {
    const states = filter.states ? JSON.stringify(filter.states) : null;
    return all<Command>(
      `SELECT * FROM commands WHERE ($runId IS NULL OR run_id = $runId) AND ($attemptId IS NULL OR attempt_id = $attemptId)
         AND ($states IS NULL OR state IN (SELECT value FROM json_each($states))) ORDER BY id`,
      { runId: filter.runId ?? null, attemptId: filter.attemptId ?? null, states },
    );
  }

  // The scheduler lease: one process acts on this ledger at a time

  /**
   * Takes or renews the lease `name` for `owner` until ttlMs from now, and
   * returns its generation; null while another owner holds an unexpired lease
   * that `canTakeOver` doesn't release. A new owner gets the next generation.
   */
  function acquireLease(name: string, owner: string, ttlMs: number, canTakeOver: (holder: string) => boolean): number | null {
    return transaction(() => {
      const row = db.prepare("SELECT owner, generation, expires_at FROM leases WHERE name = $name").get({ name });
      const expires = new Date(Date.now() + ttlMs).toISOString();
      if (!row) {
        db.prepare("INSERT INTO leases (name, owner, generation, expires_at) VALUES ($name, $owner, 1, $expires)").run({ name, owner, expires });
        return 1;
      }
      const generation = Number(row.generation);
      if (row.owner === owner) {
        db.prepare("UPDATE leases SET expires_at = $expires WHERE name = $name").run({ name, expires });
        return generation;
      }
      if (Date.parse(String(row.expires_at)) > Date.now() && !canTakeOver(String(row.owner))) return null;
      db.prepare("UPDATE leases SET owner = $owner, generation = $generation, expires_at = $expires WHERE name = $name").run({ name, owner, generation: generation + 1, expires });
      return generation + 1;
    });
  }

  /** Lets another process take over at once (a clean stop). */
  function releaseLease(name: string, owner: string) {
    db.prepare("UPDATE leases SET expires_at = $at WHERE name = $name AND owner = $owner").run({ name, owner, at: new Date(0).toISOString() });
  }

  function getLease(name: string): { owner: string; generation: number; expiresAt: string } | undefined {
    return one("SELECT owner, generation, expires_at FROM leases WHERE name = $name", { name });
  }

  /** From now on every write checks that `token` still holds the lease (null: no checks). */
  function fence(token: { name: string; owner: string; generation: number } | null) {
    fenceToken = token;
  }

  // Remembered requests (Idempotency-Key): a repeated key gets the first answer

  function recallRequest(key: string): { route: string; response: unknown } | undefined {
    const row = db.prepare("SELECT route, response FROM requests WHERE key = $key").get({ key });
    return row ? { route: String(row.route), response: JSON.parse(String(row.response)) } : undefined;
  }

  function rememberRequest(key: string, route: string, response: unknown) {
    guard();
    db.prepare("DELETE FROM requests WHERE created_at < $cutoff").run({ cutoff: new Date(Date.now() - 86_400_000).toISOString() });
    db.prepare("INSERT OR IGNORE INTO requests (key, route, response, created_at) VALUES ($key, $route, $response, $at)").run({ key, route, response: JSON.stringify(response), at: now() });
  }

  // Signed-in sessions (auth.ts): the cookie's sha256 is the key; sign-in isn't scheduler work, so no fencing

  function createSession(x: { idHash: string; subject: string; issuer: string; name: string; roles: string[]; expiresAt: string }) {
    db.prepare("DELETE FROM sessions WHERE expires_at < $now").run({ now: now() });
    db.prepare("INSERT INTO sessions (id_hash, subject, issuer, name, roles, expires_at, created_at) VALUES ($idHash, $subject, $issuer, $name, $roles, $expiresAt, $at)").run({ ...x, roles: JSON.stringify(x.roles), at: now() });
  }

  function getSession(idHash: string): { subject: string; issuer: string; name: string; roles: string[]; expiresAt: string } | undefined {
    const row = db.prepare("SELECT subject, issuer, name, roles, expires_at FROM sessions WHERE id_hash = $idHash").get({ idHash });
    return row ? { subject: String(row.subject), issuer: String(row.issuer), name: String(row.name), roles: JSON.parse(String(row.roles)), expiresAt: String(row.expires_at) } : undefined;
  }

  function deleteSession(idHash: string) {
    db.prepare("DELETE FROM sessions WHERE id_hash = $idHash").run({ idHash });
  }

  // Small settings: a day's raised budget, the last digest sent

  function getKv(key: string): string | undefined {
    const row = db.prepare("SELECT value FROM kv WHERE key = $key").get({ key });
    return row ? String(row.value) : undefined;
  }

  function setKv(key: string, value: string) {
    guard();
    db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ($key, $value, $at) ON CONFLICT(key) DO UPDATE SET value = $value, updated_at = $at").run({ key, value, at: now() });
  }

  /** A consistent copy of the whole ledger, for a backup. */
  function snapshot(file: string) {
    db.prepare("VACUUM INTO $file").run({ file });
  }

  // Costs, summed from attempts

  function runCost(runId: string): number {
    return count("SELECT COALESCE(SUM(cost_usd), 0) AS n FROM attempts WHERE run_id = $runId", { runId });
  }

  /** What attempts started since `since` (ISO) have spent so far, across runs: a day's spending. */
  function costSince(since: string): number {
    return count("SELECT COALESCE(SUM(cost_usd), 0) AS n FROM attempts WHERE started_at >= $since", { since });
  }

  function workOrderCost(workOrderId: string): number {
    return count("SELECT COALESCE(SUM(cost_usd), 0) AS n FROM attempts WHERE work_order_id = $workOrderId", {
      workOrderId,
    });
  }

  return {
    createRun,
    getRun,
    listRuns,
    updateRun,
    addWorkOrders,
    listWorkOrders,
    getWorkOrder,
    updateWorkOrder,
    deleteWorkOrders,
    addAttempt,
    getAttempt,
    getAttemptByConversation,
    updateAttempt,
    listAttempts,
    activeAttempts,
    liveRuntimes,
    usedContainers,
    addCheck,
    listChecks,
    openInbox,
    getInbox,
    listInbox,
    decideInbox,
    dismissInbox,
    openInboxCount,
    markNotified,
    runCost,
    costSince,
    workOrderCost,
    addCommand,
    getCommand,
    updateCommand,
    listCommands,
    acquireLease,
    releaseLease,
    getLease,
    fence,
    recallRequest,
    rememberRequest,
    createSession,
    getSession,
    deleteSession,
    getKv,
    setKv,
    snapshot,
    transaction,
    close: () => db.close(),
  };
}

export type Ledger = ReturnType<typeof openLedger>;
