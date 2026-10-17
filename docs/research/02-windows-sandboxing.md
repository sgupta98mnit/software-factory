Recommendation: isolate the whole agent workload in an approved environment and treat approval prompts as a separate control.
Finding: upstream issue #5480 requests interactive ACP permission forwarding; the inspected SDK still selects the first permission option ([A1], [A2]; read 2026-10-17).
Recommendation: validate Podman compatibility and a restricted Codex-native profile before selecting the Windows pilot baseline; estimates and license exceptions follow.

## Findings

### Threat boundary and the actual local setup

**Local facts.** The factory’s development launcher runs Canvas directly on the host. Installed OpenHands SDK **1.55.1**, identified by its package metadata, defaults Claude’s ACP provider to `bypassPermissions` and Codex’s to `agent-full-access`. Its bridge answers `request_permission` with the **first supplied option**, even if that option is not an allow option. “Auto-approve” describes intent, not a reliable by-kind selection algorithm. Current upstream source retains this behavior. A worktree or workspace path does not itself restrict what those processes can read, execute or contact. ([L1], [L2], [L3], [A2]; read 2026-10-17.)

**Recommendation / inference.** Evaluate containment against four independent requirements: which host files and secrets the workload can read, where it can write, which network/control-plane services it can reach, and who can approve an escalation. Keep the factory approval authority and audit storage outside the agent’s writable mounts. A UI permission button alone cannot supply an OS boundary, and an OS boundary alone cannot prove a human approved a work order. The separation follows directly from the host execution and permission paths above. ([L1]–[L3], [A2]; read 2026-10-17.)

### Windows environment comparison

The first two columns report source-backed behavior. The last column is a **recommendation/inference for this project**, not a certification of the product.

| Option | What sources establish | Fit and limitation |
| --- | --- | --- |
| Docker Desktop | Proprietary subscription terms apply. Windows supports a per-user WSL2 installation mode that can install/update without administrator privileges; required Windows/WSL capabilities remain prerequisites. ([D1], [D2], [D3]; read 2026-10-17.) | Fastest existing OpenHands example when already approved and licensed. Treat as an external prerequisite, not an open-source component to redistribute. |
| Podman / Podman Desktop | Both projects have Apache-2.0 top-level licenses; Windows Podman uses a Linux machine, documented as a WSL2 distribution. ([P1], [P2], [P3]; read 2026-10-17.) | Preferred permissive engine candidate. Windows path mapping, API/CLI compatibility, networking and OpenHands lifecycle remain **unconfirmed** until tested; do not promise a drop-in replacement. |
| WSL2 alone | Windows drives automount by default; Windows process interop is enabled by default. Linux accesses Windows files using the launching Windows user’s permissions. ([W1], [W2]; read 2026-10-17.) | Useful Linux compatibility layer, insufficient project isolation by itself. Disabling automount/interop reduces exposure but is not a demonstrated immutable sandbox policy. |
| Windows Sandbox | Disposable Windows environment with hypervisor kernel isolation, included in supported Pro/Enterprise/Education editions. Configuration controls networking, mapped folders and clipboard; networking and clipboard are enabled by default. Writable mappings persist changes to host files. ([W3], [W4]; read 2026-10-17.) | Good installer/untrusted-code smoke-test environment. Persistent agent sessions, credentials and per-work-order orchestration would need extra engineering; prefer a durable approved VM for that use. |
| Dev containers | The MIT Dev Container CLI creates/configures containers from `devcontainer.json` and runs commands inside them; the specification includes users, mounts and lifecycle commands. ([V1], [V2], [V3]; read 2026-10-17.) | Reproducible environment description layered on an engine, not a replacement security boundary. Review repository configuration before executing lifecycle commands or allowing extra mounts/capabilities. |

**Docker licensing: contractor is not automatically “small business.”** Docker’s documentation gives the commercial free-tier test as **fewer than 250 employees AND less than US$10 million annual revenue**, while Government Entities require a paid subscription. The actual SSA, updated **2026-08-26**, defines Government Entity broadly, including entities whose **principal source of funds comes from government**, and reserves classification discretion to Docker. It also excludes employment-related work from personal Developer Use and routes U.S. public-sector entities to a separate public-sector agreement. ([D1], [D2]; read 2026-10-17.)

