// The factory's own scans of what a work order adds, so the merge policy
// never takes an agent's word for it:
//
// - secrets: every added line against known credential formats (cloud keys,
//   tokens, private keys, webhook URLs) and hard-coded password-like values.
//   A finding names the rule, file and line, never the secret itself.
// - dependencies: package.json changes that pull code in a way a reviewer
//   should see: a version that isn't exact, a source outside the npm registry,
//   or a new install script.
//
// Both are deterministic and offline. They're a floor, not a replacement for
// a real scanner (gitleaks, npm audit) a team can add as a gate.
import { fileAt } from "./git.js";

export interface ScanFinding {
  rule: string;
  file: string;
  line: number | null;
  /** Safe to show and to audit: never contains the matched secret. */
  detail: string;
}

interface SecretRule {
  rule: string;
  pattern: RegExp;
}

const SECRET_RULES: SecretRule[] = [
  { rule: "private-key", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/ },
  { rule: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { rule: "aws-secret-key", pattern: /aws_?secret_?access_?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}\b/i },
  { rule: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { rule: "slack-token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { rule: "chat-webhook", pattern: /https:\/\/(?:hooks\.slack\.com\/services\/|[\w.-]+\.webhook\.office\.com\/webhookb2\/|outlook\.office\.com\/webhook\/)[\w/@-]{16,}/ },
  { rule: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { rule: "stripe-live-key", pattern: /\b[rs]k_live_[0-9A-Za-z]{20,}\b/ },
  { rule: "model-api-key", pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { rule: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];

/** `password = "..."` and friends with a literal value that doesn't look like a placeholder. */
const ASSIGNED = /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["'`]([^"'`\s]{8,})["'`]/i;
const PLACEHOLDER = /^(?:x+|\*+|\.+|changeme|change-me|example|placeholder|password|secret|redacted|dummy|test|fake|sample|your[-_].*|<.*>|\$\{.*\}|%.*%|\{\{.*\}\})$/i;
/** Files that hold hashes and fixtures rather than credentials. */
const SKIP_FILES = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|[^/]*\.lock|[^/]*\.min\.js|[^/]*\.map)$/i;

/** Shannon entropy in bits per character: random secrets score high, words low. */
function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const c of text) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Secrets among added lines. `lines` carry the file and, when known, the line
 * number in the new file; one finding per rule per line.
 */
export function scanSecrets(lines: { path: string; line: string; number?: number | null }[]): ScanFinding[] {
  const found: ScanFinding[] = [];
  for (const { path: file, line, number } of lines) {
    if (SKIP_FILES.test(file)) continue;
    const at = number ?? null;
    for (const { rule, pattern } of SECRET_RULES) {
      if (pattern.test(line)) found.push({ rule, file, line: at, detail: `Looks like a ${rule.replaceAll("-", " ")}` });
    }
    const value = ASSIGNED.exec(line)?.[1];
    if (value && !PLACEHOLDER.test(value) && !/^(?:process\.env|import\.meta\.env|os\.environ)/.test(value) && entropy(value) >= 3) {
      if (!found.some((f) => f.file === file && f.line === at)) {
        found.push({ rule: "hardcoded-secret", file, line: at, detail: "A password, key or token is written into the code" });
      }
    }
  }
  return found;
}

const MANIFEST = /(^|\/)package\.json$/;
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"];
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const OUTSIDE = /^(?:git(?:\+[a-z]+)?:|github:|gitlab:|bitbucket:|https?:|file:|link:|[\w.-]+\/[\w.-]+(?:#.*)?$)/i;

type Manifest = Record<string, unknown> | null;
const mapping = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** What a package.json change brings in that a person should look at, comparing `before` with `after`. */
export function scanManifest(file: string, before: Manifest, after: Manifest): ScanFinding[] {
  const found: ScanFinding[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const old = mapping(before?.[field]);
    for (const [name, spec] of Object.entries(mapping(after?.[field]))) {
      if (old[name] === spec) continue; // unchanged
      const version = typeof spec === "string" ? spec.trim() : "";
      if (OUTSIDE.test(version)) {
        found.push({ rule: "dependency-source", file, line: null, detail: `${name} installs from outside the npm registry (${version})` });
      } else if (!EXACT.test(version)) {
        found.push({ rule: "dependency-unpinned", file, line: null, detail: `${name}@${version || "?"} isn't pinned to an exact version` });
      }
    }
  }
  const oldScripts = mapping(before?.scripts);
  for (const [name, command] of Object.entries(mapping(after?.scripts))) {
    if (INSTALL_SCRIPTS.includes(name) && oldScripts[name] !== command) {
      found.push({ rule: "install-script", file, line: null, detail: `Adds or changes the "${name}" script, which runs on every install` });
    }
  }
  return found;
}

/** Dependency findings for every package.json among `files` between `base` and `head`. Unreadable JSON is a finding too. */
export async function scanDependencies(dir: string, base: string, head: string, files: string[]): Promise<ScanFinding[]> {
  const read = async (ref: string, file: string): Promise<Manifest | "invalid"> => {
    const text = await fileAt(dir, ref, file);
    if (text === null) return null;
    try {
      return mapping(JSON.parse(text.replace(/^﻿/, "")));
    } catch {
      return "invalid";
    }
  };
  const found: ScanFinding[] = [];
  for (const file of files.filter((f) => MANIFEST.test(f))) {
    const after = await read(head, file);
    if (after === "invalid") {
      found.push({ rule: "manifest-invalid", file, line: null, detail: "package.json isn't valid JSON" });
      continue;
    }
    const before = await read(base, file);
    found.push(...scanManifest(file, before === "invalid" ? null : before, after));
  }
  return found;
}

/** One line per finding, for a check's output, a repair message and an inbox item. */
export const describeFindings = (findings: ScanFinding[]) =>
  findings.map((f) => `${f.file}${f.line ? `:${f.line}` : ""}: ${f.detail} (${f.rule})`).join("\n");
