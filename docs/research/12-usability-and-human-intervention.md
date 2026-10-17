We recommend one outcome-to-preview journey: connect once, describe the result, and let the factory plan, build, test and iterate.
We recommend autonomous execution by default, with a small exception inbox for decisions the factory cannot resolve itself.
We recommend measuring usable outcomes and human interruptions, rather than agent activity or completed work-order counts.

# 12 — Usability and minimal human intervention

## Findings — sources say

Sources document capabilities, not measured completion rates; live products were not tested. All read **2026-10-17**; source dates appear below.

| Product | Verified interaction patterns |
| --- | --- |
| Devin | Current first-session guidance separates Ask for investigation/planning from Agent for execution. Testing can run the application, exercise it in a browser and return a recording; a saved **Pre-approve testing** preference removes another testing approval click. Session tools expose browser/IDE access, command history and read-only side chats that leave the main task running. [D1], [D2], [D3] (undated; read 2026-10-17). |
| Devin's earlier planner | March 25, 2025 release notes describe an Interactive Planner with initial findings and an optional wait-for-approval choice. This is **>12 months old**. Its old documentation URL now redirects to the tutorial library; do not assume the historical interaction is today's default. [D4], [D5] (read 2026-10-17). |
| Factory | Mission Control exposes milestones, validation criteria, commits, worker progress, time/credits and pause/replan/resume. Interaction mode and autonomy level are separate controls. Its CLI guidance still describes a user monitoring, unblocking and redirecting missions; it does not establish unattended success. [F1], [F2], [F3] (undated; read 2026-10-17). |
| 8090 | Work orders carry acceptance criteria, dependencies, development links and activity. Feedback connects reports/themes to work orders. Its triage automation processes reports, explains unfinished triage in run history, and does **not** automatically create work orders. This is a useful loop with a documented handoff remaining. [E1], [E2] (undated; read 2026-10-17). |
| OpenHands Canvas | Conversations expose live activity and artifact previews; the Automate view provides configuration, run history/status and lifecycle controls. These offer reusable inspection surfaces, but these pages do not establish an integrated outcome-to-usable-preview journey. [O1], [O2] (undated; read 2026-10-17). |

Microsoft's human-AI guidance recommends setting capability expectations, supporting correction, explaining actions, remembering interactions and providing global controls. It dates to **March 5, 2019 (>12 months old)**. W3C's status-message guidance describes announcing relevant updates without moving keyboard focus; that living page's update date is unconfirmed. [U1], [U2] (read 2026-10-17).

Our inference: combine these patterns around a clear outcome, visible progress and a working result. Expose inspection when useful; make execution and recovery the factory's responsibility. Vendor documentation alone does not prove fewer interruptions or better software.

## Recommendations — proposed product behavior

### One continuous journey

1. **Connect project once.** Offer **Open folder** or **Connect repository**. Detect the stack, run/test commands and existing conventions. Show a compact readiness result: “Project connected · app starts · checks available.” Fix routine setup automatically within the chosen project settings; collect missing credentials in one setup step. Save the environment and preferences. Put model/agent selection in project settings with a sensible default.
2. **Describe the outcome.** Home asks, **“What should this project do next?”** Accept text, an issue or an image. Show three editable fields inferred from the request: outcome, constraints and how to know it works. The primary button is **Build it**, not “Generate work orders.” Optional **Plan with me** supports users who want discussion.
3. **Plan and resolve details.** Build it starts investigation and execution under saved project preferences. Infer routine implementation choices from the codebase. Record reversible assumptions in a collapsed **Decisions made** list. Generate scenarios, dependencies and a work queue automatically. Display the plan as it develops; do not require another approval for each plan, worker, test or work order in the authorized outcome.
4. **Run the queue.** One outcome page owns all workers and dependencies. Show **Building → Checking → Preparing preview**, with completed scenarios, current work, elapsed time and budget usage. Keep scheduling ready tasks, fixing failed checks and integrating results. A failed worker should first trigger diagnosis/recovery, not a request that the user paste instructions into another chat. Continue independent tasks while one branch is blocked.
5. **Return something usable.** The primary result is **Open preview**, alongside “What changed,” scenarios exercised, remaining limitations and a short demonstration when useful. For a service/CLI, supply a runnable example and inspectable output instead. Keep code diffs and logs one level deeper. A finished agent process is not the product's completion condition: show **Ready to try**, **Needs your decision**, or **Incomplete** according to the actual result.
6. **Continue from feedback.** Keep an outcome-level composer beside the preview: **“What should change?”** Preserve screenshots, selected elements, prior decisions and test results as context. Turn “make this easier to scan” into scoped follow-up work, check it, refresh the preview and summarize the difference. Route duplicates to existing work. Do not ask the user to translate feedback into requirements, blueprints and tickets before proceeding.

### The exception inbox, not a stream of approval dialogs

An exception earns an interruption only when it changes a user-owned product decision, requires missing access, exceeds the saved scope/budget/destination, or remains blocked after a bounded recovery attempt. Routine code choices, test execution, ordinary fixes and retrying a transient failure stay with the factory.

