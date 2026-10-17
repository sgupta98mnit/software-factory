Recommendation: retain Canvas’s Electron shell and add the factory API to its existing supervised service lifecycle.
Finding: the packaged static frontend has no factory API process or production `/sf-api` route today ([L1], [L2], [L3]; read 2026-10-17).
Recommendation: pilot with a signed, agency-deployed installer; make self-update an explicit deployment choice, with effort estimates below.

## Findings

### What the local desktop build actually does

**Local facts.** `build:desktop` builds the frontend, downloads uv and Node, then runs electron-builder with `--publish never`. The app root is `electron/`; the installer contains the Electron entry point, launcher scripts, configuration, static build and custom Python tools. `asar:false` keeps subprocess scripts as ordinary files. An `afterPack` hook removes the large hoisted application dependency tree and restores only the runtime package closure of `sirv` and `httpxy`; another hook restores and verifies the bundled Windows Node distribution’s npm files. Simply adding the factory’s compiled JavaScript to the file list would therefore omit its runtime dependencies. ([L1], [L4]; read 2026-10-17.)

**Local facts.** On application readiness, `main.mjs` puts bundled uv/uvx and Node/npm/npx on PATH, creates its desktop tunnel bridge, checks `uvx --version`, and opens a loading window. It imports `scripts/dev-with-automation.mjs` and calls its `main()` in static, non-public mode. That launcher starts the Python agent server, automation backend, static frontend and ingress. The configuration pins agent-server **1.55.1**, automation **1.20.1**, and default ports **18000**, **18001** and **8000** respectively; the frontend’s preferred internal port is **3001**. Python packages can still be obtained through uv at runtime; bundling uv is not equivalent to bundling a complete offline Python environment. ([L2], [L3], [L5], [L6]; read 2026-10-17.)

**Local facts.** Startup streams service logs to the splash and allows ten minutes for the first agent-server start. The main process then probes ingress and `/server_info` before opening the browser window at `http://localhost:8000`. The window has `nodeIntegration:false` and `contextIsolation:true`. On quit, Electron invokes the launcher's registered cleanup; Windows uses `process.emit("SIGTERM")`, since killing the process with that signal would skip its listener. Tracked process trees and shutdown hooks are cleaned up, with a six-second Electron exit fallback. These details matter when adding another child process: launching it separately without registering cleanup would risk leaving its port occupied after exit. ([L2], [L3]; read 2026-10-17.)

**Correction to the brief.** The inspected checkout includes a Windows CI matrix entry and a `windows-latest` NSIS build workflow. The latter explicitly describes its installer as unsigned. This establishes build automation, not successful execution on a particular agency image; no installer was run during this research. ([L7], [L8]; read 2026-10-17.)

### Factory integration and the production proxy gap

**Local facts.** Today `scripts/dev.mjs` starts the factory and Canvas as separate development processes. Factory UI requests use the literal `/sf-api` prefix; only `vite.config.ts` adds the factory proxy. Desktop mode serves prebuilt assets rather than Vite, and the launcher's production route table covers its OpenHands/automation/editor services without a factory route. The factory itself serves `/sf-api/...`, so a future proxy should **preserve** that prefix. The existing proxy forwards the original request path and rewrites Host to the backend, which also matches the factory's loopback Host validation. ([L3], [L9], [L10], [L11], [L12]; read 2026-10-17.)

**Recommendation / design inference.** Add one compiled factory Node child to this launcher’s existing service tracking, using the **bundled Node executable**, not Electron’s `process.execPath` as an ordinary Node executable. Reuse ingress routing for `/sf-api` to `http://127.0.0.1:4317`; preserve streaming for the events endpoint. Wait for factory health before showing the factory pages, report child failures through the splash, and register shutdown using the existing hook. This is a small extension of the inspected lifecycle, not a reason to add a Windows service or another server framework. ([L2], [L3], [L12]; read 2026-10-17.)

**Local facts and resulting packaging requirements.** Factory `config.ts` searches upwards for `pnpm-workspace.yaml`, defaults workspace/data paths relative to that root, and binds explicitly to `127.0.0.1`. `tools.ts` resolves OpenSpec and Backlog.md from package manifests, and the API runs their bin scripts with Node. **Recommendation:** ship the compiled factory plus its complete production dependency closure, including CLI binaries/assets and Windows platform packages; explicitly set `SF_WORKSPACE`, `SF_AGENT_WORKSPACE` and `SF_DATA_DIR` at launch. Store audit data in a writable application-data directory outside the installation and select the actual project directory. Test from an installed location on a clean account, because a development checkout can conceal missing packages and bad root discovery. ([L13], [L14], [L15]; read 2026-10-17.)

