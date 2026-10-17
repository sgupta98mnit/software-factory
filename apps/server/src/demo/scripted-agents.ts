// Scripted stand-ins for Autopilot's agents, for `pnpm demo` and for working
// on the Canvas pages without a model login. They do real work in the
// conversation's folder, so the factory's own checks (openspec validate, the
// gates, git) run for real on what they write:
//
// - spec: an OpenSpec change for the goal with three task groups (two
//   independent, one that uses both), scenarios and a Controls table
// - critic and reviewer: a pass verdict
// - validator (when the policy turns hidden tests on): a black-box test per scenario
// - builder: a small module and a node:test test per work order. The second
//   work order's first try has a bug its test catches, so the repair loop
//   shows; the third touches `src/auth/`, a sensitive path, so its merge waits
//   for a person under the default policy.
//
// No network, no model: the same goal always gives the same files.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FakeConversation, FakeHandler, FakeReply } from "./fake-agent-server.js";

export interface ScriptedOptions {
  /** How long each agent turn takes, so a person can watch the pipeline move. */
  turnMs?: number;
  /** Turn off the deliberate bug in WO-2's first try. */
  noBugs?: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const write = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

/** The goal and change name from the spec agent's brief. */
function briefOf(conv: FakeConversation) {
  const first = conv.messages[0] ?? "";
  const change = /The change is called `([^`]+)`/.exec(first)?.[1] ?? "demo-change";
  const goal = /<goal>\n([\s\S]*?)\n<\/goal>/.exec(first)?.[1]?.trim() ?? change.replaceAll("-", " ");
  return { change, goal };
}

/**
 * A capability name from the change name: its first three words, plus the
 * number the factory adds to a repeated goal ("...-2"), so a second run of
 * the same goal in the same workspace writes new files instead of the ones
 * the first run already merged.
 */
export function capabilityOf(change: string) {
  const words = change.split("-").filter(Boolean);
  const cap = words.slice(0, 3);
  const last = words.at(-1) ?? "";
  if (words.length > 3 && /^\d+$/.test(last)) cap.push(last);
  return cap.join("-") || "feature";
}
const sentence = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return /[.!?]$/.test(line) ? line : `${line}.`;
};

/** The change the scripted spec agent writes. Valid under `openspec validate --strict`. */
export function scriptedChange(goal: string, change: string): Record<string, string> {
  const cap = capabilityOf(change);
  const purpose = sentence(goal);
  return {
    "proposal.md": `## Why

${purpose} People need this to work reliably, with every request checked and recorded, so it is built as three small pieces that can each be tested on their own.

## What Changes

- Add a \`${cap}\` module with the core behavior the goal asks for.
- Validate every input and reject malformed ones with a clear message.
- Write one audit record per request, without personal data.

## Capabilities

### New Capabilities

- \`${cap}\`: ${purpose}

### Modified Capabilities

None.

## Impact

- New code under \`src/${cap}/\`, plain JavaScript on Node, tested with \`node --test\`.
- NIST 800-53 controls touched: SI-10 (input validation), AU-2 (event logging), AC-3 (access enforcement).

## Assumptions

- Plain JavaScript modules tested with node:test are enough for this change.
- An in-memory store stands in for a database until a later change adds one.

## Open questions

- None.
`,
    [`specs/${cap}/spec.md`]: `## ADDED Requirements

### Requirement: Core behavior

The system SHALL provide the behavior the goal describes through a \`handle(input)\` function that returns a result object.

#### Scenario: Valid request

- **WHEN** a caller passes a valid input
- **THEN** the system returns \`{ ok: true }\` with the result

### Requirement: Input validation

The system SHALL reject inputs that are missing or longer than 200 characters, with a message that says what is expected.

#### Scenario: Missing input

- **WHEN** a caller passes an empty input
- **THEN** the system returns \`{ ok: false }\` with a message naming the expected input

### Requirement: Audit every request

The system SHALL write one audit record per request with the time and the outcome, and SHALL NOT write the raw input to it.

#### Scenario: Request is audited

- **WHEN** any request completes, whether it succeeds or is rejected
- **THEN** exactly one audit record is written and it does not contain the raw input
`,
    "design.md": `## Context

Scripted demo change for: ${purpose}

## Decisions

- **Stack:** plain JavaScript modules on Node with \`node --test\`; no framework.
- **Layout:** \`src/${cap}/\` for the behavior, \`src/auth/\` for the access check.

## Controls

| Control | How this design meets it |
| --- | --- |
| SI-10 Information input validation | Inputs are checked before use; malformed ones are rejected |
| AU-2 Event logging | Every request writes one audit record |
| AC-3 Access enforcement | Requests go through the access check in \`src/auth/\` |
`,
    "tasks.md": `## 1. Core behavior

Depends on: none

- [ ] 1.1 Add \`handle(input)\` in \`src/${cap}/core.js\` returning \`{ ok: true, result }\`
- [ ] 1.2 Test it with node:test

## 2. Input validation

Depends on: none

- [ ] 2.1 Add \`validate(input)\` in \`src/${cap}/validate.js\` rejecting empty and over-long inputs
- [ ] 2.2 Test both rejections and a valid input

## 3. Audit and access

Depends on: 1, 2

- [ ] 3.1 Add an audit record per request in \`src/${cap}/audit.js\` without the raw input
- [ ] 3.2 Add the access check in \`src/auth/${cap}.js\`
`,
  };
}

