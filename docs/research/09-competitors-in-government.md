Sources show substantial overlap already: Factory and Cognition market sovereign deployment, approved models, governance, and audit trails. [F1] [C2] (read 2026-10-17).
Cognition's dated announcement distinguishes authorized Desktop/CLI from Cloud's High In-Process status; current authorization boundaries still need marketplace/package confirmation. [C1] [R1] (read 2026-10-17).
We recommend owning a small, inspectable evidence package for each change, rather than claiming local execution, human control, or air-gapping is unique. [F1] [C2] [L1] (read/inspected 2026-10-17; inference).

# 09 — Competitors in government and a defensible position

## Findings — sources say

### How to interpret the evidence

This review distinguishes **a vendor statement**, **a procurement channel**, and **an independently confirmed authorization record**. The FedRAMP Marketplace returned no readable product records to this research browser, including when followed from Cognition's announcement. Therefore exact current product IDs, authorization packages, sponsors, and boundaries were **not independently confirmed** here; vendor claims below retain that label. [R1] [C1] (read 2026-10-17; research-access limitation).

GovRAMP's public participant list was readable. Searches within that page for 8090, Opsera, Factory, Blitzy, Cognition, Devin, and Windsurf found no matching text. This is **no matching entry in the reviewed page**, not proof that a company has no offering under another legal name, inherited boundary, or newly changed listing. [R2] (read 2026-10-17; negative search result/limit). “StateRAMP status” is treated here through the current GovRAMP participant directory. [R2] (read 2026-10-17).

### Authorization, customers, and buying route

| Product | FedRAMP / GovRAMP status established by this review | Government customers or procurement evidence |
| --- | --- | --- |
| **8090 Software Factory** | No product-specific FedRAMP authorization was confirmed in reviewed official vendor docs; no matching name in the reviewed GovRAMP page. **Unconfirmed**, not “not authorized.” [E1] [E2] [R1] [R2] | A 2026-06-29 company post says it serves the United States government, without identifying an agency, award, or contract vehicle. Treat as vendor-reported government activity. [E3] |
| **Opsera Forge / SoftwareForge** | Current product/home/pricing pages establish an enterprise platform, but not a product-specific FedRAMP authorization. No matching name in the reviewed GovRAMP list. **Unconfirmed.** [P1] [P2] [R1] [R2] | Reviewed sources did not establish a named federal customer or government contract vehicle. Cloud-marketplace logos on the pricing page do not establish a government ordering vehicle or authorized service boundary. [P2] (assessment) |
| **Factory** | Older indexed vendor text says “FedRAMP In Process,” but opening the former FedRAMP deployment URL redirects to the current federal page, which does not make that claim. Do **not** repeat the indexed text as confirmed current status. Marketplace authorization remains **unconfirmed**. [F1] [F4] [R1] [R2] | Current vendor page and a Carahsoft vendor page establish a public-sector sales channel. No named agency deployment or exact current ordering SKU/contract was confirmed from those pages. [F1] [F3] |
| **Cognition / Devin / formerly Windsurf** | Vendor announcement **2026-07-13** says Desktop/CLI are High Authorized and the broader platform, including Cloud, is **Class D (High) In-Process**. Its broad “extends authorization” wording must not erase that explicit distinction. Exact current marketplace boundary is unconfirmed here. [C1] [R1] [R2] | Same announcement names U.S. Army, U.S. Navy, and NASA JPL as users — vendor-reported, without agency award records. A **2026-06-03** Carahsoft release names **NASA SEWP V, NASPO ValuePoint, OMNIA Partners** as channels; verify current vehicle/ordering eligibility before buying. [C1] [C3] |
| **Blitzy** | Security page claims SOC 2 Type II and ISO 27001, which do not establish FedRAMP/GovRAMP. No product-specific authorization or matching GovRAMP name was confirmed. [B1] [R1] [R2] | No named government customer or contract vehicle was established by the reviewed official pages. [B1] [B2] (research limit) |

All table sources were **read 2026-10-17**. Vendor self-descriptions are not an agency ATO determination; package review is still an open action, not work represented as completed. [R1] [R2] (assessment).

### Deployment and public pricing

