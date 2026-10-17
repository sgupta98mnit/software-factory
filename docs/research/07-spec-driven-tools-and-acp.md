Sources say OpenSpec and Spec Kit are MIT tools; Kiro is an AWS-licensed product, so it fails this brief's adoption rule. [O1] [G1] [K2] (read 2026-10-17).
We recommend keeping OpenSpec and Backlog.md, adding explicit evidence links rather than replacing the working file-based flow. [L1] [B1] (inspected/read 2026-10-17; inference).
ACP has a stable v1 protocol, a draft v2, and a broad agent ecosystem, but adapter versions and permissions still need independent qualification. [A1] [A2] (read 2026-10-17; recommendation).

# 07 — Spec-driven tools, file-based tasks, and ACP

## Findings — sources say

### Compare the actual integration surfaces

The factory currently invokes OpenSpec with `--json`; its planner separately reads numbered task groups and heuristically assigns control-family labels from the design's Controls table. That distinction matters: a label is a suggested relationship, not proof of implementation or a durable requirement identifier. [L1] [L3] (inspected 2026-10-17; last sentence is inference).

| Tool | Maturity and license evidence | Machine interface | Fit for controls traceability — our assessment |
| --- | --- | --- | --- |
| **OpenSpec** | MIT. Published v1.14.3 on 2026-10-17; this factory pins 1.14.0. Releases show continuing validation, archive, and Windows fixes. [O1] [O3] [L2] | Documented JSON for `list`, `show`, `status`, `validate`, and `instructions`; schema customization changes artifacts and templates. [O2] [O4] | Best incremental fit: retain proposal/spec/design/tasks and add an explicit controls artifact, stable scenario IDs, and evidence references. This is a recommendation, not a built-in OSCAL claim. [O4] [L1] |
| **GitHub Spec Kit** | MIT; GitHub-maintained repository with SDD plus independently selectable processes, presets, extensions, and workflows. This is more than the original fixed sequence of slash commands. [G1] [G2] | CLI and generated scripts/agent instructions, rather than a hosted requirements database. Documented CLI examples include `specify version --json`; scripts and individual extension commands need contract review before use as a server integration. [G2] [G3] | Constitution/presets can express team policy, but those instructions do not themselves prove a control passed. A migration would also need a new artifact/task adapter. [G2] [L1] (inference) |
| **Kiro** | AWS product terms govern both IDE and CLI; not MIT/Apache/BSD. It has open-source components, including LGPL obligations, but that does not make the product permissively licensed. [K2] | Specs produce `requirements.md` or `bugfix.md`, `design.md`, and `tasks.md`. The ACP directory lists Kiro CLI; that is an agent interface, not evidence of a public spec-management JSON API. [K1] [A2] | Similar artifacts are usable as references. Do not embed/adopt Kiro under this brief's license constraint; no general spec CRUD/JSON API was confirmed from these docs. [K1] [K2] (assessment/search limit) |
| **BMad Method** | MIT. Current README separates stable v6.12 from a v7 preview alpha and warns of breaking changes. Its stated v7 ETA was 2026-10-16; an ETA is not proof of release. [M1] [M2] | Agent skills, templates, planning/architecture workflows, and setup scripts. A supported requirements-database JSON contract was not established by the reviewed README. [M1] | Useful process ideas; avoid adding another workflow engine to this pilot. Imported community content still needs revision/license review. [M1] (recommendation) |

All table sources were read **2026-10-17**. Maturity here means visible releases, interfaces, and maintenance posture, not a security certification or a forecast of maintainer support. [O3] [G2] [M1] (assessment).

OpenSpec's current docs describe schema forking and project rules separately: project configuration adds guidance, whereas a schema changes artifacts, order, and templates. Start with rules if a Controls section is enough; fork a schema only when a distinct `controls.md` artifact is actually needed. Neither mechanism makes a model-generated mapping authoritative. [O4] (read 2026-10-17; final two sentences are recommendations).

### Backlog.md and alternatives that survive in git

