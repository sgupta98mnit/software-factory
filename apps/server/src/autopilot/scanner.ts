// The security scanner the factory runs itself, outside any agent's control:
// Trivy, a binary the operator installs and pins (SF_TRIVY, the policy's
// version, optionally SF_TRIVY_SHA256), with a vulnerability database the
// operator keeps fresh; the factory never downloads one. Reports are reduced
// to what a person or a builder may see: ids, packages, files and lines,
// never a secret's matched text or the code around it.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { canonicalJson, sha256 } from "../audit.js";
import { cliRunner, type DockerRunner } from "./execution.js";
import type { Finding, Severity } from "./ledger.js";
import type { Policy } from "./policy.js";

export type TrivyPolicy = Policy["verification"]["trivy"];
export type ScannerRunner = DockerRunner;

export interface ScanFinding {
  kind: "vuln" | "secret" | "misconfig";
  severity: Severity;
  id: string; // CVE, secret rule or check id
  target: string; // the file
  title: string;
  pkg?: string;
  installed?: string;
  fixed?: string | null;
  line?: number | null;
}

export interface ScannerInfo {
  scanner: "trivy";
  version: string;
  dbUpdatedAt: string | null;
  dbNextUpdate: string | null;
  binarySha256: string | null;
}

/** The scanner can't give a trustworthy answer: missing, another version, a stale database, an error. */
export class ScannerUnavailable extends Error {}

export const trivyCli = (): ScannerRunner => cliRunner(process.env.SF_TRIVY || "trivy");

const SEVERITY: Record<string, Severity> = { CRITICAL: "critical", HIGH: "high", MEDIUM: "medium", LOW: "low" };
const severity = (v: unknown): Severity => SEVERITY[String(v).toUpperCase()] ?? "low";
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const firstLine = (text: string) => text.trim().split(/\r?\n/)[0]?.slice(0, 300) ?? "";

const digests = new Map<string, string>(); // binary path + size + mtime -> sha256

function hashFile(file: string): string {
  try {
    const { size, mtimeMs } = statSync(file);
    const key = `${file}:${size}:${mtimeMs}`;
    let digest = digests.get(key);
    if (!digest) digests.set(key, (digest = createHash("sha256").update(readFileSync(file)).digest("hex")));
    return digest;
  } catch {
    throw new ScannerUnavailable(`Can't read the Trivy binary at ${file}.`);
  }
}

/** SF_TRIVY_SHA256 pins the binary itself, which needs SF_TRIVY to be its full path. */
function binaryDigest(): string | null {
  const bin = process.env.SF_TRIVY;
  const expected = process.env.SF_TRIVY_SHA256?.trim().toLowerCase();
  if (!expected) return bin && path.isAbsolute(bin) ? hashFile(bin) : null;
  if (!bin || !path.isAbsolute(bin)) throw new ScannerUnavailable("SF_TRIVY_SHA256 is set, so SF_TRIVY must be the full path of the Trivy binary.");
  if (hashFile(bin) !== expected) throw new ScannerUnavailable(`The Trivy binary at ${bin} doesn't match SF_TRIVY_SHA256.`);
  return expected;
}