const PACKAGE = `${JSON.stringify({ name: "demo-workspace", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`;

/** What each builder writes: file -> content, for work order `seq` of change `cap`. */
function builtFiles(cap: string, seq: number, buggy: boolean): Record<string, string> {
  const t = (name: string, imports: string, body: string) =>
    `import { test } from "node:test";\nimport assert from "node:assert/strict";\n${imports}\n\ntest(${JSON.stringify(name)}, () => {\n${body}\n});\n`;
  switch (seq) {
    case 1:
      return {
        [`src/${cap}/core.js`]: "export function handle(input) {\n  return { ok: true, result: String(input).trim() };\n}\n",
        [`src/${cap}/core.test.js`]: t("handle returns the result", 'import { handle } from "./core.js";', '  assert.deepEqual(handle(" a "), { ok: true, result: "a" });'),
      };
    case 2:
      return {
        [`src/${cap}/validate.js`]: buggy
          ? 'export function validate(input) {\n  // Off by one: an empty input slips through.\n  if (String(input ?? "").length > 200) return { ok: false, message: "Input must be at most 200 characters." };\n  return { ok: true };\n}\n'
          : 'export function validate(input) {\n  const text = String(input ?? "").trim();\n  if (!text) return { ok: false, message: "Enter an input (1 to 200 characters)." };\n  if (text.length > 200) return { ok: false, message: "Input must be at most 200 characters." };\n  return { ok: true };\n}\n',
        [`src/${cap}/validate.test.js`]: t(
          "validate rejects empty and over-long inputs",
          'import { validate } from "./validate.js";',
          '  assert.equal(validate("").ok, false);\n  assert.equal(validate("x".repeat(201)).ok, false);\n  assert.equal(validate("ok").ok, true);',
        ),
      };
    default:
      return {
        [`src/${cap}/audit.js`]:
          'import { createHash } from "node:crypto";\nexport const records = [];\nexport function audit(input, ok) {\n  records.push({ at: new Date().toISOString(), ok, input: createHash("sha256").update(String(input)).digest("hex") });\n}\n',
        [`src/${cap}/audit.test.js`]: t(
          "audit never stores the raw input",
          'import { audit, records } from "./audit.js";',
          '  audit("secret-claim", true);\n  assert.equal(records.length, 1);\n  assert.ok(!JSON.stringify(records).includes("secret-claim"));',
        ),
        [`src/auth/${cap}.js`]: "export const allowed = (caller) => typeof caller === \"string\" && caller.length > 0;\n",
        [`src/auth/${cap}.test.js`]: t("access check", `import { allowed } from "./${cap}.js";`, '  assert.equal(allowed(""), false);\n  assert.equal(allowed("clerk"), true);'),
      };
  }
}

