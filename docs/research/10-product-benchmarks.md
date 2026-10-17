Recommendation: make one user request drive planning, execution, testing, repair and delivery, with people interrupted only for decisions or genuine blockers.
Benchmark: Factory documents resumable Missions and Devin documents replayable multi-agent workflows; both are stronger autonomy references than a planning-only handoff ([F1], [F3], [D2]; read 2026-10-17).
Evidence limit: this is public-document research, not hands-on validation; no reviewed source proves guaranteed, unattended delivery for arbitrary projects.

## Findings

### How to read the comparison

**Documented** means an official guide describes a concrete user workflow. **Vendor claim** means a vendor announcement or marketing statement, without independent validation here. **Unconfirmed** means the reviewed material does not establish the behavior; it does not mean the feature is absent. No product was installed or exercised. All linked material was read **2026-10-17**; publication dates and retrieval limits appear below.

| Product | Intake → plan | Execution and repair | Human handoff and visibility |
| --- | --- | --- | --- |
| **8090** | Requirements → blueprints → phased work orders | External coding agent reads/updates work through MCP; document/feedback automations | Developer asks agent for next work order; board/table/roadmap and linked PRs; automatic merge/deploy unconfirmed. **Documented.** ([A1], [A2], [A3]; read 2026-10-17.) |
| **Opsera Forge** | Intent → requirements → architecture → user stories/work orders | Approved context goes to coding assistants through MCP; Jira sync | Interactive architecture and explicit stage approvals; unattended test/repair/deploy loop unconfirmed. **Vendor-described.** ([O1], [O2]; read 2026-10-17.) |
| **Factory** | Collaborative feature/milestone plan → Mission | Orchestrator manages workers and milestone validators; can add fix features | Plan approval, then inspect/steer/pause/resume; remote execution and headless Missions documented. ([F1], [F2], [F3], [F4]; read 2026-10-17.) |
| **Devin** | Prompt/ticket/spec → investigation and session or workflow | Code/test/browser tools; staged or looping multi-agent workflows; event-driven CI repair | PR delivery; live shell/IDE/browser and test recordings; ordinary delivery uses team review/merge/pipeline. **Documented.** ([D1], [D2], [D3], [D4], [D5]; read 2026-10-17.) |
| **Blitzy** | Existing-code ingestion/spec or new-product prompt → editable Agent Action Plan | Generation opens PR; validation evidence, targeted refinement and conflict repair | User reviews plan and Project Guide, then merges/refines/closes; intent-grouped review. **Documented.** ([B1], [B2], [B3]; read 2026-10-17.) |

### 8090: coherent planning and feedback, with an execution handoff

The quickstart explicitly asks users to review work orders, assign them and ask their connected coding agent for the next one. MCP carries linked requirements/blueprints and status updates, rather than requiring copy/paste. Work orders expose dependencies, child work, linked PRs and chronological activity. However, blueprint edits **do not automatically update their work orders**; the guide tells users to request another review/extraction. **Documented:** useful context flow, but not proof of a self-running implementation scheduler. ([A1], [A2]; read 2026-10-17.)

Scheduled and event-triggered automations have run histories/transcripts. Feedback can be collected through an API, grouped into themes and linked to work; automated triage does **not** create missing work orders on its own. **Recommendation:** borrow linked context and feedback-to-work traceability, but remove the repeated “ask the coding agent for the next task” step from our normal execution path. ([A3], [A4]; read 2026-10-17.)

### Opsera Forge: richer intent/context, more manual checkpoints

Forge’s official material describes generated BRD/PRD artifacts, interactive architecture diagrams, sprint-ready work orders, MCP coding-assistant connections and Jira synchronization. Its documentation describes reviewing/approving each stage before the next. These are **vendor-described capabilities**, not independently demonstrated behavior here; direct retrieval of the docs page failed, although its official indexed content was readable. ([O1], [O2]; read 2026-10-17.)