/** The scanner's version and database, refusing what the policy doesn't accept. */
export async function scannerInfo(run: ScannerRunner, policy: TrivyPolicy, now = new Date()): Promise<ScannerInfo> {
  const r = await run(["--version", "--format", "json"], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new ScannerUnavailable(`Trivy didn't run: ${firstLine(r.stderr) || `exit code ${r.code}`}`);
  let info: { Version?: unknown; VulnerabilityDB?: { UpdatedAt?: unknown; NextUpdate?: unknown } | null };
  try {
    info = JSON.parse(r.stdout);
  } catch {
    throw new ScannerUnavailable("Trivy's version output isn't JSON.");
  }
  const version = str(info.Version) || "unknown";
  if (policy.version && version !== policy.version) throw new ScannerUnavailable(`Trivy ${version} is installed; the policy accepts only ${policy.version}.`);
  const binarySha256 = binaryDigest();
  const updatedAt = str(info.VulnerabilityDB?.UpdatedAt) || null;
  if (policy.scanners.includes("vuln")) {
    if (!updatedAt) throw new ScannerUnavailable("Trivy has no vulnerability database. Download one with: trivy image --download-db-only");
    const ageHours = (now.getTime() - Date.parse(updatedAt)) / 3_600_000;
    if (!(ageHours <= policy.maxDbAgeHours)) {
      throw new ScannerUnavailable(`Trivy's vulnerability database is from ${updatedAt}, more than ${policy.maxDbAgeHours} hours old. Refresh it with: trivy image --download-db-only`);
    }
  }
  return { scanner: "trivy", version, dbUpdatedAt: updatedAt, dbNextUpdate: str(info.VulnerabilityDB?.NextUpdate) || null, binarySha256 };
}

/** Only these fields leave a report: never Match, Code or anything else a secret could be in. */
export function parseReport(report: unknown): ScanFinding[] {
  const out: ScanFinding[] = [];
  const results = (report as { Results?: unknown } | null)?.Results;
  for (const raw of Array.isArray(results) ? results : []) {
    const r = raw as Record<string, unknown>;
    const target = str(r.Target);
    const list = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
    for (const v of list(r.Vulnerabilities)) {
      out.push({ kind: "vuln", severity: severity(v.Severity), id: str(v.VulnerabilityID), target, title: str(v.Title) || str(v.VulnerabilityID), pkg: str(v.PkgName), installed: str(v.InstalledVersion), fixed: str(v.FixedVersion) || null });
    }
    for (const s of list(r.Secrets)) {
      out.push({ kind: "secret", severity: severity(s.Severity), id: str(s.RuleID), target, title: str(s.Title) || str(s.RuleID), line: typeof s.StartLine === "number" ? s.StartLine : null });
    }
    for (const m of list(r.Misconfigurations)) {
      if ((str(m.Status) || "FAIL") !== "FAIL") continue;
      out.push({ kind: "misconfig", severity: severity(m.Severity), id: str(m.AVDID) || str(m.ID), target, title: str(m.Title) });
    }
  }
  return out.sort((a, b) => findingKey(a).localeCompare(findingKey(b)));
}

/** Scans the folder (a clean checkout of a commit) without updating the database. */
export async function scan(run: ScannerRunner, dir: string, policy: TrivyPolicy): Promise<ScanFinding[]> {
  const r = await run(
    ["fs", "--format", "json", "--quiet", "--skip-db-update", "--scanners", policy.scanners.join(","), "--timeout", `${policy.timeoutSec}s`, dir],
    { timeoutMs: (policy.timeoutSec + 30) * 1000 },
  );
  if (r.timedOut) throw new ScannerUnavailable(`Trivy didn't finish within ${policy.timeoutSec} s.`);
  if (r.code !== 0) throw new ScannerUnavailable(`Trivy failed: ${firstLine(r.stderr) || `exit code ${r.code}`}`);
  try {
    return parseReport(JSON.parse(r.stdout));
  } catch {
    throw new ScannerUnavailable("Trivy's report isn't JSON.");
  }
}

/** The same problem on the base and on the branch has the same key (a secret's line can move). */
export const findingKey = (f: ScanFinding) => [f.kind, f.target, f.id, f.pkg ?? "", f.installed ?? ""].join("|");

/** sha256 of the canonical list: identifies the result without keeping the report. */
export const scanDigest = (findings: ScanFinding[]) => sha256(canonicalJson(findings));

/** One line a builder or a person may read. */
export function describe(f: ScanFinding): string {
  if (f.kind === "vuln") return `${f.id} in ${f.pkg} ${f.installed} (${f.target})${f.fixed ? `; fixed in ${f.fixed}` : ""}: ${f.title}`;
  if (f.kind === "secret") return `Possible secret (${f.id}) in ${f.target}${f.line ? `:${f.line}` : ""}. Remove it and read the value from configuration instead.`;
  return `${f.id}: ${f.title} (${f.target})`;
}

export const scanFindings = (list: ScanFinding[]): Finding[] =>
  list.map((f) => ({ source: "gate", severity: f.severity, title: `Security scan: ${describe(f)}`, detail: "", file: f.target }));

/** Counts by kind, for the check's record and the merge decision. */
export function counts(list: ScanFinding[]) {
  return { vuln: list.filter((f) => f.kind === "vuln").length, secret: list.filter((f) => f.kind === "secret").length, misconfig: list.filter((f) => f.kind === "misconfig").length };
}