Backlog.md is MIT and Markdown-native. Its manifesto makes the CLI canonical, treats MCP as an optional legacy adapter, and explicitly declines to support internal JavaScript/TypeScript APIs for outside consumers. The existing factory's CLI boundary is aligned with that posture. [B1] [B2] [L1] (read/inspected 2026-10-17; alignment is inference).

| Candidate | Storage/interface and license | Decision for this factory |
| --- | --- | --- |
| **Keep Backlog.md** | Markdown task files; CLI semantic mutations; acceptance criteria and outcomes in the same task model; MIT. [B1] [B2] | Existing adapter and human-review flow make replacement unnecessary for the pilot. [L1] (recommendation) |
| **Taskell** | BSD-3-Clause, Markdown kanban lists with clean diffs, subtasks and due dates. README describes Mac/Linux and says the author is taking a development break; no comparable stable automation/approval API was established. [T1] | License-compatible, but a weaker Windows/automation choice for this use case. Keep as a lightweight manual-board alternative. [T1] (assessment) |
| **driusan/bug** | Human-readable issue directories/files branch and merge with source; GPL-3.0. [T2] | Meets the files-in-git idea but **excluded by the brief's license rule**. [T2] |
| **git-bug** | GPL-3.0-or-later; stores issues in git without adding normal project files; CLI and GraphQL surface. [T3] | **Excluded by license**, and not a normal Markdown-file substitute. [T3] |

All table sources were read **2026-10-17**. These are alternatives examined, not dependencies proposed for installation. Taskell's maintenance-break notice is **undated**; current Windows support and a supported automation interface remain unconfirmed. [T1] (read 2026-10-17).

### ACP ecosystem and stability

ACP is maintained under the `agentclientprotocol` organization and Apache-2.0. Its README identifies stable protocol **1** separately from Rust-crate and generated-schema release versions; v2 remains draft/unstable in the reviewed material. Negotiate `protocolVersion` and capabilities rather than treating an SDK version number as wire compatibility. [A1] (read 2026-10-17; last sentence is recommendation).

The maintainer list, updated **2026-06-01**, names Ben Brandt (Zed) and Sergey Ignatov (JetBrains) as lead maintainers, with core and language-SDK maintainers. Governance describes core-maintainer decisions, public proposals, and a biweekly meeting process. This is multi-vendor project governance, not a government interoperability accreditation. [A3] [A4] (read 2026-10-17; final sentence is assessment).

The official agent directory lists Gemini CLI, OpenHands, Cursor, Factory Droid, GitHub Copilot (public preview), Goose, Junie, Kiro CLI, Kimi CLI, Mistral Vibe, OpenCode, Qwen Code, and others. **Claude Agent uses Zed's SDK adapter; Codex CLI uses an ACP adapter.** Their presence in the directory does not establish that every upstream CLI feature or authentication method survives that adapter. [A2] (read 2026-10-17; final sentence is inference).

We recommend qualifying only the two launch paths already used here first: initialize/authentication, workspace path, streamed tools, permission choice, cancellation, reconnect, and final outcome. Record the agent CLI, adapter, SDK, model endpoint, and policy versions in evidence. ACP transport is not a sandbox or an approval authority; the current factory/OpenHands behavior still needs the permission work in [02](02-windows-sandboxing.md). [A1] [L1] (read/inspected 2026-10-17; recommendation).

## Recommendation — our judgment

Keep the existing OpenSpec/Backlog split. Define an agency-reviewed record joining **requirement/scenario ID → work order → control statement → commit/diff → check results → content-bound human approval**. Make the existing heuristic control suggestions visible for review rather than silently accepting them as compliance. The present planner and the tools' documented artifact surfaces make this an incremental change. **Estimate: 2–4 engineering days** for an explicit mapping and one representative export, excluding agency control tailoring. [L1] [O4] [B1] (inspected/read 2026-10-17; design/estimate).

Pin ACP adapters independently from agents and run one compatibility check per approved configuration before accepting upgrades. **Estimate: 1–2 days** to define and exercise the initial two-agent compatibility matrix; implementing permission relay is estimated separately in file 02. Do not migrate spec/task tools during the first federal pilot unless an observed requirement cannot be met by the existing CLIs. [A1] [A2] [L1] (read/inspected 2026-10-17; recommendation/estimate).

