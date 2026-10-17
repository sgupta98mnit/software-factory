The current factory connects specs, work orders, agent chats, and manual approval; its inspected modules do not implement a complete automatic delivery loop. [L1] [L2] [L3] (inspected 2026-10-17).
We recommend making an outcome-driven run the primary product: plan, dispatch, build, verify, repair, integrate, preview, and deliver without per-task clicks. [L1] [W1] (inference; read/inspected 2026-10-17).
Reuse Canvas's agent infrastructure and add the missing factory coordination and user experience; start with one project and one automatically completed multi-task change. [L4] [L5] [W2] (recommendation; read/inspected 2026-10-17).

# 13 — From the current app to an autonomous software factory

## Scope

This report follows the user's **2026-10-17 clarification**: focus on features, usability, full autonomous delivery, and the least possible human intervention. The saved research brief remains unchanged. Files 10–13 and SUMMARY are the primary product research; earlier federal/platform reports are supporting references. This is research and proposed behavior, with no product implementation.

## Findings — what the inspected code does today

| Part of the journey | Current factory behavior | Missing capability for the requested experience — our assessment |
| --- | --- | --- |
| Describe an outcome | Requirements displays existing OpenSpec changes and can start review/planning conversations. [L6] | A single “What should the factory deliver?” entry point that creates and carries an outcome through delivery. |
| Plan implementation | Planner splits numbered `tasks.md` groups, copies checklist items, and makes every group depend on the previous group. [L7] | Semantic decomposition, executable acceptance criteria, and genuine dependency edges; independent tasks should not be serialized automatically. |
| Begin work | StartAgentModal loads a brief, selects an agent profile, creates one conversation, records its ID, and navigates to chat. [L2] | Automatic task dispatch under a saved project/run profile, without opening a modal for every work order. |
| Respect dependencies | The brief mentions unfinished dependencies; the StartAgentModal's start condition checks workspace existence, message text, and pending creation, not dependency completion. [L2] [L3] | Enforced readiness and one owner per task; the scheduler must decide what can run next. |
| Know work succeeded | Agent instructions ask it to check criteria and write a summary. API status changes do not require test results or a verified code revision. [L1] [L3] [L8] | Structured checks against the produced revision, a separate review pass, and automatic repair of failed checks. |
| Complete a work order | The final status requires `approve`; the brief explicitly says a person reviews and approves. The UI can offer Approve from an intermediate status. [L3] [L8] [L9] | A policy-completed path for ordinary authorized work, with exact reasons/results recorded. Human approval becomes an optional policy action, not the only final state. |
| Continue automatically | Factory API routes record/link conversations; its file watcher records changes and broadcasts refresh events. No queue dispatcher is wired into these inspected modules. [L1] [L8] [L10] | A durable run coordinator that observes completion, handles failures, and dispatches successors. |
| Show the result | Current factory routes are Requirements, Work orders, and Audit log. [L11] | A run overview and usable product preview with checks, delivery status, and feedback in context. |
| Improve after delivery | The inspected factory routes/API do not connect a feedback item to an automatic repair/new run. [L1] [L11] | Feedback → reproduction → scoped task → validated repair → updated preview/delivery. |

All local evidence above was **inspected 2026-10-17**; files are undated snapshot sources. “Missing” means not connected in the inspected **factory modules**, not that upstream Canvas has no related capability. These were code observations, not runtime tests. [L1] [L11] (inspection scope).

### The upstream app is a source of reusable capabilities

Canvas already has child-conversation launch logic, automation APIs, and conversation metrics/runtime-resume types. Its chat hooks also expose conversation goals. OpenHands documents resumable goal-driven conversations. These reduce the amount of agent infrastructure the factory needs to own; they do not supply its task graph, integration verdict, or delivery state automatically. [L4] [L5] [L12] [L13] [W2] (read/inspected 2026-10-17; final sentence is inference).

Current public examples support the product direction: Factory Missions coordinates planned work and validation; GitHub supports auto-merge after required checks/reviews and a merge queue that checks combined changes; Playwright provides traces and test-agent workflows. Reuse these mechanisms where applicable instead of inventing another repository host or browser-testing framework. [W1] [W3] [W4] [W5] [W6] (read 2026-10-17; recommendation).

## Recommendation — the proposed product behavior

### One project setup; one outcome request

The following is **our proposed design**, not a claim that it exists today. Configure the repository, agent/provider, install/start/check commands, sample data, destination, and spending/concurrency limits once. The factory detects candidate commands from the repo and performs a readiness run; the user only supplies values it cannot discover, such as access credentials. Then the ordinary interaction is **describe the outcome → Start factory → return to a working result**. [L2] [L3] [W1] (basis inspected/read 2026-10-17; design inference).

