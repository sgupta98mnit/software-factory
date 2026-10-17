We recommend making attributable approvals and independently retained evidence the first compliance milestone.
We recommend using OSCAL for reviewed implementation descriptions and evidence exchange, with no automatic compliance claims.
We recommend a small KMS-signed checkpoint and retention pilot before adding a transparency-log service.

# 05 — Audit and compliance

## Findings

### Sources say: scope and current control catalog

The factory currently records work-order file hashes, approval events and conversation IDs in a local SHA-256 chain; it trusts `SF_USER`, and transcripts remain in OpenHands. These are the documented design, not independently tested findings in this research. [Local architecture][L1] (undated; read 2026-10-17).

Read-only source inspection also found that the status endpoint accepts a caller-supplied `approve` flag and records `LOCAL_USER`; its Host/JSON checks do not authenticate a human caller. Treat current approval as workflow traceability, not an enforced human-only security boundary. This was code inspection, not an exploit or runtime test. [API source][L2] (undated local source; read 2026-10-17).

NIST's Rev. 5 publication page identifies Release **5.2.0, August 27, 2025**, including new SA-15(13) and SA-24 controls/enhancements and software integrity/update changes. This is **>12 months old**. Use that release's machine-readable catalog rather than assuming the original 2020 PDF incorporates the additions. NIST published corresponding assessment-procedure updates; it reported no substantive changes to the baselines. [N1], [N2], [N3] (read 2026-10-17).

The catalog is not a mandatory baseline for every desktop tool. SP 800-53B provides baselines and tailoring; RMF selects controls in the context of a categorized system and its risks. The factory's own security, the development environment, the software it produces and inherited agency services need distinct implementation responsibilities. [N4], [N5] (read 2026-10-17; both **>12 months old**).

### Sources say: relevant control candidates

This **review shortlist is not a selected baseline**. Confirm parameters and 5.2.0 wording with the agency. [N6] (published 2020, **>12 months old**; read 2026-10-17).

| Family | Specific candidates and subjects |
| --- | --- |
| AU | AU-2 event selection; AU-3 record content; AU-4 capacity; AU-5 logging failures; AU-6 analysis; AU-8 timestamps; AU-9 protection; AU-10 non-repudiation; AU-11 retention; AU-12 generation. |
| AC | AC-2 accounts; AC-3 enforcement; AC-4 information flow; AC-5 separation of duties; AC-6 least privilege. |
| IA | IA-2 organizational users; IA-4 identifiers; IA-5 authenticators; IA-8 non-organizational users; IA-9 services; IA-11 reauthentication. |
| CM | CM-2 baseline; CM-3 change control; CM-4 impact analysis; CM-5 change permissions; CM-6 settings; CM-7 functionality; CM-8 inventory; CM-14 signed components. |
| SA | SA-3 lifecycle; SA-4 acquisition; SA-8 engineering; SA-9 external services; SA-10 developer configuration management; SA-11 testing; SA-15 development tools/processes. |
| SR | SR-2 supply-chain plan; SR-3 processes; SR-4 provenance; SR-5 acquisition; SR-6 supplier reviews; SR-8 notifications; SR-11 authenticity. |

We recommend mapping these to concrete factory behavior as follows; these are proposed implementation/evidence choices, not NIST-prescribed product features:

| Area | We recommend collecting |
| --- | --- |
| Audit | Actor and service identity, action/outcome, UTC event and receipt times, sequence, workspace/change/work-order IDs, before/after digests, integrity checks, retention configuration and delivery-failure alerts. |
| Access and identity | Agency sign-in subject/issuer, approval role and authorization decision; separate agent execution from approval; scoped service credentials; denied-action records. Never treat a display name as identity proof. |
| Configuration | Approved spec and repository revision, exact reviewed diff/commit, agent/tool versions, sandbox/network policy, dependency lockfile/SBOM digest, change impact and rollback decision. |
| Development and suppliers | Test and scan artifacts, unresolved findings and dispositions, reviewer decisions, endpoint/provider and model identifiers, component provenance and supplier-change notifications. |

Candidate enhancements: AU-9(2)/(3)/(4), separate storage/cryptographic protection/restricted administration; CM-3(2), tested/documented changes. AU-10(5) is withdrawn; do not present it as an active signature requirement. [N6] (read 2026-10-17).

### Sources say: continuous authorization needs current risk evidence

RMF's Monitor step covers changes, ongoing assessments, updates and reporting. Task M-6 assigns an ongoing risk-acceptability determination to the authorizing official, using such inputs as posture reports, assessment results, plans and POA&Ms. SP 800-53A supplies assessment procedures; generating a record is different from establishing control effectiveness. [N5], [N3] (read 2026-10-17; original publications **>12 months old**).

We recommend one inspectable evidence package per approved change: immutable manifest, requirements/scenarios, selected control statements, source revision, test commands/results and tool versions, security findings, reviewer identity/decision, approval digest, deployment artifact and environment, exceptions, and remote storage receipt. Record failures and skipped checks alongside passes. Preserve the evidence bytes behind every digest; a hash with no retrievable artifact is an inadequate review experience.

