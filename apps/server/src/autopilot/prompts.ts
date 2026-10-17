// What Autopilot tells its agents: the first message for each role and the
// follow-ups the orchestrator sends back. Pure functions of the run's data, so
// a restart can rebuild a brief exactly. Briefs point at files rather than
// pasting them, like briefs.ts does for hand-started work orders.
import type { Gate } from "./gates.js";
import type { Autonomy, Finding, WorkOrder } from "./ledger.js";
import { clusterFindings } from "./review.js";

/** `problem`: why the previous spec agent of this run stopped (a retry), so this one can fix it. */
export function specBrief(o: { goal: string; change: string; autonomy: Autonomy; openspecVersion: string; problem?: string | null }): string {
  const dir = `openspec/changes/${o.change}/`;
  const cli = `npx -y @fission-ai/openspec@${o.openspecVersion}`;
  const questions =
    o.autonomy === "suggest"
      ? "A person reviews the spec before anything is built. Don't ask questions in this conversation: list the assumptions you made under `## Assumptions` in proposal.md, and questions for that person under `## Open questions` (one bullet each)."
      : "Nobody is watching this conversation, so don't ask questions. Make reasonable assumptions and list them under `## Assumptions` in proposal.md. Put anything an assumption can't settle under `## Open questions` (one bullet each).";
  return [
    "You are the spec agent in a Software Factory Autopilot run. Write an OpenSpec change for this goal:",
    "",
    "<goal>",
    o.goal,
    "</goal>",
    "",
    `The change is called \`${o.change}\`. This folder is a git worktree made for it; work only here.`,
    "",
    `1. Create the change with \`openspec new change ${o.change}\` (or \`${cli} new change ${o.change}\` if openspec isn't installed). If \`${dir}\` already exists, continue from what's there.`,
    `2. In \`${dir}\` write:`,
    "   - `proposal.md`: why, what changes, the capabilities touched, and the impact.",
    "   - `specs/<capability>/spec.md`: requirements under `## ADDED Requirements` (or MODIFIED / REMOVED), each with at least one `#### Scenario:` written as **WHEN** / **THEN** lines that a test can check.",
    "   - `design.md`: how it will be built. When NIST 800-53 controls apply, add a `## Controls` table with rows like `| SI-10 Information Input Validation | how it's met |`.",
    "   - `tasks.md` in the format below.",
    `3. Run \`openspec validate ${o.change} --strict\` and fix everything it reports until it passes.`,
    "",
    ...(o.problem ? ["A previous spec agent for this change stopped on this problem. Fix it:", "", o.problem, ""] : []),
    "tasks.md format:",
    "- One `## N. Title` group per work order: a small piece of work one agent can build and test on its own.",
    "- Checklist lines `- [ ] N.M item` under each group. They become the work order's acceptance criteria.",
    "- Optionally one line `Depends on: 1, 3` or `Depends on: none` per group. Without it, a group depends on the one before it. Prefer independent groups where the design allows, so they can be built in parallel.",
    "",
    "Rules:",
    "- Don't write application code. Builders do that later, one work order at a time.",
    "- Don't commit, create branches, or touch `backlog/`. The factory validates and commits the change.",
    `- ${questions}`,
    "",
    "Finish with a short summary of the change.",
  ].join("\n");
}

export function criticBrief(o: { change: string }): string {
  return [
    `You are the spec critic in a Software Factory Autopilot run. Review the OpenSpec change in \`openspec/changes/${o.change}/\` (proposal.md, design.md, specs/, tasks.md) before anyone builds it.`,
    "",
    "Look for:",
    "- scenarios that are vague or can't be tested",
    "- missing error cases",
    "- missing accessibility (Section 508, WCAG 2.0 AA) for user-facing work",
    "- security controls in design.md that no task covers",
    "- task groups too big for one work order, and wrong or missing `Depends on:` lines",
    "",
    "Stick to correctness and requirements: no style nits, and don't invent scope the proposal doesn't ask for.",
    "Don't edit any files. The spec agent makes the changes.",
    "",
    "End your reply with exactly one fenced json block:",
    "```json",
    '{ "verdict": "pass" | "revise", "findings": [{ "severity": "high" | "medium" | "low", "where": "file and section", "issue": "what is wrong", "suggestion": "how to fix it" }] }',
    "```",
    'Say "revise" only when a finding matters (high or medium).',
  ].join("\n");
}

