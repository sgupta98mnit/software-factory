Sources say: native desktop sign-in should use a system browser and Authorization Code + PKCE; Entra and Okta can authenticate smart-card users. [I1] [I2] [I3] [I4] (read 2026-10-17)
Sources say: an OIDC assertion authenticates a session; it does not itself sign the work order that the person approves. [N1] [N2] (read 2026-10-17; distinction is our inference)
We recommend: agency workforce OIDC first, an approval service outside agent control, and signatures over an immutable approval envelope; add PIV document signing only if the agency requires it. [N1] [N2] [N3] [E1] (inference; read 2026-10-17)

## Findings — sources say

### Start with the agency identity provider

The current architecture identifies approvals through `SF_USER` and writes approvals and work-order hashes into a local hash chain. It does not establish authenticated human identity or an independent signing authority. [R1] [R2] (read 2026-10-17)

RFC 8252 requires external-user-agent authorization and PKCE for public native clients; a secret embedded in an installed app cannot be treated as confidential client authentication. It supports desktop loopback redirects, including dynamically allocated ports, subject to registration/validation rules. This is a durable standard, but its October 2017 publication is **>12 months old**. [I1] (read 2026-10-17)

Microsoft has an Electron example using **MSAL Node**, and explicitly says MSAL Browser is not supported in Electron. Entra CBA supports browser applications and Windows smart cards, including Edge and Chrome. Entra's CBA documentation describes certificate-based authentication; using it still requires the agency's configured trust, user mappings and authentication policy. These Microsoft pages were last updated in April/September 2025 and are **>12 months old**; actual agency tenant behavior remains untested. [I2] [I3] (read 2026-10-17)

Okta documents a Smart Card IdP for X.509/PIV and a native/public application type using Authorization Code + PKCE, with client authentication `None`. Its Classic Engine documentation explicitly mentions both PIV and CAC. Product edition, the agency's authorization server, certificate mappings and assurance policy must be confirmed with its administrators. [I4] [I5] [I6] (undated; read 2026-10-17; confirmation is our recommendation)

For an Entra US Government tenant, the authority is `https://login.microsoftonline.us`, distinct from global `https://login.microsoftonline.com`. National-cloud app registration/authority must match the agency; do not infer the workforce tenant's cloud from the desktop's location or the model endpoint alone. [I7] (updated 2025-01-15, **>12 months old**; read 2026-10-17; final interpretation is ours)

| Identity provider | Practical desktop arrangement we recommend | What remains agency-specific |
| --- | --- | --- |
| Agency Entra ID | Public-client registration; MSAL Node in Electron main process; external browser handles PIV/CAC certificate selection and PIN through the agency sign-in flow. [I2] [I3] | Authority/tenant, certificate trust/mapping, Conditional Access/authentication strength, permitted redirect URI and token audience. |
| Agency Okta | Native OIDC registration; external browser; IdP handles Smart Card authentication; require PKCE. [I4] [I5] [I6] | Engine/edition, authorization-server policy, certificate mappings, government offering/authorization boundary and role claims. |
| Login.gov | Consider for an agency's non-workforce/public users through its approved integration; do not substitute it for the agency's workforce directory without an explicit identity design. [I8] [I9] [I10] | Production partnership/IAA, accepted redirect design, assurance requested/returned and separate assignment of app roles. |

**Login.gov is not “only for people without PIV.”** Its own help page supports federal-employee PIV/CAC as an authentication method. Its OIDC docs support PKCE (preferred for native mobile apps) or `private_key_jwt` (preferred for web apps). Our workforce/public distinction is a product recommendation about directory ownership and authorization, not a statement that Login.gov forbids employees. [I8] [I9] (undated; read 2026-10-17)

There is a concrete desktop integration obstacle: Login.gov production guidance requires **HTTPS redirect URIs**, an ATO-approved environment and a signed IAA listing the integration; the guidance does not establish a production exception for a desktop `http://127.0.0.1` callback or custom scheme. Its published lead times are up to six weeks for an IAA and approximately two weeks for production deployment/configuration changes. **Native desktop callback acceptance is unconfirmed.** An agency-controlled HTTPS callback/broker is a possible design, but must be agreed and must not return credentials in a redirect URL. [I10] (undated; read 2026-10-17; broker design is our inference)