We recommend defining freshness with the ISSO: evidence should identify the assessed revision/environment, collection time, responsible owner, assessment objective, result and expiry/reassessment trigger. A later file edit or regenerated build should require a new review of the changed content. Periodic scans, incident handling, access reviews, runtime telemetry and remediation tracking belong in the wider agency process; this product should supply its part of the evidence, not promise continuous ATO from work-order completion.

### Sources say: OSCAL and compliance-trestle can carry the evidence

OSCAL Component Definitions describe controls supported by a component and provide reusable implementation detail for SSP authors. Assessment Results represents observations/evidence, risks and findings associated with an Assessment Plan, including continuous assessment information. These are separate models with separate purposes. [O1], [O2] (undated; read 2026-10-17).

`compliance-trestle`, originally contributed by IBM and now under OSCAL Compass, is **Apache-2.0**. Its documentation describes JSON/YAML/Markdown governance, component generation/assembly, and SSP generation from a profile and component definitions; the tutorial also points to CSV-to-component-to-SSP authoring. [T1], [T2] (undated; read 2026-10-17).

We recommend a small export, outside the desktop runtime initially:

1. Resolve `control:SI-10` to the pinned catalog's `si-10`; reject unknown, withdrawn or ambiguous identifiers and retain the original label.
2. Produce one versioned factory Component Definition, with implementation prose written/reviewed by its owner, plus evidence references for affected changes.
3. Require system owner/ISSO decisions for applicability, control/statement IDs, parameters, inherited versus shared responsibilities, implementation status and assessment objectives.
4. Add Assessment Results only when an assessor-approved plan and actual observations/results exist. Keep human approval as an approval event, with links to evidence; never manufacture a passing assessment from it.
5. Validate schema and referential links, then have the intended agency importer review the output. Keep catalog, profile, OSCAL schema and trestle versions pinned together.

Our inference: labels identify relevance, not implementation; approval does not supply an SSP boundary, inventory, control narrative, assessor independence, test coverage, risk acceptance or POA&M. Trestle cannot determine those missing facts. No repository-specific converter was established in this research. [O1], [O2], [T2] (read 2026-10-17).

### Sources say: anchoring choices solve different problems

| Option | Verified capability and limit | We recommend |
| --- | --- | --- |
| AWS KMS | Asymmetric signing keeps the private key within KMS; `Sign` supports message digests, and public keys can be exported for verification. GovCloud lists KMS in East and West and restricts export-controlled content in metadata fields. [A1], [A2], [A3] (undated; read 2026-10-17). | Sign a canonical checkpoint containing workspace ID, sequence range, previous checkpoint, chain head, evidence-manifest digest and format version. Save key ID, algorithm, signature and public key. A service signature attests the service's statement; separately bind the authenticated human approval to its exact content. |
| S3 Object Lock | Compliance mode protects an object version from deletion/overwrite, including by account root, and disallows shortening retention; governance mode permits privileged bypass. These are version-level protections. [A4] (undated; read 2026-10-17). | Upload checkpoint plus evidence bundle with explicit retention and version IDs to an independently administered account. Test retention in governance mode, then use compliance mode only after records/legal owners approve duration. Monitor failed uploads and verify retrieval. |
| Sigstore/Rekor | Rekor records signed metadata in an append-only verifiable log; public services support public auditing. Sigstore describes persisting artifact digests, signatures and certificates. Rekor is Apache-2.0 and can run independently. [G1], [G2], [G3] (undated; read 2026-10-17). | Defer a private Rekor deployment until multiple independent parties need transparency proofs. Do not send agency identities, repository URLs, sensitive metadata or attestations to the public log by default; even an artifact digest can disclose linkage. Review every public field and require agency approval of the destination. |
| Agency SIEM/SOC | **M-26-14, May 22, 2026, rescinds M-21-31** and requires risk-based continuous event monitoring and investigation/forensics capabilities. Its minimum retained logs are searchable for six months and retrievable for one year, subject to other applicable retention requirements and its scope exceptions. [P1] (read 2026-10-17). | Forward structured security/approval events to the agency's existing destination. Use authenticated transport, acknowledgments, bounded durable spooling, sequence-gap alerts and duplicate-safe IDs. Let the agency choose ingestion format, operational retention and access. SIEM forwarding complements immutable evidence storage. |

We did not confirm FedRAMP authorization of the public Sigstore services or a GovCloud-specific managed Rekor offering. AWS service presence in GovCloud also does not establish this application's authorization or every algorithm/feature's approval. Validate the precise region, endpoint, encryption/signature module requirements, retention features and agency boundary before selecting the anchoring destination. [A3], [G1] (read 2026-10-17; authorization status **unconfirmed**).

## Recommendation — our judgment and effort estimates

