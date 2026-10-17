// What Autopilot tells its agents: the first message for each role and the
// follow-ups the orchestrator sends back. Pure functions of the run's data, so
// a restart can rebuild a brief exactly. Briefs point at files rather than
// pasting them, like briefs.ts does for hand-started work orders.
import type { Autonomy, Finding } from "./ledger.js";

export function specBrief(o: { goal: string; change: string; autonomy: Autonomy; openspecVersion: string }): string {
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