**Recommendation:** borrow a compact, versioned description of intent, constraints and architecture; reuse it in every work order. Avoid copying an approval at every document transition into a product whose objective is minimal intervention. Exact native coding-agent scheduling, background restart semantics, test repair, live app previews and merge/deploy automation remain **unconfirmed** from the reviewed sources. ([O1], [O2]; read 2026-10-17.)

### Factory: the clearest documented mission-control pattern

Missions turn a goal into features/milestones and then delegate execution after plan approval. Validators run at milestone boundaries; validation can lead the orchestrator to create additional fix features. The docs emphasize scriptable application startup and user-flow testing as prerequisites for reliable self-correction. They also explicitly warn that Missions are **not fire-and-forget** and describe pausing/replanning stalled work. ([F1], [F2]; read 2026-10-17.)

The app lets users resume past Missions, inspect feature criteria/commits and worker output, see elapsed time/credits, and change orchestrator/worker/validator models. Remote Droid Computers support background Missions; these computers retain files, installed packages and running services across sessions. Headless `droid exec --mission` is separately documented. This is the best **interaction-pattern reference**, not evidence that a particular job survives every crash or provider failure. ([F3], [F4], [F5]; read 2026-10-17.)

### Devin: durable execution plus proof a user can inspect

Devin documents live shell, IDE and browser access, including taking over an agent’s work. Dynamic Workflows use a generated deterministic Python script to coordinate agents and structured results; recorded completed calls replay on resumption while unfinished work runs again. This is a more specific durability contract than “the chat is saved.” ([D1], [D2]; read 2026-10-17.)

Automations can start a session or message an existing one from repository/ticket events, schedules and webhooks. Testing mode produces annotated browser recordings; **Pre-approve testing** removes its normal button click. Normal repository delivery still ends in a PR reviewed, merged and shipped through the team’s pipeline; built-in hosted deployment is a narrower standalone-app feature requiring explicit approval. **Recommendation:** borrow automatic repair triggers, replayable stages and short proof-of-work videos; do not confuse a preview deployment with completed integration into the real application. ([D3], [D4], [D5]; read 2026-10-17.)

### Blitzy: batch generation with review organized around intent

The documented flow is environment/context setup → specification → generation prompt → approve/refine/edit/discard the Agent Action Plan → generation/PR → Project Guide → review and merge/refine/close. This is **not** a documented zero-human workflow. PR Review groups changes by purpose, surfaces reasoning and runtime/test evidence, distinguishes key changes from all files, and supports targeted refinement and a merge-conflict repair action. ([B1], [B2], [B3]; read 2026-10-17.)

Blitzy **claims** managed long-running multi-agent inference and provider fallback routing. Its own published case study also describes human UI fixes, backend/integration work and a later refinement run, illustrating why generation completion is not the same as shipping. Exact cancellation/restart guarantees should be verified in the product; public marketing/FAQ statements are insufficient for a durable-job contract. ([B4], [B5]; read 2026-10-17.)

### Routing and the last mile

Factory documents separate role-model settings and a selectable Router that chooses models per task and supports provider failover. Blitzy describes routing as vendor-managed. 8090 and Forge connect developers’ chosen coding assistants; the reviewed guides do not establish automatic cross-agent failover. A general customer-selectable provider/model-routing policy for Devin is **unconfirmed**. Do not infer routing quality or cost savings from the existence of a selector. ([F3], [F4], [F6], [B4], [A1], [O2]; read 2026-10-17.)

**Synthesis / inference:** the opportunity is to remove coordination work between these stages: choose ready work, dispatch it, capture real test outcomes, ask a separate reviewer to inspect it, repair failures, integrate it, and turn feedback into the next bounded change. Planning artifacts and agent chat alone do not implement that loop. ([A1], [A2], [F1], [F2], [D2], [B1]; read 2026-10-17.)

