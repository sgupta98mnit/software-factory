Sources say: GovCloud availability, model authorization, and account entitlement are separate checks; the live AWS DoD model cells are incomplete. [A1] [A2] (read 2026-10-17)
Sources say: Azure Government now lists GPT-5.6 models and the Responses API; this does not establish Codex compatibility with a particular Government deployment. [M1] [M2] [O1] (read 2026-10-17)
We recommend: qualify one agency-owned endpoint and pinned model first; keep subscription use and proprietary Claude components outside the approved deployment until policy and contract questions are resolved. [C1] [C2] [O2] [O3] (inference; read 2026-10-17)

## Findings — sources say

### What needs approval

The factory currently delegates agent execution to OpenHands/ACP and uses existing CLI logins; it is not itself an approved model service. The project brief identifies personal subscriptions as a development arrangement and approved endpoints as a product gap. [R1] [R2] (read 2026-10-17)

Use three separate records: **model/region/API availability**, **authorization boundary and data category**, and **customer access/quota/contract**. AWS explicitly directs GovCloud customers to separate availability and model-certification lists; Microsoft separately publishes Government model deployments and service audit scope. An endpoint being callable does not establish that the selected model and feature are covered by the agency's authorization. [A0] [M1] [M3] (read 2026-10-17; final sentence is our inference)

### Claude on Bedrock in AWS GovCloud

The current regional matrix explicitly lists the following Claude GovCloud routes. `W` = `us-gov-west-1`; `E` = `us-gov-east-1`; `Geo` = cross-region inference through `bedrock-runtime`; `Mantle` = in-region `bedrock-mantle`. No listed row below supports a global route. **These are availability observations, not DoD authorization assertions.** [A2] (undated; read 2026-10-17)

| Model | W | E | Lifecycle note |
| --- | --- | --- | --- |
| Claude Haiku 5.5 | Mantle + Geo | Geo | Listed |
| Claude Sonnet 5.5 | Mantle + Geo | Geo | Listed |
| Claude Opus 5.5 | Mantle + Geo | Geo | Listed |
| Claude Fable 5.1 | Mantle + Geo | Geo | Listed; account access unconfirmed |
| Claude Opus 5 | Mantle + Geo | Geo | Listed |
| Claude Sonnet 5 | Mantle + Geo | Geo | Listed |
| Claude Haiku 4.5 | Mantle + Geo | Geo | Listed |
| Claude Sonnet 4.5 | Geo | Geo | EOL shown as 2027-04-08 |
| Claude 3 Haiku | In-region runtime, EOL | Geo, EOL | EOL shown as 2026-09-10; already past |

AWS's August 13 announcement describes Opus 5 as available via runtime in both GovCloud regions and Mantle in West; the current matrix above specifically distinguishes **Geo runtime** from **in-region runtime**. Prefer the more specific routing matrix when defining the deployment. [A5] [A2] (read 2026-10-17; preference is our inference)

The **live rendered** October 5 certification table has these GovCloud marks. We inspected the nested table cells, preserving blank cells; flattened search text loses their alignment. `X` means AWS marks the model in its GovCloud FedRAMP column, headed **Class D, formerly High**; `—` means blank, **not a finding that authorization was denied**. All eighteen Claude DoD IL4/IL5 cells were blank in the rendered page read on October 17. [A1] (updated 2026-10-05; read 2026-10-17)

| Claude model, as named in certification table | GovCloud mark | DoD IL4/IL5 mark |
| --- | --- | --- |
| 3 Haiku | X | — |
| 3.5 Haiku | — | — |
| 3.5 Sonnet | X | — |
| 3.5 Sonnet v2 | — | — |
| 3.7 Sonnet | X | — |
| 4.0 Sonnet | — | — |
| 4.1 Opus | — | — |
| 4.5 Haiku | — | — |
| 4.5 Opus | — | — |
| 4.5 Sonnet | X | — |
| 4.6 Opus | — | — |
| 4.6 Sonnet | — | — |
| 4.8 Opus | X | — |
| 5.0 Opus | X | — |
| 5 Sonnet | X | — |
| 5.5 Haiku | X | — |
| 5.5 Opus | X | — |
| 5.5 Sonnet | X | — |

