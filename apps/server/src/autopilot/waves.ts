// Autopilot's planner: turns a change's tasks.md into work orders, without a
// model. Each "## N. Title" group is one work order numbered N, its checklist
// items are the acceptance criteria, and an optional "Depends on: 1, 3" (or
// "none") line says what it waits for; without one it waits for the group
// before it. Work orders whose dependencies are all done build in parallel, so
// the dependency graph is cut into waves. Controls come from design.md's
// Controls table (planner.ts), and a rough risk score says which need care.
import path from "node:path";
import { controlsFor, controlTable } from "../planner.js";
import { readInside } from "./git.js";
import type { NewWorkOrder, Risk } from "./ledger.js";

export interface TaskGroup {
  seq: number; // N from "## N. Title"
  title: string;
  items: string[];
  dependsOn: number[];
}

const HEADING = /^##\s+(\d+)\.\s+(.*\S)/;
const ITEM = /^\s*[-*]\s+\[[ xX]\]\s+(?:\d+(?:\.\d+)*\.?\s+)?(.*\S)/;
const DEPENDS = /^\s*(?:[-*]\s+)?[*_]*depends on[*_]*\s*:[*_]*\s*(.*?)\s*$/i;

function parseDepends(value: string, seq: number): number[] {
  if (/^(none|nothing|n\/a|-)?\.?$/i.test(value)) return [];
  const deps = [...value.matchAll(/(\d+)(?:\.\d+)*/g)].map((m) => Number(m[1]));
  if (!deps.length) throw new Error(`Task group ${seq} says "Depends on: ${value}". Use group numbers ("Depends on: 1, 3") or "Depends on: none".`);
  return [...new Set(deps)];
}

/**
 * The task groups that have checklist items, keeping their numbers. A group
 * without a "Depends on:" line depends on the group before it.
 */
export function parseTasks(markdown: string): TaskGroup[] {
  const groups: (Omit<TaskGroup, "dependsOn"> & { dependsOn: number[] | null })[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading) {
      const seq = Number(heading[1]);
      if (groups.some((g) => g.seq === seq)) throw new Error(`tasks.md has two task groups numbered ${seq}.`);
      groups.push({ seq, title: heading[2] ?? "", items: [], dependsOn: null });
      continue;
    }
    const current = groups.at(-1);
    if (!current) continue;
    const item = ITEM.exec(line)?.[1];
    const depends = item ? undefined : DEPENDS.exec(line)?.[1];
    if (item) current.items.push(item);
    else if (depends !== undefined) current.dependsOn = parseDepends(depends, current.seq);
  }
  return groups
    .filter((g) => g.items.length > 0)
    .map((g, i, kept) => ({ ...g, dependsOn: g.dependsOn ?? (i > 0 ? [kept[i - 1]!.seq] : []) }));
}

/** Wave of each group (seq -> 1, 2, ...): one more than the latest wave it depends on. */
export function computeWaves(groups: Pick<TaskGroup, "seq" | "dependsOn">[]): Map<number, number> {
  const bySeq = new Map(groups.map((g) => [g.seq, g]));
  for (const g of groups) {
    const unknown = g.dependsOn.find((d) => !bySeq.has(d));
    if (unknown !== undefined) throw new Error(`Task group ${g.seq} depends on ${unknown}, but tasks.md has no task group ${unknown} with checklist items.`);
  }
  const waves = new Map<number, number>();
  const visit = (seq: number, trail: number[]): number => {
    const known = waves.get(seq);
    if (known) return known;
    if (trail.includes(seq)) {
      const cycle = [...trail.slice(trail.indexOf(seq)), seq].join(" → ");
      throw new Error(`Task groups depend on each other in a cycle (${cycle}), so none of them can start.`);
    }
    const wave = 1 + Math.max(0, ...(bySeq.get(seq)?.dependsOn ?? []).map((d) => visit(d, [...trail, seq])));
    waves.set(seq, wave);
    return wave;
  };
  for (const g of groups) visit(g.seq, []);
  return waves;
}

// Words that mark work worth a closer look. Simple on purpose; edit to suit your system.
const RISKY: { points: number; pattern: RegExp }[] = [
  { points: 3, pattern: /\b(auth\w*|sign[- ]?in|log[- ]?in|passwords?|sessions?|permissions?|crypto\w*|encrypt\w*|secrets?|private keys?|tokens?|mfa)\b/i },
  { points: 2, pattern: /\b(migrations?|schema|database|infra\w*|deploy\w*|docker\w*|terraform|ci|payments?|pii|ssn)\b/i },
];

/**
 * A rough risk score: sensitive wording, attached controls (access, identity
 * and crypto ones count double) and size. 0-1 low, 2-3 medium, 4+ high.
 */
export function riskOf(wo: { title: string; acceptance: string[]; controls: string[] }): { score: number; level: Risk } {
  const text = `${wo.title} ${wo.acceptance.join(" ")}`;
  let score = RISKY.reduce((sum, r) => sum + (r.pattern.test(text) ? r.points : 0), 0);
  if (wo.controls.length) score += 1;
  if (wo.controls.some((c) => /^(AC|IA|SC)-/.test(c))) score += 1;
  if (wo.acceptance.length > 5) score += 2;
  else if (wo.acceptance.length > 3) score += 1;
  return { score, level: score >= 4 ? "high" : score >= 2 ? "medium" : "low" };
}

/** Work orders for the change in `dir` (the run's integration worktree). Throws, saying what to fix, when tasks.md can't be planned. */
export function planWorkOrders(dir: string, change: string): NewWorkOrder[] {
  const read = (file: string) => readInside(dir, path.join("openspec", "changes", change, file));
  const tasks = read("tasks.md");
  if (tasks === null) throw new Error(`openspec/changes/${change}/tasks.md is missing.`);
  const groups = parseTasks(tasks);
  if (!groups.length) throw new Error(`openspec/changes/${change}/tasks.md has no "## 1. Title" task groups with "- [ ] 1.1 ..." checklist items.`);
  const waves = computeWaves(groups);
  const table = controlTable(read("design.md") ?? "");
  return groups.map((g) => {
    const controls = controlsFor(`${g.title} ${g.items.join(" ")}`, table);
    const risk = riskOf({ title: g.title, acceptance: g.items, controls });
    return {
      seq: g.seq,
      title: g.title,
      acceptance: g.items,
      controls,
      dependsOn: g.dependsOn,
      wave: waves.get(g.seq) ?? 1,
      risk: risk.level,
      riskScore: risk.score,
    };
  });
}
