import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { detectGates, gateFindings, NO_GATES, runGates } from "../src/autopilot/gates.js";
import { OUTPUT_LIMIT } from "../src/autopilot/ledger.js";

const tmp = () => mkdtempSync(path.join(tmpdir(), "sf-gates-"));

function write(dir: string, file: string, content: string | object) {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), typeof content === "string" ? content : JSON.stringify(content));
}

test("detectGates: npm scripts at the root and one folder down, prefixed by folder, with install only where it's needed", () => {
  const dir = tmp();
  // Root: dependencies, a lockfile and no node_modules -> npm ci, then its scripts in a fixed order.
  write(dir, "package.json", { dependencies: { hono: "4.0.0" }, scripts: { test: "node --test", lint: "eslint .", start: "node ." } });
  write(dir, "package-lock.json", "{}");
  // A service: devDependencies, no lockfile -> npm install.
  write(dir, "claim-status-service/package.json", { devDependencies: { tsx: "4.0.0" }, scripts: { typecheck: "tsc", test: "node --test" } });
  // Already installed -> no install gate. No dependencies -> none either.
  write(dir, "web/package.json", { dependencies: { react: "19.0.0" }, scripts: { test: "vitest" } });
  mkdirSync(path.join(dir, "web", "node_modules"));
  write(dir, "tools/package.json", { scripts: { lint: "node lint.js" } });
  // Not looked at: packages without any of the scripts, dot folders, two levels down, broken JSON.
  write(dir, "docs/package.json", { dependencies: { x: "1" }, scripts: { build: "x" } });
  write(dir, ".cache/package.json", { scripts: { test: "x" } });
  write(dir, "packages/deep/package.json", { scripts: { test: "x" } });
  write(dir, "broken/package.json", "{ not json");

  assert.deepEqual(detectGates(dir), [
    { name: "install", run: "npm ci --no-audit --no-fund", cwd: undefined },
    { name: "lint", run: "npm run lint", cwd: undefined },
    { name: "test", run: "npm run test", cwd: undefined },
    { name: "claim-status-service:install", run: "npm install --no-audit --no-fund", cwd: "claim-status-service" },
    { name: "claim-status-service:typecheck", run: "npm run typecheck", cwd: "claim-status-service" },
    { name: "claim-status-service:test", run: "npm run test", cwd: "claim-status-service" },
    { name: "tools:lint", run: "npm run lint", cwd: "tools" },
    { name: "web:test", run: "npm run test", cwd: "web" },
  ]);
  // Nor installed packages.
  const installed = tmp();
  write(installed, "node_modules/dep/package.json", { scripts: { test: "x" } });
  assert.deepEqual(detectGates(installed), []);
});

test("runGates: pass and fail with exit code and output, a failing install stops the rest, and no gates is a failure", async () => {
  const dir = tmp();
  write(dir, "sub/ok.js", "console.log('all good in', process.cwd());");
  write(dir, "fail.js", "console.error('expected 404, got 500'); process.exit(3);");

  const run = await runGates(dir, [
    { name: "sub:ok", run: "node ok.js", cwd: "sub" },
    { name: "test", run: "node fail.js" },
    { name: "lint", run: "node sub/ok.js" },
  ]);
  assert.equal(run.ok, false);
  assert.deepEqual(run.results.map((r) => [r.name, r.ok, r.exitCode, r.timedOut]), [
    ["sub:ok", true, 0, false],
    ["test", false, 3, false],
    ["lint", true, 0, false], // a failing test doesn't stop the gates after it
  ]);
  assert.match(run.results[0]!.output, /all good in .*sub/);
  assert.match(run.results[1]!.output, /expected 404, got 500/);
  assert.ok(run.results.every((r) => r.durationMs >= 0));

  const [finding] = gateFindings(run.results);
  assert.deepEqual(finding, { source: "gate", severity: "high", title: "Gate test: `node fail.js` failed with exit code 3", detail: run.results[1]!.output });

  const install = await runGates(dir, [{ name: "web:install", run: "node fail.js" }, { name: "web:test", run: "node sub/ok.js" }]);
  assert.deepEqual(install.results.map((r) => r.name), ["web:install"]);

  assert.deepEqual((await runGates(dir, [{ name: "test", run: "node sub/ok.js" }])).ok, true);
  const none = await runGates(dir, []);
  assert.deepEqual([none.ok, none.results[0]?.name, none.results[0]?.output], [false, "gates", NO_GATES]);
  assert.deepEqual(gateFindings(none.results), [{ source: "gate", severity: "high", title: NO_GATES, detail: "" }]);
});

