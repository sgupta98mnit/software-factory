We recommend agreeing an agency-specific AI use, data and acquisition decision before an operational pilot.
We recommend treating the coding assistant, its model service and the delivered application as separate review subjects.
We recommend shipping a reusable evidence packet and secure defaults, while leaving formal risk acceptance with agency officials.

# 06 — Federal AI policy

## Findings

### Sources say: which OMB policies are current

OMB's index lists M-25-21/22 and newer M-26-04 LLM procurement guidance. No later replacement for these was identified in targeted official searches; unpublished agency instructions and later changes remain outside that finding. [P0] (undated; read 2026-10-17).

| Instrument | Verified status and date |
| --- | --- |
| M-24-10 | Rescinded/replaced by **M-25-21, April 3, 2025**. Use the replacement for current general agency AI-use analysis. [P1] (read 2026-10-17; **>12 months old**). |
| M-24-18 | Rescinded/replaced by **M-25-22, April 3, 2025**. Use the replacement for AI acquisition. [P2] (read 2026-10-17; **>12 months old**). |
| M-26-04 | **December 11, 2025**; complements M-25-22 and implements LLM “Unbiased AI Principles” procurement guidance. It is an additional layer, not a replacement of M-25-21/22. [P3] (read 2026-10-17). |
| M-26-05 | **January 23, 2026**; rescinds software-security memos **M-22-18 and M-23-16**. Distinguish M-22-18 from the AI acquisition memo M-24-18. [P4] (read 2026-10-17). |

### Sources say: M-25-21 governs use, with risk-based distinctions

M-25-21 covers AI developed, used or acquired by/on behalf of covered agencies, excludes National Security Systems (NSS), and has section-specific exceptions, including Intelligence Community provisions. High-impact status depends on AI output serving as a principal basis for decisions/actions significantly affecting specified rights or safety; human oversight does not automatically remove that status. High-impact practices include predeployment testing, impact assessment with independent review and signed risk acceptance, monitoring, operator training, human intervention/accountability, and appropriate remedies/feedback. The implementation deadline was 365 days after issuance. Agencies must maintain applicable inventories; the text recommends generative-AI acceptable-use policy. [P1, Appendix §§1, 3–6][P1] (read 2026-10-17; **>12 months old**).

We recommend submitting actual permissions, repository sensitivity, automated actions, review gates and deployment destinations to the agency CAIO process. Our inference: drafting reviewed code may warrant a different determination from autonomous access-control changes or deployments. A checkbox should not decide high-impact status, and coding assistants have no exemption established here.

We recommend separate descriptions of the AI coding workflow and any AI functionality in the delivered application. Our interpretation: LLM authorship alone should not make a deterministic application an operational AI system; calling a consequential agent a development tool should not settle its classification. Retain the authorized rationale.

### Sources say: M-25-22 governs buying AI and supplier terms

M-25-22 addresses AI acquired by/on behalf of agencies, with exceptions including NSS, Intelligence Community elements and incidental contractor use not directed/required by the contract. The common-commercial-product exception considers substantial non-AI functions; it is not a blanket exemption for commercial AI tools. Its contract coverage starts with solicitations and extension options 180 days after issuance. It directs agency acquisition procedures, cross-functional review, privacy/IP/data terms, vendor-lock-in protections and evaluation access. Contracts must prohibit training publicly/commercially available AI on nonpublic agency inputs/results absent explicit consent, and enable ongoing testing/monitoring; agency-operated information systems still require ATO. Agencies determine when unsolicited contractor AI use should be disclosed. [P2, §§2–4][P2] (read 2026-10-17; **>12 months old**).

We recommend a factsheet covering providers/subprocessors, endpoint/region, model/agent versions, data flows, retention/training terms, testing, updates/rollback, exports, pricing/licensing and incident contacts. Have contracting/privacy officials approve terms. Our scope interpretation: incidental-contractor treatment does not resolve separate contract, security or data-handling rules for personal services.

### Sources say: newer LLM transparency requirements matter to a reseller too

M-26-04 requires new LLM solicitations/orders after issuance to include contractual requirements for the named truth-seeking and ideological-neutrality principles. Existing contracts should be modified where practicable, before extension options at latest; agency procurement policies were due March 11, 2026. Agencies must request an acceptable-use policy, model/system/data cards, end-user resources and feedback mechanism, including for embedded LLMs. The memo addresses intermediaries and encourages avoiding demands for sensitive internals such as model weights. It excludes NSS and specified incidental administrative contractor use; free/open-source LLM acquisitions have a different due-diligence treatment. Its sunset is two years after issuance unless OMB provides otherwise. [P3, Scope, Agency Actions, Appendix A][P3] (read 2026-10-17).

We recommend passing through dated provider documentation, identifying Radiant's responsibilities, recording approved configurations and preserving an output-reporting channel. A factory prompt/review gate should not be sold as proof of model procurement compliance; ask contracting staff to allocate obligations across intermediaries.

### Sources say: NIST AI RMF is voluntary guidance, currently under revision

