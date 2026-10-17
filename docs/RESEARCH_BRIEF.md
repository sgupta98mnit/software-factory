# Research brief: a software factory for federal delivery teams

Written October 2026 to hand to a research agent (Codex). Read it, then read
`README.md` and `docs/ARCHITECTURE.md` in this repo for how the code works today.

**Your job is research, not code.** Don't change anything outside `docs/research/`.

---

## 1. What we're building

A **software factory**: a desktop tool where a small team turns requirements
into working software with coding agents, under human control, with a record an
agency's security staff can trust. It's modeled on 8090's "Software Factory",
but aimed at **federal delivery teams** working the way the
[USDS Digital Services Playbook](https://playbook.usds.gov/) describes: user
needs first, small iterative releases, and everything traceable for an
Authority to Operate (ATO).

The loop:

1. **Requirements** are written as specs with testable WHEN/THEN scenarios
   ([OpenSpec](https://github.com/Fission-AI/OpenSpec)). Each change has a
   proposal, specs, a design (including the NIST 800-53 controls it touches),
   and a task list.
2. **Work orders** are generated from the task list
   ([Backlog.md](https://github.com/MrLesk/Backlog.md) tasks). They carry
   acceptance criteria, dependencies and `control:` labels (for example `control:SI-10`).
3. **Agents** (Claude Code or Codex, through the Agent Client Protocol) pick up
   a work order, build it, check off criteria and write a summary.
4. **A person approves** each work order. Agents never mark work done; the
   tool flags anything that reaches Done without a person's approval.
5. **Everything is recorded** in a hash-chained audit log that can be verified.

**Who:** Sumit Gupta at Radiant (a federal contractor). One or two engineers,
TypeScript. The product would be used by Radiant's delivery teams first, and
possibly offered to agencies later.

**Where it should run:** a **desktop app** on the developer's Windows PC is the
current goal. Hosted or multi-user versions may come later.

## 2. What exists today (this repo)

- **UI:** a fork of [OpenHands Agent Canvas](https://github.com/OpenHands/OpenHands)
  (MIT, v1.27.1, commit `0452907`). Canvas already runs Claude Code, Codex,
  Gemini CLI and OpenHands' own agent over ACP, using the user's existing CLI logins.
  We add three pages (Requirements, Work orders, Audit log) in
  `canvas/src/factory/`, kept as `patches/canvas-factory.patch`.
- **Factory API:** `apps/server`, Node + Hono, on 127.0.0.1:4317. It reads
  OpenSpec through its `--json` CLI and changes Backlog.md tasks through its
  CLI. It also generates work orders from `tasks.md`, writes the agent's first
  message (the "brief"), enforces the approval rule, and keeps
  `data/audit.jsonl` (each line's SHA-256 covers the previous one).
- **Verified:** a real Claude Code run started from a work order. It read the
  spec, moved the work order to In Progress, checked off its criterion and wrote
  a summary, and the board updated live. Approval and the "done without
  approval" flag both work, and the audit chain verifies.
- **Runs today as** a local web app (`pnpm dev`, then a browser at
  localhost:8000). Canvas also has an Electron build (`canvas/electron/`,
  `npm run build:desktop`) that we haven't adapted yet.

## 3. Known gaps and risks

1. **Agents run unsandboxed with every permission granted.** The OpenHands SDK
   auto-approves all ACP permission requests (`request_permission` in
   `openhands/sdk/agent/acp_agent.py`). Its defaults start Claude Code in
   `bypassPermissions` and Codex in `agent-full-access`.
2. **No identity.** The audit log trusts an environment variable (`SF_USER`).
3. **Audit log lives on one laptop.** It's tamper-evident, but it can be deleted
   outright. Agent transcripts stay in OpenHands' local storage.
4. **Model access.** We use personal Claude/Codex subscriptions while
   building. A product for agencies needs approved endpoints (for example
   Bedrock in AWS GovCloud, Azure OpenAI in Azure Government).
5. **Fork maintenance.** Our Canvas changes are a patch against a pinned
   commit. Canvas has an early "Canvas Extensions" API that might replace it.
6. **Windows.** OpenHands doesn't test native Windows in CI. The agent server
   runs through `uv` (Python).
7. **Outbound traffic.** With telemetry off, the browser still contacts Google
   Fonts and the npm registry (update check).

## 4. Competitors (from browsing in Oct 2026; verify before relying on it)

- **8090 Software Factory:** Requirements, Blueprints, Work Orders, Feedback.
  It connects to Claude Code and Cursor over MCP and is multi-model. Pricing seen:
  about $200 per seat plus tokens plus 20%.
- **Opsera Forge (SoftwareForge):** work order as a contract, "Living Specs", a
  quality score ("ForgeScore"), a security agent.
- **Factory (factory.com / factory.ai):** model routing in the harness, outbound-only
  connections, its own compute.
- **Cognition / Devin:** reports FedRAMP High for some products. Pattern of one
  writer agent plus a separate clean-context reviewer.
- **Blitzy:** large-codebase autonomous generation.

## 5. Research questions

Answer each in its own file, `docs/research/NN-topic.md` (for example
`01-desktop-packaging.md`).

1. **Desktop packaging.** How does Canvas's Electron build start its
   services (`canvas/electron/main.mjs`, `electron-builder.config.mjs`)?
   What's the cleanest way to add our factory API to it? Then cover
   Windows code signing (EV vs. standard certificates, Azure Trusted Signing),
   auto-update options, installing without admin rights, and how agencies
   typically allow or block unsigned and Electron apps on government laptops.

2. **Sandboxing agents on a Windows PC.** Compare these options for a federal
   developer laptop:
   - Docker Desktop (licensing for contractors and agencies) vs. Podman
     vs. WSL2 vs. Windows Sandbox vs. dev containers
   - OpenHands' own Docker runtime
   - Claude Code's and Codex's built-in sandboxes on Windows

   Also check whether OpenHands has an issue, PR or setting that relays ACP
   permission requests to the UI instead of auto-approving. If not, how hard is
   it to add upstream?

3. **Approved model access.** Which Claude models are on Bedrock in AWS GovCloud,
   and at what FedRAMP and DoD Impact Levels today? The same for OpenAI models on
   Azure Government. How do you point Claude Code at Bedrock, and Codex at Azure
   OpenAI? What do Anthropic's and OpenAI's terms say about building a product on
   their CLIs or SDKs, and about using consumer subscriptions in it?

4. **Identity for a desktop tool.** PIV/CAC sign-in from an Electron app.
   OIDC with agency identity providers (Entra ID, Okta, Login.gov for
   non-employees). What should a signed approval look like so it holds up in
   an audit (identity, timestamp, signature over the work order content)?

5. **Audit and compliance requirements.** Which NIST 800-53 Rev 5 controls
   apply to a tool like this (AU, AC, IA, CM, SA, SR families)? What does good
   evidence look like for continuous ATO? Look at OSCAL and IBM's
   `compliance-trestle` for generating component definitions or SSP content
   from our `control:` labels and approvals. Cover options for anchoring the
   log: KMS signing, S3 Object Lock, Sigstore/Rekor, forwarding to a SIEM.

6. **Federal AI policy that applies.** Current OMB memos on federal AI use and
   acquisition, NIST AI RMF, NIST SP 800-218A (secure development for AI),
   CISA Secure by Design, and FedRAMP 20x. For each, say what it requires or
   recommends for AI coding tools and agent-written code.

7. **Spec-driven development tools.** OpenSpec vs. GitHub Spec Kit vs. Kiro
   vs. others: maturity, licenses, JSON or programmatic interfaces, and how
   well each fits controls traceability. Backlog.md alternatives that keep
   tasks as files in git. Do the same for the Agent Client Protocol
   ecosystem: which agents support it, how stable it is, who maintains it.

8. **Getting off the patch.** Status of OpenHands Canvas Extensions
   (`canvas/specs/canvas-extensions.md`): is the backend API shipped, and
   could our three pages become an extension? What is OpenHands' release
   cadence and roadmap, and are there signs of Windows support?

9. **Competitors in government.** For the products in section 4: FedRAMP or
   StateRAMP status, government customers or contract vehicles, pricing,
   and self-hosted or air-gapped options. What could we own that they don't?
   Candidates: open source, local-first, controls traceability built in, an
   evidence package for each change.

## 6. Rules for the research

- **Cite every claim** with a link and the date you read it. Prefer primary
  sources: vendor docs, GitHub repos, official .gov pages.
- **Check dates.** Mark anything older than 12 months, and anything you couldn't confirm.
- **Keep fact separate from your inference.** Use "Sources say…" vs. "We recommend…".
- **Stick to compatible licenses.** We only adopt MIT/Apache/BSD-compatible
  tools. Flag any GPL, BUSL or source-available licenses.
- **Don't edit code, and don't run installers or network tools against
  anything but public docs.**

## 7. What to hand back

1. One file per question in `docs/research/`. Each starts with a three-line
   summary, then findings, a recommendation, open questions and sources.
2. `docs/research/SUMMARY.md`: the top 10 recommendations, ranked by impact
   on getting this in front of a federal team. For each, give an effort guess
   (days) and the file it came from.
