Sources say the extension REST router exists upstream, and the app-backend bridge PR merged on 2026-09-30; the local spec's future-tense notes are partly stale. [U1] [U2] [L1] (read/inspected 2026-10-17).
Our three pages fit the routed-page contract, but their React/Canvas dependencies, conversation launch flow, and separate factory API still require integration work. [L2] [L3] (inspected 2026-10-17; assessment).
We recommend a bounded extension proof after the safety work, retaining the patch until a released backend passes the real install/enable/use/disable flow. [U3] [L1] (read/inspected 2026-10-17; recommendation).

# 08 — Getting off the Canvas patch

## Findings — sources say

### What is present, what is shipped, and what remains unverified

| Evidence level | Observed result | Meaning |
| --- | --- | --- |
| Local factory snapshot | `canvas.lock.json` names Canvas 1.27.1 at `045290739f0af2ae4cc89d2a209c6bd930bb81ee`; local Canvas HEAD is a factory commit, `e86a0c9d2a454fcaa7b353ecae37377a2a71eb28`, dated 2026-10-17. Local defaults and package pin Agent Server/client **1.55.1**, minimum server 1.51.0. [L4] [L5] | A UI version alone does not identify backend capabilities. These are local observations, not a clean upstream release checkout. |
| Public implementation | Upstream `canvas_extensions_router.py` implements install/list/get/enable/disable/uninstall/bundle operations, returns a validated optional `manifest`, and contains optional backend lifecycle routes. [U1] | The backend API is no longer merely an unimplemented proposal on upstream `main`. |
| Release-level evidence | SDK **v1.55.1** was released 2026-10-16. Its tagged `api.py` imports the extension and bridge routers. Bridge PR **#5272** merged 2026-09-30. [U2] [U3] [U4] | Released-source evidence exists for wiring; this research did not start a server or assert every extension path works in the installed runtime. |
| Local frontend | It imports the typed `CanvasExtensionsClient`, handles unsupported backends, registers extension pages, and feature-detects `canvas_app_backend_bridge_v1`, ingress URL, and client methods. Cloud backends are explicitly rejected by this service. [L2] [L11] [L12] | There is a real frontend integration surface, with deployment restrictions. |
| Local spec | It still says the manifest is not returned and some tests intercept the API until backend delivery; elsewhere it says the bridge client is released. [L1] | Read the spec as an evolving contract and plan, not a reliable shipped-status ledger. |

All table evidence was **read/inspected 2026-10-17**. The tagged router file itself could not be fetched through the research browser; the tagged API imports, current router, release, and merge record support the narrower conclusion above. A live installed-backend compatibility test remains **unconfirmed**, intentionally outside this docs-only task. [U1] [U2] [U3] [U4] (read 2026-10-17).

### Could Requirements, Work orders, and Audit log become an extension?

**Yes in principle, not a drop-in relocation.** The local v1 manifest declares multiple routed pages; the host mounts them under `/extensions/{extension-name}/...`, calls `activate(host)`, and accepts `registerPage(id, mount)` contributions. A factory extension can declare three pages. It must supply one self-contained browser ESM entrypoint with embedded/bundled dependencies and cleanup; the host does not promise a general React component import API. [L1] [L2] (inspected 2026-10-17; first and third sentences are assessment).

The current factory pages import Canvas aliases/components, React Router, React Query hooks, and conversation-start helpers. Their API client hardcodes `/sf-api`, presently supplied by Vite's development proxy. Moving files alone will not provide those host imports, route assumptions, or an HTTP bridge to the Node API. [L3] [L6] (inspected 2026-10-17; migration implication is inference).

| Integration | What the evidence supports | Proposed approach — inference |
| --- | --- | --- |
| Three page surfaces/navigation | Declared page contributions and host navigation are part of the local host contract. [L2] | Bundle factory UI dependencies and mount/dispose a React root per page; use host navigation where applicable. |
| Factory API | `host.agentServer.request` targets the owning **Agent Server**, not an arbitrary local Node port. The separate optional `appBackendView` exposes an app-owned HTTP UI through a discovered bridge. [L1] [L2] | Evaluate whether a managed app backend can own the Node process and serve the UI/API. Otherwise retain a narrow approved ingress integration; do not invent arbitrary proxy behavior. |
| Start-agent action | Current pages call Canvas conversation helpers; the minimal page host contract does not expose those helpers. [L2] [L3] | Prove an existing supported Agent Server request plus navigation can reproduce profile/workspace/brief handling, or propose a small upstream host capability. Do not depend on private stores. |
| Authentication and isolation | Local extension modules are trusted same-realm code; enablement is product consent, not proof that an agent cannot call the same API. The backend-view bridge is a separate mechanism. [L1] | Permit only reviewed, revision-pinned factory extensions. Keep human approval credentials out of agent-reachable trust. |

Table sources **inspected 2026-10-17**. These are design options to test, not implementation claims. Packaging the Node service, workspace paths, Backlog/OpenSpec CLIs, SSE, and Windows child-process cleanup remains part of the desktop work in [01](01-desktop-packaging.md). [L5] [L6] (inspected 2026-10-17; assessment).

The public extension epic, opened **2026-08-04**, tracks backend, CLI, defense-in-depth, themes, and conversation surfaces. Its checkbox progress is not an accurate substitute for examining merged code. No contractual date for completing the larger roadmap was established. [U5] [U2] (read 2026-10-17; assessment).

### Release cadence and Windows: correct the brief's premise

Canvas release history shows **1.25.0 on 2026-10-06, 1.26.0 on 2026-10-08, and 1.27.0/1.27.1 on 2026-10-12**. That is several releases in one week, not a promised service-level cadence. SDK 1.55.1 followed on 2026-10-16. Treat Canvas, SDK/client, automation, and adapters as a compatibility set rather than upgrading them independently on agency laptops. [U3] [U6] (read 2026-10-17; recommendation in final sentence).