Prices are advertised commercial references in USD, **read 2026-10-17**, not government quotes or a total-cost comparison. No paid account, demo, or sales contact was used for this research. [E1] [P2] [F2] [C4] [B2] (research method).

| Product | Deployment evidence | Advertised pricing / limits |
| --- | --- | --- |
| **8090** | Its changelog calls Software Factory a hosted product with all organizations on the latest release. No customer self-hosted/air-gapped package was confirmed for this self-serve product. Distinguish custom 8090 Enterprise engagements. [E2] [E4] | Full seat **$200/month**, View **$0**; active full members contribute included usage, then on-demand usage; self-serve usage carries a **20% platform fee**. Enterprise terms differ. Marketing separately says 8090 Enterprise starts at **$1M/year**. [E1] [E4] |
| **Opsera** | Current homepage says SaaS, self-hosted/on-premises, and hybrid, including full-platform on-premises. Truly disconnected inference, license activation, update, and support behavior is **unconfirmed**. [P1] | Contact sales; pricing options reference users and pipelines. No public Forge-specific dollar schedule was established. [P2] |
| **Factory** | Current federal page offers cloud, hybrid, on-premises, and fully air-gapped deployment plus customer-selected model endpoints. These features therefore cannot be claimed as unique to this factory. [F1] (last sentence inference) | **Pro $20, Plus $100, Max $200/month**; Teams **$60/month plus $40/seat**, up to ten seats. Business/Enterprise are sales-led, with enterprise on-premises options. Government/air-gapped pricing unconfirmed. [F2] |
| **Cognition** | Government page says GovCloud/on-premises and **air-gapped CLI/IDE**, with customer-approved endpoints. Do not extend the air-gap claim to all Devin Cloud configurations. [C2] | Current unified page: **Pro $20, Max $200/month**, Teams **$80/month plus $40/full developer seat**; Enterprise quote. The page still mentions a promotion ending **2026-10-16**, already expired at read time; excluded from this comparison. [C4] |
| **Blitzy** | Security page lists cloud, VPC, black-box VPC, on-premises, and black-box on-premises. Its phrase “air-gapped code generation” describes an isolated generation subsystem; this alone does not prove an entirely disconnected customer installation. [B1] (final sentence assessment) | Live homepage shows **Core $500K/year, Scale $1M typical/year, Transformation $10M typical/year**. A security-page FAQ gives different older-looking tier names/amounts, but neither page has a reliable update date. Quote required; the discrepancy is **unresolved**, not averaged away. [B1] [B2] |

### What could we own?

The strongest candidate is **an open, portable change-evidence contract**: a reviewer should be able to inspect requirement/scenario → work order → control statement → diff/commit → checks → exact-content approval → externally anchored receipt. This is a proposed product promise, not an existing complete capability. The present code already has file-based requirements/work orders and an audit chain, but still trusts `SF_USER` and stores its log locally. [L1] (inspected 2026-10-17; proposal).

| Candidate position | Assessment from these sources |
| --- | --- |
| “Local-first / air-gapped / bring your models” | Valuable requirement, weak exclusivity claim: Factory and Cognition advertise these deployment choices; Blitzy and Opsera advertise private/on-premises options. [F1] [C2] [B1] [P1] (inference) |
| “Human control and auditability” | Necessary but already marketed by competitors. Demonstrate who can approve, what content was approved, and what invalidates approval. [F1] [C2] [L1] (recommendation) |
| “Open source” | Could differentiate the **factory layer**, provided Radiant actually chooses a compatible license and maintains notices. This research did not establish a permissively licensed full equivalent of each commercial product, nor does a public repo imply a license. [L1] (proposed strategy; competitor licensing unconfirmed) |
| “Controls traceability with evidence per change” | Promising narrow wedge. Do not claim competitors lack it merely because public pages omit details. Evaluate the same exported evidence package from each vendor during procurement. [F1] [P1] [C2] (recommendation) |

## Recommendation — our judgment

Pilot with one Radiant delivery team and its security reviewer on an approved low-sensitivity repository. Make the success criterion **a complete, independently verifiable evidence package for one real change**, including refusal of agent-origin approval and rejection of stale approval after a content change. Measure review completeness and time-to-reconstruct the change, not unverified vendor productivity multipliers. **Estimate: 2–3 engineering days** to define the sample evidence contract and buyer checklist; implementation is covered by files 02–05. [L1] [F1] [C2] (read/inspected 2026-10-17; recommendation/estimate).