Use three configurable operating presets, with **Autonomous** as the target default for a configured project:

| Proposed preset | What runs automatically | When the user intervenes |
| --- | --- | --- |
| Autonomous | Research local context, draft/revise specs, generate tasks, execute, verify, review, repair, integrate, and update the preview; deliver to the already-authorized target. | A new decision is genuinely required, credentials are missing, repeated recovery fails, or requested work exceeds configured scope/budget/destination. |
| Plan first | Same execution after the user chooses to review the proposed outcome/plan once. | One initial plan review, then exceptions. |
| Custom | Project-selected review/release rules. | Only the boundaries the project owner explicitly configured. |

This is a product recommendation from the user's stated preference; it is **not** a proposal to secretly count an agent action as a person's approval. Automatic acceptance should record a system/policy decision, the policy version and verification result, while a real human decision stays separately identifiable. The present final-status assumption needs a deliberate behavioral change for this product direction. [L3] [L8] (inspected 2026-10-17; recommendation).

### Make the factory perform the coordination

**Proposed run model:** outcome, current plan revision, dependency graph, selected project settings, task attempts, conversation IDs, workspace/revision, checks, integration state, preview/delivery result, and unresolved exceptions. Preserve durable state before dispatch and after each meaningful transition. On restart, reconcile with actual agent/git/CI state before starting another attempt. This is the minimal missing coordination state; conversation transcripts alone are not the run ledger. [L1] [L5] [L8] (inspected 2026-10-17; design inference).

**Proposed execution:** choose a ready task; start an isolated worker; verify its result; ask a separate reviewer to inspect that revision; automatically send actionable failures back for repair; integrate passing work; run combined checks; unlock successors. Begin sequentially, then admit independent parallel tasks once integration/recovery works. The planner must not treat all tasks as independent or chain everything by file order. [L7] [W3] [W4] (read/inspected 2026-10-17; recommendation).

**Proposed recovery:** classify failed setup, network/provider failure, failed assertions, merge conflict, and insufficient product information differently. Retry transient operations; repair code for a failing assertion; rebase/retest a changed integration base; ask a narrow question only when missing information changes the requested result. Track whether attempts actually change the failing condition so a “keep going” loop cannot burn the entire budget repeating itself. See [11](11-autonomous-delivery-loop.md) for the proposed state transitions. [L1] [L3] (inspected 2026-10-17; design inference).

### Deliver working software the user can inspect

**Proposed Definition of Done:** agreed scenario checks pass on the integrated revision; the application starts with known sample data; the preview points to that revision; and the requested delivery target reports success. Keep separate labels for **Implemented**, **Verified**, **Integrated**, and **Delivered**. A changed task checkbox or fluent summary must not skip those distinctions. [L3] [L8] [W3] [W5] (read/inspected 2026-10-17; product recommendation).

Playwright's healer can return a skipped test when it believes functionality is broken. Therefore an automatically “healed” test file is not sufficient evidence that the product works. Preserve the intended scenario assertions; report skipped/unexercised required scenarios as unmet and route them back to implementation. Canvas already pins Playwright, so a new browser test dependency is unnecessary for this app. [W6] [L14] (read/inspected 2026-10-17; recommendation).

**Proposed experience:** default to the running preview plus a short outcome summary, visible checks, activity, and an exceptions inbox. Let the user say “make this field optional” against the preview; carry the exact screenshot/page/revision into a new scoped run, reproduce the issue, and update the result. 8090's documented feedback model links reports, themes, and work orders, but its triage automation explicitly stops short of creating work orders automatically. Our proposed loop should continue through an authorized repair rather than ending at triage. [W7] (read 2026-10-17; proposed behavior contrasted with documented boundary).

**Proposed background behavior:** closing a window should not cancel a run; an explicit Quit/Stop should state what happens. Current Electron shutdown cleans up its services, and a sleeping/offline laptop cannot execute local work. Choose a deliberate tray/background-worker mode first and offer a remote runner later for “continue while my laptop is off.” Persisting state and executing while the host is off are different capabilities. [L15] [W8] (read/inspected 2026-10-17; product recommendation/physical execution constraint).

## Smallest useful milestone and effort

Our estimate is **12–18 engineering days** for one existing, scriptable web project: readiness/settings; a persistent sequential run; three dependent work orders; independent checks/review and at least one automatic repair; integrated runnable preview; automatic progression; and basic restart reconciliation. Assumptions: use the existing Canvas/Agent Server and available credentials, avoid rebuilding chat/testing/hosting, and qualify one agent path. This is an engineering guess, not a demonstrated schedule or an autonomous-success guarantee. [L1] [L2] [L4] [L5] (inspected 2026-10-17; estimate).