## Recommendations: borrow the workflow, reuse the existing pieces

1. **One “Run factory” entry point.** Accept a goal, repository, desired outcome and run limits. Generate the plan/work-order graph automatically. Let the user choose an autonomous preset once; stop for unresolved product choices, exhausted limits or genuinely blocked work, not each routine transition. Borrow Factory’s mission model. ([F1]–[F4]; read 2026-10-17.)
2. **Make checks drive the loop.** Execute ready work → run repository checks and user journeys → review → bounded repair → integration. Retry only with a diagnosis; stop and explain lack of progress. Surface the failing command/result and the next attempted fix. Borrow Factory milestone validation and Devin’s staged/replayable workflows. ([F2], [D2]; read 2026-10-17.)
3. **One product view, several depths.** Show goal, current milestone, next action, blockers, elapsed time/budget and last successful checkpoint. Put a working preview, screenshots/video, changed behavior and test results ahead of transcripts; keep logs/diffs one click away. Borrow Devin’s recordings and Blitzy’s intent-grouped review. ([F3], [D4], [B3]; read 2026-10-17.)
4. **Own the handoffs, reuse the engines.** Our current architecture already provides OpenSpec artifacts, Backlog work orders and Canvas agent conversations. Extend their orchestration instead of rebuilding an IDE, agent terminal, planner document format or issue tracker. Use the repository’s actual build/test/deploy commands; make merge/deploy policy part of initial run configuration. ([R1]; read 2026-10-17.)
5. **Make feedback another input.** Convert a failed check, review finding or user report into linked repair work; deduplicate against active tasks and rerun only affected stages. Start with existing work-order files and a small feedback capture flow, rather than building a full theme/roadmap suite first. ([A4], [D3], [R1]; read 2026-10-17.)

These are product recommendations, not implemented features or effort commitments. Borrow interaction patterns; this report does not recommend copying proprietary implementations or adding dependencies.

## Open questions

- **Unconfirmed:** Which products actually resume after host/process/network failure without duplicate side effects? Test interruption and resumption on the same repository rather than accepting “persistent” as sufficient.
- **Unconfirmed:** How many human touches remain between one goal and an integrated, previewable change? Benchmark a normal change, failing-test repair and changing requirement; count prompts, switches, approvals and manual corrections.
- **Unconfirmed:** Can routing change mid-task without losing the workspace, validation contract or cost limit? Is provider failover distinct from retrying the same broken plan?
- **Unconfirmed:** Which merge/deploy/feedback steps can run automatically under an initial policy, and which are still external manual actions? None of the reviewed documentation establishes universal unattended delivery.

## Source registry

All sources are primary vendor documentation or explicitly labeled vendor publications. Undated pages have **unknown publication age**; crawl dates do not establish freshness. None of the dated publications used below is >12 months old; any undated page could contain older material.