### The browser handles the card; the app handles the session

We recommend this minimal flow, applying the native-app standard and vendor integration guidance, rather than writing a smart-card reader stack for login. [I1] [I2] [I3] [I5] (inference; read 2026-10-17)

1. The Electron **main process** loads an administrator-approved issuer, tenant/client ID and redirect registration. Generate fresh PKCE `S256`, `state` and OIDC `nonce`; keep the verifier out of the renderer and agent environment.
2. Start the permitted callback listener on loopback, then open the **system browser** to the authorization endpoint. The IdP/OS prompts for the card/certificate/PIN; the factory does not request the PIN or export the private key.
3. Accept only the expected callback/state once; exchange the code with its verifier. Validate issuer, audience, signature, lifetime and nonce using discovery/JWKS from the approved issuer. Reject unregistered issuers and callback substitution.
4. Establish a short-lived factory session. Treat identity as `(issuer, subject)` and, where relevant, immutable tenant/object identifiers. Display name/email are labels, not authorization keys. Map roles explicitly to engineer, approver and ISSO through agency-managed groups/assignments.
5. Keep refresh/access tokens in the main process with least privilege and short lifetime. Renderer IPC exposes narrowly defined actions, not a token getter; agent processes receive no approval-service tokens. Clear session/cache on sign-out and enforce reauthentication for sensitive approval when policy requires it.

The validation rationale comes from NIST federation guidance: the RP verifies the IdP assertion and creates a session; issuer signatures protect assertions. This does **not** give the person a document-signing signature over arbitrary application content. The current final guidance is SP 800-63C-4, published July 2025 (**>12 months old**). [N1] (read 2026-10-17)

Electron's `safeStorage` uses Windows DPAPI but explicitly warns that it protects against other Windows users, **not other applications running as the same user**. Electron also recommends context isolation, sandboxing and validation of IPC senders. These are useful protections, not a security boundary against a fully privileged coding agent running in the approver's Windows account. [E1] [E2] (undated; read 2026-10-17; last conclusion is our inference)

**Human-only approval needs a separate trust boundary.** We recommend an authenticated agency approval API/web origin, with its signing key and authoritative role checks outside the laptop's agent execution context. Require a distinct audience/scope, a fresh one-use approval challenge, the exact revision hash, and explicit confirmation in a trusted human UI. A normal local browser cookie, localhost API or same-user DPAPI cache can be exercised or stolen by a sufficiently privileged agent; adding OIDC to the current local API alone does not make an approval human-only. Sandboxing must deny the agent approval endpoints/credentials, and the external service should still enforce authorization. [R2] [E1] [N1] (inference/threat model; read 2026-10-17)

For a truly offline single-laptop pilot, we recommend labeling approvals as **local evidence with a trusted-device assumption**. A separate Windows approver account/device and hardware signing can strengthen it, but do not claim resistance to a compromised host or allow automatic agent approval because the user once signed in. [E1] [N2] [N3] (inference; read 2026-10-17)

### What a signed approval should contain

NIST's Digital Signature Standard says digital signatures detect content modification and authenticate the signatory; federation guidance instead describes assertions about authentication/accounts. RFC 8785 provides deterministic JSON canonicalization for repeatable hashing/signing. RFC 3161 defines signed timestamp tokens binding a message imprint to a time-stamping authority's time. These are different functions. [N1] [N2] [N4] [N5] (read 2026-10-17; standards are **>12 months old**)

We recommend an immutable, versioned **approval envelope** with the following fields. This is a proposed application schema, not a NIST-mandated field list. Sign the canonical envelope bytes (or their specified digest), not just a task ID or the word “Approved.” [N2] [N4] (design inference; read 2026-10-17)

