
<!-- BACKLOG.MD GUIDELINES START -->
<!-- backlog.md-instructions-version: 1.53.0 -->
<CRITICAL_INSTRUCTION>

## Backlog.md Workflow

This project uses Backlog.md for task and project management.

**At the beginning of each conversation in this project, run `backlog instructions overview` before answering or taking action. Re-read it only if you have not read it yet in the current conversation.**

Use the overview to decide whether to search, read, create, or update Backlog tasks.

Before task lifecycle actions, read the matching detailed guide:
- `backlog instructions task-creation` before creating or splitting tasks
- `backlog instructions task-execution` before planning, changing status or assignee, adding a plan or implementation notes, or implementing task work
- `backlog instructions task-finalization` before checking acceptance criteria, writing final summaries, or moving tasks to terminal statuses

Use `backlog <command> --help` before running unfamiliar commands. Help shows options, fields, and examples.

Do not edit Backlog task, draft, document, decision, or milestone markdown files directly. Use the `backlog` CLI so metadata, relationships, and history stay consistent.

</CRITICAL_INSTRUCTION>
<!-- BACKLOG.MD GUIDELINES END -->

<!-- SOFTWARE FACTORY CONVENTIONS START -->
## Software Factory conventions

This workspace is run from the Software Factory (OpenHands Agent Canvas with Requirements, Work orders and Audit log pages). Requirements and designs live in OpenSpec (`openspec/`); work orders are Backlog.md tasks (`backlog/`). If the `openspec` or `backlog` command isn't installed, use `npx -y @fission-ai/openspec@1.14.0` or `npx -y backlog.md@1.53.0`.

- **Requirements first.** New behavior starts as an OpenSpec change (`openspec/changes/<name>/`: proposal, specs, design, tasks). Use the OpenSpec skills or `openspec ... --json` commands; validate with `openspec validate --all`.
- **One work order per task group.** When asked to plan work orders for a change, create one Backlog.md task per `## N.` group in its `tasks.md`, in order, each depending on the previous one.
- **Acceptance criteria come from the spec.** Turn the change's spec scenarios (WHEN/THEN) and task items into `--ac` acceptance criteria.
- **Labels:** every work order gets `change:<change-name>`, plus `control:<ID>` for each NIST 800-53 control from the design's Controls table that the work touches (for example `control:SI-10`).
- **Keep the work order current.** Move it to `In Progress` when you start (`backlog task edit WO-N --status "In Progress"`), check off each acceptance criterion as you meet it (`--check-ac <n>`), and finish with `--final-summary "<what changed, how you tested it>"`.
- **People approve, agents don't.** Never move a work order to `Done`. A person approves it in the Software Factory after reviewing; the factory flags any work order that reaches `Done` without that approval.
- **No secrets or personal data** in work orders, specs or logs.
<!-- SOFTWARE FACTORY CONVENTIONS END -->