| ID | Source | Published/updated | Read |
| --- | --- | --- | --- |
| A1 | [8090 Quickstart](https://docs.8090.ai/general/quickstart) | Undated | 2026-10-17 |
| A2 | [8090 Work Orders](https://docs.8090.ai/modules/work-orders) | Undated | 2026-10-17 |
| A3 | [8090 Automations](https://docs.8090.ai/modules/automations) | Undated | 2026-10-17 |
| A4 | [8090 Feedback](https://docs.8090.ai/modules/feedback) | Undated | 2026-10-17 |
| O1 | [Forge documentation](https://forge.opsera.ai/docs) | Undated; official indexed page read, direct page retrieval failed | 2026-10-17 |
| O2 | [Why We Built Forge](https://opsera.ai/blog/why-we-built-forge-the-software-factory-the-ai-era-actually-needs) | 2026-04-23; vendor launch publication | 2026-10-17 |
| F1 | [Factory Missions overview](https://docs.factory.com/missions/overview) | Undated | 2026-10-17 |
| F2 | [Mission planning and validation](https://docs.factory.com/missions/planning) | Undated | 2026-10-17 |
| F3 | [Missions in the app](https://docs.factory.com/missions/running-app) | Undated | 2026-10-17 |
| F4 | [Mission configuration and headless execution](https://docs.factory.com/missions/reference) | Undated | 2026-10-17 |
| F5 | [Droid Computers](https://docs.factory.com/droid-computers/overview) | Undated | 2026-10-17 |
| F6 | [Factory Router](https://docs.factory.com/model-independence/factory-router) | Undated; routing description, performance claims not adopted | 2026-10-17 |
| D1 | [Introducing Devin](https://docs.devin.ai/get-started/devin-intro) | Undated | 2026-10-17 |
| D2 | [Devin Dynamic Workflows](https://docs.devin.ai/work-with-devin/dynamic-workflows) | Undated | 2026-10-17 |
| D3 | [Devin Automations](https://docs.devin.ai/product-guides/automations) | Undated | 2026-10-17 |
| D4 | [Testing and recordings](https://docs.devin.ai/work-with-devin/testing-and-recordings) | Undated | 2026-10-17 |
| D5 | [Devin deployment scope](https://docs.devin.ai/product-guides/deployment-capabilities) | Undated | 2026-10-17 |
| B1 | [Blitzy Quickstart](https://docs.blitzy.com/quickstart) | Undated | 2026-10-17 |
| B2 | [Agent Action Plan review](https://docs.blitzy.com/project-lifecycle/aap-review) | Undated | 2026-10-17 |
| B3 | [Blitzy PR Review](https://docs.blitzy.com/project-lifecycle/pr-review) | Undated; corroborating [launch announcement](https://blitzy.com/blog/blitzy-announces-pr-review-helping-teams-understand-and-merge-ai-generated-code-faster) dated 2026-09-28 | 2026-10-17 |
| B4 | [Managed orchestration and fallback claims](https://blitzy.com/blog/beyond-the-volatility-tax) | Opened page: 2026-10-08; search snippet showed 2026-10-01, so prefer page date | 2026-10-17 |
| B5 | [Blitzy’s Chrome-extension case study](https://blitzy.com/blog/from-comment-to-chrome-extension) | 2026-04-01; vendor-reported example | 2026-10-17 |
| R1 | [Our current architecture](../ARCHITECTURE.md) | Undated local snapshot | 2026-10-17 |

[A1]: https://docs.8090.ai/general/quickstart
[A2]: https://docs.8090.ai/modules/work-orders
[A3]: https://docs.8090.ai/modules/automations
[A4]: https://docs.8090.ai/modules/feedback
[O1]: https://forge.opsera.ai/docs
[O2]: https://opsera.ai/blog/why-we-built-forge-the-software-factory-the-ai-era-actually-needs
[F1]: https://docs.factory.com/missions/overview
[F2]: https://docs.factory.com/missions/planning
[F3]: https://docs.factory.com/missions/running-app
[F4]: https://docs.factory.com/missions/reference
[F5]: https://docs.factory.com/droid-computers/overview
[F6]: https://docs.factory.com/model-independence/factory-router
[D1]: https://docs.devin.ai/get-started/devin-intro
[D2]: https://docs.devin.ai/work-with-devin/dynamic-workflows
[D3]: https://docs.devin.ai/product-guides/automations
[D4]: https://docs.devin.ai/work-with-devin/testing-and-recordings
[D5]: https://docs.devin.ai/product-guides/deployment-capabilities
[B1]: https://docs.blitzy.com/quickstart
[B2]: https://docs.blitzy.com/project-lifecycle/aap-review
[B3]: https://docs.blitzy.com/project-lifecycle/pr-review
[B4]: https://blitzy.com/blog/beyond-the-volatility-tax
[B5]: https://blitzy.com/blog/from-comment-to-chrome-extension
[R1]: ../ARCHITECTURE.md
