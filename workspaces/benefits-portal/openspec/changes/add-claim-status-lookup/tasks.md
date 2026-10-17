## 1. Service skeleton

- [ ] 1.1 Create `claim-status-service` with TypeScript, a test runner and `GET /health`

## 2. Status lookup

- [ ] 2.1 Add `GET /claims/:claimId/status` backed by an in-memory store
- [ ] 2.2 Validate claim IDs and return 400 for malformed ones
- [ ] 2.3 Return 404 for unknown claims

## 3. Audit

- [ ] 3.1 Write one audit record per lookup with a hashed claim ID
- [ ] 3.2 Add a test proving raw claim IDs never reach any log
