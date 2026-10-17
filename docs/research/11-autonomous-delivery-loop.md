Sources say: OpenHands already provides conversations, persistence, resumable goals, automation dispatch and critique loops; reuse those execution surfaces. [S1] [S2] [S3] [S4] (read 2026-10-17)
Sources say: the current factory still starts work through a modal, generates sequential dependencies and requires human completion; automatic delivery is a proposed product change. [R1] [R2] [R3] (read 2026-10-17)
We recommend: one objective launches a bounded, resumable delivery run that automatically tests, reviews, repairs, integrates and previews routine work; interrupt the user only for unresolved scope or authorization. (design recommendation)

## Findings — sources say

### Existing machinery and the useful seams

| Evidence in this checkout | Implication for the design |
| --- | --- |
| Factory planning makes one work order per numbered task group and chains each to its predecessor. Briefs tell the agent to leave final completion to a person. [R1] [R2] | Reuse the planner/Backlog CLI; add an explicit dependency graph and policy acceptance rather than more manual handoffs. |
| The start modal passes `workingDir`; the shared conversation service defaults that override to `local_repo` unless `workspaceMode` is supplied. [R3] [R4] | Explicitly request a worktree for autonomous writers. |
| Canvas has independent child conversations; its launch service can fall back from worktree creation failure to a shared directory. [R5] | Reuse backend conversation creation, but require successful isolation for concurrent factory work. |
| Defaults pin agent server `1.55.1`, automation `1.20.1`; its local launcher configures a persistent SQLite automation database. [R6] [R7] | Qualify the installed versions before adding another scheduler/database. |

All checkout observations above were read **2026-10-17**; they are source inspection, not executed integration tests. Recommendations in the right column are ours.

OpenHands **Conversation Goals** adds a progress-judging driver to an ordinary conversation. It exposes `POST /api/conversations/{id}/goal`, `/goal/stop` and `/goal/resume`; goal-state events persist, permitting resume after server restart. `complete` and `capped` goals are terminal, and there is no dedicated `GET /goal`: restore status from events. This is a within-conversation continuation facility, not a documented factory-wide DAG executor. [S1] (undated; read 2026-10-17; final distinction is our inference)

SDK persistence restores a conversation by the same ID and persistence directory, retaining event history, execution state and metrics. Remote Agent Server supports HTTP/WebSocket execution and container/remote workspaces. The automation service owns scheduling, webhook triggers, run history and dispatch; its current README calls its API **beta**. Its dispatcher supports local/cloud execution and assumes a single process for SQLite. [S2] [S3] [S4] [S5] (undated; read 2026-10-17)

The SDK documents a writer/critic iterative-refinement example and usage/cost metrics. ACP advertises session loading/resume as negotiated capabilities; supporting ACP does not guarantee every agent can restore a session. None of these sources confirms that every current CLI/adapter reports complete token costs or that the pinned installation exposes all latest goal features. [S6] [S7] [S8] (undated; read 2026-10-17; compatibility limits are our inference)

## Proposed delivery loop — we recommend

Use the factory API as the **delivery coordinator**; OpenHands owns agent execution/history. Persist factory stages and identifiers, not duplicate transcripts. Qualify existing automation dispatch before adding a scheduler; defer Temporal/another workflow platform for this slice. (Design inference from [S1] [S2] [S4]; read 2026-10-17.)

1. **Objective → executable scope.** Capture outcome, repository, examples, time/spend caps and a preset authorizing edits, integration and deployment target. An agent writes the OpenSpec proposal/scenarios/design/tasks. Validate automatically; record reversible assumptions. Ask only when missing information changes the goal or exceeds authority.
2. **Scope → dependency queue.** Use the planner/Backlog CLI. Start sequentially; later permit independent dependencies. Reject cycles/missing prerequisites. Ready means prerequisites are **integrated and verified**, not writer-reported Done.
3. **Dispatch → isolated execution.** Claim a ready item, persist its attempt ID, create a worktree from the verified integration SHA and launch the existing profile/brief. Cap concurrency. Treat worktree failure as setup failure; never silently share concurrent writers' directories.
4. **Candidate → independent evidence.** Run repository build/tests and scenarios in a clean environment on the candidate SHA. Launch a separate reviewer with spec, diff and evidence. Require concrete findings and pass/fail reasons; confidence scores cannot waive checks or policy.
5. **Failure → repair.** Return failing command/logs/scenario and findings to the writer. Preserve branch/conversation; repair within limits, rerun checks and review the changed revision. Diagnose infrastructure faults separately from code failures.
6. **Verification → integration.** Automatically accept routine work; record policy/version/evidence, not fictitious personal approval. Serialize integration against the latest verified branch. Resolve conflicts in a dedicated attempt; rerun required checks on the resulting SHA before releasing dependents.
7. **Integration → preview/deployment.** Produce a preview; deploy to the authorized target, record artifact/SHA, smoke-test and restore the previous artifact on failure where supported. Preauthorized production advances automatically; only policy-required exceptions need approval.
8. **Feedback → next work.** Link preview/user/operational feedback to scenarios. Reproduce, create bounded follow-up work and dispatch within scope. Replanning preserves evidence and cannot silently broaden the objective.

