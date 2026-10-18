// Write-once evidence: exported packets, release approval envelopes and
// attestations, kept as canonical JSON named by their sha256 under
// <dataDir>/evidence/<run>/ (or SF_EVIDENCE_DIR), made read-only and never
// overwritten. verifyEvidence recomputes every digest; pruneEvidence removes
// only files older than the retention period. On one machine this is best
// effort (an administrator can change file permissions): point
// SF_EVIDENCE_DIR at write-once storage for more.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson, sha256 } from "../audit.js";

export type EvidenceKind = "packet" | "release" | "attestation";

const NAME = /^(packet|release|attestation)-([0-9a-f]{64})\.json$/;

export const evidenceRoot = (dataDir: string) => path.resolve(process.env.SF_EVIDENCE_DIR ?? path.join(dataDir, "evidence"));

/** Retention in days (SF_EVIDENCE_RETENTION_DAYS, seven years by default). */
export const retentionDays = () => Number(process.env.SF_EVIDENCE_RETENTION_DAYS) || 2555;

/** Stores `value` once, named by its digest. The same value again is fine; a different file under that name is not. */
export function storeEvidence(root: string, runId: string, kind: EvidenceKind, value: unknown): { file: string; sha256: string } {
  if (!/^ap-[0-9a-f]{8}$/.test(runId)) throw new Error(`Not a run id: ${runId}`);
  const text = canonicalJson(value);
  const digest = sha256(text);
  const dir = path.join(root, runId);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${kind}-${digest}.json`);
  try {
    writeFileSync(file, text, { flag: "wx" });
    chmodSync(file, 0o444);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    if (sha256(readFileSync(file, "utf8")) !== digest) throw new Error(`Stored evidence ${runId}/${kind}-${digest}.json has changed since it was written.`);
  }
  return { file: `${runId}/${kind}-${digest}.json`, sha256: digest };
}

/** Every stored file, oldest first. */
export function listEvidence(root: string): { file: string; runId: string; kind: EvidenceKind; sha256: string; writtenAt: string }[] {
  if (!existsSync(root)) return [];
  const out: { file: string; runId: string; kind: EvidenceKind; sha256: string; writtenAt: string }[] = [];
  for (const runId of readdirSync(root).filter((d) => /^ap-[0-9a-f]{8}$/.test(d))) {
    for (const name of readdirSync(path.join(root, runId))) {
      const m = NAME.exec(name);
      if (!m) continue;
      out.push({ file: `${runId}/${name}`, runId, kind: m[1] as EvidenceKind, sha256: m[2]!, writtenAt: statSync(path.join(root, runId, name)).mtime.toISOString() });
    }
  }
  return out.sort((a, b) => a.writtenAt.localeCompare(b.writtenAt));
}

/** Each file's content still hashes to its name. */
export function verifyEvidence(root: string): { ok: boolean; checked: number; changed: string[] } {
  const changed = listEvidence(root)
    .filter((e) => sha256(readFileSync(path.join(root, e.file), "utf8")) !== e.sha256)
    .map((e) => e.file);
  return { ok: changed.length === 0, checked: listEvidence(root).length, changed };
}

/** Removes files older than the retention period, and only those. Returns what went. */
export function pruneEvidence(root: string, days = retentionDays(), now = Date.now()): string[] {
  const cutoff = now - days * 86_400_000;
  const removed: string[] = [];
  for (const e of listEvidence(root)) {
    if (Date.parse(e.writtenAt) >= cutoff) continue;
    const file = path.join(root, e.file);
    chmodSync(file, 0o644);
    rmSync(file);
    removed.push(e.file);
  }
  return removed;
}