/** A builder's first message: one work order, built and tested in its own worktree. `gates`: the policy's, when it lists them. */
export function builderBrief(o: {
  change: string;
  wo: Pick<WorkOrder, "seq" | "title" | "acceptance" | "controls" | "branch" | "findings">;
  gates?: Gate[] | null;
}): string {
  const { wo } = o;
  const checks = o.gates?.length
    ? `When you finish, the factory runs these checks itself, in this order: ${o.gates.map((g) => `${g.name} (\`${g.run}\`${g.cwd ? ` in \`${g.cwd}/\`` : ""})`).join(", ")}. Make them pass.`
    : "When you finish, the factory runs these checks itself: `npm run typecheck`, `npm run lint` and `npm run test` in every package (this folder and one folder down) that has those scripts, after installing dependencies where node_modules is missing. Make them pass. There must be at least one `test` script.";
  return [
    `You are a builder in a Software Factory Autopilot run. Build work order WO-${wo.seq}: ${wo.title}.`,
    "",
    `It comes from the OpenSpec change in \`openspec/changes/${o.change}/\`. Read proposal.md, design.md, the scenarios in specs/ and task group ${wo.seq} in tasks.md before you start.`,
    "",
    "Acceptance criteria (write tests for each one):",
    ...wo.acceptance.map((a, i) => `${i + 1}. ${a}`),
    ...(wo.controls.length ? ["", `Security controls this work order must meet, as design.md describes them: ${wo.controls.join(", ")}.`] : []),
    ...(wo.findings?.length ? ["", "A previous attempt at this work order failed:", "", clusterFindings(wo.findings), "", "Start from the code as it is now and avoid those problems."] : []),
    "",
    `${checks} Then a reviewer reads your diff against the acceptance criteria and the scenarios.`,
    "",
    "Rules:",
    "- This folder is a git worktree made for this work order. Work only here.",
    `- Commit your work on the current branch${wo.branch ? ` (\`${wo.branch}\`)` : ""} when you're done.`,
    "- Don't create or switch branches, merge or rebase. The factory merges.",
    "- Don't change `openspec/`, `.factory/` or `backlog/`. This is an Autopilot work order: don't use Backlog.md for it.",
    "",
    "Finish with a short summary of what you changed and how you tested it.",
  ].join("\n");
}

/** A reviewer's first message: one work order's diff, after the gates passed. Another vendor than the builder when there is one. */
export function reviewerBrief(o: {
  change: string;
  wo: Pick<WorkOrder, "seq" | "title" | "acceptance" | "controls" | "branch" | "baseSha">;
}): string {
  const { wo } = o;
  return [
    `You are the reviewer in a Software Factory Autopilot run. Review work order WO-${wo.seq}: ${wo.title}.`,
    "",
    `A builder's work is committed in this folder${wo.branch ? ` on \`${wo.branch}\`` : ""}. Read it with \`git diff ${wo.baseSha ?? "HEAD~1"}...HEAD\`. It comes from the OpenSpec change in \`openspec/changes/${o.change}/\`: the scenarios are in specs/, and this is task group ${wo.seq} in tasks.md.`,
    "",
    "Acceptance criteria:",
    ...wo.acceptance.map((a, i) => `${i + 1}. ${a}`),
    ...(wo.controls.length ? ["", `Security controls it must meet, as design.md describes them: ${wo.controls.join(", ")}.`] : []),
    "",
    "The factory's checks (install, typecheck, lint, tests) already pass. Check that the work meets every criterion and the scenarios it covers, handles their error cases, and has tests that would catch it breaking.",
    "Stick to correctness and requirements: no style nits, and don't ask for scope this work order doesn't have.",
    "Don't edit or commit anything. The builder makes the fixes.",
    "",
    "End your reply with exactly one fenced json block:",
    "```json",
    '{ "verdict": "pass" | "fail", "findings": [{ "severity": "critical" | "high" | "medium" | "low", "criterion": <number from the list above> | null, "scenario": "<scenario name from specs/>" | null, "file": "<path>" | null, "issue": "what is wrong", "fix": "how to fix it" }] }',
    "```",
    'Say "fail" when something must be fixed before this work can merge.',
  ].join("\n");
}

/**
 * The validator's first message: black-box acceptance tests, one per scenario,
 * written before the code. Its folder holds a copy of the change (spec/) and
 * the plan (plan.md); the tests it writes stay there, out of every builder's sight.
 */