Agree an evidence contract with one agency ISSO/system owner (**1–2 engineer-days**, plus agency review). Bind approval to an authenticated subject and exact work-order/spec/code/evidence digests; later edits should invalidate or supersede approval (**3–5 days**, excluding identity integration). Add remote checkpoints, independent storage, retry/failure visibility and a restore exercise (**3–5 days** with provisioned services). Our threat-model inference: a local chain can be rewritten/truncated by an attacker controlling all copies; the independent checkpoint supplies the proposed trust anchor.

Prototype one component and two reviewed control responses in OSCAL/trestle (**2–4 days**, excluding SSP authoring). Use existing agency SIEM ingestion (**1–3 days** after its interface is provided). These are engineering planning guesses; agency access/procurement queues are excluded.

For adoption, trestle and Rekor pass the requested Apache/MIT/BSD-compatible **top-level** license screen; transitive dependencies and selected versions still need review. Treat AWS selection as a managed-service procurement decision. No GPL, BUSL or source-available implementation is recommended here. [T1], [G3] (read 2026-10-17).

## Open questions

- Which authorization boundary includes the factory, developer workstation, model endpoint and generated application? Who selects/tailors the baseline and owns inherited controls?
- Which events, artifacts, exclusions, records schedule, litigation holds and data classifications does the agency require?
- Who may approve, when is reauthentication needed, and which changes require independent security review?
- Which current CISA Logging Reference Architecture and agency logging plan governs this deployment? The memo was read; that architecture's latest version was **not independently confirmed** here. [P1] (read 2026-10-17).
- Which OSCAL schema/profile and receiving GRC importer will the agency accept? What independent failure/restore demonstration is required?

## Sources and currency

All links below were opened/read **2026-10-17**. “Undated” means the page did not establish a publication/update date; a recent crawl is not a publication date. A dated old standard may remain applicable; age is not evidence of rescission.

- L1 — [Repository architecture][L1]. Undated local document; documented current design, not runtime verification.
- L2 — [Factory API source][L2]. Undated local source; read-only inspection, no runtime test.
- N1 — [SP 800-53 Rev. 5 publication/status][N1]. Published September 2020; planning update 2025-08-27; **>12 months old**.
- N2 — [NIST Release 5.2.0 announcement][N2]. 2025-08-27; **>12 months old**; latest identified release, no newer release confirmed.
- N3 — [SP 800-53A Rev. 5][N3]. January 2022; planning update 2025-08-27; **>12 months old**.
- N4 — [SP 800-53B][N4]. December 2020 update; 2025-08-27 planning note; **>12 months old**.
- N5 — [SP 800-37 Rev. 2][N5]. December 2018; **>12 months old**; official final source, no newer final confirmed here.
- N6 — [SP 800-53 Rev. 5 PDF][N6]. September/December 2020; **>12 months old**; supplement with 5.2.0 changes.
- O1/O2 — [OSCAL Component Definition][O1] / [Assessment Results][O2]. Undated living documentation; exact page update dates unconfirmed.
- T1/T2 — [Trestle repository/license][T1] / [authoring tutorial][T2]. Undated living sources; verify pinned release before adoption.
- A1/A2/A3/A4 — [KMS asymmetric keys][A1], [Sign API][A2], [GovCloud KMS][A3], [S3 Object Lock][A4]. Undated vendor documentation; precise update dates unconfirmed.
- G1/G2/G3 — [Rekor overview][G1], [Sigstore overview][G2], [Rekor repository/license][G3]. Undated living sources; public-service federal authorization unconfirmed.
- P1 — [OMB M-26-14][P1]. 2026-05-22; current memo found in OMB's index; agency implementation/current LRA must be checked.

[L1]: ../ARCHITECTURE.md
[L2]: ../../apps/server/src/index.ts
[N1]: https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final
[N2]: https://csrc.nist.gov/news/2025/nist-releases-revision-to-sp-800-53-controls
[N3]: https://csrc.nist.gov/pubs/sp/800/53/a/r5/final
[N4]: https://csrc.nist.gov/pubs/sp/800/53/b/upd1/final
[N5]: https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-37r2.pdf
[N6]: https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-53r5.pdf
[O1]: https://pages.nist.gov/OSCAL/learn/concepts/layer/implementation/component-definition/
[O2]: https://pages.nist.gov/OSCAL/learn/concepts/layer/assessment/assessment-results/
[T1]: https://github.com/oscal-compass/compliance-trestle
[T2]: https://oscal-compass.dev/compliance-trestle/latest/tutorials/Trestle_authoring/ssp_profile_catalog_authoring/
[A1]: https://docs.aws.amazon.com/kms/latest/developerguide/symmetric-asymmetric.html
[A2]: https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html
[A3]: https://docs.aws.amazon.com/govcloud-us/latest/UserGuide/govcloud-kms.html
[A4]: https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html
[G1]: https://docs.sigstore.dev/logging/overview/
[G2]: https://docs.sigstore.dev/
[G3]: https://github.com/sigstore/rekor
[P1]: https://www.whitehouse.gov/wp-content/uploads/2026/05/M-26-14-Ensuring-Effective-and-Efficient-Agency-Logging-and-Network-Visibility-to-Defend-Against-Evolving-Cyber-Threats.pdf
