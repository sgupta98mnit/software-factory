# Isolated execution implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Roadmap milestone 2. Autopilot agents and the gates that run their code execute either locally (explicitly identified as not isolated) or in one hardened container per attempt, chosen by the pinned policy; execution that a required isolation policy cannot satisfy is refused.

**Architecture:** `execution.ts` defines a provider contract with two implementations. `local` keeps today's behavior (the shared Canvas agent server, host paths, host gates). `container` follows the agent server's own per-conversation runtime and the SDK's `DockerWorkspace` lifecycle, driven by the factory through the Docker CLI: `docker run` of a digest-pinned agent-server image with only the attempt's worktree mounted at `/workspace` (its `.git` file shadowed read-only, so nothing in the container can redirect the host's git), a factory-owned state directory, per-role credential names, memory/CPU/PID limits, an explicit network, a loopback-only port and a session key derived from a local secret. The factory copies the agent profile into the container's agent server over REST and starts the conversation there. Gates in container mode run as throwaway `docker run --rm` containers without credentials. Containers are named and labelled per attempt, so a restart reconnects or reports the runtime gone, and a sweep removes retired and orphaned ones.

**Tech stack:** Node 26, TypeScript strict, Hono, node:sqlite, Docker CLI (external, not a dependency), React 19 + React Query in Canvas.

**Spec:** [Roadmap milestone 2](../../autopilot/ROADMAP.md) and the agent server 1.55.1 sources (`openhands/agent_server/docker_runtime/registry.py`, `openhands/workspace/docker/workspace.py`).

## Global constraints

- Root and Canvas `AGENTS.md`; no new dependencies; API stays on 127.0.0.1; `audit()` every change without secrets or prompts.
- Never put a credential value in argv, the ledger, the audit log, evidence or an HTTP response: `docker run -e NAME` takes the value from the Docker CLI's environment.
- The image must be pinned by digest (`name@sha256:<64 hex>`); the factory never pulls images.
- No silent fallback: a container policy that preflight cannot satisfy refuses execution; `SF_REQUIRE_ISOLATION=1` refuses local execution.
- Local runs behave exactly as before apart from recorded execution facts.

## Review focus

1. A Windows path with a drive letter, spaces or a comma reaches Docker intact (`--mount` CSV quoting); UNC paths are refused.
2. After a factory restart, a live container is reused (same name, recomputed session key) and a removed one turns its attempt into an error the repair loop handles, never an endless "unreachable" wait.
3. Docker going down mid-run pauses progress like an unreachable agent server instead of recording failed gates.
4. Containers on the agent network that can reach the factory API on the host are reported as a preflight problem, because agents could otherwise approve their own work.
5. Teardown never removes the container of an attempt that can still receive a follow-up (repair rounds reuse the builder conversation).

### Task 1: Policy and provider contract

**Files:** Modify `apps/server/src/autopilot/policy.ts`, `apps/server/src/config.ts`; create `apps/server/src/autopilot/execution.ts`; test `apps/server/test/autopilot-execution.test.ts`.

**Interfaces (produces):**
- `Policy.execution: { provider: "local" | "container"; container: ContainerPolicy }` with `ContainerPolicy = { image: string | null; gateImage: string | null; network: string | null; gateNetwork: string | null; user: string | null; memory: string; cpus: number; pids: number; hostPathStyle: "native" | "wsl"; credentials: Record<AttemptRole, string[]>; startTimeoutSec: number }`; defaults `local`, memory `4g`, cpus 2, pids 512, `native`, empty credentials, 120 s.
- `parsePolicy` refuses: container without a digest-pinned image or without a network; network `host` or `container:*`; credential names outside `^[A-Z_][A-Z0-9_]*$` or starting `SF_`/`OH_`/`DOCKER_`.
- `execution.ts`: `ExecutionFacts`, `Preflight`, `RuntimeUnavailable`, `RuntimeGone`, `dockerPath(hostPath, style)`, `mountArg(source, target, readonly)`, `createExecution(policy, deps) → Execution` with `preflight`, `prepare`, `clientFor`, `release`, `sweep`, `gateRunner`.

- [x] Tests: path mapping (drive/backslash/space/comma, wsl style, UNC refused); policy refusals above; local preflight identifies `isolated: false` and fails only under `SF_REQUIRE_ISOLATION`; container preflight lists Docker down, missing image, missing network, missing credential, failed mount probe, reachable control plane.
- [x] Implement; run `node --import tsx --test test/autopilot-execution.test.ts`.

### Task 2: Container lifecycle with a fake Docker

**Files:** Create `apps/server/test/fake-docker.ts`; modify `apps/server/test/fake-openhands.ts` (root `/health`, `POST /api/agent-profiles/{name}`, path mapping for handlers), `apps/server/src/autopilot/openhands.ts` (`getProfile`, `saveProfile`).

- [x] Tests: `prepare` runs one container with `--cap-drop ALL`, `no-new-privileges`, limits, network, loopback port, the four mounts, `-e` names only (values only in the Docker CLI env), waits for health, copies the profile, returns `/workspace`; `clientFor` after a new provider instance reconnects; a removed container gives `null`; `release` and `sweep` remove by name/label; a gate runs as `docker run --rm` without credentials on the gate network and is removed on timeout.
- [x] Implement; run the same test file.

### Task 3: Orchestrator, ledger, routes and evidence

**Files:** Modify `ledger.ts` (schema v2: `attempts.runtime` JSON, `checks.runner`), `orchestrator.ts`, `gates.ts`, `integrator.ts`, `prompts.ts`, `routes.ts`, `evidence.ts`, `index.ts`; test `apps/server/test/autopilot-isolation.test.ts`.

- [x] Tests: a container-mode builder runs in its own container with `/workspace`, its gates run through Docker, its reviewer reads `/factory/changes.diff`, and its containers are removed once it merges; a restart mid-build reconnects; `createRun` is refused (and audited) when isolation cannot be satisfied; local attempts record `{ provider: "local", isolated: false }` and evidence shows the execution facts without host paths.
- [x] Implement; run focused tests, then `pnpm typecheck` and `pnpm test`.

### Task 4: Operator flow and documentation

**Files:** Canvas `src/factory/api.ts`, `copy.ts`, `routes/autopilot-home.tsx`, `routes/autopilot-pipeline.tsx`, `__tests__/factory/autopilot.test.tsx` (and remove the leftover `zz-debug.test.tsx`); README, ARCHITECTURE, ROADMAP; regenerate the Canvas patch.

- [x] Tests (MSW): Home says agents run locally without isolation, or shows the container image/network with a Check isolation button and its problems; the run page shows the execution fact; a container attempt shows "Isolated" and no Canvas conversation link.
- [x] Implement; run `npx vitest run __tests__/factory`, `npx tsc --noEmit`, `npx eslint src/factory`, `pnpm export:canvas-patch`; commit.

## Execution results (2026-10-18)

- New server tests: 6 provider tests (`autopilot-execution.test.ts`) and 3 orchestrator tests (`autopilot-isolation.test.ts`). The provider tests caught one defect before commit: exit code 127 from `docker run` (a command missing in the image) was read as "Docker unavailable"; the CLI failing to start is now its own code.
- A self-review found that a fresh builder, a merged work order's cleanup, a cancel or a finished run removed a worktree while an older container could still have it mounted; containers are now removed before their folder.
- Root typecheck, server source+test typecheck and `pnpm test`: 124/124 pass. Canvas: `tsc --noEmit` clean, `eslint src/factory` 0 errors (11 existing token warnings in `factory-markdown.tsx`), factory Vitest 8/8 (3 new). The leftover `zz-debug.test.tsx` probe was removed from Canvas and the patch.
- Updated on purpose: the default policy hash (`e649538d0b98`, for the `execution` block) and the run and status response shapes in the route tests.
- Not verified: a live Docker engine and agent-server image (Docker Desktop's engine wasn't running here), so the real image's health endpoint, its ACP tooling, profile import and file ownership on bind mounts are untested. Egress control is the chosen network's job; preflight only checks that this machine's factory and Canvas ports are unreachable from it.
- Local gates no longer inherit the factory's own `SF_*` settings or `LOCAL_BACKEND_API_KEY` (an open item from the C5 review).