| Bound field | Proposed content/purpose |
| --- | --- |
| Context | Envelope schema/version, factory/workspace/repository identity, work-order ID, unique approval ID and purpose/domain string such as `software-factory.work-order-approval.v1`. Prevent reuse in another workflow. |
| Exact content | Algorithm and digest of the immutable work-order snapshot; snapshot includes acceptance criteria and decision-relevant notes. Hash a manifest of approved spec/design/control mappings, test evidence and the actual code tree/commit/diff. Preserve those artifacts for independent reconstruction. |
| Decision and intent | Approve/reject, explicit attestation text and version, review scope, reviewer note, role exercised and policy version. Distinguish engineering approval from ISSO/security acceptance. |
| Identity | Verified issuer + subject, tenant/object ID where available, role/assignment evidence at decision time, authentication context (`acr`/`amr`) and authentication time when provided. Include certificate identity if the person signs with a certificate. |
| Freshness and linkage | One-use service challenge, preceding audit-event hash, decision time in UTC and external receipt time. Distinguish client-asserted time from service/TSA time. |
| Signature metadata | Signature format/algorithm, signer type (person or service), key ID/certificate chain, signature bytes and optional RFC 3161 timestamp token over the signed result. Keep verification material and historical revocation/status evidence. |

We recommend a two-step approval: prepare a frozen revision and challenge; display that revision to the reviewer; verify/consume the signed response atomically against the same revision. If anything changes before commit, reject and re-present. After approval, any material task/spec/code/evidence change invalidates the current approval; preserve the old record and require a new one. Choose exact snapshot bytes or a published canonicalization rule, preserve them, and verify outside the desktop. Merely sorting a few JSON keys is not a claim of full RFC 8785 conformance. [N4] [R2] (design inference; read 2026-10-17)

### Choose the claim the signature actually supports

| Option | Evidence it can support | Limit we recommend stating |
| --- | --- | --- |
| OIDC session + unsigned local event | The local application recorded an action under an authenticated session. [N1] [R2] | No cryptographic binding by the person to the work order; host/session compromise can fabricate actions. |
| OIDC + agency-service signature over the envelope | The agency service attests to its authorization/identity checks and the exact approved snapshot; verification uses the service key. [N1] [N2] | **Service attestation**, not a personal PIV signature. The service could issue a false record; remote immutable retention and independent verification remain useful. |
| PIV/CAC document-signing key + envelope + timestamp | The person's signing key produced a signature over the chosen content, with certificate/status evidence. [N2] [N3] [N5] | Stronger evidence, but card presence, authentic display, consent, certificate policy and compromised-host risks still matter; legal nonrepudiation is not guaranteed by the tool. |

FIPS 201-3 distinguishes the PIV authentication key from the document-signing key. The signature key is non-exportable and requires cardholder authentication for each signing operation; signing requires explicit user action. Windows CNG provides `NCryptSignHash`, but that API does not itself solve certificate selection, trust-chain/revocation validation, an honest approval display or long-term evidence retention. [N3] [W1] (read 2026-10-17; both sources **>12 months old**; final limitation is our inference)

We recommend a small signed Windows helper using the existing agency card's supported CNG/KSP provider only if direct PIV/CAC signing is required. Do not use the TLS authentication certificate as a substitute for the document-signing certificate or promise all CAC/PIV middleware works identically. Test real agency readers, certificates, PIN cancellation, card removal, expired/revoked certificates and algorithm support. A timestamp is an independent time claim; a desktop clock, ID token `iat`, or a KMS signature alone is not a trusted timestamp. [N3] [W1] [N5] (inference; read 2026-10-17)

### Compatible tools and licensing

MSAL JavaScript/Node and `openid-client` are MIT; Electron uses the MIT permission grant. These meet the brief's license family rule, subject to preserving notices and reviewing the exact pinned dependency tree. Prefer MSAL Node for Entra or a maintained OIDC client for a multi-IdP implementation; do not add both simply to support one agency pilot. IdP/cloud subscriptions are separately contracted services, not MIT-licensed product components. [L1] [L2] [L3] (undated license files; read 2026-10-17; selection is our recommendation)

