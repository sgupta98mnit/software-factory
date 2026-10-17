import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// Point the audit log at a temp folder before the module reads its config.
const dir = mkdtempSync(path.join(tmpdir(), "sf-audit-"));
process.env.SF_DATA_DIR = dir;
const { audit, verifyAudit } = await import("../src/audit.js");

test("the chain verifies, and editing any line breaks it", async () => {
  await audit("user:test", "work_order.status_changed", "WO-1", { from: "To Do", to: "In Progress" });
  await audit("user:test", "work_order.approved", "WO-1", { from: "In Progress", to: "Done" });
  await audit("filesystem", "work_order.file_changed", "WO-1", { status: "Done" });
  assert.deepEqual(verifyAudit(), { ok: true, checked: 3 });

  const file = path.join(dir, "audit.jsonl");
  const lines = readFileSync(file, "utf8").trim().split("\n");
  // Someone rewrites who approved it.
  lines[1] = lines[1]!.replace("user:test", "user:someone-else");
  writeFileSync(file, `${lines.join("\n")}\n`);
  const result = verifyAudit();
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, 2);
});