There is a material source conflict: an indexed copy of that same page contains DoD marks; the opened live table has none. Historical AWS announcements explicitly state FedRAMP High and IL4/IL5 approval for **Claude 3.5 Sonnet v1 and Claude 3 Haiku** (May 23, 2025), and **Claude 3.7 Sonnet** in GovCloud West (July 10, 2025). Both announcements are **>12 months old** and do not prove present availability or authorization for newer models. **Current per-model DoD status is unconfirmed from the live table; obtain AWS's current authorization package/model annex rather than interpreting blank cells as revocation or extending historical approval to new models.** [A1] [A3] [A4] (read 2026-10-17; action is our recommendation)

The regional list and certification list also differ: some historically certified models have no current GovCloud row, while Haiku 4.5 and Fable 5.1 have availability rows without a corresponding GovCloud certification mark. No IL6 claim is established by these Bedrock GovCloud sources. [A1] [A2] (read 2026-10-17; comparison and limit are our inference)

### Azure OpenAI in Azure Government

Microsoft's Government model page supplies this complete deployment matrix. `Both` means **US Gov Arizona (`usgovarizona`) and US Gov Virginia (`usgovvirginia`)**; `AZ` means Arizona only; `—` means not marked available. Model versions below are model snapshot identifiers, not publication dates of the source. The matrix establishes catalog availability, not subscription quota or blanket model authorization. [M1] [M4] (read 2026-10-17)

| Exact model / version | Data Zone Standard | Data Zone Provisioned managed | Regional Standard | Regional Provisioned |
| --- | --- | --- | --- | --- |
| `gpt-5.6-sol` / `2026-07-09` | Both | Both | — | — |
| `gpt-5.6-terra` / `2026-07-09` | Both | Both | — | — |
| `gpt-5.6-luna` / `2026-07-09` | Both | Both | — | — |
| `gpt-5.1` / `2025-11-13` | Both | — | — | — |
| `gpt-4.1` / `2025-04-14` | Both | — | Both | — |
| `gpt-4.1-mini` / `2025-04-14` | Both | Both | Both | — |
| `o3-mini` / `2025-01-31` | Both | Both | — | — |
| `gpt-4o` / `2024-11-20` | Both | Both | Both | Both |
| `text-embedding-ada-002` / `2` | — | — | Both | — |
| `text-embedding-3-large` / `1` | Both | — | AZ | — |
| `text-embedding-3-small` / `1` | Both | — | AZ | — |

The source leaves Virginia's `gpt-5.1` regional-provisioned cell empty and marks Arizona `—`; neither is a positive availability mark. Data Zone deployments can route within Azure Government, so choosing a resource's region alone does not imply inference stays in that single region. [M1] (updated 2026-09-01; read 2026-10-17)

Microsoft's Azure Government **service** audit table marks Azure OpenAI for **FedRAMP High, DoD IL2, IL4 and IL5 via Workload Isolation (IL5WI)**, and separately IL6 in **Azure Government Secret**. US Gov regions and US DoD regions have different PA scopes; IL5WI may require additional isolation configuration. This service row is not a per-model/feature authorization annex, and the unclassified AZ/VA model matrix is not evidence that these exact versions are available in Secret/IL6. Confirm model, deployment type, Responses feature and isolation against the customer-accessible authorization package. [M3] (table dated February 2026; page updated 2026-09-21; read 2026-10-17; final interpretation/recommendation is ours)

Government now explicitly lists **Responses API: Yes** and **Model router: No**. Therefore the older assumption that Government necessarily lacks Responses is no longer supported. Nevertheless, a working commercial Azure Codex configuration does not prove compatibility with Government's API version, model capabilities or tenant policy. [M2] [O1] (read 2026-10-17; compatibility limit is our inference)

### Point the existing CLIs at the approved endpoint

**Claude Code:** Anthropic documents the AWS credential chain, Bedrock environment switch, region, model pins and GovCloud `us-gov.` profile prefix. It uses the Invoke API rather than Converse; Mantle is a distinct option. Configure the **agent child process**, since Canvas/OpenHands spawns the CLI. The following is our template, not a tested GovCloud deployment; the profile ID must come from the agency account's actual allowed profiles. [C3] [R2] (read 2026-10-17)

```powershell
$env:CLAUDE_CODE_USE_BEDROCK = '1'
$env:AWS_PROFILE = 'agency-govcloud'
$env:AWS_REGION = 'us-gov-west-1'
$env:ANTHROPIC_MODEL = '<approved GovCloud inference-profile ID or ARN>'
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = $env:ANTHROPIC_MODEL
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = $env:ANTHROPIC_MODEL
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = $env:ANTHROPIC_MODEL
claude
```

