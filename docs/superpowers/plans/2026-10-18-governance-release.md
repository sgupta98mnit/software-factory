# Governance and release implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Roadmap milestone 6. People sign in and act within roles. Spending holds reservations across run, work-order and daily scopes. Work orders with mapped controls need an ISSO's approval of their verified commit, and finished runs need a release approval bound to their evidence. Evidence is retained write-once, attestations are exported only from recorded facts, and people hear about decisions waiting for them. A backup restores to a ledger, audit log and evidence that verify.

**Architecture** (one commit per part):
1. **Sign-in and roles (`auth.ts`).**
   - `SF_AUTH=local` is the default: the existing local user holds every role (`SF_LOCAL_ROLES` narrows them), and the mode is labelled in the UI.
   - `SF_AUTH=oidc` uses Authorization Code + PKCE against the agency's issuer. Discovery, a token exchange and ID token checks are done with node:crypto: JWKS signature (RS256/ES256), issuer, audience, expiry and nonce.
   - Sessions are hashed ids in SQLite behind an HttpOnly SameSite=Strict cookie. Roles come from a claim (`SF_OIDC_ROLES_CLAIM`, mapped by `SF_OIDC_ROLE_MAP`). The audit actor is the issuer and subject, not the display name.
   - Roles are engineer, approver, isso, release_manager and admin. Every change checks the role its action needs; each Inbox kind names the role that decides it.
2. **ISSO and release approvals.**
   - With `governance.controlApproval: required`, a ready work order with controls waits in `awaiting_control_approval`. An ISSO approves its verified head (the same freshness rule as merge approvals), and merging requires that approval.
   - With `governance.releaseApproval: required`, a finished run opens a `release` item. Approving it writes a canonical approval envelope (run, artifact commit, evidence digest, policy hash, approver identity and roles) to the evidence store. Four-eyes: the run's creator can't approve its own release.
3. **Scoped budgets with reservations.** An active attempt holds `budget.reserveUsd` minus what it has spent, so parallel starts can't overrun a scope. Before any agent starts, its run, work order and day (`budget.perDayUsd`, across runs, raised per day from the Inbox) must have room for another reservation.
4. **Evidence retention and backups.**
   - Exported packets and release envelopes are written once to `data/evidence/<run>/<kind>-<sha256>.json` (read-only, never overwritten). They are verified by digest and pruned only after `SF_EVIDENCE_RETENTION_DAYS`.
   - `POST /admin/backup` snapshots the ledger (`VACUUM INTO`), the audit log and the evidence store, with a digest manifest. `verifyBackup`/`restoreBackup` (and `pnpm --filter @sf/server restore`) check every digest and the audit chain before restoring into an empty folder.
5. **Attestations.**
   - An in-toto Statement v1 for a finished run's artifact commit, in a DSSE envelope signed with the factory's Ed25519 key (labelled as the factory's attestation, not a person's).
   - An OSCAL assessment-results document.
   - Both refuse (409, naming what's missing) unless the facts exist. For the attestation: a recorded and available artifact, every merged work order verified at its commit, and stored evidence. OSCAL additionally needs an ISSO approval per control and the agency's assessment plan reference.
6. **Notifications.** With `SF_NOTIFY_WEBHOOK`, new Inbox items are posted once (titles, kinds, run changes, a link; never goals or prompts) and a daily digest goes out at `notify.digestHour`. Failures retry without repeating sent items.

**Tech stack:** Node 26 (crypto, fetch, sqlite), Hono, React 19.

**Spec:** [Roadmap milestone 6](../../autopilot/ROADMAP.md); research [04 desktop identity](../../research/04-desktop-identity.md) and [05 audit and compliance](../../research/05-audit-compliance.md).

## Global constraints

- No new dependencies. In local mode everything still works as before, as one person with every role.
- Approvals bind to exact commits and digests. No export claims compliance or authorization; the limitations say so.
- Session ids, tokens and keys never reach the audit log, evidence or responses, beyond a session's own cookie.

## Review focus

1. A request without a valid session (or with an expired one) changes nothing in OIDC mode, and a forged or wrongly signed ID token is refused.
2. A person without the role an Inbox kind needs can't decide it, and a merge approval can't stand in for an ISSO's.
3. Parallel dispatch can't start more agents than the remaining budget can reserve.
4. A stored evidence file can't be overwritten through the factory, and a changed one fails verification.
5. An export with a missing fact is refused, never produced with a gap.

### Tasks
- [x] 1. `auth.ts`, sessions (ledger v6), routes and middleware, the actor taken from the request everywhere, role checks; tests with a stand-in OIDC issuer.
- [x] 2. Control and release approvals, envelopes, four-eyes; tests.
- [x] 3. Reservations and the daily scope; tests.
- [x] 4. Evidence store, retention, backup/verify/restore with a CLI; tests.
- [ ] 5. DSSE-signed in-toto Statement and OSCAL assessment results, gated on facts; tests.
- [ ] 6. Webhook notifications and digest; tests.
- [ ] 7. Canvas (sign-in, the signed-in user, release state, exports) and docs; full verification.
