import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { computeWaves, parseTasks, planWorkOrders, riskOf } from "../src/autopilot/waves.js";

const TASKS = `# Tasks

Intro text that isn't a group. Depends on: 9

## 1. Service skeleton
- [ ] 1.1 Create the service with a test runner

## 2. Status lookup
- [ ] 2.1 Add GET /claims/:id/status
- [x] 2.2 Validate claim IDs and return 400 for malformed ones

## 3. Notes
Nothing to build here.

## 5. Audit
Depends on: none
- [ ] 5.1 Write one audit record per lookup

## 6. Sign-in
**Depends on:** 2, 5
- [ ] Add staff sign-in
`;

test("parseTasks: groups keep their numbers, items, explicit and default dependencies", () => {
  assert.deepEqual(parseTasks(TASKS), [
    { seq: 1, title: "Service skeleton", items: ["Create the service with a test runner"], dependsOn: [] },
    {
      seq: 2,
      title: "Status lookup",
      items: ["Add GET /claims/:id/status", "Validate claim IDs and return 400 for malformed ones"],
      dependsOn: [1], // no "Depends on:" line: the group before
    },
    // Group 3 has no checklist items, so it isn't a work order.
    { seq: 5, title: "Audit", items: ["Write one audit record per lookup"], dependsOn: [] },
    { seq: 6, title: "Sign-in", items: ["Add staff sign-in"], dependsOn: [2, 5] },
  ]);
  // After a group without items, the default is the last group that has some.
  assert.deepEqual(
    parseTasks("## 1. A\n- [ ] 1.1 a\n## 2. Notes\n## 3. C\n- [ ] 3.1 c\n").map((g) => g.dependsOn),
    [[], [1]],
  );
  assert.deepEqual(parseTasks("## 1. A\n- [ ] a\nDepends on: 1.2 and 1.3\n")[0]?.dependsOn, [1]);
  assert.throws(() => parseTasks("## 1. A\n- [ ] a\n## 1. B\n- [ ] b\n"), /two task groups numbered 1/);
  assert.throws(() => parseTasks("## 1. A\n- [ ] a\n## 2. B\nDepends on: the first one\n- [ ] b\n"), /Task group 2 says "Depends on: the first one"/);
});

test("computeWaves: topological levels; cycles and unknown groups are refused with the reason", () => {
  const waves = computeWaves([
    { seq: 1, dependsOn: [] },
    { seq: 2, dependsOn: [] },
    { seq: 3, dependsOn: [] },
    { seq: 4, dependsOn: [1, 2, 3] },
    { seq: 5, dependsOn: [4, 1] },
    { seq: 6, dependsOn: [2] },
  ]);
  assert.deepEqual([...waves].sort(([a], [b]) => a - b), [[1, 1], [2, 1], [3, 1], [4, 2], [5, 3], [6, 2]]);

  assert.throws(
    () => computeWaves([{ seq: 1, dependsOn: [] }, { seq: 2, dependsOn: [3] }, { seq: 3, dependsOn: [4] }, { seq: 4, dependsOn: [2] }]),
    /cycle \(2 → 3 → 4 → 2\)/,
  );
  assert.throws(() => computeWaves([{ seq: 1, dependsOn: [1] }]), /cycle \(1 → 1\)/);
  assert.throws(() => computeWaves([{ seq: 1, dependsOn: [] }, { seq: 2, dependsOn: [1, 7] }]), /Task group 2 depends on 7, but tasks.md has no task group 7/);
});

test("riskOf: sensitive wording, controls and size raise the score", () => {
  assert.deepEqual(riskOf({ title: "Service skeleton", acceptance: ["Create the service with GET /health"], controls: [] }), { score: 0, level: "low" });
  assert.deepEqual(riskOf({ title: "Status lookup", acceptance: ["Return 400 for malformed IDs"], controls: ["SI-10"] }), { score: 1, level: "low" });
  assert.deepEqual(riskOf({ title: "Audit", acceptance: ["a", "b", "c", "d"], controls: ["AU-2", "AU-3"] }), { score: 2, level: "medium" });
  assert.deepEqual(riskOf({ title: "Store claims", acceptance: ["Add a database migration"], controls: [] }), { score: 2, level: "medium" });
  assert.deepEqual(riskOf({ title: "Staff sign-in", acceptance: ["Require MFA"], controls: ["IA-2"] }), { score: 5, level: "high" });
});

test("planWorkOrders: reads tasks.md and design.md in the worktree; says what to fix when it can't", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-waves-"));
  const change = path.join(dir, "openspec", "changes", "add-x");
  mkdirSync(change, { recursive: true });
  assert.throws(() => planWorkOrders(dir, "add-x"), /openspec\/changes\/add-x\/tasks.md is missing/);
  writeFileSync(path.join(change, "tasks.md"), "# Tasks\n\nTo do.\n");
  assert.throws(() => planWorkOrders(dir, "add-x"), /has no "## 1. Title" task groups/);

  writeFileSync(path.join(change, "tasks.md"), TASKS);
  writeFileSync(
    path.join(change, "design.md"),
    "## Controls\n\n| Control | How |\n| --- | --- |\n| SI-10 Input validation | pattern |\n| AU-2 Event logging | every lookup |\n| IA-2 Identification | staff sign-in |\n",
  );
  assert.deepEqual(
    planWorkOrders(dir, "add-x").map((w) => [w.seq, w.wave, w.dependsOn, w.controls, w.risk, w.riskScore]),
    [
      [1, 1, [], [], "low", 0],
      [2, 2, [1], ["SI-10"], "low", 1],
      [5, 1, [], ["AU-2"], "low", 1],
      [6, 3, [2, 5], ["IA-2"], "high", 5],
    ],
  );
  writeFileSync(path.join(change, "tasks.md"), "## 1. A\nDepends on: 2\n- [ ] a\n## 2. B\n- [ ] b\n");
  assert.throws(() => planWorkOrders(dir, "add-x"), /cycle \(1 → 2 → 1\)/);
});
