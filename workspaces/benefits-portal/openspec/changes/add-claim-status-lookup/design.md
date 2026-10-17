## Context

Small public-facing service; no sign-in for status lookups. Moderate impact system.

## Decisions

- **Stack:** TypeScript on Node 22 with the built-in `node:http` server; no framework needed at this size.
- **Storage:** an in-memory store of sample claims for this change; a database comes later.
- **API:** `GET /health` and `GET /claims/:claimId/status` returning `{ claimId, status, explanation }`.
- **Validation:** claim IDs must match `^[A-Z]{2}-\d{6}$`; anything else returns HTTP 400.
- **Audit:** append one JSON line per lookup to a separate audit log, with `sha256(claimId)` instead of the ID.

## Controls

| Control | How this design meets it |
| --- | --- |
| SI-10 Information input validation | Strict claim-ID pattern, 400 on mismatch |
| AU-2 Event logging | Every lookup is an audited event |
| AU-3 Content of audit records | Time, outcome, hashed claim ID |
| AU-12 Audit record generation | Audit write happens in the request path, tested |

## Risks

- Enumeration of claim numbers: mitigated later with rate limiting (out of scope here).
