# Durable commands and watchdogs implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Roadmap milestone 4. No follow-up message is lost or sent twice across crashes, timeouts and restarts; only one factory process acts on a ledger at a time; stuck agents and undeliverable messages reach a person; a repeated API request doesn't repeat its effect.

**Architecture:** Follow-up messages become rows in a `commands` outbox, written in the same transaction as the attempt's next turn and the state change that caused them, then delivered. Each message ends with a marker (`sf-msg-<id>`). A send that may or may not have arrived (a timeout, a gateway timeout, a crash mid-send) is settled by searching the conversation's user events for the marker (`GET /api/conversations/{id}/events/search`): found means delivered, still missing after a minute means resend, and an engine without that search quarantines it for a person (resend, it arrived, cancel). Refused connections retry with bounded exponential backoff, and the tenth failure or a definite refusal goes to the Inbox. Polling ignores an attempt while a message to it is undelivered. A conversation left "starting" is looked up before it is created again. A `scheduler` lease row (owner, generation, expiry) lets one process act: it is renewed every tick and taken over at once from a dead process (or an earlier orchestrator in the same process), otherwise after it expires. Once a process holds it, every ledger write checks the lease, so a stale worker's writes fail and it stops. A watchdog marks an attempt failed after `watchdog.idleMinutes` without a new event or cost, and the existing repair and Inbox paths take over. `Idempotency-Key` on POST /runs and decide returns the first response for a repeated key.

**Tech stack:** Node 26, TypeScript, node:sqlite, Hono, React 19 (Inbox labels, Home standby notice).

**Spec:** [Roadmap milestone 4](../../autopilot/ROADMAP.md); open issues C2, C3 and C5 in [OPEN-ISSUES.md](../../autopilot/OPEN-ISSUES.md).

## Global constraints

- Message texts live in the ledger only (to deliver them); the audit log records command ids, reasons and outcomes, never texts.
- Nothing is sent before the state change it belongs to is committed.
- No new dependencies; existing runs keep working after the v4 migration.

## Review focus

1. A crash after the message reached the agent but before the factory recorded it must not send it again.
2. A crash after the state change but before the send must deliver it exactly once on restart.
3. A second process on the same data folder does nothing while the first lives, and the first stops writing once the second takes over.
4. A message to a conversation that's gone ends in a person's decision, not an endless retry.
5. The watchdog never stops an attempt whose conversation is still producing events.

### Task 1: Outbox, delivery and reconciliation
**Files:** `ledger.ts` (v4: `commands`, `leases`, `requests`; `attempts.progress_at`, `attempts.last_event`; `inbox.ref`), `openhands.ts` (`OpenHandsError.delivery`, `findUserMessage`, `latestEvent`), `orchestrator.ts`; tests `apps/server/test/autopilot-durable.test.ts`, `fake-openhands.ts` (event search, delayed replies).
- [x] Tests: crash before delivery → one delivery after restart; delivery that timed out but arrived → reconciled, not resent; engine without search → quarantine → resend/arrived decisions; refused connection → backoff → escalation after the limit; definite failure → Inbox.
- [x] Implement; run the test file.

### Task 2: Lease and fencing, start reconciliation, watchdog, idempotent requests
**Files:** `ledger.ts`, `orchestrator.ts`, `routes.ts`, `policy.ts` (`watchdog.idleMinutes`); same test file.
- [x] Tests: standby while another live owner holds the lease; takeover fences the stale worker's writes and stops it; a starting attempt whose conversation exists isn't created again; a stalled attempt is stopped and escalated while an active one isn't; the same Idempotency-Key gives one run and one decision.
- [x] Implement; full server suite.

### Task 3: Operator view and docs
**Files:** Canvas `api.ts`, `copy.ts`, `autopilot-home.tsx`, tests; README, ARCHITECTURE, ROADMAP, OPEN-ISSUES; Canvas patch.
- [x] Tests: Inbox labels the new item kind; Home says when another factory process is running Autopilot.
- [x] Implement; full verification; commit.

## Execution results (2026-10-18)

- New server tests in `autopilot-durable.test.ts` (7): crash before delivery (one delivery after restart); a lost answer and a crash mid-send reconciled by marker (no second copy); an unsearchable engine quarantining to a person (resend, or confirm it arrived); ten refused tries escalating; a gone spec conversation restarting with the lost message; two processes on one ledger (standby, takeover of a dead owner, the stale writer refused); start reconciliation and the watchdog (stops a silent agent, spares one with new events); Idempotency-Key on runs and decisions (also under concurrency).
- Caught while testing: a regex mangled by shell escaping in the key check (now written out), and a test reading an error the critic path doesn't keep (it lives in the run's pause reason).
- Self-review change: while a message is undelivered or unconfirmed, polling still records the agent's cost (budgets keep working) but doesn't change its state.
- Updated on purpose: the default policy hash (`cb6eacf60807`, the `watchdog` block) and the status shape (`scheduler`).
- `pnpm typecheck`, server source+test typecheck, `pnpm test`: 136/136. Canvas: `tsc --noEmit` clean, `eslint src/factory` 0 errors (11 existing warnings), factory Vitest 12/12 (2 new); audit labels added for every action milestones 2–4 introduced.
- Not covered: pauses, resumes, container and Git operations stay idempotent retries rather than outbox commands; the lease protects one machine's processes (another machine waits for expiry); reconciliation depends on the agent server's event search, which a live 1.55.1 server has but hasn't been exercised here.