### Windows signing: standard, EV and Azure

**Sources say.** Microsoft’s current SmartScreen guidance accepts both organization-validated **OV** and extended-validated **EV** certificates. Neither now grants an automatic SmartScreen bypass; a valid new signed release may still warn while reputation develops. Microsoft distinguishes publisher reputation from individual file-hash reputation. A signature identifies a publisher and protects integrity; it does not grant an agency’s execution authorization. ([S1], [S6]; read 2026-10-17.)

**Sources say.** Standard code-signing keys, not only EV keys, have required compliant hardware/token/HSM protection for new issuance since June 2023. Avoid an implementation premised on obtaining a newly issued, freely exportable OV private key as a CI `.pfx`. This DigiCert article is **undated and contains >12-month-old historical guidance**; its hardware requirement should be checked against the selected CA’s current issuance terms. Electron’s tutorial contains conflicting statements that EV is mandatory and Artifact Signing eliminates warnings; Microsoft’s newer explicit OV/EV guidance takes precedence for this recommendation. ([S2], [S1], [S3]; read 2026-10-17.)

**Sources say.** Azure **Artifact Signing**, formerly **Trusted Signing**, manages signing keys in FIPS 140-3 Level 3 HSMs and supports digest signing without uploading the complete file. It offers Public Trust and Private Trust scenarios; it does **not** issue EV certificates. The pinned electron-builder **26.15.3** supports its older `win.azureSignOptions` configuration with account, certificate profile, endpoint and exact publisher name. The current v27 documentation describes a different interface and is explicitly unreleased: do not copy that interface into this v26 project. ([S4], [S5], [S8], [S9], [L4]; read 2026-10-17.)

**Recommendation.** Prefer Radiant’s existing approved signing service if there is one; otherwise evaluate Artifact Signing Public Trust for release CI. Sign and timestamp the installer, uninstaller and shipped executables, verify the resulting signatures, and fail release builds when signing fails. Preserve upstream signatures on bundled third-party runtimes and inventory their trust requirements. Treat commercial Azure signing availability, procurement and permitted build-data handling as separate questions from Azure Government model hosting; **Azure Government availability and the target agency’s acceptance of this signing path remain unconfirmed**. ([S4], [S5], [S8]; read 2026-10-17.)

### Admin-free installation, updates and agency policy

**Local fact with an important qualification.** Canvas builds a Windows x64 NSIS assisted installer with `oneClick:false`, `perMachine:false`, and a changeable install directory. In electron-builder v26, that combination presents an install-mode choice; it is **not a hard guarantee of per-user-only installation**. A per-user install into a user-writable location can avoid UAC, while choosing all-users or a protected directory changes the requirement. WSL/virtualization setup and sandbox provisioning have their own privileges, independent of the app installer. ([L1], [S10], [S11]; read 2026-10-17.)

**Sources say.** `electron-updater` supports NSIS, release metadata, staged rollout, Windows signature validation and generic HTTPS feeds. Local inspection found no `electron-updater` dependency or `autoUpdater` use in the desktop entry point, and the build disables publishing. These are missing pieces in the inspected build, not evidence that upstream could never add an updater. Microsoft also warns that apps installed through App Control’s managed-installer mechanism may be blocked after self-update because new files lack the original managed-installer provenance. ([S12], [L2], [L4], [S7]; read 2026-10-17.)

**Recommendation.** For the first agency deployment, let IT deploy signed, versioned installers through its approved distribution process. Offer opt-in application update checks only where the agency permits them. If self-update is selected later, use the existing NSIS-compatible `electron-updater`, retain signature verification and publisher matching, use an approved HTTPS feed, let the user defer installation until agent jobs stop, and verify old-to-new update, interrupted-update and data-retention behavior. Do not assume a GitHub release or a low-friction consumer updater is reachable or permitted on the agency network. ([S12], [S7]; read 2026-10-17.)