**Recommendation / uncertainty.** Confirm Radiant’s classification, organization-wide counts/revenue and contract/order terms with procurement or Docker before relying on the free tier. Agency use requires a paid agreement under the cited terms. A contractor-owned laptop or a two-person project does not settle the customer’s status. Docker Engine/Moby licensing is separate from Desktop licensing; avoiding Desktop does not establish that an entire Linux runtime distribution is permissively licensed. ([D1], [D2]; read 2026-10-17.)

**License boundary.** WSL’s open-source repository is MIT, while the WSL Linux kernel is **GPL-2.0 with the Linux syscall exception**. Docker documents GPL components in Desktop. Podman’s Apache license does not relicense its guest Linux OS or every image package. The Dev Container CLI’s MIT license does not cover every feature, image or editor extension. **Recommendation:** keep adoption of application dependencies MIT/Apache/BSD-only; obtain separately reviewed, IT-supplied operating environments. Do not bundle GPL kernels/images or proprietary Desktop/CLI distributions under a claim of permissive licensing. No BUSL or source-available component is recommended for adoption here. ([W5], [W6], [D1], [P2], [P3], [V2]; read 2026-10-17.)

**Operational recommendation.** If IT permits WSL, use a managed image, explicit network policy, patch ownership and endpoint visibility. Microsoft describes Defender for Endpoint integration, Intune settings and firewall controls, but its enterprise overview is updated **2024-08-16 (>12 months old)**; the more recent WSL configuration reference is updated **2026-10-16**. Do not translate the existence of management features into an assertion that the target laptop has them enabled. ([W1], [W2]; read 2026-10-17.)

### OpenHands’ own container runtime

**Local facts.** Canvas documents two different arrangements. **Option 2** puts the Canvas/agent stack in one Docker container, publishes only host `127.0.0.1:8000`, and mounts a chosen projects directory plus `.openhands` state. Every project under that mounted directory is accessible to its agents. **Option 3** sets `OH_CONVERSATION_RUNTIME=docker` to create per-conversation agent-server containers; the outer Canvas/agent-server remains on the host. Conversations sharing a workspace still share files. The Windows guide directs Option 3 through **WSL2**, because the implementation uses POSIX UID/GID operations and does not support a native Windows host for this mode. ([L4], [L5], [O1]; read 2026-10-17.)

**Sources say.** The SDK’s `DockerWorkspace` starts a prebuilt agent-server image, applies configured volumes/network options, publishes its API on host loopback, waits for health and stops the container on cleanup. It is container lifecycle code, not an additional hypervisor or an automatic outbound allowlist. Docker’s security documentation warns that control of the daemon and permissive host mounts can compromise host isolation. ([O2], [D4]; read 2026-10-17.)

**Recommendation.** Start with one approved project mount, separate state, no host home-directory mount, no agent access to the container-engine socket, nonprivileged execution and externally enforced egress. Run both the ACP process and any tools it launches inside that environment. Set `SF_AGENT_WORKSPACE` to the actual container path and verify the factory and agent see identical work-order files. For concurrent work, use distinct worktrees and per-conversation containers after the simpler single-project setup works. An unrestricted local outer controller remains trusted infrastructure. These are hardening recommendations, not properties demonstrated by the quickstart. ([L4], [L5], [O2], [D4], [L6]; read 2026-10-17.)

### Claude Code and Codex built-in sandboxes

**Anthropic documentation says.** Claude Code’s OS-enforced shell sandbox runs on macOS, Linux and **WSL2**; native Windows shell commands run unsandboxed. It covers shell commands and descendants, while file tools, MCP servers and hooks run outside that shell boundary. It is off by default. Managed settings can enable it, set `failIfUnavailable:true` and `allowUnsandboxedCommands:false`; credential read access also needs deliberate policy. Therefore use WSL2/container/VM containment for the entire Claude workload, with its shell sandbox as another layer. Whether our exact ACP adapter forwards/enforces the desired managed settings remains **unconfirmed**. ([C1]; read 2026-10-17.)