We recommend temporary agency credentials and pinning every helper/default selection to the approved profile initially, so background activity cannot silently select an unreviewed model. Verify the actual CLI version accepts the selected aliases/profile and that streaming works. Do not assume a commercial `us.` profile targets GovCloud; examine destination regions and IAM/SCP permissions. [C3] [A2] (inference; read 2026-10-17)

**Codex:** official OpenAI documentation supplies a custom Azure provider using `wire_api = "responses"`, an API-version query parameter and an environment key. Microsoft's cloud comparison identifies the Government Azure OpenAI suffix as `openai.azure.us`, distinct from commercial `openai.azure.com`. This is a **candidate adaptation** of OpenAI's example; the preview API version shown is from that example and must be confirmed for the Government deployment before use. No live credentials or inference were exercised in this research. [O1] [M5] (read 2026-10-17)

```toml
# User-level Codex config.toml; model is the Azure deployment name.
model_provider = "azure_gov"
model = "AGENCY_DEPLOYMENT_NAME"

[model_providers.azure_gov]
name = "Agency Azure Government"
base_url = "https://RESOURCE.openai.azure.us/openai"
env_key = "AZURE_OPENAI_API_KEY"
query_params = { api-version = "2025-04-01-preview" }
wire_api = "responses"
```

We recommend checking the resource's documented base path/authentication scheme and supported Responses API version, then running a minimal streamed tool-call and multi-turn test with the **pinned Codex build**. If the resource requires an `api-key` header rather than bearer authentication, Codex also documents `env_http_headers`; use the resource's supported scheme, not an assumed interchangeability. Token helpers are another documented option for bearer authentication. Do not substitute Chat Completions or commercial-cloud failover when the approved Responses deployment fails; treat this as a compatibility gate. [O1] [M2] (inference; read 2026-10-17)

### Terms, distribution and subscription use

These are **tentative technical readings of public terms**, not a legal opinion or a determination of the contract Radiant/agency actually has. A code license, the right to call a paid service, and government authorization are separate matters. [C1] [C2] [O2] [O3] [L1] (read 2026-10-17; separation is our interpretation)

| Component/path | Sources say | Consequence we infer |
| --- | --- | --- |
| Claude Code binary in another product | Anthropic permits preinstallation/running under Commercial Terms if the binary remains unmodified, built-in auth methods remain available, and each user supplies their own provider/subscription credentials and is billed directly. [C1] | Do not bundle it under a claim of MIT/Apache compatibility; agency restrictions and commercial conditions need reconciliation. |
| Claude login in our own UI or Agent SDK wrapper | Third-party apps must not collect/intermediate Claude credentials or offer claude.ai login; use API keys/supported providers. Users may themselves sign into the unmodified Claude binary. [C1] [C2] | A wrapper cannot turn captured consumer tokens into a permitted product API. The existing CLI-login path needs vendor/legal review, not a blanket claim that every subscription use is forbidden. |
| Claude Agent SDK | It runs the Claude Code binary; its license is Anthropic Commercial Terms, except separately licensed components. [C2] [L4] | **Proprietary/commercial, outside the brief's MIT/Apache/BSD adoption rule.** The ordinary Anthropic TypeScript API client is MIT, but is not the same agent harness. [L5] |
| Codex CLI / SDK | Codex is Apache-2.0; its TypeScript SDK spawns the CLI and exchanges JSONL. The official SDK docs support integration into one's own applications. [L1] [O4] [O5] | Compatible code adoption, preserving license/NOTICE obligations; pin the CLI too. This does not grant model access or remove service terms. |
| OpenAI API integration | Services Agreement §2.2 permits API-powered customer applications; §3 forbids shared individual logins, account resale and transferring API keys. [O2] | Use an organization's contracted service or agency-owned Azure endpoint; avoid pooling personal accounts. Azure procurement terms must be separately checked. |
| Consumer ChatGPT / Codex plans | General Terms restrict credential sharing and programmatic extraction, but September 29, 2026 **Sign in with ChatGPT (SIWC)** terms expressly allow eligible plans in connected apps through the supported flow. Requests must be user-controlled/authorized, tokens stored locally under user control, no pooled usage, and the SIWC path must be usable without paying the app vendor. [O3] [O6] | Do not assert a universal ban. SIWC is a constrained separate option, not evidence of an agency-approved Government endpoint or a right to monetize subscription access. |
| OpenAI ordinary API SDK | `openai-node` is Apache-2.0. [L2] | Compatible client code, not an authorization or entitlement. |

