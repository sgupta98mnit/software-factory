// The first message an agent gets when you start it on a work order.
// It points at files rather than pasting them, so the agent reads the current
// version and the brief stays short. You can edit it in Canvas before sending.
import { getWorkOrder, finalStatus, listWorkOrders } from "./backlog.js";
import { tools } from "./tools.js";

export function workOrderBrief(id: string): { workOrder: string; text: string } {
  const wo = getWorkOrder(id);
  const change = wo.labels.find((l) => l.startsWith("change:"))?.slice("change:".length);
  const controls = wo.labels.filter((l) => l.startsWith("control:")).map((l) => l.slice("control:".length));
  const all = listWorkOrders().workOrders;
  const final = finalStatus();
  const openDeps = wo.dependencies
    .map((d) => all.find((w) => w.id.toLowerCase() === d.toLowerCase()))
    .filter((d) => d && d.status !== final);
  const cli = `npx -y backlog.md@${tools.backlog.version}`;

  const lines = [
    `Work on ${wo.id}: "${wo.title}".`,
    "",
    "Read these first:",
    `- \`${wo.file}\`: the work order`,
    ...(change ? [`- \`openspec/changes/${change}/\`: proposal.md, design.md, specs/ and tasks.md`] : []),
    "- `AGENTS.md`: the conventions for this repo",
    "",
    "Acceptance criteria:",
    ...wo.acceptanceCriteria.map((ac) => `${ac.index}. ${ac.done ? "(done) " : ""}${ac.text}`),
  ];
  if (controls.length) {
    lines.push("", `Security controls this work must satisfy: ${controls.join(", ")}. design.md says how.`);
  }
  if (openDeps.length) {
    lines.push("", `Note: it depends on ${openDeps.map((d) => `${d!.id} (${d!.status})`).join(", ")}, which isn't ${final} yet.`);
  }
  lines.push(
    "",
    `Keep the work order current with the Backlog.md CLI (\`backlog\`, or \`${cli}\` if it isn't installed):`,
    `- When you start: \`backlog task edit ${wo.id} --status "In Progress"\``,
    `- As you meet each criterion: \`backlog task edit ${wo.id} --check-ac <number>\``,
    `- When you finish: \`backlog task edit ${wo.id} --final-summary "<what changed, how you tested it>"\``,
    "",
    `Don't set the status to ${final}. A person reviews the work and approves it in the Software Factory.`,
    "Start by reading the files above and telling me your plan.",
  );
  return { workOrder: wo.id, text: lines.join("\n") };
}

/** Message for an agent to refine a change's requirements or plan its work orders. */
export function changeBrief(change: string, purpose: "review" | "plan"): string {
  const base = `openspec/changes/${change}/`;
  if (purpose === "review") {
    return [
      `Review the OpenSpec change in \`${base}\` (proposal.md, design.md, specs/, tasks.md).`,
      "",
      "Look for requirements without scenarios, scenarios that can't be tested, missing error cases, accessibility (Section 508) and plain-language gaps, and security controls in design.md that no task covers.",
      `Run \`npx -y @fission-ai/openspec@${tools.openspec.version} validate ${change} --strict\` and fix what it reports.`,
      "Tell me what you'd change before editing anything.",
    ].join("\n");
  }
  return [
    `Plan Backlog.md work orders for the OpenSpec change in \`${base}\`.`,
    "",
    "Follow the conventions in AGENTS.md: one work order per task group, acceptance criteria from the checklist items, labels `change:" +
      change +
      "` and `control:<ID>` for controls from design.md, and dependencies in order.",
    "Show me the plan first. After I agree, create them with the `backlog task create` CLI.",
  ].join("\n");
}
