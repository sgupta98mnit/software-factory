# Trusted verification implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Roadmap milestone 3. What decides that a work order passed comes from the base branch and from parties other than its builder, every result names the commit it checked, and nothing merges without those results for its exact head.

**Architecture:** At run creation the factory pins the verification commands: the policy's `gates`, else the `typecheck`/`lint`/`test` script bodies (with their pre/post scripts) read from the base branch's package.json files, run directly with `node_modules/.bin` on PATH so a builder's package.json, `.npmrc` or scripts can't change them. Only when the base defines none does it fall back to the branch's own scripts, recorded as unpinned. Paths under `verification.protectedPaths` that a work order changes are restored to their base content by the factory and recorded. With `hiddenTests.enabled`, a validator agent writes black-box tests per scenario in its own worktree before any builder's work is verified; the factory keeps them outside every worktree with their digests and runs them on a clean checkout of each work order's commit and on the integration branch after each merge, reporting only the scenario and the first assertion line. With `verification.trivy.mode` advisory or required, the factory runs a pinned Trivy binary on a clean checkout of the commit and of its base, and sends new findings at the blocking severities back with redacted summaries (secrets by rule and line, never the match); in required mode an unavailable, unpinned-version or stale scanner stops the work order for a person. A `verified` check bound to the commit is written when all of this passes, and merging requires one for the branch's current head, so a person's merge approval can't merge anything else.

**Tech stack:** Node 26, TypeScript, node:sqlite, Git, Trivy CLI (external, operator-installed), React 19 in Canvas.

**Spec:** [Roadmap milestone 3](../../autopilot/ROADMAP.md) and design §9 C10/C11 in [DESIGN.md](../../autopilot/DESIGN.md).

## Global constraints

- No new dependencies; no network calls by the factory beyond what Trivy and gates do themselves (`--skip-db-update`: the operator keeps the database fresh).
- Never store, log or return a secret's matched text or hidden test source; findings carry rule ids, files, lines and first assertion lines.
- Runs created before this milestone keep their old verification behavior (no `runs.verification`).
- `hiddenTests.enabled` now defaults to false (it adds an agent per run); policy hash changes on purpose.

## Review focus

1. A builder that rewrites `scripts.test` to `exit 0`, adds `.npmrc`, or edits `.factory/policy.yml` still gets the base branch's checks and rules.
2. A secret in the code never appears in a check's output, a finding, the audit log, evidence or an API response.
3. A Trivy finding already present on the base doesn't block a work order; a new one does.
4. A required scanner that is missing, the wrong version or has a stale database fails closed; an advisory one is recorded and doesn't block.
5. A merge approval for a branch whose head moved after verification is refused.

### Task 1: Pinned gates, protected paths and commit-bound checks
**Files:** `ledger.ts` (v3: `checks.commit`, `checks.meta`, `runs.verification`), `policy.ts`, `gates.ts`, `git.ts`, `orchestrator.ts`; test `apps/server/test/autopilot-trusted.test.ts`.
- [x] Tests: base scripts run even when the branch changes them; `.factory/policy.yml` edits are restored and recorded; gate checks carry the commit; merging needs `verified` at the head.
- [x] Implement; run the test file.

### Task 2: Independent acceptance tests (validator)
**Files:** `prompts.ts` (`validatorBrief`), `orchestrator.ts`, `integrator.ts` (`after` hook); same test file.
- [x] Tests: the validator's files are kept outside worktrees with digests and its worktree removed; a failing hidden test sends back the scenario and one assertion line, never the source; integration runs merged work orders' hidden tests.
- [x] Implement; run the test file.

### Task 3: Trivy
**Files:** create `apps/server/src/autopilot/scanner.ts`; modify `orchestrator.ts`, `config.ts`; same test file with a fake Trivy runner.
- [x] Tests: new secret/vulnerability findings go back redacted; base findings don't block; required + missing/wrong version/stale fails closed with a retry; advisory records and continues; scanner version, database age, binary digest and result digest are recorded.
- [x] Implement; run the test file.

### Task 4: API, evidence, Canvas and docs
**Files:** `routes.ts`, `evidence.ts`, Canvas `api.ts`, `copy.ts`, `autopilot-pipeline.tsx`, `autopilot-home.tsx`, tests; README, ROADMAP; Canvas patch.
- [x] Tests: evidence marks checks commit-bound and reports security scanning and independent validation only when recorded; the run page shows the verification fact and scanner details.
- [x] Implement; full verification; commit.

## Execution results (2026-10-18)

- New server tests in `autopilot-trusted.test.ts` (5): pinned checks with a builder that rewrites `scripts.test` and edits `.factory/policy.yml`; hidden tests end to end (kept outside worktrees, redacted repair, rerun on integration); Trivy required mode through a wrong version, a stale database and a new secret (whose value appears nowhere); a merge approval that can't merge a moved head; `gatesAt`/`parseReport` units. One test assumption was wrong (it expected the unreviewed commit to merge; the review step drops commits the builder didn't make), corrected in the test.
- Added during implementation: changing a pinned script is a merge reason (the next run would pin it); factory git runs with `core.fsmonitor=false` and `diff.ignoreSubmodules=all`; proposal, tasks, design and hidden-test reads refuse symlinks that leave the worktree.
- Updated on purpose: the default policy hash (`b98d4edcbac6`), the `verified` check in existing check-list expectations, and the run/status shapes in the route tests.
- `pnpm typecheck`, server source+test typecheck, `pnpm test`: 129/129. Canvas: `tsc --noEmit` clean, `eslint src/factory` 0 errors (11 existing warnings), factory Vitest 10/10 (2 new). Patch regenerated.
- Not verified: a real Trivy binary and database (none installed here); Trivy's check-bundle and Java DB downloads still happen unless the operator configures Trivy offline. Hidden-test quality depends on the test writer's reading of the spec; the factory only guarantees they're independent of builders and unchanged.
