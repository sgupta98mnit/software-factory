// The spec stage's pieces that aren't state machine: naming the change,
// running OpenSpec's strict validation, reading the critic's verdict and the
// proposal's assumptions and open questions. The agents write the spec; the
// factory only names, validates, reads and commits it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { validateChange } from "../openspec.js";
import { git } from "./git.js";
import type { Finding, Severity } from "./ledger.js";

const MAX_NAME = 48;

/** Cuts at the last "-" that keeps it within `max` chars. */
function cut(slug: string, max: number): string {
  if (slug.length <= max) return slug;
  const dash = slug.lastIndexOf("-", max);
  return slug.slice(0, dash > 0 ? dash : max).replace(/-+$/, "");
}

/**
 * A kebab-case OpenSpec change name for a goal: lowercase letters and digits,
 * at most 48 chars, starting with a letter, and not in `taken` (adds -2, -3, ...).
 */
export function changeNameFor(goal: string, taken: Set<string> = new Set()): string {
  let slug = goal.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(slug)) slug = slug ? `change-${slug}` : "change";
  const base = cut(slug, MAX_NAME);
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${cut(base, MAX_NAME - `-${n}`.length)}-${n}`;
    if (!taken.has(name)) return name;
  }
}

/** Change names already used on the base branch or by an autopilot/<name> branch. */
export async function takenChangeNames(workspace: string, baseBranch: string): Promise<Set<string>> {
  const changes = await git(workspace, ["ls-tree", "--name-only", `${baseBranch}:openspec/changes`], { allowFail: true });
  const branches = await git(workspace, ["for-each-ref", "--format=%(refname:short)", "refs/heads/autopilot/"]);
  const fromBranches = branches.stdout.split("\n").map((b) => b.trim().split("/")[1] ?? "");
  return new Set([...(changes.code === 0 ? changes.stdout.split("\n") : []), ...fromBranches].map((s) => s.trim()).filter(Boolean));
}

/** `openspec validate <change> --strict` in the worktree, as a check: ok, and the issues as text. */
export async function checkChange(change: string, dir: string): Promise<{ ok: boolean; output: string; durationMs: number }> {
  const started = Date.now();
  const { valid, issues } = await validateChange(change, dir);
  const output = issues.map((i) => `- ${i.level}${i.path && i.path !== "file" ? ` (${i.path})` : ""}: ${i.message}`).join("\n");
  return { ok: valid, output: output || (valid ? "Valid." : "Invalid, with no issues listed."), durationMs: Date.now() - started };
}

export function readProposal(dir: string, change: string): string {
  try {
    return readFileSync(path.join(dir, "openspec", "changes", change, "proposal.md"), "utf8");
  } catch {
    return "";
  }
}

/** Bullets under a heading ("## Open questions"), up to the next heading. "None" doesn't count. */
export function sectionBullets(markdown: string, heading: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of markdown.split(/\r?\n/)) {
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      inside = (h[1] ?? "").toLowerCase().startsWith(heading.toLowerCase());
      continue;
    }
    const bullet = inside ? /^\s*[-*+]\s+(.*\S)/.exec(line)?.[1] : undefined;
    if (bullet && !/^(none|n\/a|nothing)\.?$/i.test(bullet)) out.push(bullet);
  }
  return out;
}

export const openQuestions = (proposal: string) => sectionBullets(proposal, "Open questions");
export const assumptionsOf = (proposal: string) => sectionBullets(proposal, "Assumptions");

/** The proposal's "# Title", if it has one. */
export const proposalTitle = (proposal: string) => /^#\s+(.+)$/m.exec(proposal)?.[1]?.trim() ?? null;

/** The JSON object from `start` to its matching brace, or null. */
function balancedFrom(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/**
 * The verdict object at the end of an agent's reply: the last ```json block
 * that parses and has a "verdict", else the last balanced {...} that does.
 */
export function lastVerdictJson(text: string): Record<string, unknown> | null {
  const parse = (s: string): Record<string, unknown> | null => {
    try {
      const v: unknown = JSON.parse(s);
      return v && typeof v === "object" && !Array.isArray(v) && "verdict" in v ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const fenced = [...text.matchAll(/```\s*json\s*\n([\s\S]*?)```/gi)].map((m) => m[1] ?? "").reverse();
  for (const block of fenced) {
    const v = parse(block.trim());
    if (v) return v;
  }
  for (let i = text.lastIndexOf("{"); i >= 0; i = i > 0 ? text.lastIndexOf("{", i - 1) : -1) {
    const candidate = balancedFrom(text, i);
    const v = candidate ? parse(candidate) : null;
    if (v) return v;
  }
  return null;
}

export interface CriticVerdict {
  verdict: "pass" | "revise";
  findings: Finding[];
  unreadable?: boolean;
}

const SEVERITIES = new Set<string>(["critical", "high", "medium", "low"]);
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Lenient: a reply without a readable verdict counts as "revise" with one finding saying so. */
export function parseCriticVerdict(reply: string): CriticVerdict {
  const raw = lastVerdictJson(reply);
  if (!raw) {
    return {
      verdict: "revise",
      findings: [{ source: "critic", severity: "medium", title: "The critic's reply had no readable verdict", detail: "" }],
      unreadable: true,
    };
  }
  const findings = (Array.isArray(raw.findings) ? raw.findings : [])
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
    .map((f): Finding => {
      const severity = text(f.severity).toLowerCase();
      return {
        source: "critic",
        severity: SEVERITIES.has(severity) ? (severity as Severity) : "medium",
        title: text(f.issue) || text(f.title),
        detail: text(f.suggestion) || text(f.detail) || text(f.fix),
        file: text(f.where) || text(f.file) || null,
      };
    })
    .filter((f) => f.title);
  return { verdict: /^(pass|approve)/i.test(text(raw.verdict)) ? "pass" : "revise", findings };
}
