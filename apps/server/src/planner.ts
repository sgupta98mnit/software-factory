// Turns an OpenSpec change into Backlog.md work orders, without a model:
// one work order per task group in tasks.md ("## 1. Service skeleton"), its
// checklist items become acceptance criteria, each one depends on the one
// before it, and NIST 800-53 controls from design.md's Controls table are
// attached as labels where the group's wording matches.
//
// It's deterministic on purpose. You see the plan, approve it, and the same
// tasks.md always gives the same work orders. Ask an agent in Canvas when you
// want a smarter split.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { audit } from "./audit.js";
import { listWorkOrders, runBacklog, type WorkOrder } from "./backlog.js";
import { WORKSPACE } from "./config.js";

const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/i;

export interface PlannedWorkOrder {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  controls: string[];
  labels: string[];
  /** Index (in this plan) of the work order it waits for, if any. */
  dependsOn: number | null;
}

export interface WorkOrderPlan {
  change: string;
  source: string;
  workOrders: PlannedWorkOrder[];
  /** Work orders already created for this change; planning again is refused while there are any. */
  existing: Pick<WorkOrder, "id" | "title" | "status">[];
}

/** "## 1. Service skeleton" + "- [ ] 1.1 ..." lines -> [{ title, items }] */
export function parseTaskGroups(markdown: string): { title: string; items: string[] }[] {
  const groups: { title: string; items: string[] }[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^##\s+\d+\.\s+(.*)$/);
    if (heading?.[1]) groups.push({ title: heading[1].trim(), items: [] });
    const item = line.match(/^\s*- \[[ x]\]\s+[\d.]+\s+(.*)$/i);
    const current = groups.at(-1);
    if (item?.[1] && current) current.items.push(item[1].trim());
  }
  return groups.filter((g) => g.items.length > 0);
}

/** Controls listed in design.md as "| SI-10 | how it's met |" rows. */
export function controlTable(designMarkdown: string): { id: string; how: string }[] {
  return [...designMarkdown.matchAll(/^\|\s*([A-Z]{2}-\d+(?:\(\d+\))?)\s*[^|]*\|\s*([^|]+)\|/gm)].map((m) => ({
    id: m[1] ?? "",
    how: (m[2] ?? "").trim(),
  }));
}

// Words that point at a control family. Simple on purpose; edit to suit your SSP.
const FAMILY_HINTS: { family: string; pattern: RegExp }[] = [
  { family: "SI", pattern: /valid|reject|malformed|sanitiz|input|400\b/i },
  { family: "AU", pattern: /audit|log(s|ged|ging)?\b|trace/i },
  { family: "AC", pattern: /access|permission|role|authori[sz]/i },
  { family: "IA", pattern: /auth(enticat)?|sign[- ]?in|login|identity|mfa/i },
  { family: "SC", pattern: /encrypt|tls|https|secret|transit/i },
];

export function controlsFor(text: string, table: { id: string }[]): string[] {
  const hits = new Set<string>();
  for (const { family, pattern } of FAMILY_HINTS) {
    if (pattern.test(text)) table.filter((c) => c.id.startsWith(`${family}-`)).forEach((c) => hits.add(c.id));
  }
  return [...hits];
}

export function planWorkOrders(change: string): WorkOrderPlan {
  if (!SAFE_ID.test(change)) throw new Error(`Invalid change "${change}"`);
  const dir = path.join(WORKSPACE, "openspec", "changes", change);
  const tasksFile = path.join(dir, "tasks.md");
  if (!existsSync(tasksFile)) throw new Error(`Change "${change}" has no tasks.md yet.`);
  const designFile = path.join(dir, "design.md");
  const table = existsSync(designFile) ? controlTable(readFileSync(designFile, "utf8")) : [];
  const groups = parseTaskGroups(readFileSync(tasksFile, "utf8"));
  if (groups.length === 0) throw new Error(`tasks.md in "${change}" has no "## 1. ..." task groups with checklist items.`);

  const workOrders = groups.map((group, i): PlannedWorkOrder => {
    const controls = controlsFor(`${group.title} ${group.items.join(" ")}`, table);
    return {
      title: group.title,
      description: `From OpenSpec change \`${change}\`, task group ${i + 1}. Read \`openspec/changes/${change}/\` before you start.`,
      acceptanceCriteria: group.items,
      controls,
      labels: [`change:${change}`, ...controls.map((c) => `control:${c}`)],
      dependsOn: i > 0 ? i - 1 : null,
    };
  });
  const existing = listWorkOrders()
    .workOrders.filter((w) => w.labels.includes(`change:${change}`))
    .map(({ id, title, status }) => ({ id, title, status }));
  return { change, source: `openspec/changes/${change}/tasks.md`, workOrders, existing };
}

/** Create the planned work orders with the backlog CLI. Recorded as a person's approval of the plan. */
export async function createWorkOrders(change: string, actor: string) {
  const plan = planWorkOrders(change);
  if (plan.existing.length) {
    throw new Error(`${change} already has work orders (${plan.existing.map((w) => w.id).join(", ")}). Edit those instead.`);
  }
  const created: { id: string; title: string }[] = [];
  const record = () =>
    audit(actor, "work_orders.created_from_change", `change:${change}`, {
      source: plan.source,
      workOrders: created.map((c) => c.id),
    });
  try {
    for (const wo of plan.workOrders) {
      const args = ["task", "create", wo.title, "--description", wo.description, "--labels", wo.labels.join(","), "--plain"];
      for (const ac of wo.acceptanceCriteria) args.push("--ac", ac);
      const dep = wo.dependsOn !== null ? created[wo.dependsOn] : undefined;
      if (dep) args.push("--dep", dep.id);
      const out = await runBacklog(args);
      // `--plain` prints "Task WO-2 - Title". Don't match ids inside the file path above it.
      const id = out.match(/^Task ([A-Za-z]+-\d+) - /m)?.[1]?.toUpperCase();
      if (!id) throw new Error(`backlog didn't report an id for "${wo.title}":\n${out}`);
      created.push({ id, title: wo.title });
    }
  } catch (err) {
    if (created.length) await record();
    const partial = created.length ? ` Created ${created.map((c) => c.id).join(", ")} before it failed.` : "";
    throw new Error(`${(err as Error).message}${partial}`);
  }
  await record();
  return { change, created };
}