Anthropic's Commercial Terms permit powering customer products, prohibit unauthorized resale/competing-service uses, and apply through its referenced offerings; its CLI legal page says an existing commercial agreement applies also through Bedrock unless otherwise agreed. The Commercial Terms page is effective June 17, 2025 (**>12 months old**), while the undated CLI legal page contains the more specific current hosting/authentication conditions above. Ask counsel/vendor to resolve their application to our paid wrapper and agency-managed credentials. [C4] [C1] (read 2026-10-17)

## Recommendation — we recommend

1. **Qualify the agency's existing cloud first (3–5 engineering days after access).** Obtain a written model/version/region/deployment/API/authorization allowlist; configure one CLI and prove streaming, tool calls, credential renewal and no commercial fallback. The contradictory AWS DoD table and Government Codex compatibility are explicit acceptance gates. [A1] [M1] [M2] [O1] (our estimate/inference; read 2026-10-17)
2. **Use customer-owned commercial credentials; do not broker subscriptions (1–2 days of integration design, plus external legal/procurement time).** Prefer Codex's Apache-2.0 integration when the strict tool-license policy governs distribution. Treat Claude Code/Agent SDK as separately licensed external integrations requiring a policy decision, not compatible OSS dependencies. [C1] [L1] [L4] (our estimate/inference; read 2026-10-17)
3. **Keep the product's endpoint inventory explicit (1–2 days).** Record CLI version, provider/model/profile ID, region and route, auth owner, allowed features, authorization evidence date and revalidation owner; fail closed on retirement/access failure. Catalog entries and successful calls are not authorization evidence. [A2] [M1] [M3] (our estimate/inference; read 2026-10-17)

## Open questions

- **AWS:** Which exact current Claude snapshots/profiles are in the IL4/IL5 authorization annex, and why are live DoD cells blank while indexed text differs? Has any previously approved model retired in the agency account? [A1] [A2] [A3] [A4] (read 2026-10-17)
- **Microsoft:** Are the selected GPT snapshot, Data Zone route and Responses feature covered for this workload/IL, with required isolation? Which API versions, auth headers/scopes and quotas does the actual Government resource expose? [M1] [M2] [M3] [M4] (read 2026-10-17)
- **Integration:** Does the pinned ACP adapter preserve provider settings/environment and sandbox policy for all child processes? The architecture establishes spawning but not this endpoint-specific behavior; no live provider integration was tested here. [R2] (read 2026-10-17; unconfirmed)
- **Contracts:** Does our paid distribution meet Anthropic's unmodified-binary/user-credential conditions, and is proprietary-tool integration allowed despite the strict OSS adoption rule? Does a proposed SIWC integration meet its no-charge condition? Obtain written answers before product commitments. [C1] [L4] [O6] (read 2026-10-17; interpretation tentative)

## Source registry

All sources were opened/read **2026-10-17**. “Undated” means no reliable publication/update date was exposed; crawl dates and copyright years are not publication dates. Live docs can change after this snapshot. Entries marked **>12 months old** predate 2025-10-17.