Each card should show **the blocked outcome, what was tried, the decision needed, recommended option and consequences**. Example proposed copy: “CSV export can finish now; live accounting sync needs an account connection. **Continue with CSV** / **Connect accounting**.” Include **Defer this part**. Group decisions that can be answered together, and expose a safe batch action with an editable summary. Show “Other work continues” when true. Notify on required action, usable result or terminal failure; keep normal progress in the app.

Make choices persistent at the right scope: **This run** or **Remember for this project**. Never re-ask a saved, applicable decision because a different worker reached the same step. If project settings must change, show the specific change and its effect together.

### Intervention levels and recovery controls

These are proposed delegation levels, not competitors' permission labels:

| Level | Human involvement |
| --- | --- |
| Guided, optional | Discuss plan and chosen milestones before execution. |
| **Outcome autonomy, default** | Describe a result once; factory runs its queue through tests and preview. Human handles genuine exceptions and gives product feedback. |
| Continuous, later | Factory selects from an authorized backlog and processes eligible feedback within saved priorities, budget and delivery settings. Human handles exceptions and periodic direction. |

Save delivery preferences once, including whether the factory may integrate changes or deploy to designated environments. Apply existing authorization to routine work instead of prompting again at every handoff.

Keep **Pause**, **Stop**, **Resume**, **Retry failed step** and **Change direction** visible. Pause should stop scheduling and preserve a checkpoint; report any action still finishing. Stop should cancel work and say what remains. Resume restores context without a new brief. Retry preserves completed work. Change direction shows affected work and updates the queue. A read-only **Ask about progress** panel should answer without pausing execution. Explanations should show evidence and decisions, not a wall of agent narration; status changes should remain accessible without stealing focus.

### Product priorities and observable success

Prioritize **P0: outcome page, autonomous queue, preview and recovery**; **P1: exception batching and remembered decisions**; **P2: feedback automation and continuous backlog execution**. Planning guesses: **2–3 days for an interactive prototype**, **3–5 days for usability sessions/iteration**; implementation requires an engine-capability assessment.

Proposed pilot checks, not published industry benchmarks:

- A returning user starts a normal outcome in one request, without repeating project setup.
- For a prepared, routine feature: **zero mid-run approvals** and **zero user-issued continue/retry prompts** before a usable result.
- A user who closes the UI can reopen it, understand status in 30 seconds and resume without restating the task; actual work continues only where the configured backend supports it.
- Every ready result has a reachable preview/runnable example and recorded scenario results. Failures remain visible.
- Measure median/p90 human interventions and active minutes per accepted outcome, time to usable preview, autonomous recovery rate, and post-preview rework. Count duplicated questions and manual task handoffs as failures, even if code eventually ships.

## Open questions

- Is the first target a developer delegating an existing repo change, or a product owner asking for a new application?
- Which preview, checkpoint, queue and recovery capabilities already work reliably enough to hide behind this journey?
- Which project-wide delivery settings should be offered during setup, and which should be inferred?
- What representative outcomes will test whether intervention falls without lowering accepted-result quality?

## Sources and currency

All read **2026-10-17**. Undated vendor documentation is current reachable evidence, with exact revision dates and live availability **unconfirmed**.

- [D1] Devin first session; [D2] testing/recordings; [D3] session tools — undated.
- [D4] Devin 2025 release notes — cited entry 2025-03-25, **>12 months old**; historical behavior.
- [D5] Former interactive-planning URL — now redirects to undated tutorial library.
- [F1] Factory app missions; [F2] interaction modes; [F3] CLI missions — undated.
- [E1] 8090 work orders; [E2] feedback — undated.
- [O1] Canvas conversations; [O2] automations — undated; upstream capability is not verification of this pinned fork.
- [U1] Microsoft Research human-AI guidelines — 2019-03-05, **>12 months old**; foundational guidance, not a current product specification.
- [U2] W3C WCAG 2.2 status-message explanation — undated living page; exact update date unconfirmed.

[D1]: https://docs.devin.ai/get-started/first-run
[D2]: https://docs.devin.ai/work-with-devin/testing-and-recordings
[D3]: https://docs.devin.ai/work-with-devin/devin-session-tools
[D4]: https://docs.devin.ai/release-notes/2025
[D5]: https://docs.devin.ai/work-with-devin/interactive-planning
[F1]: https://docs.factory.com/missions/running-app
[F2]: https://docs.factory.com/autonomy-and-safety/specification-mode
[F3]: https://docs.factory.com/missions/running-cli
[E1]: https://docs.8090.ai/modules/work-orders
[E2]: https://docs.8090.ai/modules/feedback
[O1]: https://docs.openhands.dev/openhands/usage/agent-canvas/conversations
[O2]: https://docs.openhands.dev/openhands/usage/agent-canvas/managing-automations
[U1]: https://www.microsoft.com/en-us/research/articles/guidelines-for-human-ai-interaction-eighteen-best-practices-for-human-centered-ai-design/
[U2]: https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html