**Sources say / limits of evidence.** App Control can allow by signer, hash or managed-installer provenance; path rules reject user-writable paths by default. Microsoft documents enterprise policies that prevent users bypassing SmartScreen. **No reviewed source establishes a government-wide ban on Electron or a government-wide allowance for signed Electron apps.** The target agency’s approved-software list, App Control/AppLocker rules and endpoint configuration must settle the actual outcome. Signed Electron, Node, uv, Python, CLI adapters and newly generated developer binaries each need a workable execution policy. ([S1], [S6], [S7]; read 2026-10-17.)

**License boundary.** Canvas, Electron and electron-builder have MIT top-level licenses. That does not establish the licenses of every bundled runtime, installer component, Python package or npm dependency. **Recommendation:** retain notices and review an artifact-level SBOM before distribution; adopt no additional GPL, BUSL or source-available updater. Windows and Azure signing are separately licensed platform/service prerequisites, not MIT components to embed. ([L16], [S13], [S14]; read 2026-10-17.)

## Recommendation and estimated effort

These are **engineering estimates for one engineer**, not vendor commitments; they exclude procurement, identity validation and agency approval waiting time.

| Order | Proposed result | Estimate |
| --- | --- | --- |
| 1 | Add supervised factory child, runtime dependencies, explicit paths and production proxy; verify installed CRUD/SSE, failure and shutdown | 4–7 working days |
| 2 | Signed CI artifact, timestamp/signature checks and clean standard-user installation | 2–4 working days |
| 3 | Agency execution-policy package: process inventory, hashes, notices/SBOM, network needs and deployment procedure | 2–4 working days |
| 4 | Approved mirrors/preseeded Python and CLI prerequisites, with first-run/offline acceptance checks | 3–6 working days |
| Later | Optional signed NSIS updater with controlled feed, deferral and recovery testing | 2–4 working days |

Prioritize the service/proxy closure and an IT-managed signed installer. Offline completeness and sandbox prerequisites should be part of the pilot’s acceptance criteria, not inferred from a successful build. This recommendation follows the local packaging and Microsoft policy evidence above. ([L1]–[L15], [S7]; read 2026-10-17.)

## Open questions

- **Unconfirmed:** Which agency image, Windows architecture, publisher trust rule and software-distribution channel will be used? Is per-user installation permitted?
- **Unconfirmed:** Can signing occur in Radiant’s commercial build environment, and does the agency require its own enterprise trust chain or signing approval?
- **Unconfirmed:** Which Python/npm/CLI artifacts can be mirrored or preapproved, and what is the exact redistribution license inventory?
- **Unconfirmed:** Can the installed factory read/write a selected Windows or WSL project, preserve audit data through upgrade/uninstall, and avoid orphaned children? No packaging or runtime tests were performed in this research-only task.

## Source registry

All sources were **opened/read on 2026-10-17**. “Undated” means no reliable publication/update date was exposed; a recent crawl is not a publication date. Local files are the inspected snapshot, not a claim about every upstream version.