These eight stages are a **proposed application contract**, not shipped OpenHands/factory behavior. The reusable primitives are evidenced above. [R1] [R2] [S1] [S3] [S6] (read 2026-10-17)

For a GitHub-backed project, prefer native required checks plus auto-merge: GitHub merges when configured requirements pass. Its merge queue checks changes with the latest target branch and queued predecessors; Actions checks used by the queue need the separate `merge_group` trigger. Plan/repository eligibility still applies. [G1] [G2] [G3] (undated; read 2026-10-17)

We recommend a single local integration lane first, or GitHub auto-merge if already available; add a merge queue when parallel PR volume justifies it. Do not require human reviews in the default preset simply because a PR exists. Keep deterministic CI checks distinct from the agent review outcome. (Design recommendation.)

### Recovery, bounded repair and visible progress

Persist `run ID, objective/spec revision, policy, stage, dependencies, attempt/conversation IDs, worktree/base/head SHA, check/review results, integration/deployment receipt, event cursor, retries and consumed/reserved budget`. Assign stable operation IDs. On restart reconcile conversations, refs, checks and deployments **before** retrying; missing acknowledgement is not failure. Reconciliation repairs missed callbacks. (Design inference using [S2] [S5]; read 2026-10-17.)

| Failure class | Proposed automatic behavior |
| --- | --- |
| Temporary network/model/runtime failure | Up to 3 delayed retries; same logical operation/attempt identity; stop repeated identical failures. |
| Test or review failure | Up to 2 repair cycles per work order, then one diagnosis/replan attempt within remaining budget. |
| Merge conflict | One integration repair attempt; recheck the resulting tree; keep unrelated ready work moving. |
| Missing credential, exhausted budget, unresolved goal ambiguity | Preserve state and surface one actionable exception; do not keep retrying or buy more usage. |
| Deployment outcome unknown | Inspect deployment receipt/target health before retrying or rolling back. |

These are **starting policy choices**, not vendor limits. Reserve budget before dispatch, including review/repair/integration. If ACP cost reporting is incomplete, show **unknown/estimated** and enforce time/attempt/concurrency limits plus available provider caps. Count in-flight work when stopping at the cap. (Design recommendation; metrics source [S7], read 2026-10-17.)

Show outcome, stage, running/queued tasks, preview, verified progress, spend/cap, last useful event and next action. Notify on preview/completion or actionable exceptions. “Agent finished” is not “feature delivered.” (Design recommendation.)

The current Electron app quits on window close and terminates its service processes. Persistent state enables later recovery; it does not keep execution running after those processes stop. [R8] (undated; read 2026-10-17) We recommend making “pause and resume on reopen” reliable first, then offering an explicit background-worker or remote-runner mode for work that must continue with the desktop closed. (Design recommendation.)

## Recommendation and effort

**Minimal slice: one project, one writer, separate reviewer, 2–3 dependent tasks, automatic integration and local preview.** Start with one objective and preauthorized routine-work preset; no per-task confirmation. Demonstrate an intentionally failed test repaired automatically, app restart during execution, no duplicated branch/PR, correct dependency release and an actionable budget-cap stop. Our estimate: **10–15 engineering days**, assuming the existing backend/CLI profile runs reliably and the project already has runnable tests/preview commands. This is an estimate, not a vendor promise.

Then add two independent writers and conflict-aware integration (**4–7 additional days**), followed by an existing CI/deployment target and feedback ingestion (**4–8 days**). Fully unattended operation across arbitrary repositories, infrastructure failures and production rollbacks is a later capability with project-specific qualification, not a credible fixed-date promise. (Our estimates/design inference.)

