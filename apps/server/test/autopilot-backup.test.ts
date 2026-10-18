import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Hono } from "hono";

const dataDir = mkdtempSync(path.join(tmpdir(), "sf-backup-"));
process.env.SF_DATA_DIR = dataDir;
process.env.SF_WORKSPACE = mkdtempSync(path.join(tmpdir(), "sf-backup-unused-"));
delete process.env.SF_EVIDENCE_DIR;
delete process.env.SF_BACKUP_DIR;
const { openLedger } = await import("../src/autopilot/ledger.js");
const { audit, listAudit, sha256, verifyAuditText } = await import("../src/audit.js");
const { evidenceRoot, storeEvidence, verifyEvidence } = await import("../src/autopilot/evidence-store.js");
const { createAdminRoutes, restoreBackup, verifyBackup } = await import("../src/backup.js");
const { createAuth, authConfigFromEnv } = await import("../src/auth.js");

const ledger = openLedger(path.join(dataDir, "autopilot.db"));
const run = ledger.createRun({ goal: "g", change: "c", autonomy: "suggest", baseBranch: "main", integrationBranch: "autopilot/c", createdBy: "user:test" });
ledger.createSession({ idHash: sha256("a-session-cookie"), subject: "s", issuer: "https://idp.example.gov", name: "N", roles: ["admin"], expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
const stored = storeEvidence(evidenceRoot(dataDir), run.id, "packet", { run: run.id, digest: "x" });
await audit("user:test", "test.event", run.id, { n: 1 });

/** POST /admin/backup as this machine's user with these roles. */
function backupAs(roles: string) {
  const app = new Hono();
  app.use("*", createAuth(authConfigFromEnv({ SF_LOCAL_ROLES: roles }, "user:local"), ledger).middleware);
  app.route("/admin", createAdminRoutes({ ledger, dataDir }));
  return app.request("/admin/backup", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
}

const fresh = (name: string) => path.join(mkdtempSync(path.join(tmpdir(), "sf-backup-target-")), name);
let backup: { dir: string; digest: string };

test("an admin's backup holds the ledger (without sessions), the audit log and the evidence, and restores only into an empty folder", async () => {
  assert.equal((await backupAs("engineer,approver,isso,release_manager")).status, 403, "admins only");
  const res = await backupAs("admin");
  assert.equal(res.status, 200);
  const answer = (await res.json()) as { folder: string; manifestSha256: string; files: number };
  backup = { dir: path.join(dataDir, "backups", answer.folder), digest: answer.manifestSha256 };
  assert.deepEqual(readdirSync(backup.dir).sort(), ["audit.jsonl", "autopilot.db", "evidence", "manifest.json"]);
  assert.equal(answer.files, 3);
  const copy = new DatabaseSync(path.join(backup.dir, "autopilot.db"), { readOnly: true });
  assert.deepEqual([copy.prepare("SELECT COUNT(*) AS n FROM sessions").get()?.n, copy.prepare("SELECT COUNT(*) AS n FROM runs").get()?.n], [0, 1], "no one's session goes into a backup");
  copy.close();
  assert.ok(!readFileSync(path.join(backup.dir, "autopilot.db")).includes(sha256("a-session-cookie")), "not even in free pages");
  await audit("test", "test.flush", "test");
  assert.equal(listAudit().find((e) => e.action === "factory.backup_created")?.data.manifestSha256, backup.digest, "the audit log records the manifest's digest");

  assert.deepEqual(verifyBackup(backup.dir, backup.digest), { ok: true, problems: [], manifest: verifyBackup(backup.dir).manifest });
  const busy = fresh("busy");
  cpSync(backup.dir, busy, { recursive: true });
  assert.throws(() => restoreBackup(backup.dir, busy), /isn't empty/);
  const target = fresh("data");
  assert.equal(restoreBackup(backup.dir, target, backup.digest).files, 3);
  const restored = openLedger(path.join(target, "autopilot.db"));
  assert.equal(restored.getRun(run.id)?.change, "c");
  restored.close();
  assert.equal(verifyAuditText(readFileSync(path.join(target, "audit.jsonl"), "utf8")).ok, true);
  assert.deepEqual(verifyEvidence(path.join(target, "evidence")), { ok: true, checked: 1, changed: [] });
  if (process.getuid?.() !== 0) assert.throws(() => writeFileSync(path.join(target, "evidence", stored.file), "{}"), "restored evidence is read-only");
});

test("a changed, missing or extra file, a broken audit chain, a path out of the backup or another manifest fails verification, and restore refuses it", () => {
  const bad = fresh("bad");
  cpSync(backup.dir, bad, { recursive: true });
  const log = readFileSync(path.join(bad, "audit.jsonl"), "utf8").replace('"n":1', '"n":2');
  writeFileSync(path.join(bad, "audit.jsonl"), log);
  writeFileSync(path.join(bad, "extra.txt"), "x");
  const evidence = path.join(bad, "evidence", stored.file);
  chmodSync(evidence, 0o644);
  writeFileSync(evidence, "{}");
  const { problems } = verifyBackup(bad, "0".repeat(64));
  assert.deepEqual(problems.map((p) => p.replace(/[0-9a-f]{64}/g, "<sha>").replace(/ap-[0-9a-f]{8}/, "<run>").replace(/at event \d+/, "at event N")), [
    "The manifest's digest isn't <sha>.",
    "audit.jsonl has changed.",
    "evidence/<run>/packet-<sha>.json has changed.",
    "extra.txt isn't in the manifest.",
    "The audit chain is broken at event N (contents were changed).",
    "evidence/<run>/packet-<sha>.json doesn't match its digest.",
  ]);
  const target = fresh("refused");
  assert.throws(() => restoreBackup(bad, target), /doesn't verify/);
  assert.equal(existsSync(target), false, "nothing was restored");

  const escape = fresh("escape");
  cpSync(backup.dir, escape, { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(escape, "manifest.json"), "utf8"));
  manifest.files.push({ path: "../outside.txt", sha256: "0".repeat(64), bytes: 1 });
  writeFileSync(path.join(escape, "manifest.json"), JSON.stringify(manifest));
  assert.deepEqual(verifyBackup(escape).problems, ["../outside.txt isn't a path inside the backup."]);
});

test("no backup while stored evidence has changed", async () => {
  const file = path.join(evidenceRoot(dataDir), stored.file);
  chmodSync(file, 0o644);
  writeFileSync(file, "{}");
  const res = await backupAs("admin");
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /Stored evidence has changed since it was written/);
  ledger.close();
});
