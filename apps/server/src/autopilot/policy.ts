// Autopilot's rules for a workspace, kept in .factory/policy.yml: how far a
// run may go on its own, which agent profile plays each role, how many
// repairs and reviews it gets, which gates run, and when a work order may
// merge without a person. The file is read from the base branch only, never
// from a worktree or a work-order branch, so a change can't relax its own
// rules. A run pins the policy it started with, and the policy's hash names
// it as the actor of what it approves ("policy@<hash>"), so automated
// approvals are as traceable as a person's.
import path from "node:path";
import matter from "gray-matter";
import { canonicalJson, sha256 } from "../audit.js";
import type { Gate } from "./gates.js";
import { fileAt } from "./git.js";
import type { AttemptRole, Autonomy, Risk, Severity } from "./ledger.js";
import { BLOCKING } from "./review.js";

export const POLICY_FILE = ".factory/policy.yml";

export interface Policy {
  version: 1;
  autonomy: { default: Autonomy; max: Autonomy };
  /** Agent profile id or name per role; null = Canvas's active profile (critic and reviewer prefer another vendor). */
  agents: Record<AttemptRole, string | null>;
  /** Builder profile by work-order risk (C9). */
  routing: Record<Risk, string | null>;
  /** Work orders of one run in building, verifying or reviewing at once. */
  parallel: number;
  /** Follow-ups to a builder before a fresh one takes over, and fresh builders before a person is asked. */
  repair: { sameConversation: number; fresh: number };
  spec: { validateTries: number; criticRounds: number };
  /** Review findings of these severities stop a work order. */
  review: { blocking: Severity[] };
  /** null = detect npm scripts (gates.ts). */
  gates: Gate[] | null;
  autoMerge: { maxChangedLines: number; sensitivePaths: string[]; dependencyAllowlist: string[] };
  budget: { perWorkOrderUsd: number; perChangeUsd: number };
  hiddenTests: { enabled: boolean; run: string };
  notify: { digestHour: number };
  /** Release into the base branch on its own (autonomous runs only). Off: a person's click, the default. */
  release: { auto: boolean };
  /** The watchdog: minutes a working agent may show no progress (no new events or cost) before it's nudged; as long again and it's stopped. */
  selfHealing: { quietMinutes: number };
}

export const DEFAULT_POLICY: Policy = {
  version: 1,
  autonomy: { default: "supervised", max: "autonomous" },
  agents: { spec: null, critic: null, builder: null, reviewer: null, validator: null },
  routing: { low: null, medium: null, high: null },
  parallel: 3,
  repair: { sameConversation: 2, fresh: 1 },
  spec: { validateTries: 3, criticRounds: 2 },
  review: { blocking: [...BLOCKING] },
  gates: null,
  autoMerge: {
    maxChangedLines: 400,
    sensitivePaths: [
      "**/auth/**", "**/auth.*", "**/crypto/**", "**/*crypto*", "**/migrations/**",
      ".env", ".env.local", ".env.*.local", ".env.production", ".env.development", "**/*.pem", "**/*.key",
      "infra/**", "**/terraform/**", "**/*.tf", "**/*.tfvars", "**/k8s/**", "**/helm/**",
      "Dockerfile*", "docker-compose*.yml", "docker-compose*.yaml",
      "**/.github/**", ".gitlab/**", ".gitlab-ci.yml", "Jenkinsfile",
      ".factory/**", "AGENTS.md", "CLAUDE.md",
    ],
    dependencyAllowlist: [],
  },
  budget: { perWorkOrderUsd: 5, perChangeUsd: 30 },
  // Opt-in: one more agent per run, and specs concrete enough to test black-box.
  hiddenTests: { enabled: false, run: "node --test" },
  notify: { digestHour: 17 },
  release: { auto: false },
  selfHealing: { quietMinutes: 20 },
};

// ---- reading and checking policy.yml ----

/** What's wrong with the value at `key`, or null when it's fine. */
type Rule = (value: unknown, key: string) => string | null;

