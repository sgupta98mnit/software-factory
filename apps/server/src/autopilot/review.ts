// The reviewer's side of the verify stage: reading its verdict and turning
// findings (from the reviewer, the gates or hidden tests) into the short,
// grouped list a builder gets in a repair message. Hidden tests stay hidden:
// their findings travel by name only, never with the test's source.
import type { Finding, Severity } from "./ledger.js";
import { lastVerdictJson } from "./spec.js";

export interface ReviewVerdict {
  verdict: "pass" | "fail";
  findings: Finding[];
  unreadable?: boolean;
}

/** Findings that stop a work order unless policy.yml says otherwise (review.blocking). */
export const BLOCKING: Severity[] = ["critical", "high"];
const SEVERITIES = new Set<string>(["critical", "high", "medium", "low"]);
const ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function criterionOf(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v.replace(/^#/, "")) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

/** Lenient like the critic's: the last json block (or bare object) with a "verdict". */
export function parseVerdict(reply: string): ReviewVerdict {
  const raw = lastVerdictJson(reply);
  if (!raw) {
    return { verdict: "fail", findings: [{ source: "review", severity: "high", title: "The reviewer's reply had no readable verdict", detail: "" }], unreadable: true };
  }
  const findings = (Array.isArray(raw.findings) ? raw.findings : [])
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
    .map((f): Finding => {
      const severity = text(f.severity).toLowerCase();
      return {
        source: "review",
        severity: SEVERITIES.has(severity) ? (severity as Severity) : "medium",
        title: text(f.issue) || text(f.title),
        detail: text(f.fix) || text(f.suggestion) || text(f.detail),
        file: text(f.file) || null,
        criterion: criterionOf(f.criterion),
        scenario: text(f.scenario) || null,
      };
    })
    .filter((f) => f.title);
  const verdict = /^(pass|approve)/i.test(text(raw.verdict)) ? "pass" : "fail";
  // A fail with nothing to fix would send the builder an empty repair message.
  if (verdict === "fail" && !findings.length) {
    findings.push({ source: "review", severity: "high", title: "The reviewer failed the work without saying why", detail: "Check every acceptance criterion and scenario again, with tests." });
  }
  return { verdict, findings };
}

/** Passes only with a "pass" verdict and no finding of a blocking severity. */
export const passed = (v: ReviewVerdict, blocking: Severity[] = BLOCKING) =>
  v.verdict === "pass" && !v.findings.some((f) => blocking.includes(f.severity));

/** Gate and integration findings carry command output, shown as a block. */
const OUTPUT = new Set<Finding["source"]>(["gate", "integration"]);

function line(f: Finding): string {
  const head = `(${f.severity}) ${f.title}${f.file ? ` (${f.file})` : ""}`;
  // Hidden tests: the name and first assertion line are in the title; the detail is for people only.
  if (f.source === "hidden" || !f.detail) return head;
  if (OUTPUT.has(f.source)) return `${head}\n\n  \`\`\`text\n${f.detail.replace(/^/gm, "  ")}\n  \`\`\``;
  return `${head}. Fix: ${f.detail}`;
}

/**
 * Markdown bullets, most severe first, grouped by scenario, then criterion:
 * `- Scenario "Unknown claim": (high) expected 404, got 500 (src/routes.ts)`.
 * Findings tied to neither (a gate, the agent) get a bullet each, in severity order too.
 */
export function clusterFindings(findings: Finding[]): string {
  const groups = new Map<string, { label: string | null; list: Finding[] }>();
  [...findings]
    .sort((a, b) => ORDER[a.severity] - ORDER[b.severity])
    .forEach((f, i) => {
      const label = f.scenario ? `Scenario "${f.scenario}"` : f.criterion ? `Criterion ${f.criterion}` : null;
      const group = groups.get(label ?? String(i)) ?? { label, list: [] };
      group.list.push(f);
      groups.set(label ?? String(i), group);
    });
  return [...groups.values()]
    .map(({ label, list }) => {
      if (!label) return `- ${line(list[0]!)}`;
      if (list.length === 1) return `- ${label}: ${line(list[0]!)}`;
      return [`- ${label}:`, ...list.map((f) => `  - ${line(f)}`)].join("\n");
    })
    .join("\n");
}