The milestone is complete when a user can request one bounded feature and leave: the factory finishes its three work orders, catches and repairs a deliberately introduced failure, restarts without duplicate implementation, opens a working preview, and reports the exact result **without the user starting or approving each work order**. Add deployment integration, parallel scheduling, and feedback-triggered repairs incrementally after that loop works. This is our proposed acceptance demonstration, not a test run performed in this research.

## Open questions

- **Unconfirmed:** End-to-end success, cost, and reliability of the exact pinned agent/ACP setup. These need a real representative run during implementation, not competitor marketing evidence. [L2] [W2] (inspected/read 2026-10-17).
- **Project-specific:** Which app/repository is the first factory output, and which install/start/check scripts and sample data already work? Start with the existing demo or another scriptable app; do not require a general-purpose builder before testing the loop. [L1] (inspected 2026-10-17; recommendation).
- **Deployment choice:** The report assumes autonomous delivery to a project-configured destination. Exact host, credentials, rollback support, and production-release policy remain unspecified; the proposed design should support them without forcing every project into one hosting vendor.
- **Visibility:** Which artifacts let this user quickly judge the result: a preview, screenshot, demo recording, API example, or test report? Support an application-specific outcome view, with transcripts available as detail. [W5] (read 2026-10-17; design question).

## Sources and dates

All sources were **read/inspected 2026-10-17**. Local files are undated current snapshots; living vendor docs are undated unless specified. Their publication age is unconfirmed. No source older than 12 months is used here as current product-version evidence. Recommendations and effort figures are our inferences.

- [L1] Factory routes, service startup, and file watchers.
- [L2] Factory one-conversation launch modal.
- [L3] Agent briefs and manual handoff instructions.
- [L4] Canvas child-conversation launch service.
- [L5] Canvas automation API.
- [L6] Requirements page.
- [L7] Task planner.
- [L8] Backlog parsing, status changes and watch behavior.
- [L9] Work-order action UI.
- [L10] Factory live refresh hooks.
- [L11] Factory folder documentation/routes.
- [L12] Conversation metrics/resume request types.
- [L13] Goal mutation helpers.
- [L14] Canvas package metadata; Playwright 1.63.0, MIT Canvas declaration.
- [L15] Electron startup/shutdown source.
- [W1] Factory Missions overview — undated current vendor docs; vendor-documented behavior, not independent testing.
- [W2] OpenHands Conversation Goals — undated current docs; exact pinned/ACP behavior untested here.
- [W3] GitHub auto-merge — undated current docs.
- [W4] GitHub merge queues — undated current docs; plan/organization eligibility applies.
- [W5] Playwright trace viewer — undated current docs.
- [W6] Playwright test agents — undated current docs; skip behavior explicitly documented.
- [W7] 8090 feedback — undated current docs; documented automation boundary.
- [W8] OpenHands Remote Agent Server — undated current docs; deployment requires a live runner.
- [W9] Playwright license — undated Apache-2.0 license file; supports compatible reuse, not the licensing of every browser or operating environment.

[L1]: ../../apps/server/src/index.ts
[L2]: ../../canvas/src/factory/components/start-agent-modal.tsx
[L3]: ../../apps/server/src/briefs.ts
[L4]: ../../canvas/src/services/child-conversation-launch.ts
[L5]: ../../canvas/src/api/automation-service/automation-service.api.ts
[L6]: ../../canvas/src/factory/routes/requirements.tsx
[L7]: ../../apps/server/src/planner.ts
[L8]: ../../apps/server/src/backlog.ts
[L9]: ../../canvas/src/factory/routes/work-orders.tsx
[L10]: ../../canvas/src/factory/hooks.ts
[L11]: ../../canvas/src/factory/README.md
[L12]: ../../canvas/src/api/conversation-service/agent-server-conversation-service.types.ts
[L13]: ../../canvas/src/hooks/mutation/conversation-mutation-utils.ts
[L14]: ../../canvas/package.json
[L15]: ../../canvas/electron/main.mjs
[W1]: https://docs.factory.com/missions/overview
[W2]: https://docs.openhands.dev/sdk/guides/agent-server/conversation-goals
[W3]: https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/automatically-merging-a-pull-request
[W4]: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue
[W5]: https://playwright.dev/docs/trace-viewer-intro
[W6]: https://playwright.dev/docs/test-agents
[W7]: https://docs.8090.ai/modules/feedback
[W8]: https://docs.openhands.dev/sdk/guides/agent-server/overview
[W9]: https://raw.githubusercontent.com/microsoft/playwright/main/LICENSE