const oneOf =
  (allowed: readonly string[]): Rule =>
  (v, key) =>
    typeof v === "string" && allowed.includes(v) ? null : `${key} must be one of: ${allowed.join(", ")}`;
const whole =
  (min: number, max = Infinity): Rule =>
  (v, key) =>
    Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? null : `${key} must be a whole number from ${min}${max < Infinity ? ` to ${max}` : " up"}`;
const positive: Rule = (v, key) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? null : `${key} must be a number above 0`);
const text: Rule = (v, key) => (typeof v === "string" && v.trim() ? null : `${key} must be a non-empty string`);
const flag: Rule = (v, key) => (typeof v === "boolean" ? null : `${key} must be true or false`);
const profile: Rule = (v, key) => (v === null || (typeof v === "string" && v.trim()) ? null : `${key} must be an agent profile id or name, or null`);
const listOf =
  (item: Rule): Rule =>
  (v, key) =>
    Array.isArray(v) ? (v.map((x, i) => item(x, `${key}[${i}]`)).find(Boolean) ?? null) : `${key} must be a list`;

const isMapping = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;

// A day at most: setTimeout fires at once for anything past ~24.8 days, which would fail every gate.
const seconds: Rule = (v, key) => positive(v, key) ?? ((v as number) <= 86400 ? null : `${key} must be at most 86400 (a day)`);
const GATE_KEYS = new Set(["name", "run", "cwd", "timeoutSec"]);
const gate: Rule = (v, key) => {
  if (!isMapping(v)) return `${key} must be a mapping with name and run`;
  const unknown = Object.keys(v).find((k) => !GATE_KEYS.has(k));
  if (unknown) return `${key}.${unknown} isn't a gate setting (name, run, cwd, timeoutSec)`;
  return text(v.name, `${key}.name`) ?? text(v.run, `${key}.run`) ?? (v.cwd === undefined ? null : text(v.cwd, `${key}.cwd`)) ?? (v.timeoutSec === undefined ? null : seconds(v.timeoutSec, `${key}.timeoutSec`));
};

const AUTONOMY: Autonomy[] = ["suggest", "supervised", "autonomous"];
const RULES: Record<string, Rule> = {
  version: (v, key) => (v === 1 ? null : `${key} must be 1`),
  "autonomy.default": oneOf(AUTONOMY),
  "autonomy.max": oneOf(AUTONOMY),
  ...Object.fromEntries(Object.keys(DEFAULT_POLICY.agents).map((role) => [`agents.${role}`, profile])),
  ...Object.fromEntries(Object.keys(DEFAULT_POLICY.routing).map((risk) => [`routing.${risk}`, profile])),
  parallel: whole(1),
  "repair.sameConversation": whole(0),
  "repair.fresh": whole(0),
  "spec.validateTries": whole(1),
  "spec.criticRounds": whole(1),
  "review.blocking": listOf(oneOf(["critical", "high", "medium", "low"])),
  gates: (v, key) => (v === null ? null : Array.isArray(v) && !v.length ? `${key} must list at least one gate, or be null` : listOf(gate)(v, key)),
  "autoMerge.maxChangedLines": whole(1),
  "autoMerge.sensitivePaths": listOf(text),
  "autoMerge.dependencyAllowlist": listOf(text),
  "budget.perWorkOrderUsd": positive,
  "budget.perChangeUsd": positive,
  "hiddenTests.enabled": flag,
  "hiddenTests.run": text,
  "notify.digestHour": whole(0, 23),
  "release.auto": flag,
  "selfHealing.quietMinutes": whole(1, 1440),
};

/** `over` on top of `base`: mappings merge key by key, anything else (lists too) replaces. A key the defaults don't have is an error, so a typo can't go unnoticed. */
function mergeOver(base: Record<string, unknown>, over: unknown, key: string): Record<string, unknown> {
  if (over === null) return base; // `autoMerge:` with nothing under it
  if (!isMapping(over)) throw new Error(`${key || "The policy"} must be a mapping`);
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const name = key ? `${key}.${k}` : k;
    if (!Object.hasOwn(base, k)) throw new Error(`${name} isn't a policy setting`);
    const current = base[k];
    out[k] = isMapping(current) ? mergeOver(current, v, name) : v;
  }
  return out;
}