| ID | Primary source | Publication/update | Read |
| --- | --- | --- | --- |
| R1 | [Repository research brief](../RESEARCH_BRIEF.md) | October 2026 | 2026-10-17 |
| R2 | [Repository architecture](../ARCHITECTURE.md) | Undated | 2026-10-17 |
| A0 | [AWS Bedrock GovCloud guide][A0] | Undated | 2026-10-17 |
| A1 | [AWS model certification table][A1] | 2026-10-05; live nested cells inspected; index conflict disclosed | 2026-10-17 |
| A2 | [AWS regional model matrix][A2] | Undated | 2026-10-17 |
| A3 | [AWS first model IL4/5 announcement][A3] | 2025-05-23; **>12 months old** | 2026-10-17 |
| A4 | [AWS Claude 3.7 GovCloud announcement][A4] | 2025-07-10; **>12 months old** | 2026-10-17 |
| A5 | [AWS Opus 5 GovCloud announcement][A5] | 2026-08-13 | 2026-10-17 |
| M1 | [Government models and deployment matrix][M1] | 2026-09-01 | 2026-10-17 |
| M2 | [Foundry features in Azure Government][M2] | 2026-09-04 | 2026-10-17 |
| M3 | [Azure Government audit scope][M3] | Scope table February 2026; page 2026-09-21 | 2026-10-17 |
| M4 | [Government quota scope][M4] | Undated in retrieved excerpt | 2026-10-17 |
| M5 | [Government vs commercial endpoints][M5] | 2025-08-21; **>12 months old** | 2026-10-17 |
| C1 | [Claude Code legal/compliance][C1] | Undated | 2026-10-17 |
| C2 | [Claude Agent SDK overview][C2] | Undated | 2026-10-17 |
| C3 | [Claude Code Bedrock configuration][C3] | Undated | 2026-10-17 |
| C4 | [Anthropic Commercial Terms][C4] | Effective 2025-06-17; **>12 months old** | 2026-10-17 |
| O1 | [Official OpenAI Codex advanced configuration][O1] | Undated | 2026-10-17 |
| O2 | [OpenAI Services Agreement][O2] | Updated 2025-12-01; effective 2026-01-01 | 2026-10-17 |
| O3 | [OpenAI Terms of Use][O3] | Published/effective 2026-01-01 | 2026-10-17 |
| O4 | [Official Codex SDK docs][O4] | Undated | 2026-10-17 |
| O5 | [Codex TypeScript SDK README][O5] | Undated | 2026-10-17 |
| O6 | [Sign in with ChatGPT Terms][O6] | 2026-09-29 | 2026-10-17 |
| L1 | [Codex LICENSE][L1] | Undated license file; Apache-2.0 text version 2004 | 2026-10-17 |
| L2 | [OpenAI Node LICENSE][L2] | Undated license file; Apache-2.0 | 2026-10-17 |
| L4 | [Claude Agent SDK LICENSE.md][L4] | Undated; Commercial Terms, all rights reserved | 2026-10-17 |
| L5 | [Anthropic TypeScript API client LICENSE][L5] | Undated license file; MIT | 2026-10-17 |

[R1]: ../RESEARCH_BRIEF.md
[R2]: ../ARCHITECTURE.md
[A0]: https://docs.aws.amazon.com/govcloud-us/latest/UserGuide/govcloud-bedrock.html
[A1]: https://aws.amazon.com/compliance/services-in-scope/FedRAMP/amazon-bedrock-models/
[A2]: https://docs.aws.amazon.com/bedrock/latest/userguide/models-region-compatibility.html
[A3]: https://aws.amazon.com/about-aws/whats-new/2025/05/amazon-bedrock-models-fedramp-high-dod-il-4-5-govcloud/
[A4]: https://aws.amazon.com/about-aws/whats-new/2025/07/anthropics-claude-3-7-sonnet-available-amazon-bedrock-aws-govcloud-us-west/
[A5]: https://aws.amazon.com/about-aws/whats-new/2026/07/claude-opus-5-aws-govcloud/
[M1]: https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure-gov
[M2]: https://learn.microsoft.com/en-us/azure/foundry/concepts/foundry-azure-government
[M3]: https://learn.microsoft.com/en-us/azure/azure-government/compliance/azure-services-in-fedramp-auditscope
[M4]: https://learn.microsoft.com/en-us/azure/foundry/openai/quotas-limits-gov
[M5]: https://learn.microsoft.com/en-us/azure/azure-government/compare-azure-government-global-azure
[C1]: https://code.claude.com/docs/en/legal-and-compliance
[C2]: https://code.claude.com/docs/en/agent-sdk/overview
[C3]: https://code.claude.com/docs/en/amazon-bedrock
[C4]: https://www.anthropic.com/legal/commercial-terms
[O1]: https://learn.chatgpt.com/docs/config-file/config-advanced
[O2]: https://openai.com/policies/services-agreement/
[O3]: https://openai.com/policies/terms-of-use/
[O4]: https://learn.chatgpt.com/docs/codex-sdk
[O5]: https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/README.md
[O6]: https://openai.com/policies/sign-in-with-chatgpt-terms/
[L1]: https://raw.githubusercontent.com/openai/codex/main/LICENSE
[L2]: https://raw.githubusercontent.com/openai/openai-node/main/LICENSE
[L4]: https://raw.githubusercontent.com/anthropics/claude-agent-sdk-typescript/main/LICENSE.md
[L5]: https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/LICENSE
