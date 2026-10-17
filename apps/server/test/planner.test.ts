import assert from "node:assert/strict";
import { test } from "node:test";
import { controlTable, controlsFor, parseTaskGroups } from "../src/planner.js";

const TASKS = `# Tasks

## 1. Service skeleton
- [ ] 1.1 Create the service with a test runner

## 2. Status lookup
- [ ] 2.1 Add GET /claims/:id/status
- [x] 2.2 Validate claim IDs and return 400 for malformed ones

## 3. Notes
Nothing to do here.
`;

const DESIGN = `## Controls
| Control | How it's met |
| --- | --- |
| SI-10 | Claim IDs are validated against a pattern |
| AU-2 | Every lookup writes an audit record |
| AU-3 | Records hold time, outcome and a hashed ID |
`;

test("one group per numbered heading, checklist items in order, empty groups dropped", () => {
  const groups = parseTaskGroups(TASKS);
  assert.deepEqual(groups, [
    { title: "Service skeleton", items: ["Create the service with a test runner"] },
    { title: "Status lookup", items: ["Add GET /claims/:id/status", "Validate claim IDs and return 400 for malformed ones"] },
  ]);
});

test("reads the Controls table from design.md", () => {
  assert.deepEqual(
    controlTable(DESIGN).map((c) => c.id),
    ["SI-10", "AU-2", "AU-3"],
  );
});

test("matches controls by family from the group's wording", () => {
  const table = controlTable(DESIGN);
  assert.deepEqual(controlsFor("Validate claim IDs and return 400", table), ["SI-10"]);
  assert.deepEqual(controlsFor("Write one audit record per lookup", table), ["AU-2", "AU-3"]);
  assert.deepEqual(controlsFor("Create the service skeleton", table), []);
});