test("runGates: a gate past its timeout is killed with everything it started, and only the output's tail is kept", async () => {
  const dir = tmp();
  // The shell starts node, which starts another node: killing only the shell would leave the output pipe open.
  write(dir, "hang.js", "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' }); console.log('started');");
  write(dir, "loud.js", "process.stdout.write('x'.repeat(20000) + 'THE END');");

  const started = Date.now();
  const hung = await runGates(dir, [{ name: "test", run: "node hang.js", timeoutSec: 1 }]);
  assert.ok(Date.now() - started < 15_000, "the gate was killed, not waited for");
  const [result] = hung.results;
  assert.deepEqual([hung.ok, result?.exitCode, result?.timedOut], [false, null, true]);
  assert.match(result?.output ?? "", /started[\s\S]*Stopped: still running after 1 s/);
  assert.match(gateFindings(hung.results)[0]?.title ?? "", /timed out$/);

  // A test that leaves a detached process holding the output pipe: the gate ends when its own process does.
  write(dir, "leak.js", "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'inherit', detached: true }).unref(); console.log('leaked');");
  const leakStarted = Date.now();
  const leaked = (await runGates(dir, [{ name: "test", run: "node leak.js", timeoutSec: 60 }])).results[0]!;
  assert.ok(Date.now() - leakStarted < 15_000, "the gate didn't wait for the process it left behind");
  assert.deepEqual([leaked.ok, leaked.exitCode, leaked.timedOut], [true, 0, false]);
  assert.match(leaked.output, /leaked/);

  const loud = (await runGates(dir, [{ name: "test", run: "node loud.js" }])).results[0]!;
  assert.equal(loud.output.length, OUTPUT_LIMIT);
  assert.ok(loud.output.endsWith("THE END"));
});

test("runGates rerunFailed: a failure runs once more; a pass then is flaky, two failures say so; installs and timeouts aren't run again", async () => {
  const dir = tmp();
  const counter = path.join(dir, "count");
  // Fails on odd runs, passes on even ones.
  const flip = `node -e "const fs=require('fs');const n=fs.existsSync('count')?+fs.readFileSync('count','utf8')+1:1;fs.writeFileSync('count',String(n));process.exit(n%2)"`;
  const out = await runGates(dir, [{ name: "test", run: flip }, { name: "lint", run: "node -e \"console.log('bad'); process.exit(2)\"" }], { rerunFailed: true });
  assert.deepEqual(out.results.map((r) => [r.name, r.ok, r.flaky ?? false]), [["test", true, true], ["lint", false, false]]);
  assert.match(out.results[0]!.output, /\[Flaky: it failed the first time \(exit code 1\) and passed when run again\./);
  assert.match(out.results[1]!.output, /^bad\n\n\[Run again once in case it was flaky: it failed both times\.\]$/);
  assert.equal(out.ok, false);
  writeFileSync(counter, "0");
  const install = await runGates(dir, [{ name: "install", run: flip }, { name: "test", run: "node -e 0" }], { rerunFailed: true });
  assert.deepEqual(install.results.map((r) => [r.name, r.ok]), [["install", false]]);
  const slow = await runGates(dir, [{ name: "test", run: "node -e \"setTimeout(()=>{}, 5000)\"", timeoutSec: 0.5 }], { rerunFailed: true });
  assert.equal(slow.results[0]?.timedOut, true);
  assert.ok(slow.results[0]!.durationMs < 4000, "a timeout isn't run again");
});