NIST identifies AI RMF 1.0 as voluntary and says it is being revised under the AI Action Plan. The released framework dates to **January 26, 2023**; its functions are Govern, Map, Measure and Manage. NIST also identifies a July 2024 Generative AI Profile and an April 7, 2026 critical-infrastructure profile **concept note**. A concept note is not a finalized replacement framework. No final AI RMF 2.0 was confirmed in the official sources reviewed. [N1], [N2] (read 2026-10-17; 2023/2024 publications **>12 months old**; landing-page update date unconfirmed).

We recommend a workflow profile: assign owners/acceptable uses; map repository/model/tool boundaries and harms; evaluate task success, unsafe actions, secret leakage and vulnerabilities; manage denials, escalation, rollback and model changes. Compare with the human workflow and retain failures. These are our suggested tests, not mandatory RMF benchmarks. Check whether agency policy/contracts incorporate selected practices; voluntary guidance alone establishes neither ATO nor product certification. [N1], [N2] (read 2026-10-17).

### Sources say: SP 800-218A concerns AI model development

SP 800-218A, final **July 26, 2024**, augments SSDF 1.1 with practices specifically for AI model development; its audience includes AI model producers, AI system producers and acquirers. It should be used with SP 800-218. Its technical recommendations include protecting model-related artifacts and reviewing/testing AI model code and models. It does not state that every application whose author used a coding assistant must perform foundation-model training controls. [N3], [N4] (read 2026-10-17; **>12 months old**).

NIST still presents SSDF 1.1 as the February 2022 final, while **SSDF 1.2/SP 800-218 Rev. 1** is an **initial public draft dated December 17, 2025** with comments closed. A later final was not confirmed. M-26-05 now calls for agency risk-based software/hardware assurance and inventories; agencies may still choose attestation forms and SBOM contract terms. It does not justify describing the rescinded M-22-18 attestation process as universally mandatory. [N5], [N6], [P4] (read 2026-10-17; SSDF 1.1 **>12 months old**).

We recommend protected changes, dependency review, tests/scans, provenance, vulnerability response and human acceptance for **all** code. If the factory trains/fine-tunes/distributes models or builds an AI application, select relevant 800-218A practices separately. Obtain provider evidence for model/data responsibilities; an integrator should not invent training evidence for its supplier.

### Sources say: CISA Secure by Design is an engineering expectation

CISA's official April 13, 2023 announcement urges manufacturers to ship secure-by-design/default products, own customer security outcomes, be transparent/accountable about vulnerabilities, and provide executive commitment to security. These are guidance/recommendations, not a universal AI-tool authorization. [C1] (read 2026-10-17; **>12 months old**). The direct CISA hub and updated-guide URLs could not be retrieved in this research; their current revision/supersession status is **unconfirmed**. Do not label the 2023 announcement the latest guide.

We recommend restrictive execution/network defaults, approvals protected from agent credentials, accessible security controls, logs, trustworthy updates and vulnerability response. Document escape hatches and attribute their use. These are our product proposals; an agent's security assertion should not replace independent checks.

### Sources say: FedRAMP 20x is beyond the 2025 pilots

FedRAMP's **October 8, 2026** update reports public 20x certification pipelines and finalized Class B/C requirements, with agencies already using certified services. The Consolidated Rules timeline lists Class A opening August 3 and B/C August 31, 2026; mandatory adoption begins January 1, 2027, subject to specific applicability/effective dates. The October 15 changelog announces a **Class D pilot requirements RFC**, not completed general High certification availability. [F1], [F2], [F3] (read 2026-10-17).

Current terminology is **FedRAMP Certified**, satisfying the statutory concept of authorized. A certification profile includes type, path and class; a Marketplace presence alone must not be read as evidence of a particular certified boundary or suitability. Agency responsibilities still include reviewing the package, configuring/assessing integration, authorizing the agency system and monitoring agency-owned controls. [F4], [F5] (read 2026-10-17).

FedRAMP's current scope examples explicitly put cloud coding assistants accessing private, controlled code **in scope**, and assistants on entirely public repositories with no sensitive predecisional queries **out of scope**. Only an agency determines scope for its use case. [F6] (undated living guidance; read 2026-10-17).

We recommend separate reviews of the desktop application and each cloud model/storage/telemetry service. Record offering, status/type/class, region, covered features, customer duties and agency authorization. One certified endpoint/infrastructure service should not become a blanket “FedRAMP approved” claim for factory or generated code. Pursue factory cloud certification only if a later hosted offering warrants it.

## Recommendation — our judgment and effort estimates

Create one reusable agency pilot packet (**2–3 engineer-days**, plus agency review): intended use and prohibited actions; data-flow/boundary diagram; provider/model documentation and acquisition terms; permissions and human gates; proposed high-impact determination rationale; test/security evidence; incident/rollback/update ownership; and endpoint-specific authorization evidence. Ask the CAIO, system owner/ISSO, privacy and contracting staff to resolve the applicable policy and contract decisions before agency code enters the workflow.