No GPL/BUSL/source-available card middleware or signing package is recommended for adoption here. Native platform CNG is the proposed integration surface; actual third-party middleware redistribution terms remain unconfirmed and require review if bundled. [W1] (read 2026-10-17; scope decision and uncertainty are ours)

## Recommendation — we recommend

1. **Workforce login pilot: 4–7 engineering days**, assuming an already configured agency IdP, a permitted native registration and access to a real PIV/CAC test account. Use external-browser PKCE, explicit roles, secure main-process session handling, logout and denial tests. Agency registration, policy approval and card troubleshooting are external calendar time, not included. [I1] [I2] [I3] [I5] (our estimate; read 2026-10-17)
2. **Approval envelope + agency service attestation: 5–10 additional engineering days**, assuming an approved service/key/retention location already exists. Include revision-race prevention, one-use challenges, remote signing, evidence export and independent verification. Keep the signing identity/audience unavailable to agent processes; verify an agent cannot approve through the loopback API. This is the practical first audit target. [N1] [N2] [N4] [E1] (our estimate/inference; read 2026-10-17)
3. **Direct PIV/CAC document signing: 10–20 additional engineering days** for a narrow Windows/one-card-family pilot; broad middleware support, formal crypto validation, packaging and agency testing can take longer. Add it only for an explicit agency evidence requirement. Avoid marketing either OIDC or a service-signed event as a personal digital signature or guaranteed legal nonrepudiation. [N2] [N3] [W1] (our estimate/inference; read 2026-10-17)
4. **Defer Login.gov for the workforce MVP.** For a real public-user need, resolve production redirect acceptance and the agency's IAA first; allow the published onboarding lead time in addition to engineering effort. [I10] (our recommendation; read 2026-10-17)

## Open questions

- Which agency issuer/tenant, government environment, PIV/CAC mappings and assurance policy apply? Can it return stable subject/role and authentication-context claims, and does policy permit a native loopback callback? No actual agency sign-in was tested. [I3] [I5] [I7] (read 2026-10-17; unconfirmed)
- Who can approve engineering work versus controls/security changes? Is author/self-approval allowed? What event invalidates approval, and what review artifacts must be retained? These are policy choices, not facts supplied by OIDC. [N1] (read 2026-10-17; design questions)
- Can the approver use a trusted device/origin separated from the coding agent, and where will the agency-controlled signing service run? Without that boundary, what laptop-compromise assumptions will the ISSO accept? [E1] [E2] (read 2026-10-17; threat-model questions)
- Is a service attestation sufficient, or is a certificate-based personal signature required? Which card key/certificate policies and trust roots are accepted, and what timestamp/revocation evidence must remain verifiable after certificate expiry? [N2] [N3] [N5] (read 2026-10-17)
- For Login.gov, will an HTTPS broker design be accepted for a desktop application, what subject/assurance scopes are approved, and who owns production partnership and role assignment? A public Login.gov account alone does not establish permission to approve agency work. [I8] [I10] [N1] (read 2026-10-17; final statement is our inference)

## Source registry

All sources were opened/read **2026-10-17**. “Undated” means no reliable publication/update date was exposed; license copyright years and crawl dates are not update dates. **>12 months old** means before 2025-10-17. Older standards are identified for age, not presumed invalid.

