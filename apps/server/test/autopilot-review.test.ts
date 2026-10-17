import assert from "node:assert/strict";
import { test } from "node:test";
import type { Finding } from "../src/autopilot/ledger.js";
import { builderBrief, repairMessage, reviewerBrief } from "../src/autopilot/prompts.js";
import { clusterFindings, parseVerdict, passed } from "../src/autopilot/review.js";

test("parseVerdict: the last json block, a bare object, odd values, a fail without findings, and no verdict at all", () => {
  const reply = [
    "The format is:",
    "```json",
    '{"verdict":"pass","findings":[]}',
    "```",
    "My verdict:",
    "```json",
    JSON.stringify({
      verdict: "FAIL",
      findings: [
        { severity: "Critical", criterion: 2, scenario: "Unknown claim", file: "src/routes.ts", issue: "Expected 404, got 500", fix: "Return 404 when the claim isn't found" },
        { severity: "blocker", criterion: "#1", scenario: "", issue: "No test for malformed IDs" },
        { severity: "low", criterion: "first" },
      ],
    }),
    "```",
  ].join("\n");
  assert.deepEqual(parseVerdict(reply), {
    verdict: "fail",
    findings: [
      { source: "review", severity: "critical", title: "Expected 404, got 500", detail: "Return 404 when the claim isn't found", file: "src/routes.ts", criterion: 2, scenario: "Unknown claim" },
      { source: "review", severity: "medium", title: "No test for malformed IDs", detail: "", file: null, criterion: 1, scenario: null },
    ],
  });

  const bare = parseVerdict('Looks right. {"verdict": "pass", "findings": [{"severity": "low", "issue": "Name {x} could be clearer"}]} Done.');
  assert.equal(bare.verdict, "pass");
  assert.equal(bare.findings[0]?.title, "Name {x} could be clearer");
  assert.equal(parseVerdict('{"verdict":"approved"}').verdict, "pass");

  const empty = parseVerdict('```json\n{"verdict":"fail","findings":[]}\n```');
  assert.equal(empty.findings.length, 1); // a builder never gets an empty repair message
  assert.equal(empty.findings[0]?.severity, "high");

  const unreadable = parseVerdict("I reviewed it and it's fine.");
  assert.deepEqual([unreadable.verdict, unreadable.unreadable], ["fail", true]);
});

test("passed: a pass verdict with no blocking finding; critical and high block by default, and the list can change", () => {
  const verdict = (v: "pass" | "fail", ...severities: Finding["severity"][]) => ({
    verdict: v,
    findings: severities.map((severity): Finding => ({ source: "review", severity, title: severity, detail: "" })),
  });
  assert.equal(passed(verdict("pass")), true);
  assert.equal(passed(verdict("pass", "medium", "low")), true);
  assert.equal(passed(verdict("pass", "high")), false);
  assert.equal(passed(verdict("pass", "critical", "low")), false);
  assert.equal(passed(verdict("fail", "low")), false);
  assert.equal(passed(verdict("pass", "medium"), ["critical", "high", "medium"]), false);
  assert.equal(passed(verdict("pass", "high"), ["critical"]), true);
});

test("clusterFindings: most severe first, grouped by scenario then criterion; gate output as a block; hidden tests by name only", () => {
  const SOURCE = "assert.equal(res.status, 404); // hidden test source";
  const findings: Finding[] = [
    { source: "review", severity: "low", title: "Log the claim id", detail: "", criterion: 3 },
    { source: "gate", severity: "high", title: "Gate test: `npm run test` failed with exit code 1", detail: "not ok 1 - adds\n  expected 3, got 4" },
    { source: "hidden", severity: "high", title: 'Scenario "Unknown claim": expected 404, got 500', detail: SOURCE, scenario: "Unknown claim" },
    { source: "review", severity: "critical", title: "expected 404, got 500", detail: "Return 404", file: "src/routes.ts", scenario: "Unknown claim" },
    { source: "review", severity: "medium", title: "No test for 400", detail: "Add one", criterion: 1, file: null },
  ];
  const text = clusterFindings(findings);
  assert.equal(
    text,
    [
      '- Scenario "Unknown claim":',
      "  - (critical) expected 404, got 500 (src/routes.ts). Fix: Return 404",
      '  - (high) Scenario "Unknown claim": expected 404, got 500',
      "- (high) Gate test: `npm run test` failed with exit code 1",
      "",
      "  ```text",
      "  not ok 1 - adds",
      "    expected 3, got 4",
      "  ```",
      "- Criterion 1: (medium) No test for 400. Fix: Add one",
      "- Criterion 3: (low) Log the claim id",
    ].join("\n"),
  );
  assert.ok(!text.includes(SOURCE));
  assert.ok(!repairMessage(findings).includes(SOURCE));
  assert.ok(!builderBrief({ change: "x", wo: { seq: 1, title: "t", acceptance: [], controls: [], branch: null, findings } }).includes(SOURCE));
});

test("reviewerBrief and repairMessage: the diff to read, the criteria, the verdict format; the findings and what to do", () => {
  const wo = { seq: 2, title: "Status lookup", acceptance: ["Return 404 for unknown claims", "Return 400 for malformed IDs"], controls: ["SI-10"], branch: "autopilot/x--wo-2", baseSha: "abc123" };
  const brief = reviewerBrief({ change: "add-x", wo });
  for (const part of [
    "WO-2: Status lookup",
    "`git diff abc123...HEAD`",
    "`autopilot/x--wo-2`",
    "openspec/changes/add-x/",
    "1. Return 404 for unknown claims",
    "2. Return 400 for malformed IDs",
    "SI-10",
    "Don't edit or commit anything",
    "```json",
    '"verdict": "pass" | "fail"',
    '"criterion"',
    '"scenario"',
  ]) {
    assert.ok(brief.includes(part), part);
  }
  const message = repairMessage([{ source: "review", severity: "high", title: "expected 404, got 500", detail: "", scenario: "Unknown claim" }]);
  assert.match(message, /- Scenario "Unknown claim": \(high\) expected 404, got 500/);
  assert.match(message, /commit on the current branch/);
});
