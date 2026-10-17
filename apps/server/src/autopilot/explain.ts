// The policy in plain words: what a team's .factory/policy.yml makes the
// factory do, for the Policy page and for anyone choosing a template.
import type { Policy } from "./policy.js";

const AUTONOMY_WORDS = {
  suggest: "a person approves the spec, the plan and every merge",
  supervised: "a person approves the plan; merges follow the rules below",
  autonomous: "a critic approves the plan; merges follow the rules below",
} as const;

const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const usd = (n: number) => `$${n.toFixed(2)}`;

/** One sentence per thing the policy decides, in the order a person would ask about them. */
export function explainPolicy(p: Policy): string[] {
  const out: string[] = [];
  out.push(
    `Runs start ${p.autonomy.default} (${AUTONOMY_WORDS[p.autonomy.default]}). ${p.autonomy.max === p.autonomy.default ? "Nobody can choose more." : `Anyone can choose up to ${p.autonomy.max}.`}`,
  );
  const sensitive = p.autoMerge.sensitivePaths.length;
  out.push(
    p.autonomy.max === "suggest"
      ? "Every merge waits for a person."
      : `A work order merges on its own when its gates and review pass, the scans find no secrets or risky dependencies, it adds no dependency outside the allowlist${p.autoMerge.dependencyAllowlist.length ? ` (${list(p.autoMerge.dependencyAllowlist)})` : ""}, it changes fewer than ${p.autoMerge.maxChangedLines} lines, and it changes none of the ${sensitive} sensitive path pattern${sensitive === 1 ? "" : "s"}. Anything else waits for a person in the Inbox, with the reasons. So does any change to the spec (openspec/), the policy (.factory/), AGENTS.md or CLAUDE.md, whatever the patterns say.`,
  );
  out.push(`Reviews block on ${list(p.review.blocking)} findings.`);
  out.push(
    `A failing work order goes back to its builder ${p.repair.sameConversation} time${p.repair.sameConversation === 1 ? "" : "s"}, then to ${p.repair.fresh} fresh builder${p.repair.fresh === 1 ? "" : "s"}, before a person is asked. Merge conflicts get ${p.selfHealing.conflictRounds} more round${p.selfHealing.conflictRounds === 1 ? "" : "s"}.`,
  );
  out.push(p.gates ? `The gates are ${list(p.gates.map((g) => `${g.name} (\`${g.run}\`)`))}.` : "The gates are the repo's npm typecheck, lint and test scripts, found in each worktree.");
  out.push(p.hiddenTests.enabled ? "A validator writes hidden acceptance tests from the scenarios before any code; builders never see them." : "No hidden acceptance tests: the builders' own tests and the review are the checks.");
  out.push(`Each change may spend ${usd(p.budget.perChangeUsd)} and each work order ${usd(p.budget.perWorkOrderUsd)} before a person is asked to raise it.`);
  out.push(`${p.parallel} work order${p.parallel === 1 ? "" : "s"} build at once in a run, and ${p.queue.maxActiveRuns} run${p.queue.maxActiveRuns === 1 ? "" : "s"} work at once; more wait in line.`);
  if (p.preview.enabled) out.push(`Before release, the factory runs the app (\`${p.preview.start}\`) and checks ${list(p.preview.paths)}, with screenshots.`);
  out.push(p.release.auto ? "Autonomous runs release into the base branch on their own (release.auto), unless the preview fails. Other runs wait for a person." : "A person releases every run into the base branch.");
  const intake = (["github", "webhook", "bug"] as const).map((s) => `${s === "github" ? "GitHub issues" : s === "webhook" ? "webhooks" : "bug reports"} ${p.intake[s] === "off" ? "are ignored" : p.intake[s] === "inbox" ? "wait for a person" : "start runs"}`);
  out.push(`From outside: ${list(intake)}${p.intake.github !== "off" ? ` (issues need the "${p.intake.githubLabel}" label)` : ""}; runs from outside are at most ${p.intake.autonomy}.`);
  out.push(`An agent quiet for ${p.selfHealing.quietMinutes} minutes is nudged, then stopped. Failed gates ${p.selfHealing.rerunFailedGates ? "run once more before they count" : "count at once"}.`);
  out.push(p.learning.proposals ? `A mistake builders make ${p.learning.threshold} times becomes a proposed line for AGENTS.md.` : "The factory doesn't propose AGENTS.md lines.");
  return out;
}