| ID | Source | Publication/update date; age flag |
| --- | --- | --- |
| L1 | [electron-builder.config.mjs](../../canvas/electron-builder.config.mjs) | Undated local source |
| L2 | [electron/main.mjs](../../canvas/electron/main.mjs) | Undated local source |
| L3 | [dev-with-automation.mjs](../../canvas/scripts/dev-with-automation.mjs) | Undated local source |
| L4 | [Canvas package.json](../../canvas/package.json) | Undated local source |
| L5 | [defaults.json](../../canvas/config/defaults.json) | Undated local source |
| L6 | [dev-safe.mjs](../../canvas/scripts/dev-safe.mjs) | Undated local source |
| L7 | [Windows desktop workflow](../../canvas/.github/workflows/desktop-windows.yml) | Undated local source |
| L8 | [Canvas CI workflow](../../canvas/.github/workflows/ci.yml) | Undated local source |
| L9 | [Factory development launcher](../../scripts/dev.mjs) | Undated local source |
| L10 | [Factory UI API client](../../canvas/src/factory/api.ts) | Undated local source |
| L11 | [Vite configuration](../../canvas/vite.config.ts) | Undated local source |
| L12 | [Ingress proxy helpers](../../canvas/scripts/proxy-utils.mjs) | Undated local source |
| L13 | [Factory configuration](../../apps/server/src/config.ts) | Undated local source |
| L14 | [CLI resolution](../../apps/server/src/tools.ts) | Undated local source |
| L15 | [Factory API and routes](../../apps/server/src/index.ts), [manifest](../../apps/server/package.json) | Undated local sources |
| L16 | [Canvas license](../../canvas/LICENSE) | Undated license file; copyright 2025 is not update metadata |
| S1 | [Microsoft SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation) | 2026-05-06 |
| S2 | [DigiCert standard code-signing key protection](https://knowledge.digicert.com/general-information/new-private-key-storage-requirement-for-standard-code-signing-certificates-november-2022) | Undated; historical 2022/2023 guidance **>12 months old** |
| S3 | [Electron code-signing tutorial](https://www.electronjs.org/docs/latest/tutorial/code-signing) | Undated; conflicting claims explicitly identified above |
| S4 | [Artifact Signing overview](https://learn.microsoft.com/en-us/azure/artifact-signing/overview) | 2026-05-12 |
| S5 | [Artifact Signing FAQ](https://learn.microsoft.com/en-us/azure/artifact-signing/faq) | 2026-10-06 |
| S6 | [App Control rule types](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/design/select-types-of-rules-to-create) | 2026-03-29 |
| S7 | [App Control managed installer](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/design/configure-authorized-apps-deployed-with-a-managed-installer) | 2026-08-24 |
| S8 | [electron-builder v26 signing](https://www.electron.build/v26/docs/features/code-signing/code-signing-win/) | Undated versioned documentation |
| S9 | [electron-builder next/v27 signing](https://www.electron.build/docs/features/code-signing/code-signing-win/) | Undated; page identifies unreleased next version |
| S10 | [electron-builder v26 NSIS](https://www.electron.build/v26/docs/nsis/) | Undated versioned documentation |
| S11 | [Codex Windows sandbox prerequisites](https://developers.openai.com/codex/windows) | Undated; redirects to official ChatGPT Learn |
| S12 | [electron-builder v26 auto-update](https://www.electron.build/v26/docs/features/auto-update/) | Undated versioned documentation |
| S13 | [Electron MIT license](https://raw.githubusercontent.com/electron/electron/main/LICENSE) | Undated license file |
| S14 | [electron-builder MIT license](https://raw.githubusercontent.com/electron-userland/electron-builder/master/LICENSE) | Undated license file |

[L1]: ../../canvas/electron-builder.config.mjs
[L2]: ../../canvas/electron/main.mjs
[L3]: ../../canvas/scripts/dev-with-automation.mjs
[L4]: ../../canvas/package.json
[L5]: ../../canvas/config/defaults.json
[L6]: ../../canvas/scripts/dev-safe.mjs
[L7]: ../../canvas/.github/workflows/desktop-windows.yml
[L8]: ../../canvas/.github/workflows/ci.yml
[L9]: ../../scripts/dev.mjs
[L10]: ../../canvas/src/factory/api.ts
[L11]: ../../canvas/vite.config.ts
[L12]: ../../canvas/scripts/proxy-utils.mjs
[L13]: ../../apps/server/src/config.ts
[L14]: ../../apps/server/src/tools.ts
[L15]: ../../apps/server/src/index.ts
[L16]: ../../canvas/LICENSE
[S1]: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
[S2]: https://knowledge.digicert.com/general-information/new-private-key-storage-requirement-for-standard-code-signing-certificates-november-2022
[S3]: https://www.electronjs.org/docs/latest/tutorial/code-signing
[S4]: https://learn.microsoft.com/en-us/azure/artifact-signing/overview
[S5]: https://learn.microsoft.com/en-us/azure/artifact-signing/faq
[S6]: https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/design/select-types-of-rules-to-create
[S7]: https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/design/configure-authorized-apps-deployed-with-a-managed-installer
[S8]: https://www.electron.build/v26/docs/features/code-signing/code-signing-win/
[S9]: https://www.electron.build/docs/features/code-signing/code-signing-win/
[S10]: https://www.electron.build/v26/docs/nsis/
[S11]: https://developers.openai.com/codex/windows
[S12]: https://www.electron.build/v26/docs/features/auto-update/
[S13]: https://raw.githubusercontent.com/electron/electron/main/LICENSE
[S14]: https://raw.githubusercontent.com/electron-userland/electron-builder/master/LICENSE
