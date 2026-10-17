// Where runs come from besides Home: GitHub issues, other systems' signed
// webhooks (a helpdesk's bug reports, a tracker's tickets), and the bug form
// on Home. policy.intake says per source whether a request is ignored
// ("off"), waits for a person in the Inbox ("inbox") or starts a run ("run").
//
// A request is someone else's text: it's checked, clipped, deduplicated by
// its reference, and the spec agent is told it's a description of what's
// wanted, not instructions. Signed sources need their secret from the
// environment (never from policy.yml in the repo): SF_INTAKE_GITHUB_SECRET for
// GitHub's X-Hub-Signature-256, SF_INTAKE_SECRET for X-SF-Signature. The API
// stays on 127.0.0.1, so they arrive through a relay the agency runs.
import { createHmac, timingSafeEqual } from "node:crypto";

export type IntakeSource = "github" | "webhook" | "bug";
export const INTAKE_SOURCES: readonly IntakeSource[] = ["github", "webhook", "bug"];
export type IntakeMode = "off" | "inbox" | "run";
export const INTAKE_MODES: readonly IntakeMode[] = ["off", "inbox", "run"];

/** Where a run came from; kept on the run (and in its evidence). */
export interface RunOrigin {
  source: IntakeSource;
  kind: "feature" | "bug";
  title: string;
  /** Stable id at the source ("github:org/repo#12"), for deduplication and evidence. */
  reference: string | null;
  url: string | null;
  author: string | null;
}

export interface IntakeRequest extends RunOrigin {
  body: string;
}

const MAX_TITLE = 200;
const MAX_BODY = 3000;

/** One clipped string, or "" for anything that isn't one. */
const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim().slice(0, max) : "");
/** One line: names and ids go into the spec brief's own text, where a line break would start instructions of the sender's. */
const line = (v: unknown, max: number) => str(v, max).replace(/\s+/g, " ");
/** An https link, or null: nothing else goes into a person's Inbox as a link. Normalized, so it has no spaces, < or >. */
const link = (v: unknown) => {
  if (typeof v !== "string") return null;
  try {
    const url = new URL(v);
    return url.protocol === "https:" && url.href.length <= 500 ? url.href : null;
  } catch {
    return null;
  }
};

/** HMAC-SHA256 of the raw body as "sha256=<hex>", compared in constant time. No secret configured: never valid. */
export function signatureOk(secret: string | undefined, body: string, header: string | undefined): boolean {
  if (!secret || !header) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const given = Buffer.from(header.trim());
  return expected.length === given.length && timingSafeEqual(expected, given);
}

interface GithubIssue {
  number?: number;
  title?: unknown;
  body?: unknown;
  html_url?: unknown;
  user?: { login?: unknown };
  labels?: ({ name?: unknown } | string)[];
  pull_request?: unknown;
}

/**
 * A GitHub `issues` event the factory takes: an issue opened with `label`, or
 * given it later. Anything else (other events and actions, pull requests,
 * other labels) is null: not for the factory, and not an error.
 */
export function fromGithub(event: string | undefined, payload: unknown, label: string): IntakeRequest | null {
  if (event !== "issues" || !payload || typeof payload !== "object") return null;
  const p = payload as { action?: unknown; issue?: GithubIssue; label?: { name?: unknown }; repository?: { full_name?: unknown } };
  const issue = p.issue;
  if (!issue || issue.pull_request || typeof issue.number !== "number") return null;
  const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : str(l?.name, 100))).filter(Boolean);
  const wanted = label.toLowerCase();
  if (p.action === "opened" ? !labels.some((l) => l.toLowerCase() === wanted) : p.action !== "labeled" || str(p.label?.name, 100).toLowerCase() !== wanted) return null;
  const title = str(issue.title, MAX_TITLE);
  if (!title) return null;
  const repo = str(p.repository?.full_name, 200) || "unknown";
  return {
    source: "github",
    kind: labels.some((l) => /^(bug|defect)$/i.test(l)) ? "bug" : "feature",
    title,
    body: str(issue.body, MAX_BODY),
    reference: `github:${repo}#${issue.number}`,
    url: link(issue.html_url),
    author: str(issue.user?.login, 100) || null,
  };
}

/** A signed webhook's JSON: { title, body?, kind?: "feature" | "bug", reference?, url?, author? }. Throws with what's wrong. */
export function fromWebhook(payload: unknown): IntakeRequest {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const title = str(p.title, MAX_TITLE);
  if (!title) throw new Error("title is required (a string, at most 200 characters are kept)");
  if (p.kind !== undefined && p.kind !== "feature" && p.kind !== "bug") throw new Error('kind must be "feature" or "bug"');
  const reference = line(p.reference, 200);
  return {
    source: "webhook",
    kind: p.kind === "bug" ? "bug" : "feature",
    title,
    body: str(p.body, MAX_BODY),
    reference: reference ? `webhook:${reference}` : null,
    url: link(p.url),
    author: line(p.author, 100) || null,
  };
}

/** Home's bug form: { title, happened, expected?, steps? }. Throws with what's wrong. */
export function fromBugForm(payload: unknown, reporter: string): IntakeRequest {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const title = str(p.title, MAX_TITLE);
  const happened = str(p.happened, 1500);
  if (!title || !happened) throw new Error("Say what the bug is and what happened.");
  const expected = str(p.expected, 700);
  const steps = str(p.steps, 700);
  const body = [`What happened: ${happened}`, ...(expected ? [`What was expected: ${expected}`] : []), ...(steps ? [`Steps to reproduce:\n${steps}`] : [])].join("\n\n");
  return { source: "bug", kind: "bug", title, body, reference: null, url: null, author: reporter };
}

/** The goal a run gets from a request. */
export function goalFor(r: IntakeRequest): string {
  const head = r.kind === "bug" ? `Fix this bug: ${r.title}` : r.title;
  return (r.body ? `${head}\n\n${r.body}` : head).slice(0, 4000);
}

export const originOf = ({ body: _b, ...origin }: IntakeRequest): RunOrigin => origin;

/** "GitHub issue github:org/repo#12 by @alice": where a request came from, in words. */
export function describeOrigin(o: RunOrigin): string {
  const what = o.source === "github" ? "GitHub issue" : o.source === "webhook" ? "webhook request" : "bug report from Home";
  return [what, o.reference, o.author ? `by ${o.source === "github" ? "@" : ""}${o.author}` : null].filter(Boolean).join(" ");
}
