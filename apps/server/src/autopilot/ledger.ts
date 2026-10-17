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
  | "done"
  | "releasing"
  | "released"
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
  | "integration_moved"
  | "release";
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
  integrationSha: string | null; // where the factory last left the integration branch; anything else moved it
  releasedBy: string | null; // who released it into the base branch (asked for it, while releasing)
  releasedSha: string | null; // the base branch's release merge
  releasedAt: string | null;
  state: RunState;
  resumeState: RunState | null; // where to go back to after "paused"
  pausedReason: string | null;
  policyHash: string | null;
  policy: unknown; // the effective policy pinned for the run, null until set
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
  mergeSha: string | null; // the merge commit the factory made and is testing; the only tip besides integrationSha it accepts
  findings: Finding[] | null; // what triggered the latest repair
  budgetExtraUsd: number;
  mergedBy: string | null; // "policy@<hash>" or "user:<name>"
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
  progressAt: string | null; // the watchdog: when it last showed progress (new cost, events or status)
  events: number | null; // the conversation's event count when last looked at
  nudgedAt: string | null; // when the watchdog nudged it, since its last message
  result: unknown;
  startedAt: string;
  finishedAt: string | null;
}

export interface Check {
  id: number;
  runId: string;
  workOrderId: string | null;
  stage: "spec" | "build" | "integrate" | "release";
  name: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number | null;
  output: string; // the tail, at most OUTPUT_LIMIT chars
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
}

export interface HiddenTestRow {
  runId: string;
  file: string;
  scenario: string;
  requirement: string | null;
  requires: number[];
  sha256: string;
  createdAt: string;
}

export type NewRun = Pick<Run, "goal" | "change" | "autonomy" | "baseBranch" | "integrationBranch" | "createdBy"> &
  Partial<Omit<Run, "createdAt" | "updatedAt">>;
export type NewWorkOrder = Pick<WorkOrder, "seq" | "title" | "acceptance" | "controls" | "dependsOn" | "wave" | "risk"> &
  Partial<Omit<WorkOrder, "id" | "runId" | "updatedAt">>;
export type NewAttempt = Pick<Attempt, "runId" | "role" | "conversationId"> & Partial<Omit<Attempt, "id">>;
export type NewCheck = Pick<Check, "runId" | "stage" | "name" | "ok"> &
  Partial<Pick<Check, "workOrderId" | "exitCode" | "durationMs" | "output">>;
export type NewInboxItem = Pick<InboxItem, "runId" | "kind" | "title" | "body" | "options"> &
  Partial<Pick<InboxItem, "workOrderId">>;

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

// v2: the integration tip the factory last wrote, to catch anything else moving the branch.
const SCHEMA_V2 = `
ALTER TABLE runs ADD COLUMN integration_sha TEXT;
`;

// v3: the merge commit being tested, so nothing else can pass for it.
const SCHEMA_V3 = `
ALTER TABLE work_orders ADD COLUMN merge_sha TEXT;
`;

// v4: small factory-wide settings and markers (when the last alert and digest went out).
const SCHEMA_V4 = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// v5: the hidden acceptance tests a run's validator wrote, with the hash each must keep.
const SCHEMA_V5 = `
CREATE TABLE hidden_tests (
  run_id TEXT NOT NULL REFERENCES runs(id),
  file TEXT NOT NULL,
  scenario TEXT NOT NULL,
  requirement TEXT,
  requires TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, file)
);
`;

// v6: the release into the base branch.
const SCHEMA_V6 = `
ALTER TABLE runs ADD COLUMN released_by TEXT;
ALTER TABLE runs ADD COLUMN released_sha TEXT;
ALTER TABLE runs ADD COLUMN released_at TEXT;
`;

// v7: the watchdog's view of each agent.
const SCHEMA_V7 = `
ALTER TABLE attempts ADD COLUMN progress_at TEXT;
ALTER TABLE attempts ADD COLUMN events INTEGER;
ALTER TABLE attempts ADD COLUMN nudged_at TEXT;
`;