OpenHands SDK and automation licenses are MIT; ACP's repository is Apache-2.0. These meet the requested adoption families; preserve notices and inspect pinned transitive dependencies. GitHub is a separately contracted service. No new GPL/BUSL/source-available orchestration dependency is recommended. [L1] [L2] [L3] (undated; read 2026-10-17; selection is ours)

## Open questions

- Do pinned server `1.55.1` and selected ACP adapters expose goal, replay, cancellation and usage behavior matching current docs? A compatibility smoke test remains necessary. [R6] [S1] [S8] (read 2026-10-17; unconfirmed)
- Can the existing automation API supply atomic claims/deduplication needed by this coordinator without direct edits to its database? SQLite dispatcher is single-process; multi-host reliability is not established here. [S5] (read 2026-10-17; unconfirmed)
- Which repository commands prove each scenario and preview health, which deployment targets are preauthorized, and which changes require a scope decision? These are project/preset inputs, not universal manual gates. (Design questions.)

## Sources

All links were opened/read **2026-10-17**. Public pages below expose no reliable publication/update date and are **undated**; copyright/crawl dates were not treated as updates. Local files are the inspected checkout, not claims about every released build. No dated source older than 2025-10-17 is relied on here. Latest-main documentation may exceed pinned functionality.

| ID | Source | Date/qualification |
| --- | --- | --- |
| R1 | [Factory planner][R1] | Undated checkout |
| R2 | [Factory briefs][R2] | Undated checkout |
| R3 | [Factory start modal][R3] | Undated checkout |
| R4 | [Canvas conversation service][R4] | Undated checkout |
| R5 | [Canvas child launcher][R5] | Undated checkout |
| R6 | [Canvas version defaults][R6] | Undated checkout |
| R7 | [Canvas automation launcher][R7] | Undated checkout |
| R8 | [Electron shutdown][R8] | Undated checkout |
| S1 | [Conversation Goals][S1] | Undated |
| S2 | [Persistence][S2] | Undated |
| S3 | [Remote Agent Server][S3] | Undated |
| S4 | [Automation ownership/README][S4] | Undated; beta |
| S5 | [Automation dispatcher][S5] | Undated; main branch |
| S6 | [Iterative refinement][S6] | Undated; example pattern |
| S7 | [Metrics][S7] | Undated |
| S8 | [ACP v1 session setup][S8] | Undated; negotiated capabilities |
| G1 | [GitHub auto-merge][G1] | Undated |
| G2 | [GitHub merge queue][G2] | Undated; eligibility applies |
| G3 | [Required checks/merge_group][G3] | Undated |
| L1–L3 | [SDK MIT][L1], [automation MIT][L2], [ACP Apache-2.0][L3] | Undated license files |

[R1]: ../../apps/server/src/planner.ts
[R2]: ../../apps/server/src/briefs.ts
[R3]: ../../canvas/src/factory/components/start-agent-modal.tsx
[R4]: ../../canvas/src/api/conversation-service/agent-server-conversation-service.api.ts
[R5]: ../../canvas/src/services/child-conversation-launch.ts
[R6]: ../../canvas/config/defaults.json
[R7]: ../../canvas/scripts/dev-with-automation.mjs
[R8]: ../../canvas/electron/main.mjs
[S1]: https://docs.openhands.dev/sdk/guides/agent-server/conversation-goals
[S2]: https://docs.openhands.dev/sdk/guides/convo-persistence
[S3]: https://docs.openhands.dev/sdk/guides/agent-server/overview
[S4]: https://raw.githubusercontent.com/OpenHands/automation/main/README.md
[S5]: https://raw.githubusercontent.com/OpenHands/automation/main/openhands/automation/dispatcher.py
[S6]: https://docs.openhands.dev/sdk/guides/iterative-refinement
[S7]: https://docs.openhands.dev/sdk/guides/metrics
[S8]: https://agentclientprotocol.com/protocol/v1/session-setup
[G1]: https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/automatically-merging-a-pull-request
[G2]: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue
[G3]: https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks
[L1]: https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/LICENSE
[L2]: https://raw.githubusercontent.com/OpenHands/automation/main/LICENSE
[L3]: https://raw.githubusercontent.com/agentclientprotocol/agent-client-protocol/main/LICENSE
