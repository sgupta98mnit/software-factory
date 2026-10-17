# Working on the Software Factory itself

This repo is the factory, not a workspace. Agents working on a federal project work inside `workspaces/<name>/`, which has its own instructions.

- Read `docs/ARCHITECTURE.md` first.
- Two codebases:
  - `apps/server/`: the factory API (Node, Hono, TypeScript strict, ES modules; imports use `.js` extensions).
  - `canvas/`: our OpenHands Agent Canvas clone. Factory UI code lives only in `canvas/src/factory/`. Follow `canvas/AGENTS.md` there (React 19, React Router 7, Tailwind 4 with Canvas's theme tokens, React Query).
- Outside `canvas/src/factory/`, touch upstream Canvas files only when there's no other way, and keep the change to a line or two. Today that's `src/routes.ts`, `sidebar-rail-body.tsx` and `vite.config.ts`.
- After changing anything in `canvas/`, run `pnpm export:canvas-patch` so `patches/canvas-factory.patch` matches.
- Before you finish: `pnpm typecheck` and `pnpm test` here; in `canvas/`, `npx tsc --noEmit` and `npx eslint src/factory`.
- Never edit OpenSpec or Backlog.md files by hand from server code: read OpenSpec through `openspec … --json`, change tasks through the `backlog` CLI.
- Record every action that changes something with `audit()`. Never write secrets or full prompts to the audit log.
- Keep the API bound to 127.0.0.1.
- Pin new dependencies to exact versions.