export function validatorBrief(o: { change: string; workOrders: Pick<WorkOrder, "seq" | "title" | "acceptance">[]; run: string }): string {
  return [
    `You are the validator in a Software Factory Autopilot run. Write hidden acceptance tests for the OpenSpec change \`${o.change}\` before any of it is built.`,
    "",
    "This folder holds a copy of the change in `spec/` (proposal.md, design.md, specs/, tasks.md) and the plan in `plan.md`. Builders never see your tests: the factory runs them against each work order after its own checks pass, and tells the builder only which scenario failed and the first assertion line.",
    "",
    "Write one test file per `#### Scenario:` in spec/specs/, in `tests/`, named `<scenario-slug>.test.mjs`. Each file starts with this header, filled in:",
    "",
    "```js",
    "// scenario: <the scenario's name, exactly as in the spec>",
    "// requirement: <its requirement's name>",
    "// requires: WO-2, WO-3   (the work orders whose code it needs; see plan.md)",
    "```",
    "",
    "Rules:",
    `- Black-box: test the behavior the scenario's WHEN/THEN lines and design.md describe (the module paths, function names, HTTP routes and messages they name), not how it's built. Each file is copied into \`.factory-hidden/\` at the root of the code under test and run from there with \`${o.run} <file>\`, so import application code as \`../<path from the repository root>\`.`,
    "- Use node:test, node:assert and other node: built-ins only. No dependencies, no network.",
    "- Assert what the scenario says, including its error cases. Never weaken a test to make it easier to pass.",
    "- Don't write application code and don't change `spec/`.",
    "",
    "Plan:",
    ...o.workOrders.map((w) => `- WO-${w.seq}: ${w.title} (${w.acceptance.join("; ")})`),
    "",
    "Finish with a list of the files you wrote and the scenario each covers.",
  ].join("\n");
}

/** Sent to the same builder conversation when its work failed a gate or the review. */
export function repairMessage(findings: Finding[]): string {
  return [
    "The factory checked your work on this work order. It isn't done yet:",
    "",
    clusterFindings(findings),
    "",
    "Fix these here, keep every check passing, and commit on the current branch. Finish with a short summary of what you changed.",
  ].join("\n");
}

/** For a critic or reviewer whose reply had no verdict the factory could read. */
export const verdictReminder = () =>
  "I couldn't find your verdict. Reply again with only the fenced json block, in the format from my first message.";

export function validateFollowUp(change: string, issues: string): string {
  return [
    `\`openspec validate ${change} --strict\` still reports problems:`,
    "",
    issues,
    "",
    "Fix them and run the validation again until it passes. Don't commit.",
  ].join("\n");
}

/** One bullet per finding, most severe first. */
export function findingList(findings: Finding[]): string {
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  return [...findings]
    .sort((a, b) => order[a.severity] - order[b.severity])
    .map((f) => `- (${f.severity}) ${f.file ? `${f.file}: ` : ""}${f.title}${f.detail ? ` Suggestion: ${f.detail}` : ""}`)
    .join("\n");
}

export function criticFollowUp(findings: Finding[]): string {
  return [
    "A reviewer read the change and asks for these revisions:",
    "",
    findingList(findings),
    "",
    "Revise the change where you agree. Where you don't, say why under `## Assumptions` in proposal.md. Then run the strict validation again. Don't commit.",
  ].join("\n");
}

export function reviseFollowUp(note: string): string {
  return [
    "The person reviewing the change asks for these revisions:",
    "",
    note,
    "",
    "Revise the change, keep `## Assumptions` and `## Open questions` in proposal.md current, and run the strict validation again. Don't commit.",
  ].join("\n");
}

export function answerFollowUp(answer: string): string {
  return [
    "Answers to the open questions in proposal.md:",
    "",
    answer,
    "",
    "Update the change to match, remove the questions these settle from `## Open questions`, and run the strict validation again. Don't commit.",
  ].join("\n");
}

/** The watchdog's one nudge to an agent that has shown no progress for a while. */
export function quietNudge(minutes: number): string {
  return [
    `Autopilot hasn't seen any progress from you in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    "",
    "If a command is hanging (a dev server, a watcher, an interactive prompt), stop it and don't start it again; run tests and builds so they exit on their own.",
    "Then finish what you were asked to do. If something blocks you, say what it is in your reply and stop.",
  ].join("\n");
}
