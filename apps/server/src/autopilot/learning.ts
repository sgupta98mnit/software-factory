// What the factory learns from its own runs, without another agent:
//
// - Lessons: mistakes builders keep making in this workspace (a gate that
//   fails on the first try again and again, secrets the scan catches,
//   dependencies that aren't pinned) become a line proposed for the
//   workspace's AGENTS.md, which every agent reads. A person accepts or
//   declines it in the Inbox; nothing is written without them.
// - Insights: per policy hash, how often the policy merged by itself, and for
//   each reason it held a work order for a person, what people then did. A
//   reason people merge every time is a rule stricter than it needs to be.
import type { AuditEvent } from "../audit.js";
import type { Ledger, Run } from "./ledger.js";
import { pinnedPolicy } from "./policy.js";

export interface LessonCandidate {
  key: string;
  line: string;
  count: number;
  /** Where it was seen: "<change> WO-<n>", newest first, a few. */
  seen: string[];
}

/** The command a gate runs, for a line a builder can follow. */
function gateCommand(run: Run, name: string): string | null {
  const gate = pinnedPolicy(run).gates?.find((g) => g.name === name);
  if (gate) return gate.cwd ? `cd ${gate.cwd} && ${gate.run}` : gate.run;
  // A detected gate is named after its folder, and agents name folders: a plain name only, so a lesson
  // (a line every agent reads) never carries a command someone put in one ("x`; curl … | sh; echo `").
  const m = /^(?:([\w.@-]+):)?(typecheck|lint|test)$/.exec(name);
  if (!m) return null;
  return m[1] ? `cd ${m[1]} && npm run ${m[2]}` : `npm run ${m[2]}`;
}

/**
 * Mistakes seen at least `threshold` times across the ledger's runs, as
 * lessons. A gate counts once per work order, when its first build failed it.
 */
