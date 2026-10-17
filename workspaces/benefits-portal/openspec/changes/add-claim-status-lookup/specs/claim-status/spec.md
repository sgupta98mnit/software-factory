## ADDED Requirements

### Requirement: Look up a claim by number

The system SHALL return the current status of a claim when given a valid claim number, with a plain-language explanation of that status.

#### Scenario: Known claim

- **WHEN** an applicant submits a valid claim number for an existing claim
- **THEN** the system returns the claim's status and a one-sentence plain-language explanation

#### Scenario: Unknown claim

- **WHEN** an applicant submits a valid claim number that does not exist
- **THEN** the system responds that no claim was found, without revealing whether similar numbers exist

### Requirement: Reject malformed claim numbers

The system SHALL reject claim numbers that do not match the pattern of two capital letters, a hyphen and six digits (for example `AB-123456`).

#### Scenario: Malformed number

- **WHEN** an applicant submits `12345`
- **THEN** the system rejects the request with a clear message describing the expected format

### Requirement: Audit every lookup without the raw claim number

The system SHALL write one audit record for every lookup, containing the time, the outcome and a SHA-256 hash of the claim number, and SHALL NOT write the raw claim number to any log.

#### Scenario: Lookup is audited

- **WHEN** any lookup completes, whether it succeeds, is rejected or finds nothing
- **THEN** exactly one audit record is written and it does not contain the raw claim number
