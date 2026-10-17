## Why

Applicants call the help line mainly to ask where their claim stands. A self-service status lookup answers that question without a call (USDS Playbook, Play 1: help-line call notes are the research behind this).

## What Changes

- Add a claim status lookup: an applicant enters a claim number and sees its status in plain language.
- No sign-in is needed for the lookup, so it must never show personal data.
- Every lookup is audit-logged without storing the raw claim number.

## Capabilities

### New Capabilities

- `claim-status`: look up a claim's status by claim number and explain it in plain language.

### Modified Capabilities

None.

## Impact

- New small HTTP service (`claim-status-service`), TypeScript on Node 22.
- NIST 800-53 controls touched: SI-10 (input validation), AU-2 / AU-3 / AU-12 (audit events and content).
- Section 508: the status page must meet WCAG 2.0 AA.
