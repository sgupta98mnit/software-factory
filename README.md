# Software Factory

An 8090-style software factory for federal delivery teams, built on [OpenHands Agent Canvas](https://github.com/OpenHands/OpenHands).

Canvas gives you the agent UI: chat with Claude Code, Codex or OpenHands, using the logins you already have. This repo adds three pages to it:

- **Requirements:** [OpenSpec](https://github.com/Fission-AI/OpenSpec) changes (proposal, specs with WHEN/THEN scenarios, design, tasks). Validate them, or ask an agent to review them.
- **Work orders:** [Backlog.md](https://github.com/MrLesk/Backlog.md) tasks on a board, created from a change's task list, tagged with NIST 800-53 controls. Start an agent on one; approve it when it's done.
- **Audit log:** every approval, status change and work order edit, in a hash chain you can verify.

Requirements and work orders are plain files in the workspace repo, so they also have git history.

## What's in this folder

```
apps/server/                 Factory API: OpenSpec, Backlog.md, approvals, audit log (port 4317)
canvas/                      Your OpenHands Canvas clone (created by pnpm setup:canvas; its own git repo)
patches/canvas-factory.patch Our changes to Canvas: src/factory/ plus three small edits
canvas.lock.json             The OpenHands commit the patch is built on
workspaces/benefits-portal/  Demo workspace the agents work in (OpenSpec + Backlog.md set up)
scripts/                     setup-canvas, dev, export-canvas-patch, setup-workspace
docs/ARCHITECTURE.md         How it fits together, and where to extend it
data/                        Created when you run it: audit.jsonl (git-ignored)
```

## Set up (Windows)

You need:

- **Node.js 24 or newer.** Canvas requires it. Check with `node -v`.
- **Git** ([git-scm.com](https://git-scm.com)).
- **uv**, which Canvas uses to run the OpenHands agent server:
  `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`
- **Claude Code and/or Codex**, signed in once: run `claude` and log in, and `codex login`.

Then, in PowerShell:

```powershell
cd $HOME\Documents\software-factory
npm install -g pnpm@10.34.6   # Node 25+ no longer ships corepack, so install pnpm with npm
pnpm install
pnpm setup:canvas        # fetches OpenHands Canvas into canvas\, applies our patch, runs npm ci
```

`pnpm setup:canvas` takes a few minutes the first time. Run it again any time; it skips what's done.

## Run it

```powershell
pnpm dev
```

Open **http://localhost:8000**. The first run starts the OpenHands agent server (uv downloads it once), so give it a minute.

Canvas shows its onboarding the first time. Pick **Claude Code** or **Codex** as your agent; it reuses your CLI login, so you can leave the key fields empty. To have both, add a second profile under **Settings → Agents**.

## Try the flow (5 minutes)

1. **Requirements:** open `add-claim-status-lookup`, read the requirements, click **Create work orders**, then **Create 3 work orders**.
2. **Work orders:** open **WO-1**, click **Start with an agent**, choose Claude Code or Codex, and **Start conversation**. The first message is written from the work order; you can edit it.
3. Watch the agent work in Canvas. Back on **Work orders**, WO-1 moves to In Progress, its acceptance criteria get checked off and a final summary appears, as the agent updates the work order.
4. Review what it built (`workspaces\benefits-portal\claim-status-service`), then **Approve** WO-1. That's your name on the record.
5. **Audit log → Verify chain** proves nothing in the log was edited.

To start over: stop `pnpm dev`, then delete `data\` and `workspaces\benefits-portal\backlog\tasks\`.

## Use your own project

```powershell
cd C:\path\to\your-repo
npx @fission-ai/openspec@1.14.0 init --tools claude,codex
npx backlog.md@1.53.0 init "My Project" --defaults --integration-mode cli --agent-instructions claude,agents --task-prefix wo

cd $HOME\Documents\software-factory
$env:SF_WORKSPACE = "C:\path\to\your-repo"
pnpm dev
```

Copy the "Software Factory conventions" block from `workspaces\benefits-portal\AGENTS.md` into your repo's `AGENTS.md` and `CLAUDE.md`.

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `SF_WORKSPACE` | `workspaces/benefits-portal` | The repo agents work in |
| `SF_AGENT_WORKSPACE` | same as `SF_WORKSPACE` | That repo's path as the agent server sees it (set it when agents run in Docker) |
| `SF_USER` | your Windows user name | Name recorded in the audit log when nobody signs in |
| `SF_AUTH` | `local` | `oidc` signs people in with the agency's identity provider (see [Sign-in and roles](#sign-in-and-roles)) |
| `SF_OIDC_ISSUER`, `SF_OIDC_CLIENT_ID` | none | The OpenID Connect issuer and this factory's client id; `SF_OIDC_CLIENT_SECRET` only for a confidential client |
| `SF_OIDC_REDIRECT_URI` | `http://localhost:8000/sf-api/auth/callback` | Where the identity provider sends people back |
| `SF_OIDC_ROLES_CLAIM`, `SF_OIDC_ROLE_MAP` | `roles`, none | Which claim holds roles, and how its values map to factory roles |
| `SF_LOCAL_ROLES` | every role | The roles this machine's user has when nobody signs in |
| `SF_PORT` | `4317` | Factory API port. If you change it, change `SF_API_URL` in `canvas\.env` too |
| `SF_DATA_DIR` | `data` | Where the audit log, the Autopilot ledger (`autopilot.db`) and its worktrees are kept |
| `SF_EVIDENCE_DIR` | `data/evidence` | The write-once evidence store (exported packets, release approvals); point it at write-once storage if you have it |
| `SF_EVIDENCE_RETENTION_DAYS` | `2555` (7 years) | How long stored evidence is kept before the factory prunes it |
| `SF_BACKUP_DIR` | `data/backups` | Where backups go |
| `SF_AGENT_SERVER_URL` | `http://127.0.0.1:8000` | Where Autopilot reaches the OpenHands agent server (Canvas's address) |
| `SF_AGENT_SERVER_KEY` | Canvas's saved key | The agent server's session key, if Canvas keeps it somewhere else |
| `SF_AUTONOMY_CAP` | none | Highest Autopilot autonomy anyone can pick: `suggest`, `supervised` or `autonomous` |
| `SF_REQUIRE_ISOLATION` | none | `1` refuses to run agents or their code on this machine: runs need `execution.provider: container` and a passing isolation check, whatever the workspace policy says |
| `SF_DOCKER` | `docker` | The Docker CLI Autopilot uses for isolated execution |
| `SF_TRIVY` | `trivy` | The Trivy binary Autopilot's security scan runs |
| `SF_GITHUB_TOKEN` | none | Token for pull request delivery: fine-grained, one repository, Contents read/write, Pull requests read/write, Checks and Commit statuses read |
| `SF_TRIVY_SHA256` | none | The Trivy binary's sha256; with it set, `SF_TRIVY` must be the binary's full path and any other binary is refused |

## Autopilot policy

Each run reads `.factory/policy.yml` from the workspace's base branch when it starts and keeps it until the run ends. It never reads the file from a worktree or a work-order branch, so a change can't relax its own rules. Without the file, Autopilot uses these defaults. Set only the keys you want to change, and quote glob patterns:

```yaml
version: 1
autonomy: { default: supervised, max: autonomous }   # the lower of max and SF_AUTONOMY_CAP wins
agents: { spec: null, critic: null, builder: null, reviewer: null, validator: null }   # profile id or name; null = Canvas's active profile
parallel: 3                                          # work orders building at once
repair: { sameConversation: 2, fresh: 1 }
budget: { perWorkOrderUsd: 5, perChangeUsd: 30, reserveUsd: 1, perDayUsd: null }   # perDayUsd: across runs, per local day; null = none
spec: { validateTries: 3, criticRounds: 2 }
review: { blocking: [critical, high] }
gates: null                                          # null = npm typecheck/lint/test scripts; or [{ name, run, cwd?, timeoutSec? }]
autoMerge:
  maxChangedLines: 400
  sensitivePaths: ["**/auth/**", "**/crypto/**", "infra/**", "**/*.tf", "Dockerfile", ".github/**", ".gitlab-ci.yml", ".factory/**", "AGENTS.md", "CLAUDE.md", "**/migrations/**"]
  dependencyAllowlist: []
execution:
  provider: local                                    # local (agents and gates on this machine, not isolated) or container
  container:                                         # used when provider is container
    image: null                                      # required: agent-server image pinned by digest, already pulled
    gateImage: null                                  # image the gates run in; null = image
    network: null                                    # required: a Docker network you created (not host)
    gateNetwork: null                                # null = network
    user: null                                       # "uid:gid"; null = your ids on Linux/macOS, the image's user on Windows
    memory: 4g
    cpus: 2
    pids: 512
    hostPathStyle: native                            # native (Docker Desktop) or wsl (a WSL engine: C:\x becomes /mnt/c/x)
    credentials: { spec: [], critic: [], builder: [], reviewer: [], validator: [] }   # environment variable names each role gets
    startTimeoutSec: 120
hiddenTests: { enabled: false, run: "node --test" }  # a test writer's independent tests run on every work order
watchdog: { idleMinutes: 90 }                        # stop an agent with no new event or cost for this long; 0 = never
delivery:
  mode: none                                         # none (the branch stays local) or github (push it and open a draft pull request)
  remote: origin
  repository: null                                   # "owner/name"; null = from the remote's URL
  apiUrl: "https://api.github.com"                   # GitHub Enterprise Server: https://<host>/api/v3
  requiredChecks: []                                 # checks that must pass on the pushed head; [] = every reported check
  ciTimeoutMinutes: 120
  maxCiRepairs: 2                                    # CI or review fix rounds before a person decides
verification:
  protectedPaths: [".factory/**", ".hidden-tests/**", ".sf-hidden/**"]   # put back when a work order changes them
  trivy:
    mode: off                                        # off, advisory (findings go back) or required (fails closed too)
    version: null                                    # accept only this Trivy version, like "0.58.1"
    scanners: [vuln, secret, misconfig]
    severities: [critical, high]                     # new findings at these severities send the work back
    maxDbAgeHours: 72
    timeoutSec: 600
governance:
  controlApproval: off                               # required: an ISSO approves each verified commit of a work order with mapped controls
  releaseApproval: off                               # required: a release manager approves the commit a finished run ends with
  fourEyes: true                                     # whoever started a run can't approve its release
  assessmentPlan: null                               # the agency's OSCAL assessment plan (a URI) that assessment results import
```

A work order merges without a person only when its gates and review passed, it adds no dependency outside `dependencyAllowlist`, it changes no file under `sensitivePaths` (any case, dot folders included; a bare name like `Dockerfile` matches in every folder), and it changes fewer than `maxChangedLines` lines. In `suggest` mode a person approves every merge. Anything else goes to the Inbox with the reasons. The audit log records policy approvals as `policy@<hash>`, where the hash identifies the exact rules. An invalid file (unknown key or bad value) stops new runs, and `/sf-api/autopilot/status` shows the error. `routing` and `notify` are accepted for features still to come; `delivery` is described under [Pull request delivery](#pull-request-delivery); `execution` is described under [Isolated execution](#isolated-execution), `hiddenTests` and `verification` under [Trusted verification](#trusted-verification), `governance` under [ISSO and release approvals](#isso-and-release-approvals).

Autopilot checks reported conversation costs before starting more work and after each poll. At the run limit (the amount entered in Home, or `budget.perChangeUsd`), it pauses the run's agents and opens a budget decision in the Inbox. At a work order's limit, it pauses that order while the others continue. Continue adds the policy's base budget to the relevant limit; Skip ends that work order; Cancel ends the run. Limits and decisions persist across restarts, and a normal Resume cannot bypass a run budget decision. Spending can rise between checks or while a pause request completes; enforcement depends on the agent server reporting costs.

Agents started together can't overrun a limit: each new agent reserves `budget.reserveUsd` ($1 by default; 0 turns reservations off) in its run, its work order and, with `budget.perDayUsd`, the day across all runs, until it has spent that much. An agent starts only when every one of those limits has room for its reservation beyond what's spent and what running agents still hold. Otherwise it waits (Starting) for running agents to finish, and when none are left to, the run or work order waits for a person in the Inbox. Continue on a daily item raises today's limit by `perDayUsd` for every run, unless another run's Continue already made room. An agent's whole cost counts on the day it started.

## Isolated execution

By default (`execution.provider: local`) Autopilot's agents, their tools and the gates run on this machine with your permissions, through Canvas's agent server. Nothing is isolated, and Home, the run page and evidence say so.

With `execution.provider: container`, the factory starts one agent-server container per agent attempt from the digest-pinned `image`, with the same lifecycle as the agent server's own Docker runtime: all capabilities dropped, `no-new-privileges`, the memory, CPU and process limits above, the policy's `network`, and the agent server published on 127.0.0.1 only, with a session key derived from `data/runtime.key`. Only the attempt's worktree is mounted (at `/workspace`), its `.git` file hidden behind a read-only empty file, so nothing in the container can point the factory's git elsewhere. Agents there have no git: the factory commits what they leave, and a reviewer reads the diff from `/factory/changes.diff`. Each role gets only the environment variables its `credentials` list names; values never appear in arguments, the ledger, the audit log or evidence. The factory copies the role's Canvas agent profile into the container, so use ACP profiles (Claude Code, Codex) whose keys come from those variables. Gates run in throwaway containers on `gateNetwork`, without credentials.

Before a run starts, and from **Check isolation** on Home, the factory checks that Docker answers, the image and networks exist, every named credential is set, a container can read a file the factory writes through the mount (path mapping), and that a container on the network can't reach the factory API or Canvas on this machine. Docker Desktop forwards `host.docker.internal` to this machine's loopback, so an agent on a plain bridge network could call the factory as you: use a network without access to this machine. A run that fails a check doesn't start. If Docker stops mid-run, the run waits for it, as it does for an unreachable agent server.

Containers are named after their attempt, so a restarted factory reconnects to running ones. A container that disappears ends its attempt, and the normal repair loop starts a fresh one. Containers are removed once their attempt can't get another message (its work order merged, a newer attempt replaced it, or the run ended); leftovers are swept at startup. Transcripts stay in `data/runtime/<run>/a<attempt>/state`, not in Canvas. The container provider has been tested against a stand-in Docker CLI, not yet against a live Docker engine and agent-server image.

## Trusted verification

A run fixes its checks when it starts, from the base branch: the policy's `gates`, or else the `typecheck`, `lint` and `test` scripts (with their `pre`/`post` scripts) of the base branch's package.json files, at the root and one folder down. The factory runs those script bodies itself, with `node_modules/.bin` on PATH, so a work order that rewrites a script, adds `.npmrc` settings or deletes a check doesn't change what runs. A work order that changes a pinned script needs a person's merge approval, because the next run would pin the change. When the base defines no checks, the work order's own scripts run, and evidence says the checks weren't pinned. Files under `verification.protectedPaths` that a work order changes are put back as they are on its base, and the run records it.

Every check records the commit it checked. When the gates pass, the factory checks the commit out again in a folder no agent sees and runs what the policy asks for:

- **Hidden tests** (`hiddenTests.enabled`). Before any work is checked, a test writer (another vendor than the spec agent, when there is one) writes one black-box `node:test` file per scenario from the spec. The factory keeps them in `data/hidden-tests/<run>/` with their digests, runs each work order's own after installing its dependencies, and runs all merged ones again on the integration branch after every merge. A builder hears the scenario and one line of the failure, never the test. With local execution agents run with your permissions and could read that folder: the tests stay hidden from builders only with isolated execution.
- **Trivy** (`verification.trivy.mode`). The factory runs the binary in `SF_TRIVY` without updating its database (keep it current with `trivy image --download-db-only`). It refuses a version other than `version`, a database older than `maxDbAgeHours`, and a binary that doesn't match `SF_TRIVY_SHA256`. Findings the work order's base already has don't count; new ones at the policy's `severities` go back to the builder as rule, package, file and line, never a secret's text. In `required` mode a scanner that can't answer stops the work order with a Retry in the Inbox; in `advisory` mode the run goes on and the check records why the scan didn't run.

When everything passes, the factory records a `verified` check for that commit. Merging needs one for the branch's current head: if the branch moved after verification it is verified again, and a merge approval given before that doesn't count. Evidence reports security scanning and independent validation as `recorded` only when every merged work order has them. The Trivy integration has been tested with a stand-in CLI, not yet with a real Trivy binary and database.

## Recovery and duplicates

Every follow-up message to an agent (a repair, a validation fix, your answers or revisions) is written to the ledger in the same transaction as the state change behind it, then sent; nothing is sent before that change is saved. Each message ends with a marker like `(sf-msg-12)`. If the agent server's answer is lost (a timeout, or the factory stopped mid-send), the factory searches the conversation for the marker: found means delivered, still missing a minute later means it is sent again. An agent server that can't be searched puts the message in the Inbox, where you send it again or confirm it arrived. Refused connections retry with growing delays; after ten tries, or when the agent server refuses a message outright, it goes to the Inbox. If a spec agent's conversation is gone, the Inbox offers a new spec agent that is told what the lost message said. A conversation whose start was lost is looked up before it is created again.

One factory process acts on a data folder at a time. The running process renews a lease every few seconds. A second process stands by (Home says so) and takes over when the first stops, at once if the first process is gone, otherwise when its lease expires. After a takeover the old process's writes are refused, and it stops.

The watchdog stops an agent that has produced no new conversation event and no new cost for `watchdog.idleMinutes` (90 by default; 0 turns it off), and the run handles it like any agent that stopped with an error. API clients can send an `Idempotency-Key` header (8–200 letters, digits, `-` or `_`) with `POST /runs`, the pause, resume and cancel actions, and Inbox decisions: a repeated key returns the first answer for a day.

## Pull request delivery

With `delivery.mode: github`, a run whose work orders are merged pushes its integration branch, `autopilot/<change>`, to `delivery.remote` and opens a draft pull request into the base branch. The factory only fast-forwards `autopilot/` branches: it never pushes the base branch, never force-pushes, and never marks the pull request ready, merges it or deploys. People do that. Give it a fine-grained token in `SF_GITHUB_TOKEN`, limited to the one repository, with Contents read and write (to push), Pull requests read and write, and Checks and Commit statuses read. The token goes only into request headers and the push's own environment, never into arguments, the ledger, the audit log or a comment.

The pull request's description names the run, and its evidence comment is updated for each pushed head; when the run finishes, the comment shows the evidence packet's digest. A restart finds the run's pull request again instead of opening a second one. CI and reviews count only on the exact pushed head: `delivery.requiredChecks` must all pass there (with an empty list, every reported check must). A failing check, or changes a reviewer requested on that head, becomes a new work order marked as a CI or review fix, built, verified, reviewed and merged like the others. The new head is then pushed and checked again. After `delivery.maxCiRepairs` rounds, when CI takes longer than `delivery.ciTimeoutMinutes`, or when someone else pushed to the branch or closed the pull request, the run waits in the Inbox, where you try again, finish the run there, or cancel it. A pull request a person merges ends the run. Delivery has been tested against a stand-in GitHub API with a local repository as the remote, not yet against github.com.

## Sign-in and roles

By default (`SF_AUTH=local`) the factory acts as this machine's user, with every role; `SF_LOCAL_ROLES` (for example `engineer`) narrows them. Home says which mode it's in.

With `SF_AUTH=oidc`, people sign in with the agency's identity provider (Entra ID, Okta or another OpenID Connect issuer) through Authorization Code with PKCE. Register a public client whose redirect URI is `SF_OIDC_REDIRECT_URI` (default `http://localhost:8000/sf-api/auth/callback`), then set `SF_OIDC_ISSUER` and `SF_OIDC_CLIENT_ID`. The factory checks the ID token's signature against the issuer's published keys (RS256 or ES256), its issuer, audience, expiry and nonce, and keeps only a hash of the session cookie (HttpOnly, SameSite=Strict, `SF_SESSION_HOURS`, 8 by default). Every request then needs a session, so an agent that reaches the API without a person's session changes nothing. The audit log names people by issuer and subject (`oidc:<sub>@<issuer host>`), not by display name.

Roles come from the ID token claim `SF_OIDC_ROLES_CLAIM` (`roles` by default), mapped with `SF_OIDC_ROLE_MAP` (JSON such as `{"Factory-Approvers":"approver"}`; without it, claim values that are role names are used).

| Role | May |
| --- | --- |
| engineer | start, pause, resume and cancel runs; answer questions; decide errors, failed work orders, undelivered messages and delivery problems; create and move work orders |
| approver | approve specs, plans and merges; raise budgets; approve work orders |
| isso | approve work orders that implement mapped security controls |
| release_manager | approve or reject a finished run's release |
| admin | make backups |

## ISSO and release approvals

With `governance.controlApproval: required`, a work order whose tasks map to security controls (the Controls table in the change's design.md) waits after verification and review in **Controls need an ISSO's approval**. Its Inbox item lists the controls, the checks recorded at the work order's commit, its acceptance criteria and what it changes. Only the isso role decides it, and the approval counts for that exact commit: if the work changes (a merge approval sends it back, say), it's verified again and an ISSO is asked again. A merge approval never stands in for it, and the audit log's merge event names both people.

With `governance.releaseApproval: required`, a finished run opens a **Release** item for the commit it finished with (the pushed head, when it delivered a pull request). A release manager other than the person who started the run (`fourEyes`, on by default) approves or rejects it, and approving needs the integration branch still at that commit. The factory then exports the run's evidence and stores it with an approval envelope that names the commit, the evidence digest, the policy hash and the approver's identity and roles. Both go write-once into `data/evidence/<run>/` (`SF_EVIDENCE_DIR` moves it): read-only files named by their SHA-256, which the factory never overwrites. An approval records a decision made in this factory. It isn't an authorization to operate, and nothing is merged or deployed.

## Run evidence

On a finished, failed or cancelled run, choose **Download evidence** to save a JSON packet containing the recorded artifact commit, pinned policy hash, work order criteria/control mappings, gate metadata, agent costs and approval decisions. This works after worktrees are cleaned up. The API is `POST /sf-api/autopilot/runs/:id/evidence` with JSON `{}`; active runs return 409 and missing runs return 404. A damaged audit chain blocks export with a visible error.

The response contains `packet` and its SHA-256 `digest`. Hash only `packet` using `sf-canonical-json-v1`: recursively sort object keys, preserve array order and serialize with JSON.stringify (undefined object members omitted). The existing `canonicalJson` and `sha256` exports in `apps/server/src/audit.ts` implement this format. The digest detects edits; the packet is unsigned and does not authenticate its producer. Each export is also kept write-once in the evidence store (`data/evidence/<run>/packet-<sha256>.json`, read-only, never overwritten) and pruned only after `SF_EVIDENCE_RETENTION_DAYS`. Back the store up with the relevant Git objects and audit log if you need to investigate it later.

Artifact identity comes from the run's terminal audit event, never the current branch tip. Missing commits are marked unavailable; older failed/cancelled runs may have no recorded artifact. Historical gate checks lack commit binding, and output hashes cover only the stored output tail, not the full command log. Raw goals/prompts, agent replies, gate output, approval notes and arbitrary audit payloads are excluded. Work order titles and criteria remain project content: review them before sharing. Security scanning and independent validation are explicitly unrecorded; control mappings do not establish compliance.

The [implementation roadmap](docs/autopilot/ROADMAP.md) selects approaches from the researched projects and sequences isolation, trusted verification, durable recovery, PR delivery and governance after this evidence foundation.

## Attestations and assessment results

A done run also offers **Download attestation** (`POST /sf-api/autopilot/runs/:id/attestation`). It's an in-toto Statement v1 about the run's artifact commit (subject digest `gitCommit`, predicate type `urn:software-factory:run-verification:v1`) in a DSSE envelope signed with this factory's Ed25519 key. The predicate lists each merged work order's verified commit and the checks that passed on it, the run's evidence digest, its verification settings and its release decision. The key is made on first use in `data/signing/` and never goes into a backup or a response; `GET /sf-api/autopilot/attestation-key` gives its public half and key id. The signature says the factory recorded these facts. It isn't a person's approval or a certification.

**Download OSCAL assessment results** (`POST /sf-api/autopilot/runs/:id/oscal`) produces OSCAL 1.1.2 assessment results for the controls the run's merged work orders map. Each control gets one finding, marked satisfied only because an ISSO approved each implementing work order's verified commit; each work order gets an observation, and the ISSO is named as a party. The results import the agency's assessment plan from `governance.assessmentPlan`.

Both are refused (409) unless their facts exist, and the response's `missing` lists each gap: the run isn't done, its artifact commit isn't recorded or is gone, or a merged work order has no verified commit. Assessment results also need an assessment plan, at least one mapped control, and an ISSO's approval of each implementing commit. Both are kept in the evidence store with the packet they came from.

## Backups

`POST /sf-api/admin/backup` with `{}` (admin role) writes a backup folder to `SF_BACKUP_DIR`. It holds a consistent copy of the ledger with sign-in sessions removed, the audit log copied between appends, the evidence store, and `manifest.json` with every file's SHA-256. A backup is refused while the audit chain or a stored evidence file doesn't verify. The audit log records the manifest's digest (`factory.backup_created`). Keys (`data/runtime.key`) never go into a backup: a restored factory makes new ones. Copy backups off this machine.

To check a backup, then restore it into a new, empty folder:

```powershell
pnpm --filter @sf/server restore D:\backups\2026-10-18T21-43-53-102Z --expect <manifest sha256>
pnpm --filter @sf/server restore D:\backups\2026-10-18T21-43-53-102Z D:\factory-data --expect <manifest sha256>
```

A restore first checks every file's digest, that nothing was added, the audit chain and where it ends, the evidence names and the ledger's integrity. Only then does it copy, and only into an empty folder; point `SF_DATA_DIR` at that folder. `--expect` (the digest from the audit log) also catches a backup whose manifest was rewritten along with its files.

## Working on the Canvas side

Factory UI code lives in `canvas\src\factory\`. Canvas is its own git repo on a `factory` branch, with OpenHands as the `upstream` remote.

- **Save your Canvas changes into this repo:** `pnpm export:canvas-patch`, then commit `patches\canvas-factory.patch`.
- **Push Canvas to your own GitHub fork:** `git -C canvas remote add origin <your-fork-url>`, then `git -C canvas push -u origin factory`.
- **Take a newer OpenHands release:** in `canvas\`, `git fetch --depth 50 upstream main`, then `git rebase upstream/main`. Fix conflicts (normally only in the three files listed in `canvas\src\factory\README.md`), run `pnpm export:canvas-patch`, and put the new commit in `canvas.lock.json`.

## Federal notes

- **Agents run with full permissions.** OpenHands approves every Claude Code and Codex permission request automatically, and `pnpm dev` runs the agent server directly on your machine. That's fine for trying it on the demo workspace. For agency code, run the agent server in Docker (see `canvas\README.windows.md`) so agents only see the folders you mount, and set `SF_AGENT_WORKSPACE`.
- **Approval is the gate.** Agents can change a work order, but only the Approve button records a person's approval. Anything else that marks work Done is flagged **Not approved**.
- **Telemetry is off.** `pnpm setup:canvas` sets `VITE_DO_NOT_TRACK=1` for Canvas, and OpenSpec runs with telemetry disabled. With that set, the only outside requests the browser made in testing were Google Fonts and an npm registry version check.
- **Canvas makes the workspace a git repo.** The first conversation in a folder that isn't one runs `git init` (no commit) so Canvas can show the agent's changes as a diff.
- **Subscriptions vs. products.** Your own Claude and Codex logins are fine while you build. Something you ship to agencies must use API keys or an approved endpoint such as Bedrock. Anthropic's terms don't let third-party products use claude.ai logins.
- The factory API listens on 127.0.0.1 only.

## Troubleshooting

- **The factory pages say the API isn't running:** `pnpm dev` starts it. If you started Canvas separately, run `pnpm dev:api` in another terminal.
- **`pnpm setup:canvas` says the patch doesn't apply:** `canvas\` has other changes or a different commit. Commit or stash them, or move `canvas\` aside and run it again.
- **The agent server won't start on Windows:** OpenHands doesn't test native Windows in CI yet. Run the same steps inside WSL2 (Ubuntu) with Node 24 and uv installed there.
- **Codex says to sign in:** run `codex login`, then start a new conversation.
- **Port 8000 is in use:** stop the other app, or see `canvas\docs\DEVELOPMENT.md` for Canvas's port settings.

## Versions

OpenHands Agent Canvas 1.27.1 (commit `0452907`), OpenSpec 1.14.0, Backlog.md 1.53.0, Hono 4.13. Pinned in `canvas.lock.json` and `apps/server/package.json`.