## Open questions and evidence limits

- Will the sponsoring team require a specific OSCAL profile/statement granularity? Decide this with its ISSO before freezing the controls artifact; labels alone cannot answer it. [L1] (inspected 2026-10-17; proposed decision).
- Which machine interfaces are guaranteed for the **pinned** versions? Current web docs can describe newer commands; exercise the pinned CLIs during implementation rather than copying every current flag into the server. [O2] [O3] [L2] (read/inspected 2026-10-17; recommendation).
- Kiro programmatic spec CRUD, Taskell Windows automation, and BMad's v7 final-release status were **not confirmed** by the reviewed sources. [K1] [T1] [M1] (read 2026-10-17).
- ACP agent-directory inclusion is not an end-to-end test of this factory. Directory entries and adapter licenses must be rechecked at the revision selected for distribution. [A2] (read 2026-10-17; recommendation).

## Sources and dates

Every citation below was **read or locally inspected 2026-10-17**. Dynamic `main` pages are **undated** unless a date is specified; a crawl date is not a publication date. No dated historical source older than 2025-10-17 is used as current-version evidence here; undated pages have unconfirmed publication age.

- [O1] OpenSpec README/license: undated current repository.
- [O2] OpenSpec CLI: undated current reference.
- [O3] OpenSpec releases: v1.14.3 dated 2026-10-17.
- [O4] OpenSpec customization: undated current reference.
- [G1] Spec Kit MIT license: undated license file; copyright year is not a publication date.
- [G2] Spec Kit README: undated current repository.
- [G3] Spec Kit CLI usage: undated current reference.
- [K1] Kiro Specs: undated current vendor docs.
- [K2] Kiro license: undated current legal page, ©2026.
- [M1] BMad README: undated current README; explicitly states stable/preview distinction and 2026-10-16 ETA.
- [M2] BMad MIT license: undated current file.
- [B1] Backlog.md manifesto: undated current repository.
- [B2] Backlog.md MIT license: undated current file.
- [T1] Taskell README/license: undated; development-break notice has no date.
- [T2] driusan/bug README/license: undated.
- [T3] git-bug README/license: undated.
- [A1] ACP README/versioning/license: undated current repository.
- [A2] ACP agents: undated current directory.
- [A3] ACP maintainers: last updated 2026-06-01.
- [A4] ACP governance: undated current policy.
- [L1] Factory OpenSpec adapter and planner: local snapshot, publication date unconfirmed.
- [L2] Factory package pins: local snapshot, publication date unconfirmed.
- [L3] Factory OpenSpec CLI adapter: local snapshot, publication date unconfirmed.

[O1]: https://github.com/Fission-AI/OpenSpec
[O2]: https://openspec.dev/docs/cli
[O3]: https://github.com/Fission-AI/OpenSpec/releases
[O4]: https://openspec.dev/docs/customize
[G1]: https://raw.githubusercontent.com/github/spec-kit/main/LICENSE
[G2]: https://github.com/github/spec-kit
[G3]: https://github.com/github/spec-kit/blob/main/docs/reference/core.md
[K1]: https://kiro.dev/docs/specs/
[K2]: https://kiro.dev/license/
[M1]: https://github.com/bmad-code-org/BMAD-METHOD
[M2]: https://github.com/bmad-code-org/BMAD-METHOD/blob/main/LICENSE
[B1]: https://github.com/MrLesk/Backlog.md/blob/main/MANIFESTO.md
[B2]: https://raw.githubusercontent.com/MrLesk/Backlog.md/main/LICENSE
[T1]: https://github.com/smallhadroncollider/taskell
[T2]: https://github.com/driusan/bug
[T3]: https://github.com/git-bug/git-bug
[A1]: https://github.com/agentclientprotocol/agent-client-protocol
[A2]: https://agentclientprotocol.com/get-started/agents
[A3]: https://github.com/agentclientprotocol/agent-client-protocol/blob/main/MAINTAINERS.md
[A4]: https://agentclientprotocol.com/community/governance
[L1]: ../../apps/server/src/planner.ts
[L2]: ../../apps/server/package.json
[L3]: ../../apps/server/src/openspec.ts