/** The effective policy for policy.yml's text: the file over the defaults, checked. Errors name the key that's wrong. */
export function parsePolicy(yaml: string): Policy {
  // A byte order mark (Windows editors) and an explicit start of the document; errors count lines from the top of the file.
  const start = /^\uFEFF?(---[ \t]*\r?\n)?/.exec(yaml)?.[0] ?? "";
  const body = yaml.slice(start.length);
  const firstLine = start.endsWith("\n") ? 1 : 0; // the --- taken off, for YAML errors' line numbers
  // gray-matter reads the YAML as front matter, which a line starting with --- would cut short.
  if (/^---/m.test(body)) throw new Error("must be one YAML document (no --- lines after the first)");
  let raw: unknown;
  try {
    raw = matter(`---\n${body}\n---\n`, {}).data; // options ({}) skip gray-matter's cache
  } catch (err) {
    const e = err as Error & { reason?: string; mark?: { line: number } };
    throw new Error(`isn't valid YAML${e.mark ? ` (line ${e.mark.line + firstLine})` : ""}: ${e.reason ?? e.message}`);
  }
  const policy = mergeOver(structuredClone(DEFAULT_POLICY) as unknown as Record<string, unknown>, raw, "");
  for (const [key, rule] of Object.entries(RULES)) {
    const value = key.split(".").reduce<unknown>((v, k) => (v as Record<string, unknown>)[k], policy);
    const problem = rule(value, key);
    if (problem) throw new Error(problem);
  }
  return policy as unknown as Policy;
}

/** First 12 hex of the sha256 of the policy's canonical JSON: the same rules always get the same hash. */
export const policyHash = (policy: Policy) => sha256(canonicalJson(policy)).slice(0, 12);

/**
 * The policy on `baseBranch` of the workspace repo, or the defaults when the
 * branch has no policy.yml. An invalid file throws, naming the key: a run
 * never starts on rules other than the ones written down.
 */
export async function loadPolicy(workspace: string, baseBranch: string): Promise<{ policy: Policy; hash: string; source: string }> {
  // refs/heads/: a tag with the branch's name (any agent can make one) would otherwise win.
  const yaml = await fileAt(workspace, `refs/heads/${baseBranch}`, POLICY_FILE);
  if (yaml === null) return { policy: DEFAULT_POLICY, hash: policyHash(DEFAULT_POLICY), source: "defaults" };
  const source = `${POLICY_FILE}@${baseBranch}`;
  try {
    const policy = parsePolicy(yaml);
    return { policy, hash: policyHash(policy), source };
  } catch (err) {
    throw new Error(`${source}: ${(err as Error).message}`);
  }
}

/**
 * The policy a run pinned when it was created; runs from before policies get
 * the defaults. A setting added since the run was pinned reads as its default
 * (the hash the run pinned stays its own).
 */
export function pinnedPolicy(run: { policy: unknown }): Policy {
  const pinned = run.policy as Record<string, unknown> | null;
  if (!pinned) return DEFAULT_POLICY;
  const out: Record<string, unknown> = { ...pinned };
  for (const [key, value] of Object.entries(DEFAULT_POLICY)) {
    if (!Object.hasOwn(pinned, key)) out[key] = value;
    else if (isMapping(value) && isMapping(pinned[key])) out[key] = { ...value, ...(pinned[key] as Record<string, unknown>) };
  }
  return out as unknown as Policy;
}

// ---- the merge decision ----

/** What the merge decision looks at, gathered from the ledger and git. */
export interface MergeFacts {
  autonomy: Autonomy;
  gatesOk: boolean;
  hiddenTestsOk: boolean | null; // null: not run
  hiddenTestsMissing?: boolean; // turned on, but the validator wrote none
  reviewPassed: boolean; // a pass verdict with no finding of a blocking severity
  secretFindings: number;
  dependencyFindings: string[]; // what the dependency scan flagged (unpinned, outside the registry, install scripts)
  files: string[]; // paths the work order changes
  linesChanged: number;
  newDependencies: string[]; // package names its package.json files add
}

