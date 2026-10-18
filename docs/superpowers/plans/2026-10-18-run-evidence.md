# Run evidence implementation plan

**Goal:** Deliver a usable, audited evidence download for terminal Autopilot runs.
**Architecture:** SQLite snapshot + verified audit snapshot → allowlisted packet → canonical SHA-256 digest → local API → Canvas download. Reuse existing orchestration locks and audit queue; no new service or dependency.
**Tech stack:** Node/Hono/TypeScript, node:sqlite, Git, React 19/React Query, Vitest/MSW.
**Spec:** [Terminal run evidence](../specs/2026-10-18-run-evidence.md).

## Global constraints

Follow root and Canvas AGENTS.md, keep API localhost, never modify OpenSpec/Backlog formats, audit export side effects without sensitive content, keep Canvas changes in factory, regenerate patch. Work on `codex/factory-evidence`; commit and push this feature branch under the user's existing commit/push instruction. Keep main unchanged for review.

## Review focus

1. Branch movement or cleanup must not change the artifact identity (real Git regression).
2. Raw goals, outputs, replies and notes must not escape the export (sentinel leakage regression).
3. Missing/failed checks must not become independent verification or control pass claims (packet assertions).
4. Corrupt audit data and pending writes must not produce a trusted checkpoint (audit/export regression).
5. A failed download must remain retryable, and successful downloads must release browser resources (MSW UI regression).

### Task 1: Evidence API and operator download

**Files:** New `apps/server/src/autopilot/evidence.ts`, `apps/server/test/autopilot-evidence.test.ts`, `canvas/src/factory/components/evidence-download.tsx`; modify `audit.ts`, `autopilot/orchestrator.ts`, `autopilot/routes.ts`, `canvas/src/factory/api.ts`, `canvas/src/factory/copy.ts`, `canvas/src/factory/routes/autopilot-pipeline.tsx`, `canvas/__tests__/factory/autopilot.test.tsx`, README, architecture and Canvas patch.

**Interfaces:** Consumes Ledger Run/WorkOrder/Attempt/Check/Inbox records, AuditEvent and Git commit lookup. Produces `EvidenceExport` at POST `/runs/:id/evidence`; Canvas consumes it only for terminal runs. Evidence generation must use the orchestrator's lock, not expose filesystem paths to the HTTP client.

- [x] Write endpoint tests using real ledger, temp Git repo and audit records for export/cleanup/branch movement, missing artifact, historical failed checks, sensitive-field omission, invalid audit and 404/409. Run `node --import tsx --test test/autopilot-evidence.test.ts` in apps/server. Expected: new endpoint fails before implementation.
- [x] Implement the audit snapshot and allowlisted packet/digest, serialize the export in the orchestrator and mount its route. Run the focused tests. Expected: all pass, digest recomputes and corruption is refused.
- [x] Write UI behavior tests with MSW for terminal download, failure/retry and active-run absence. Run targeted Vitest. Expected: evidence control missing before implementation.
- [x] Implement typed API method and localized download control with pending/error handling and object URL cleanup. Run targeted Vitest. Expected: all pass.
- [x] Document format/use/limitations, export Canvas patch; run root typecheck/test, Canvas tsc/eslint and targeted UI tests. Expected: no errors; report existing warnings separately.
- [x] Obtain one independent whole-change review; address material defects with regression tests. Leave work ready for review on the feature branch.

## Verification commands

Use `pnpm typecheck`, `pnpm test`, Canvas `npx tsc --noEmit`, `npx eslint src/factory` and `pnpm export:canvas-patch`. In this WSL installation the Linux Node/pnpm shims are broken: use installed Windows node.exe with the installed pnpm CLI and `-r typecheck` / `-r test`, which run the same workspace payloads. Use node.exe directly for focused tsx and Vitest commands. Do not change dependencies to work around the host tooling.

## Execution results (2026-10-18)

- Server endpoint RED: 5 failures on missing endpoint; GREEN: 5 passes.
- Canvas RED: 2 download tests fail with missing control, 3 existing passes; GREEN: all 5 pass, including downloaded JSON contents, duplicate-click protection, object URL release and error retry.
- Independent review identified two material audit errors. Regression tests failed first, then passed after safe handling of append failures and rejection of an in-process audit-tail mismatch. Final endpoint suite: 7/7.
- Final root workspace typecheck and tests: pass, 115/115 server tests. Separate typecheck of server source and all tests: pass.
- Canvas typecheck: pass. Factory ESLint: 0 errors, 11 existing `factory-markdown.tsx` token warnings. Canvas patch regenerated.
- Real production HTTP server smoke: create → cancel → export, no agent/model execution; packet digest verified with an independent canonical serializer. No live Canvas screenshot or browser compatibility verification was obtained; MSW tests establish automated coverage only.

Decision: deliver the implemented terminal packet flow and keep browser appearance/compatibility verification explicit before merge. Cost if wrong: a browser-specific download/rendering defect could remain despite passing automated tests. Later roadmap milestones and the full C13 scenario graph are not claimed complete.