Add a small representative coding/sandbox evaluation and retain results (**2–4 days** with an existing test environment), then refresh it on meaningful model/agent/permission changes. Preserve independent human approval tied to reviewed artifacts; do not implement a generic “OMB compliant” badge. These are planning estimates, not regulatory timeframes or approval guarantees. No new dependency is proposed in this policy note; future implementation choices should stay within the requested MIT/Apache/BSD-compatible license policy, with GPL, BUSL and source-available choices flagged instead of adopted.

## Open questions

- What agency, contract clauses, data classifications, CAIO determination process and local acceptable-use policy apply? General executive-branch memo scope is not identical across these instruments. [P1], [P2], [P3] (read 2026-10-17).
- Are any systems NSS or Intelligence Community systems? Separate policy applies; the June 5, 2026 **NSPM-11** addresses AI in the national-security enterprise. This note does not establish its implementation requirements for a defense/intelligence deployment. [P1], [P2], [P7] (read 2026-10-17).
- Has the agency incorporated specific AI RMF/SSDF/800-218A practices or additional disclosure/evaluation clauses into its current contract?
- Which exact model/region/service features are covered by the selected cloud offering's current package? Has its status changed since this dated review?
- What is CISA's current Secure by Design guide revision, and what newer agency directives or final NIST publications must be checked at the pilot date?

## Sources and currency

All sources below were opened/read **2026-10-17**. “Undated” identifies missing publication/update metadata, not presumed freshness. “No later replacement confirmed” is limited to this review; agency-specific implementation and later changes require rechecking.

- P0 — [OMB memorandum index][P0]. Undated living index; includes FY2026 memos through M-26-19 dated 2026-09-10.
- P1/P2 — [M-25-21][P1] / [M-25-22][P2]. Both 2025-04-03, **>12 months old**; current general use/acquisition replacements identified.
- P3 — [M-26-04][P3]. 2025-12-11; supplemental LLM guidance; sunset stated in text, no intervening replacement found.
- P4 — [M-26-05][P4]. 2026-01-23; software/hardware security policy, rescinds M-22-18/M-23-16.
- P7 — [NSPM-11][P7]. 2026-06-05; separate national-security scope; implementation not exhaustively researched.
- N1/N2 — [NIST AI RMF landing page][N1] / [AI RMF 1.0][N2]. Landing-page update undated; framework January 2023, **>12 months old**, revision in progress.
- N3/N4 — [800-218A publication/status][N3] / [final PDF][N4]. 2024-07-26, **>12 months old**; no later final confirmed.
- N5/N6 — [SSDF 1.1 final][N5] / [SSDF 1.2 draft][N6]. February 2022 (**>12 months old**) / 2025-12-17 (draft, not final).
- C1 — [CISA official announcement][C1]. 2023-04-13, **>12 months old**; current updated guide could not be retrieved/confirmed.
- F1 — [FedRAMP FY26/27 update][F1]. 2026-10-08.
- F2 — [Consolidated Rules timeline][F2]. Undated living page; 2026 implementation dates listed.
- F3 — [FedRAMP changelog][F3]. Entries through 2026-10-15; RFC publication is not a final requirement.
- F4/F5/F6 — [Definitions][F4], [agency responsibilities][F5], [scope guidance][F6]. Definitions record 2026-06-24 launch; other page update dates unconfirmed. Scope quotes M-24-15 (July 2024, **>12 months old**) with current examples.

[P0]: https://www.whitehouse.gov/omb/information-resources/guidance/memoranda/
[P1]: https://www.whitehouse.gov/wp-content/uploads/2025/02/M-25-21-Accelerating-Federal-Use-of-AI-through-Innovation-Governance-and-Public-Trust.pdf
[P2]: https://www.whitehouse.gov/wp-content/uploads/2025/02/M-25-22-Driving-Efficient-Acquisition-of-Artificial-Intelligence-in-Government.pdf
[P3]: https://www.whitehouse.gov/wp-content/uploads/2025/12/M-26-04-Increasing-Public-Trust-in-Artificial-Intelligence-Through-Unbiased-AI-Principles.pdf
[P4]: https://www.whitehouse.gov/wp-content/uploads/2026/01/M-26-05-Adopting-a-Risk-based-Approach-to-Software-and-Hardware-Security.pdf
[P7]: https://www.whitehouse.gov/presidential-actions/2026/06/national-security-presidential-memorandum-nspm-11/
[N1]: https://www.nist.gov/itl/ai-risk-management-framework
[N2]: https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.100-1.pdf
[N3]: https://csrc.nist.gov/pubs/sp/800/218/a/final
[N4]: https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-218A.pdf
[N5]: https://csrc.nist.gov/pubs/sp/800/218/final
[N6]: https://csrc.nist.gov/pubs/sp/800/218/r1/ipd
[C1]: https://content.govdelivery.com/accounts/USDHSCISA/bulletins/354a744
[F1]: https://www.fedramp.gov/2026-10-08-from-foundation-to-implementation/
[F2]: https://www.fedramp.gov/2026/timeline/
[F3]: https://www.fedramp.gov/changelog/
[F4]: https://www.fedramp.gov/2026/definitions/
[F5]: https://www.fedramp.gov/2026/responsibilities/agencies/
[F6]: https://www.fedramp.gov/2026/scope/