export function findLessons(ledger: Ledger, threshold: number): LessonCandidate[] {
  const runs = ledger.listRuns();
  const gates = new Map<string, { run: Run; seen: string[] }>();
  let secrets: string[] = [];
  let pins: string[] = [];
  for (const run of runs) {
    for (const wo of ledger.listWorkOrders(run.id)) {
      const where = `${run.change} WO-${wo.seq}`;
      const checks = ledger.listChecks({ runId: run.id, workOrderId: wo.id }).filter((c) => c.stage === "build");
      // Each gate's first run for this work order (a flaky pass counts as passing).
      const first = new Map<string, boolean>();
      for (const c of checks) if (!first.has(c.name)) first.set(c.name, c.ok);
      for (const [name, ok] of first) {
        if (ok || name.startsWith("hidden:") || name === "secret-scan" || name === "dependency-scan" || name === "gates") continue;
        const entry = gates.get(name) ?? { run, seen: [] };
        entry.seen.push(where);
        gates.set(name, entry);
      }
      if (checks.some((c) => c.name === "secret-scan" && !c.ok)) secrets.push(where);
      if (checks.some((c) => c.name === "dependency-scan" && !c.ok && /exact version|isn't pinned|not pinned/i.test(c.output))) pins.push(where);
    }
  }
  const out: LessonCandidate[] = [];
  for (const [name, { run, seen }] of gates) {
    const command = gateCommand(run, name);
    if (seen.length < threshold || !command) continue;
    out.push({ key: `gate:${name}`, line: `Run \`${command}\` before you finish and fix everything it reports: in this repo it failed on the first try in ${seen.length} work orders.`, count: seen.length, seen: seen.slice(0, 5) });
  }
  secrets = [...new Set(secrets)];
  pins = [...new Set(pins)];
  if (secrets.length >= threshold) {
    out.push({ key: "secrets", line: `Never write credentials, tokens or keys into code, tests or config: read them from environment variables. The factory's secret scan caught ${secrets.length} work orders doing it.`, count: secrets.length, seen: secrets.slice(0, 5) });
  }
  if (pins.length >= threshold) {
    out.push({ key: "deps-pinned", line: `Pin every dependency to an exact version (no ^ or ~) and add none from outside the npm registry: ${pins.length} work orders didn't, and a person had to look at each.`, count: pins.length, seen: pins.slice(0, 5) });
  }
  return out;
}

/** AGENTS.md with `line` added under the factory's section (made if missing). */
export function withLesson(agentsMd: string | null, line: string): string {
  const heading = "## Learned by the Software Factory";
  const bullet = `- ${line}`;
  const text = (agentsMd ?? "# Instructions for agents\n").replace(/\s*$/, "\n");
  if (!text.includes(heading)) return `${text}\n${heading}\n\n${bullet}\n`;
  // Append at the end of the factory's section: before the next "## " heading, or at the end.
  const start = text.indexOf(heading);
  const next = text.slice(start + heading.length).search(/\n## /);
  if (next === -1) return `${text}${bullet}\n`;
  const at = start + heading.length + next;
  return `${text.slice(0, at).replace(/\s*$/, "\n")}${bullet}\n${text.slice(at)}`;
}

// ---- insights ----

export interface ReasonOutcome {
  reason: string;
  asked: number;
  merged: number;
  sentBack: number;
  skipped: number;
}

export interface PolicyInsight {
  hash: string;
  runs: number;
  released: number;
  firstRun: string;
  lastRun: string;
  merges: { policy: number; person: number };
  /** Of the person merges, those where nobody asked for a change first. */
  reasons: ReasonOutcome[];
  releaseFailures: number;
  flakyGates: number;
  /** What the numbers suggest about the rules, in plain words. */
  notes: string[];
}

/** "Changes 512 lines, over the limit of 400" -> "Changes N lines, over the limit of N"; details after a colon go. */
export const reasonKind = (r: string) => r.split(":")[0]!.replace(/\(.*$/, "").replace(/\d+(\.\d+)?/g, "N").trim();

export function buildInsights(ledger: Ledger, events: AuditEvent[]): PolicyInsight[] {
  const byRun = new Map<string, AuditEvent[]>();
  for (const e of events) {
    const list = byRun.get(e.subject);
    if (list) list.push(e);
    else byRun.set(e.subject, [e]);
  }
  const groups = new Map<string, PolicyInsight>();
  for (const run of [...ledger.listRuns()].reverse()) {
    const hash = run.policyHash ?? "default";
    const g = groups.get(hash) ?? { hash, runs: 0, released: 0, firstRun: run.createdAt, lastRun: run.createdAt, merges: { policy: 0, person: 0 }, reasons: [], releaseFailures: 0, flakyGates: 0, notes: [] };
    groups.set(hash, g);
    g.runs++;
    g.lastRun = run.createdAt;
    if (run.state === "released") g.released++;
    const runEvents = (byRun.get(run.id) ?? []).slice().sort((a, b) => a.seq - b.seq);
    for (const e of runEvents) {
      if (e.action === "autopilot.work_order_merged") (String(e.actor).startsWith("policy@") ? g.merges.policy++ : g.merges.person++);
      if (e.action === "autopilot.release_failed") g.releaseFailures++;
      if (e.action === "autopilot.gates_run" && Array.isArray(e.data.flaky)) g.flakyGates += e.data.flaky.length;
    }
    // Each time the policy asked a person, and what that person chose. Every ask opened one merge
    // approval for its work order, so the n-th ask of a work order goes with its n-th item.
    const asks = runEvents.filter((e) => e.action === "autopilot.work_order_state_changed" && e.data.to === "awaiting_merge_approval" && Array.isArray(e.data.reasons));
    const items = ledger.listInbox({ state: "all", runId: run.id }).filter((i) => i.kind === "merge_approval").sort((a, b) => a.id - b.id);
    const seen = new Map<string, number>();
    for (const ask of asks) {
      const workOrder = `${run.id}/${String(ask.data.workOrder)}`;
      const n = seen.get(workOrder) ?? 0;
      seen.set(workOrder, n + 1);
      const item = items.filter((i) => i.workOrderId === workOrder)[n];
      const decision = item?.state === "decided" ? item : undefined;
      for (const reason of new Set((ask.data.reasons as string[]).map(reasonKind))) {
        let r = g.reasons.find((x) => x.reason === reason);
        if (!r) g.reasons.push((r = { reason, asked: 0, merged: 0, sentBack: 0, skipped: 0 }));
        r.asked++;
        if (decision?.decision === "merge") r.merged++;
        else if (decision?.decision === "send_back") r.sentBack++;
        else if (decision?.decision === "skip") r.skipped++;
      }
    }
  }
  for (const g of groups.values()) {
    g.reasons.sort((a, b) => b.asked - a.asked);
    const total = g.merges.policy + g.merges.person;
    if (total) g.notes.push(`The policy merged ${g.merges.policy} of ${total} work orders by itself.`);
    for (const r of g.reasons) {
      if (r.asked >= 5 && r.merged === r.asked) g.notes.push(`People merged all ${r.asked} work orders held for “${r.reason}”: that rule may be stricter than it needs to be.`);
      else if (r.asked >= 3 && r.sentBack + r.skipped >= r.asked / 2) g.notes.push(`“${r.reason}” caught work people sent back or skipped ${r.sentBack + r.skipped} of ${r.asked} times: that rule is earning its keep.`);
    }
    if (g.flakyGates) g.notes.push(`${g.flakyGates} gate run(s) passed only on a re-run: some tests are flaky.`);
  }
  return [...groups.values()].sort((a, b) => b.lastRun.localeCompare(a.lastRun));
}
