# PR delivery and CI repair implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Roadmap milestone 5. A finished run can push its integration branch and open a draft pull request, wait for CI and review feedback on the PR's exact head, send failures back through the normal build/verify/merge pipeline, and stop at the policy's limit for a person. Agents never push, and the factory never pushes the base branch or force-pushes.

**Architecture:** `github.ts` is a small REST client (fetch, a fine-grained token from `SF_GITHUB_TOKEN`, never in argv or records). With `delivery.mode: github`, `finish()` moves the run to a new `delivering` state instead of `done` and keeps the integration worktree. Each `deliverStep`:
1. Pushes the integration branch's tip to `refs/heads/autopilot/<change>` on the policy's remote, with the token in a per-process git config header. A rejected push or another destination is never forced.
2. Finds the open PR for that head and base, or creates one as a draft. The PR body carries a run marker, so restarts reuse it.
3. Checks that the PR head is exactly the pushed commit and upserts one evidence comment per head.
4. Reads check runs and commit statuses for that commit, and reviews at that commit. Older feedback is ignored.

When required checks pass, the run is `done`, with the PR left as a draft for people. A failing check or a changes-requested review becomes a new work order (`source: ci` or `review`) in a later wave. It is built, verified, reviewed and merged like any other, so the existing serial merge queue is reused, and the next finish pushes again. After `delivery.maxCiRepairs` rounds, a CI timeout, a moved head, a closed PR or a rejected push, the run waits for a person (`delivery` Inbox item: try again, finish here, cancel). A PR a person merged ends the run as done.

**Tech stack:** Node 26 fetch, Git (push with `GIT_CONFIG_*` environment), node:sqlite, React 19.

**Spec:** [Roadmap milestone 5](../../autopilot/ROADMAP.md); GitHub REST API (pulls, check runs, combined status, reviews, issue comments).

## Global constraints

- Least privilege: the token needs Contents read/write (push), Pull requests read/write and Checks/Commit statuses read on one repository. It is read from the environment on each call and never written anywhere.
- The factory pushes only `autopilot/<change>` branches, only fast-forwards, and never merges the PR, marks it ready or deploys.
- No new dependencies; `delivery.mode: none` (the default) keeps today's behavior.

## Review focus

1. A restart between creating the PR and recording it must reuse that PR, not open a second.
2. CI results and reviews for an older commit must not count for the current head.
3. A remote branch someone else moved must stop delivery, never be overwritten.
4. The token must never appear in argv, the ledger, the audit log, a PR comment or evidence.
5. Repair rounds must stop at the policy limit even across restarts.

### Task 1: GitHub client and delivery state
**Files:** create `apps/server/src/autopilot/github.ts`, `apps/server/test/fake-github.ts`; modify `ledger.ts` (v5: `runs.delivery`, `work_orders.source`; state `delivering`; Inbox kind `delivery`), `policy.ts` (`delivery`), `git.ts` (`env` option), `orchestrator.ts`, `prompts.ts`; test `apps/server/test/autopilot-delivery.test.ts`.
- [x] Tests: push + one draft PR reused after a restart; CI pending → passed at the exact head → done; a failing check → repair work order through the pipeline → new head pushed and checked; changes requested at the head → repair, at an older commit → ignored; limit → Inbox; moved head and rejected push → Inbox, nothing forced; token nowhere in records.
- [x] Implement; run the test file.

### Task 2: API, evidence, Canvas and docs
**Files:** `routes.ts`, `evidence.ts`, Canvas `api.ts`, `copy.ts`, `autopilot-pipeline.tsx`, `factory-badges.tsx`, tests; README, ROADMAP; Canvas patch.
- [x] Tests: the run page shows the Deliver stage, the PR link and the CI state; evidence carries the delivery section.
- [x] Implement; full verification; commit.

## Execution results (2026-10-18)

- New server tests in `autopilot-delivery.test.ts` (3), against a stand-in GitHub API (`fake-github.ts`) whose pull request heads follow a real bare repository:
  - push, one draft pull request, a lost pull request record found again, CI pending and then passed on the exact head (a pass on another commit ignored), and the evidence comment carrying the finished packet's digest;
  - the token in no record, pull request or comment;
  - a failing check and then changes requested on the new head becoming CI and review fix work orders that go through the pipeline (an older commit's review ignored), with the new heads pushed and checked;
  - the repair limit reaching the Inbox (finish here keeps the pull request open);
  - a branch someone else pushed first, refused and never force-pushed.
- The first run caught a mistake in the test setup (a duplicated policy key) and a missing evidence section; both were fixed.
- Updated on purpose: the default policy hash (`180321321476`, the `delivery` block), and the run/status shapes in the route tests (`delivery`).
- `pnpm typecheck`, server source+test typecheck, `pnpm test`: 139/139. Canvas: `tsc --noEmit` clean, `eslint src/factory` 0 errors (11 existing warnings), factory Vitest 13/13 (1 new). Patch regenerated.
- Not verified: github.com itself (the token in this environment is invalid), branch protection or merge queue settings on GitHub (required checks come from the policy), and GitHub Enterprise Server URLs beyond the configurable API base.