**Official OpenAI documentation says.** The searched-and-opened Windows page now describes **MXC (Microsoft Execution Containers)** native process isolation, requiring compatible Windows 11 capabilities; explicit compatibility probing is documented for CLI **0.162.0+**. It needs no administrator-approved setup. Legacy `elevated` needs administrator-approved provisioning but runs commands without administrator privileges; `unelevated` is weaker on networking and lacks denied-read paths. Enterprise configuration can constrain selection. MXC permits host-loopback connections and stops remaining child processes when a foreground command exits. These are capability-dependent documented options, **not verified behavior of Canvas’s ACP session**. ([X1]; read 2026-10-17.)

**Recommendation / inference.** A restricted native Codex pilot may remove the need to require WSL for Codex-only users, but first demonstrate that the ACP adapter preserves the sandbox and cannot silently switch to `agent-full-access`. Test read/write denial, child processes, package/test runners, network denial and escalation rejection. MXC’s documented loopback access means native containment must not be assumed to protect the factory’s localhost approval endpoint; authenticated human-only authorization and control-plane separation are still necessary. Linux containers likewise need a deliberate control-plane reachability policy. ([X1], [L2], [L3], [L6]; read 2026-10-17.)

### ACP permission forwarding: issue, settings and credible upstream scope

**Confirmed issue and current source.** SDK issue **[#5480](https://github.com/OpenHands/software-agent-sdk/issues/5480)**, opened **2026-10-03**, is Open in the inspected page and has no linked development PR there. It requests opt-in permission forwarding, stable request IDs, user-selected ACP `optionId`, cancellation, and rejection of stale/replayed answers. A bot triage comment identifies a real contract gap: the existing confirmation endpoint carries `accept`/`reason`, not arbitrary ACP option selection. The issue author reports a prototype; that report is not an independently verified production implementation. Current upstream `request_permission` still selects `options[0]`. ([A1], [A2]; read 2026-10-17.)

**Local settings evidence.** SDK 1.55.1 has `acp_session_mode` (including schema metadata), but that only chooses the remote agent’s session mode; the bridge independently auto-answers requests. Canvas’s ordinary `confirmation_mode` maps to `NeverConfirm`/`AlwaysConfirm`/`ConfirmRisky`; inspecting that mapping does not establish ACP forwarding. Searches of SDK/Canvas issues and the actual handler/settings found the specific open request above; **other branches or unlinked PRs may exist, and their absence is unconfirmed**. Do not tell users to enable ordinary confirmation mode and assume the risk is fixed. ([L2], [L3], [L7], [A1], [A2]; read 2026-10-17.)

**Recommended upstream scope / engineering estimate.** Split a small by-kind automatic-selection fix from the interactive feature. The latter needs typed pending-request/selection events; conversation-scoped IDs and exact allowed-option validation; a response API/client contract; UI rendering of the supplied options; a pending future that resolves once; cancellation on pause, interrupt, timeout and disconnect; an explicit restart/overlap policy; safe headless defaults; and audit records containing IDs/decisions, not full prompts or secrets. Configure non-bypass session modes as part of the feature. Reuse the existing confirmation state/UI concepts but do not force ACP’s multi-option model into a Boolean. **Estimate:** 1–2 days for the small selection fix, **6–10 days** for a reviewed SDK/server/TypeScript-client/Canvas implementation with cancellation and replay checks, excluding upstream review latency. This is our estimate, not a maintainer commitment. ([A1], [A2], [L7]; read 2026-10-17.)

## Recommendation and estimated effort

Use an **IT-provided, approved runtime**, keeping GPL/proprietary operating-environment licensing separate from permissive factory dependencies. For the fastest existing integration path, use already licensed/approved Docker; where a new permissive engine is required, test Podman before adopting it. Avoid spending the pilot rebuilding a sandbox orchestrator. Do not use agency code in the current unrestricted host profiles. These are recommendations based on the observed defaults and boundaries above. ([L1]–[L5], [D1], [P1], [X1]; read 2026-10-17.)

All numbers are **one-engineer working-day estimates**, excluding IT/procurement/agency approval waiting time:

| Work | Estimate and acceptance result |
| --- | --- |
| Existing approved container baseline | 2–4 days: project-only mounts, path translation, persistence, egress and cleanup verified |
| Podman compatibility spike | 2–3 days: prove both relevant OpenHands lifecycle and Windows/WSL paths before a commitment |
| Codex-native restricted ACP spike | 2–3 days: demonstrate enforced boundaries and human escalation behavior; fail closed when unavailable |
| ACP interactive forwarding upstream contribution | 6–10 days plus review; acceptance includes stale response, cancellation, restart and overlap checks |
| Agency hardening evidence | 2–4 days: runtime inventory, secrets/mount/network matrix, reproducible denial checks and patch owner |

## Open questions

- **Unconfirmed:** Does the target agency permit WSL2/virtualization, which runtime images are approved, and who patches guest OS packages?
- **Unconfirmed:** Does Docker classify Radiant under its broad Government Entity definition, and what agreement covers contractor/agency seats?
- **Unconfirmed:** Does our pinned Claude/Codex ACP adapter preserve required sandbox policy and version requirements? What exact option ordering and escalation behavior does it expose?
- **Unconfirmed:** Can Podman satisfy native CLI/API, mount, UID/GID and port behavior used by the pinned OpenHands version?
- **Unconfirmed:** Will maintainers accept the permission API contract and opt-in design in #5480? No issue was posted, PR created, installer executed or runtime exercised during this research.

## Source registry

Every entry was **opened/read 2026-10-17**. Undated web sources and local snapshots have unknown publication age; crawled dates are not update dates. The 2024 WSL enterprise article is explicitly **>12 months old**. License text dates identify license versions, not document publication.

| ID | Primary source / inspected local source | Publication/update date |
| --- | --- | --- |
| L1 | [Factory launcher](../../scripts/dev.mjs) | Undated local source |
| L2 | [SDK 1.55.1 bridge](C:/Users/sgupt/AppData/Local/uv/cache/archive-v0/v2p0BRhi1sqN7XUy/openhands/sdk/agent/acp_agent.py), [package metadata](C:/Users/sgupt/AppData/Local/uv/cache/archive-v0/v2p0BRhi1sqN7XUy/openhands_sdk-1.55.1.dist-info/METADATA) | Undated installed local sources |
| L3 | [Installed provider registry](C:/Users/sgupt/AppData/Local/uv/cache/archive-v0/v2p0BRhi1sqN7XUy/openhands/sdk/settings/acp_providers.py), [settings model](C:/Users/sgupt/AppData/Local/uv/cache/archive-v0/v2p0BRhi1sqN7XUy/openhands/sdk/settings/model.py) | Undated installed local sources |
| L4 | [Canvas README, Options 2/3](../../canvas/README.md) | Undated local source |
| L5 | [Windows quickstart](../../canvas/README.windows.md) | Undated local source |
| L6 | [Factory workspace/loopback configuration](../../apps/server/src/config.ts), [API routes](../../apps/server/src/index.ts) | Undated local sources |
| L7 | [Canvas confirmation mapping](../../canvas/src/api/agent-server-adapter.ts), [agent settings UI](../../canvas/src/routes/agent-settings.tsx) | Undated local sources |
| D1 | [Docker Desktop license documentation](https://docs.docker.com/subscription-billing/desktop-license/) | Undated |
| D2 | [Docker Subscription Service Agreement, definitions, Desktop limitations and U.S. Public Sector Users](https://www.docker.com/legal/docker-subscription-service-agreement/) | 2026-08-26 |
| D3 | [Docker Windows installation modes](https://docs.docker.com/desktop/setup/install/windows-install/) | Undated |
| D4 | [Docker Engine security](https://docs.docker.com/engine/security/) | Undated |
| P1 | [Podman Windows installation](https://podman.io/docs/installation) | Undated |
| P2 | [Podman license](https://github.com/podman-container-tools/podman/blob/main/LICENSE) | Undated; Apache-2.0 |
| P3 | [Podman Desktop license](https://github.com/podman-desktop/podman-desktop/blob/main/LICENSE) | Undated; Apache-2.0 |
| W1 | [WSL enterprise guidance](https://learn.microsoft.com/en-us/windows/wsl/enterprise) | 2024-08-16; **>12 months old** |
| W2 | [WSL configuration](https://learn.microsoft.com/en-us/windows/wsl/wsl-config) | 2026-10-16 |
| W3 | [Windows Sandbox overview and editions](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/) | 2026-03-29 |
| W4 | [Windows Sandbox configuration](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file) | 2026-03-29 |
| W5 | [WSL repository MIT license](https://raw.githubusercontent.com/microsoft/WSL/master/LICENSE) | Undated |
| W6 | [WSL Linux kernel copying terms](https://raw.githubusercontent.com/microsoft/WSL2-Linux-Kernel/linux-msft-wsl-6.6.y/COPYING) | Undated; **GPL-2.0 WITH Linux-syscall-note** |
| V1 | [Dev Container CLI README](https://raw.githubusercontent.com/devcontainers/cli/main/README.md) | Undated |
| V2 | [Dev Container CLI MIT license](https://github.com/devcontainers/cli/blob/main/LICENSE.txt) | Undated |
| V3 | [Development container specification](https://github.com/devcontainers/spec/blob/main/docs/specs/devcontainer-reference.md) | Undated |
| O1 | [Current upstream Windows quickstart](https://raw.githubusercontent.com/OpenHands/OpenHands/main/README.windows.md) | Undated; mutable main |
| O2 | [OpenHands DockerWorkspace implementation](https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/openhands-workspace/openhands/workspace/docker/workspace.py) | Undated; mutable main |
| C1 | [Anthropic shell sandbox documentation](https://code.claude.com/docs/en/sandboxing) | Undated |
| X1 | [Official OpenAI Windows sandbox](https://developers.openai.com/codex/windows), redirected to [ChatGPT Learn](https://learn.chatgpt.com/docs/windows/windows-sandbox) | Undated; searched then opened before conclusions |
| A1 | [SDK permission-forwarding issue #5480](https://github.com/OpenHands/software-agent-sdk/issues/5480) | Opened 2026-10-03; visible triage 2026-10-03 |
| A2 | [Current upstream ACP bridge](https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/openhands-sdk/openhands/sdk/agent/acp_agent.py) | Undated; mutable main |

[L1]: ../../scripts/dev.mjs
[L2]: C:/Users/sgupt/AppData/Local/uv/cache/archive-v0/v2p0BRhi1sqN7XUy/openhands/sdk/agent/acp_agent.py
[L3]: C:/Users/sgupt/AppData/Local/uv/cache/archive-v0/v2p0BRhi1sqN7XUy/openhands/sdk/settings/acp_providers.py
[L4]: ../../canvas/README.md
[L5]: ../../canvas/README.windows.md
[L6]: ../../apps/server/src/config.ts
[L7]: ../../canvas/src/api/agent-server-adapter.ts
[D1]: https://docs.docker.com/subscription-billing/desktop-license/
[D2]: https://www.docker.com/legal/docker-subscription-service-agreement/
[D3]: https://docs.docker.com/desktop/setup/install/windows-install/
[D4]: https://docs.docker.com/engine/security/
[P1]: https://podman.io/docs/installation
[P2]: https://github.com/podman-container-tools/podman/blob/main/LICENSE
[P3]: https://github.com/podman-desktop/podman-desktop/blob/main/LICENSE
[W1]: https://learn.microsoft.com/en-us/windows/wsl/enterprise
[W2]: https://learn.microsoft.com/en-us/windows/wsl/wsl-config
[W3]: https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/
[W4]: https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file
[W5]: https://raw.githubusercontent.com/microsoft/WSL/master/LICENSE
[W6]: https://raw.githubusercontent.com/microsoft/WSL2-Linux-Kernel/linux-msft-wsl-6.6.y/COPYING
[V1]: https://raw.githubusercontent.com/devcontainers/cli/main/README.md
[V2]: https://github.com/devcontainers/cli/blob/main/LICENSE.txt
[V3]: https://github.com/devcontainers/spec/blob/main/docs/specs/devcontainer-reference.md
[O1]: https://raw.githubusercontent.com/OpenHands/OpenHands/main/README.windows.md
[O2]: https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/openhands-workspace/openhands/workspace/docker/workspace.py
[C1]: https://code.claude.com/docs/en/sandboxing
[X1]: https://developers.openai.com/codex/windows
[A1]: https://github.com/OpenHands/software-agent-sdk/issues/5480
[A2]: https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/openhands-sdk/openhands/sdk/agent/acp_agent.py