Keep these commercial products on the buy-versus-build shortlist. Reproducing an agent platform or enterprise orchestration suite is not needed to test the factory's evidence value. If an existing product exports the required portable evidence at acceptable terms and boundary, integration may be the smaller outcome. [E1] [P1] [F1] [C2] (read 2026-10-17; judgment).

## Open questions / vendor-verification checklist

- Ask for exact marketplace product ID, authorization package/boundary and current status; clarify Desktop/CLI versus Cloud and inherited versus product-specific controls. This review did not obtain restricted packages. [C1] [R1] (read 2026-10-17; proposed due diligence).
- Request a government ordering quote identifying legal entity, SKU, contract vehicle, model costs, minimums, support, and retention terms. The cited Carahsoft announcement is dated evidence of a channel, not proof every listed vehicle remains orderable today. [C3] [F3] (read 2026-10-17; recommendation).
- Require a disconnected-install demonstration, including inference, activation, updates, support exports, and telemetry. Vendor “on-premises” and subsystem “air-gap” language is insufficient to settle those mechanics. [P1] [B1] [F1] [C2] (read 2026-10-17; assessment).
- Request one machine-readable change package with control mappings, approval signatures, invalidation behavior, and offline verification. Compare against the proposed factory contract before asserting an unoccupied market. [L1] (inspected 2026-10-17; recommendation).

## Sources and dates

All sources **read/inspected 2026-10-17**. Sources without an explicit publication/update date are marked **undated**; their publication age is unconfirmed. No dated source older than 12 months is relied on for current competitor status. All unconfirmed status/pricing details above should be rechecked at procurement.

- [E1] 8090 Usage & Billing — undated current docs.
- [E2] 8090 changelog — latest visible release 0.56.0, 2026-10-12; hosted-product statement.
- [E3] 8090 funding/customer statement — published 2026-06-29.
- [E4] 8090 pricing — undated current page.
- [P1] Opsera homepage — undated current page; opsera.io redirects to opsera.ai.
- [P2] Opsera pricing — undated; enterprise DevOps pricing, not a Forge-specific quote.
- [F1] Factory federal page — undated current factory.com page.
- [F2] Factory pricing — undated current factory.com page.
- [F3] Factory Carahsoft listing — undated current reseller page.
- [F4] Former Factory FedRAMP URL — redirected to [F1] on read date; older search text not accepted as current confirmation.
- [C1] Cognition High In-Process announcement — published 2026-07-13.
- [C2] Devin government page — undated current page.
- [C3] Cognition/Carahsoft partnership — published 2026-06-03.
- [C4] Devin pricing — undated current page, includes already-expired 2026-10-16 promotion.
- [B1] Blitzy security — undated current page; pricing FAQ conflicts with homepage.
- [B2] Blitzy homepage/pricing — undated current page.
- [R1] FedRAMP Marketplace — live attempt, no product records readable through research tool.
- [R2] GovRAMP participants — undated current directory; no matches for the searched names in returned text.
- [L1] Factory architecture — local snapshot, publication date unconfirmed.

[E1]: https://docs.8090.ai/administration/usage
[E2]: https://docs.8090.ai/resources/changelog
[E3]: https://www.8090.ai/blog/series-a
[E4]: https://www.8090.ai/pricing
[P1]: https://opsera.ai/
[P2]: https://www.opsera.io/pricing/
[F1]: https://factory.com/industries/federal
[F2]: https://factory.com/pricing
[F3]: https://www.carahsoft.com/factory
[F4]: https://factory.ai/deployment/factory-fedramp
[C1]: https://cognition.com/blog/devin-fedramp-high-in-process
[C2]: https://devin.ai/government
[C3]: https://www.carahsoft.com/news/cognition-ai-and-carahsoft-announce-partnership-to-accelerate-software-development-security-and-mainframe-modernization-2026
[C4]: https://devin.ai/pricing
[B1]: https://blitzy.com/security
[B2]: https://blitzy.com/
[R1]: https://marketplace.fedramp.gov/
[R2]: https://govramp.org/program-participants
[L1]: ../ARCHITECTURE.md