type Table = "runs" | "work_orders" | "attempts" | "checks" | "inbox" | "hidden_tests";
const TABLES: Table[] = ["runs", "work_orders", "attempts", "checks", "inbox", "hidden_tests"];

// Fields are the columns in camelCase. JSON columns are parsed; 0/1 flags become booleans.
const JSON_COLUMNS = new Set(["policy", "acceptance", "controls", "depends_on", "findings", "result", "options", "requires"]);
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

  // Schema version in PRAGMA user_version; each step upgrades one version, in order.
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (version < 1) transaction(() => db.exec(`${SCHEMA_V1}\nPRAGMA user_version = 1;`));
  if (version < 2) transaction(() => db.exec(`${SCHEMA_V2}\nPRAGMA user_version = 2;`));
  if (version < 3) transaction(() => db.exec(`${SCHEMA_V3}\nPRAGMA user_version = 3;`));
  if (version < 4) transaction(() => db.exec(`${SCHEMA_V4}\nPRAGMA user_version = 4;`));
  if (version < 5) transaction(() => db.exec(`${SCHEMA_V5}\nPRAGMA user_version = 5;`));
  if (version < 6) transaction(() => db.exec(`${SCHEMA_V6}\nPRAGMA user_version = 6;`));
  if (version < 7) transaction(() => db.exec(`${SCHEMA_V7}\nPRAGMA user_version = 7;`));

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
    const p = params(table, fields);
    const cols = Object.keys(p);
    const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => `$${c}`).join(", ")})`;
    return Number(db.prepare(sql).run(p).lastInsertRowid);
  }

  function update(table: Table, id: string | number, fields: Record<string, unknown>) {
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
    const { changes } = db
      .prepare("UPDATE inbox SET state = 'dismissed', decided_at = $at WHERE run_id = $runId AND state = 'open'")
      .run({ runId: filter.runId, at: now() });
    return Number(changes);
  }

  /** Marks items as told about (an alert or a digest), so a digest doesn't repeat them. */
  function markNotified(ids: number[], at: string) {
    const stmt = db.prepare("UPDATE inbox SET notified_at = $at WHERE id = $id");
    transaction(() => ids.forEach((id) => stmt.run({ id, at })));
  }

  function openInboxCount(): number {
    return count("SELECT COUNT(*) AS n FROM inbox WHERE state = 'open'", {});
  }

  // Hidden acceptance tests (written once per run by its validator)

  function setHiddenTests(runId: string, tests: Omit<HiddenTestRow, "runId" | "createdAt">[]) {
    const at = now();
    transaction(() => {
      db.prepare("DELETE FROM hidden_tests WHERE run_id = $runId").run({ runId });
      for (const t of tests) insert("hidden_tests", { ...t, runId, createdAt: at });
    });
  }

  function listHiddenTests(runId: string): HiddenTestRow[] {
    return all<HiddenTestRow>("SELECT * FROM hidden_tests WHERE run_id = $runId ORDER BY file", { runId });
  }

  // Meta (key -> text)

  function getMeta(key: string): string | null {
    const row = db.prepare("SELECT value FROM meta WHERE key = $key").get({ key });
    return row ? String(row.value) : null;
  }

  function setMeta(key: string, value: string) {
    db.prepare("INSERT INTO meta (key, value) VALUES ($key, $value) ON CONFLICT(key) DO UPDATE SET value = $value").run({ key, value });
  }

  // Costs, summed from attempts

  function runCost(runId: string): number {
    return count("SELECT COALESCE(SUM(cost_usd), 0) AS n FROM attempts WHERE run_id = $runId", { runId });
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
    addCheck,
    listChecks,
    openInbox,
    getInbox,
    listInbox,
    decideInbox,
    dismissInbox,
    markNotified,
    setHiddenTests,
    listHiddenTests,
    openInboxCount,
    getMeta,
    setMeta,
    runCost,
    workOrderCost,
    transaction,
    close: () => db.close(),
  };
}

export type Ledger = ReturnType<typeof openLedger>;
