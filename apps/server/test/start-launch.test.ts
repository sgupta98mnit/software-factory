// `pnpm start <folder>`: which folder becomes the workspace, and how the browser is opened.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const script = path.resolve(import.meta.dirname, "../../../scripts/start.mjs");
const { resolveWorkspace, openCommand } = (await import(script)) as {
  resolveWorkspace: (arg: string | undefined, env?: Record<string, string | undefined>, factoryRoot?: string) => string;
  openCommand: (platform: string, url: string) => { command: string; args: string[] };
};

test("resolveWorkspace: the argument, else SF_WORKSPACE, else the sample; never the factory itself or a folder holding it", () => {
  const base = mkdtempSync(path.join(tmpdir(), "sf-start-"));
  const factory = path.join(base, "software-factory");
  const sample = path.join(factory, "workspaces", "benefits-portal");
  const project = path.join(base, "my-project");
  const other = path.join(base, "other");
  for (const dir of [sample, project, other]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(base, "a-file.txt"), "x");

  assert.equal(resolveWorkspace(project, {}, factory), project);
  assert.equal(resolveWorkspace(`  ${project}  `, {}, factory), project, "spaces around a pasted path");
  assert.equal(resolveWorkspace(undefined, { SF_WORKSPACE: other }, factory), other);
  assert.equal(resolveWorkspace("", { SF_WORKSPACE: "" }, factory), sample, "the sample workspace inside the factory is fine");
  assert.equal(resolveWorkspace("~/my-project", { HOME: base }, factory), project);

  assert.throws(() => resolveWorkspace(path.join(base, "missing"), {}, factory), /missing isn't a folder/);
  assert.throws(() => resolveWorkspace(path.join(base, "a-file.txt"), {}, factory), /isn't a folder/);
  assert.throws(() => resolveWorkspace(factory, {}, factory), /is the factory itself/);
  assert.throws(() => resolveWorkspace(base, {}, factory), /is the factory itself \(or holds it\)/);
});

test("openCommand: the default browser on Windows, macOS and Linux", () => {
  const url = "http://localhost:8000/autopilot";
  assert.deepEqual(openCommand("win32", url), { command: "cmd", args: ["/c", "start", "", url] });
  assert.deepEqual(openCommand("darwin", url), { command: "open", args: [url] });
  assert.deepEqual(openCommand("linux", url), { command: "xdg-open", args: [url] });
});