// Case and leading dots don't matter: `**` doesn't reach into dot folders, and Windows doesn't care about case.
const plain = (p: string) =>
  p
    .toLowerCase()
    .split("/")
    .map((s) => s.replace(/^\.+/, ""))
    .join("/");

/**
 * The sensitive-path pattern `file` matches, if any. Like .gitignore, a
 * pattern without a slash ("Dockerfile") also matches that name in any folder.
 */
export function sensitiveMatch(file: string, patterns: string[]): string | undefined {
  const f = plain(file);
  const name = f.slice(f.lastIndexOf("/") + 1);
  return patterns.find((pattern) => {
    const p = plain(pattern);
    return f === p || path.posix.matchesGlob(f, p) || (!p.includes("/") && path.posix.matchesGlob(name, p));
  });
}

const some = (items: string[], max = 10) => (items.length > max ? `${items.slice(0, max).join(", ")} and ${items.length - max} more` : items.join(", "));

/**
 * Whether the policy merges a work order on its own, and if not, why a person
 * has to. Auto only when every check holds; autonomy suggest never is.
 */
export function evaluateMerge(policy: Policy, facts: MergeFacts): { auto: boolean; reasons: string[] } {
  const { autoMerge } = policy;
  const reasons: string[] = [];
  if (facts.autonomy === "suggest") reasons.push("Autonomy is suggest: a person approves every merge.");
  if (!facts.gatesOk) reasons.push("Not every gate passed.");
  if (facts.hiddenTestsOk === false) reasons.push("Hidden acceptance tests failed.");
  if (facts.hiddenTestsMissing) reasons.push("Hidden acceptance tests are turned on, but the validator wrote none for this change.");
  if (!facts.reviewPassed) reasons.push(`The review didn't pass, or found something ${policy.review.blocking.join(" or ")}.`);
  if (facts.secretFindings > 0) reasons.push(`The secret scan found ${facts.secretFindings} possible secret(s) in the added lines.`);
  const unlisted = facts.newDependencies.filter((d) => !autoMerge.dependencyAllowlist.some((p) => p === d || path.posix.matchesGlob(d, p)));
  if (unlisted.length) reasons.push(`New dependencies not on the allowlist: ${some(unlisted)}.`);
  if (facts.dependencyFindings.length) reasons.push(`The dependency scan found: ${some(facts.dependencyFindings, 5)}.`);
  const sensitive = facts.files.flatMap((f) => {
    const pattern = sensitiveMatch(f, autoMerge.sensitivePaths);
    return pattern ? [`${f} (${pattern})`] : [];
  });
  if (sensitive.length) reasons.push(`Changes sensitive paths: ${some(sensitive)}.`);
  if (facts.linesChanged >= autoMerge.maxChangedLines) {
    reasons.push(`Changes ${facts.linesChanged} lines; the policy merges fewer than ${autoMerge.maxChangedLines} on its own.`);
  }
  return { auto: !reasons.length, reasons };
}

const MANIFEST = /(^|\/)package\.json$/;
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/** Package names that `head` adds to the package.json files among `files`, compared with `base`. */
export async function newDependencies(dir: string, base: string, head: string, files: string[]): Promise<string[]> {
  const names = async (ref: string, file: string) => {
    // npm ignores a byte order mark, so JSON.parse must too. Unreadable: the step stops for a person.
    const pkg = JSON.parse(((await fileAt(dir, ref, file)) ?? "{}").replace(/^\uFEFF/, "")) as Record<string, unknown> | null;
    return new Set(
      DEPENDENCY_FIELDS.flatMap((field) => {
        const deps = pkg?.[field];
        return isMapping(deps) ? Object.keys(deps) : [];
      }),
    );
  };
  const added = new Set<string>();
  for (const file of files.filter((f) => MANIFEST.test(f))) {
    const before = await names(base, file);
    for (const name of await names(head, file)) if (!before.has(name)) added.add(name);
  }
  return [...added].sort();
}