**Windows support signals now exist.** Local CI defines a Windows build leg with `full_checks: false`: it builds the app, while lint/unit/library checks are conditional on the Ubuntu full-check leg. A separate Windows desktop workflow builds NSIS installers on `windows-latest`; its comments explicitly say installers are unsigned. Thus the README's broad “doesn't test native Windows in CI” statement is stale as a description of build coverage, while full native agent-server/ACP end-to-end coverage remains unconfirmed. [L7] [L8] [L9] (inspected 2026-10-17).

Upstream's Windows quickstart documents PowerShell Docker use and says per-conversation multi-sandbox mode should run in WSL2 because the runtime uses POSIX user/group IDs. This is useful Windows documentation, not proof that native Python services, smart cards, endpoint protection, or agent CLIs work on a hardened federal image. [U7] (read 2026-10-17; final sentence is assessment).

Canvas's package declares **MIT**. That is compatible with the brief's adoption rule for this UI; it does not automatically classify every optional extension, agent, container component, or service license. [L10] (inspected 2026-10-17; final clause is recommendation to review separately).

## Recommendation — our judgment

Schedule a **2-day go/no-go proof**, after sandbox/model/identity decisions: one read-only Requirements page, real manifest discovery from the pinned released server, install disabled → human enable → route → authenticated request → disable/uninstall cleanup. Include a Windows run and backend switch. If that passes, estimate **3–5 more engineering days** for three-page bundling, launch-agent integration, factory API bridging, and focused regression checks; allow **2–4 additional days** if an upstream capability or Windows lifecycle correction is required. These are estimates for one engineer, excluding upstream review and agency approval. [L1] [L2] [L3] [U3] (read/inspected 2026-10-17; recommendation/estimate).

Keep the current small patch until the proof covers the actual deployment boundary. An extension installed on a Linux agent backend cannot casually read a factory API or audit file on the Windows host. Choose one owner/location for that service and evidence store, then prove paths and authentication in that topology. [L1] [L5] [L6] (inspected 2026-10-17; inference/recommendation).

## Open questions

- Does the **running** 1.55.1 server return manifests, advertise the bridge, and support the required Node backend artifact on Windows? Released wiring is confirmed; a live result is not. [U3] [U4] (read 2026-10-17).
- Is there a supported conversation-launch host capability, or must this use authenticated Agent Server calls? The reviewed minimal host interface does not establish a first-class helper. [L2] [L3] (inspected 2026-10-17).
- Where should factory state live when the selected Agent Server is a container or remote backend? The extension follows the active backend; the present Node API uses its configured workspace/data paths. [L1] [L6] (inspected 2026-10-17).
- Which Windows agent-server/ACP workflows are release-tested upstream? Installer/build workflows alone do not settle runtime coverage. Obtain the exact upstream test matrix before claiming native Windows support to an agency. [L7] [L8] [U7] (read/inspected 2026-10-17; recommendation).

## Sources and dates

All sources were **read/inspected 2026-10-17**. Local files are snapshot evidence with publication date unconfirmed. Undated `main` documentation has unconfirmed publication age; no source older than 12 months is used as current-release evidence here.

- [U1] Current upstream extension router: undated `main`; implementation, not independently tested deployment.
- [U2] SDK PR #5272: merged 2026-09-30.
- [U3] SDK v1.55.1: released 2026-10-16.
- [U4] SDK v1.55.1 tagged API source: release-date context 2026-10-16.
- [U5] Canvas Extensions tracking epic #16289: opened 2026-08-04; open checklist can lag implementation.
- [U6] Canvas releases: 2026-10-06 through 2026-10-12 entries cited.
- [U7] Windows quickstart: undated current upstream documentation.
- [L1] Local extension specification.
- [L2] Local host types, runtime, and extension service.
- [L3] Local factory Requirements route and hooks.
- [L4] Factory Canvas lock.
- [L5] Local runtime defaults.
- [L6] Local factory API client and architecture.
- [L7] Local general CI workflow.
- [L8] Local desktop Windows workflow.
- [L9] Factory README.
- [L10] Local Canvas package metadata/license declaration.
- [L11] Local extension API service and backend feature detection.
- [L12] Local extension runtime.

[U1]: https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/openhands-agent-server/openhands/agent_server/canvas_extensions_router.py
[U2]: https://github.com/OpenHands/software-agent-sdk/pull/5272
[U3]: https://github.com/OpenHands/software-agent-sdk/releases/tag/v1.55.1
[U4]: https://raw.githubusercontent.com/OpenHands/software-agent-sdk/v1.55.1/openhands-agent-server/openhands/agent_server/api.py
[U5]: https://github.com/OpenHands/OpenHands/issues/16289
[U6]: https://github.com/OpenHands/OpenHands/releases
[U7]: https://github.com/OpenHands/OpenHands/blob/main/README.windows.md
[L1]: ../../canvas/specs/canvas-extensions.md
[L2]: ../../canvas/src/types/canvas-extension.ts
[L3]: ../../canvas/src/factory/routes/requirements.tsx
[L4]: ../../canvas.lock.json
[L5]: ../../canvas/config/defaults.json
[L6]: ../../canvas/src/factory/api.ts
[L7]: ../../canvas/.github/workflows/ci.yml
[L8]: ../../canvas/.github/workflows/desktop-windows.yml
[L9]: ../../README.md
[L10]: ../../canvas/package.json
[L11]: ../../canvas/src/api/canvas-extensions-service.ts
[L12]: ../../canvas/src/components/features/canvas-extensions/canvas-extensions-runtime.tsx