/** The scripted validator's hidden tests: one per scenario of scriptedChange, against what the builders write. */
function hiddenTestFiles(cap: string): Record<string, string> {
  const head = (scenario: string, requirement: string, wo: number) =>
    `// scenario: ${scenario}\n// requirement: ${requirement}\n// requires: WO-${wo}\nimport { test } from "node:test";\nimport assert from "node:assert/strict";\n`;
  return {
    "valid-request.test.mjs": `${head("Valid request", "Core behavior", 1)}import { handle } from "../src/${cap}/core.js";\ntest("a valid input gives ok", () => assert.equal(handle("claim AB-123456").ok, true));\n`,
    "missing-input.test.mjs": `${head("Missing input", "Input validation", 2)}import { validate } from "../src/${cap}/validate.js";\ntest("an empty input is rejected with a message", () => {\n  const r = validate("");\n  assert.equal(r.ok, false);\n  assert.ok(r.message && r.message.length > 0);\n});\n`,
    "request-is-audited.test.mjs": `${head("Request is audited", "Audit every request", 3)}import { audit, records } from "../src/${cap}/audit.js";\ntest("one record, without the raw input", () => {\n  audit("raw-input-7731", true);\n  assert.equal(records.length, 1);\n  assert.ok(!JSON.stringify(records).includes("raw-input-7731"));\n});\n`,
  };
}

const PASS = (what: string) => `${what}\n\n\`\`\`json\n{ "verdict": "pass", "findings": [] }\n\`\`\``;

/** One handler for every role, picked by the conversation's `sfrole` tag. */
export function scriptedAgents(opts: ScriptedOptions = {}): FakeHandler {
  const turnMs = opts.turnMs ?? 0;
  return async (conv): Promise<FakeReply> => {
    if (turnMs) await sleep(turnMs);
    const role = conv.tags.sfrole ?? "";
    if (role === "spec") {
      const { goal, change } = briefOf(conv);
      const dir = path.join(conv.workingDir, "openspec", "changes", change);
      for (const [file, text] of Object.entries(scriptedChange(goal, change))) write(path.join(dir, file), text);
      write(path.join(dir, ".openspec.yaml"), `schema: spec-driven\ncreated: ${new Date().toISOString().slice(0, 10)}\n`);
      return { response: `Wrote the OpenSpec change \`${change}\`: three task groups, five scenarios, three controls.`, cost: 0.42 };
    }
    if (role === "critic") return { response: PASS("The scenarios are testable and each control has a task."), cost: 0.08 };
    if (role === "validator") {
      const change = /OpenSpec change `([^`]+)`/.exec(conv.messages[0] ?? "")?.[1] ?? "demo-change";
      const files = hiddenTestFiles(capabilityOf(change));
      for (const [file, text] of Object.entries(files)) write(path.join(conv.workingDir, "tests", file), text);
      return { response: `Wrote ${Object.keys(files).length} hidden acceptance tests: ${Object.keys(files).join(", ")}.`, cost: 0.21 };
    }
    if (role === "reviewer") return { response: PASS("Every acceptance criterion has a test, and the error cases are covered."), cost: 0.11 };
    if (role === "builder") {
      const seq = Number(conv.tags.sfwo ?? "1");
      const change = /openspec\/changes\/([^/`]+)\//.exec(conv.messages[0] ?? "")?.[1] ?? "demo-change";
      const buggy = !opts.noBugs && seq === 2 && conv.messages.length === 1;
      write(path.join(conv.workingDir, "package.json"), PACKAGE);
      for (const [file, text] of Object.entries(builtFiles(capabilityOf(change), seq, buggy))) write(path.join(conv.workingDir, file), text);
      return {
        response: conv.messages.length > 1 ? `Fixed what the factory found and re-ran the tests.` : `Built WO-${seq} with its tests.`,
        cost: 0.35,
      };
    }
    return { response: "Done.", cost: 0.01 };
  };
}