| ID | Primary source | Publication/update | Read |
| --- | --- | --- | --- |
| R1 | [Repository brief](../RESEARCH_BRIEF.md) | October 2026 | 2026-10-17 |
| R2 | [Repository architecture](../ARCHITECTURE.md) | Undated | 2026-10-17 |
| I1 | [RFC 8252 native apps][I1] | October 2017; **>12 months old** | 2026-10-17 |
| I2 | [Microsoft Electron/MSAL Node tutorial][I2] | 2025-04-08; **>12 months old** | 2026-10-17 |
| I3 | [Entra CBA supported scenarios/platforms][I3] | 2025-09-12; **>12 months old** | 2026-10-17 |
| I4 | [Okta Smart Card IdP, Identity Engine][I4] | Undated | 2026-10-17 |
| I5 | [Okta native Authorization Code + PKCE][I5] | Undated | 2026-10-17 |
| I6 | [Okta PIV/CAC IdP, Classic Engine][I6] | Undated | 2026-10-17 |
| I7 | [Entra national-cloud authority endpoints][I7] | 2025-01-15; **>12 months old** | 2026-10-17 |
| I8 | [Login.gov OIDC client authentication][I8] | Undated | 2026-10-17 |
| I9 | [Login.gov PIV/CAC help][I9] | Undated | 2026-10-17 |
| I10 | [Login.gov production deployment][I10] | Undated | 2026-10-17 |
| N1 | [NIST SP 800-63C-4 federation introduction][N1]; [publication record][N1date] | July 2025; **>12 months old** | 2026-10-17 |
| N2 | [FIPS 186-5 Digital Signature Standard][N2] | 2023-02-03; planning note 2025-05-12; **>12 months old** | 2026-10-17 |
| N3 | [FIPS 201-3, §§4.2.2.1/4.2.2.4][N3] | January 2022; **>12 months old** | 2026-10-17 |
| N4 | [RFC 8785 JSON Canonicalization Scheme][N4] | June 2020; **>12 months old** | 2026-10-17 |
| N5 | [RFC 3161 Time-Stamp Protocol][N5] | August 2001; **>12 months old** | 2026-10-17 |
| E1 | [Electron safeStorage security limits][E1] | Undated | 2026-10-17 |
| E2 | [Electron security recommendations][E2] | Undated | 2026-10-17 |
| W1 | [Windows CNG NCryptSignHash][W1] | 2025-07-22; **>12 months old** | 2026-10-17 |
| L1 | [MSAL license][L1] | Undated; MIT | 2026-10-17 |
| L2 | [openid-client license][L2] | Undated; MIT | 2026-10-17 |
| L3 | [Electron license][L3] | Undated; MIT permission grant | 2026-10-17 |

[R1]: ../RESEARCH_BRIEF.md
[R2]: ../ARCHITECTURE.md
[I1]: https://www.rfc-editor.org/rfc/rfc8252.html
[I2]: https://learn.microsoft.com/en-us/entra/identity-platform/tutorial-v2-nodejs-desktop
[I3]: https://learn.microsoft.com/en-us/entra/identity/authentication/concept-certificate-based-authentication-limitations
[I4]: https://help.okta.com/oie/en-us/Content/Topics/Security/idp-smart-card-workflow.htm
[I5]: https://developer.okta.com/docs/guides/implement-grant-type/authcodepkce/main/
[I6]: https://help.okta.com/en-us/Content/Topics/Security/idp-enable-smart-card.htm
[I7]: https://learn.microsoft.com/en-us/entra/identity-platform/authentication-national-cloud
[I8]: https://developers.login.gov/oidc/getting-started/
[I9]: https://www.login.gov/help/create-account/authentication-methods/piv-cac/
[I10]: https://developers.login.gov/production/
[N1]: https://pages.nist.gov/800-63-4/sp800-63c/introduction/
[N1date]: https://csrc.nist.gov/pubs/sp/800/63/c/4/final
[N2]: https://csrc.nist.gov/pubs/fips/186-5/final
[N3]: https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.201-3.pdf
[N4]: https://www.rfc-editor.org/rfc/rfc8785.html
[N5]: https://www.rfc-editor.org/rfc/rfc3161.html
[E1]: https://www.electronjs.org/docs/latest/api/safe-storage
[E2]: https://www.electronjs.org/docs/latest/tutorial/security
[W1]: https://learn.microsoft.com/en-us/windows/win32/api/ncrypt/nf-ncrypt-ncryptsignhash
[L1]: https://raw.githubusercontent.com/AzureAD/microsoft-authentication-library-for-js/dev/LICENSE
[L2]: https://raw.githubusercontent.com/panva/openid-client/main/LICENSE.md
[L3]: https://raw.githubusercontent.com/electron/electron/main/LICENSE
