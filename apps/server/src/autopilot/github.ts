// The small part of GitHub's REST API that delivery uses: pull requests,
// check runs and commit statuses, reviews and one comment. The token comes
// from the factory's environment on every call (SF_GITHUB_TOKEN, a
// fine-grained token for one repository) and goes only into the request's
// Authorization header: never into argv, records or messages.

/** `status` is the HTTP status, or 0 when GitHub couldn't be reached (try again later). */
export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

/** Unreachable, or GitHub's own trouble: worth trying again on a later tick. */
export const transient = (err: unknown) => err instanceof GitHubError && (err.status === 0 || err.status >= 500);

export interface Pull {
  number: number;
  url: string; // html_url
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
  body: string;
}

export interface CheckResult {
  name: string;
  state: "pending" | "success" | "failure";
  summary: string; // the check's own title and summary, cut short
}

export interface Review {
  user: string;
  state: string; // APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED
  commit: string;
  body: string;
}

export interface ReviewComment {
  path: string;
  line: number | null;
  commit: string;
  body: string;
}

type Raw = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const cut = (text: string, max = 600) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function pullOf(p: Raw): Pull {
  const head = (p.head ?? {}) as Raw;
  const base = (p.base ?? {}) as Raw;
  return {
    number: Number(p.number),
    url: str(p.html_url),
    state: p.state === "closed" ? "closed" : "open",
    merged: p.merged === true || typeof p.merged_at === "string",
    draft: p.draft === true,
    headSha: str(head.sha),
    headRef: str(head.ref),
    baseRef: str(base.ref),
    body: str(p.body),
  };
}

// Check-run conclusions that pass; neutral and skipped don't fail a required check either.
const PASSING = new Set(["success", "neutral", "skipped"]);
const STATUS_STATE: Record<string, CheckResult["state"]> = { success: "success", pending: "pending", failure: "failure", error: "failure" };

/** "owner/name" from a GitHub remote URL (https or ssh), or null. */
export function repositoryOf(remoteUrl: string): string | null {
  const m = /(?:github\.com|\/\/[^/]+)[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

export class GitHubClient {
  private readonly apiUrl: string;
  private readonly token: () => string | undefined;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: { apiUrl: string; token: () => string | undefined; fetch?: typeof fetch; timeoutMs?: number }) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetch = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private async request<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
    const token = this.token();
    if (!token) throw new GitHubError(401, "SF_GITHUB_TOKEN isn't set: delivery needs a token for the repository.");
    let res: Response;
    try {
      res = await this.fetch(`${this.apiUrl}${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new GitHubError(0, `GitHub unreachable at ${this.apiUrl}`);
    }
    const text = await res.text().catch(() => "");
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const message = str((data as Raw | null)?.message) || `HTTP ${res.status}`;
      throw new GitHubError(res.status, `GitHub ${method} ${path.split("?")[0]}: ${message}`);
    }
    return data as T;
  }

  /** The token's view of the repository: whether it can push, and the scopes a classic token carries. */
  async repository(repo: string): Promise<{ canPush: boolean; defaultBranch: string }> {
    const r = await this.request<Raw>("GET", `/repos/${repo}`);
    const permissions = (r.permissions ?? {}) as Raw;
    return { canPush: permissions.push === true, defaultBranch: str(r.default_branch) };
  }

  /** The open pull request from `head` (a branch of the same repository) into `base`, if there is one. */
  async findPull(repo: string, head: string, base: string): Promise<Pull | null> {
    const owner = repo.split("/")[0];
    const q = new URLSearchParams({ head: `${owner}:${head}`, base, state: "open", per_page: "10" });
    const list = await this.request<Raw[]>("GET", `/repos/${repo}/pulls?${q}`);
    const found = (list ?? []).map(pullOf).find((p) => p.headRef === head);
    return found ?? null;
  }

  createPull(repo: string, pr: { title: string; head: string; base: string; body: string }): Promise<Pull> {
    return this.request<Raw>("POST", `/repos/${repo}/pulls`, { ...pr, draft: true, maintainer_can_modify: false }).then(pullOf);
  }

  getPull(repo: string, number: number): Promise<Pull> {
    return this.request<Raw>("GET", `/repos/${repo}/pulls/${number}`).then(pullOf);
  }

  /** Check runs and commit statuses of one commit, by name; the newest of a name counts. */
  async checks(repo: string, sha: string): Promise<CheckResult[]> {
    const runs = await this.request<{ check_runs?: Raw[] }>("GET", `/repos/${repo}/commits/${sha}/check-runs?per_page=100`);
    const status = await this.request<{ statuses?: Raw[] }>("GET", `/repos/${repo}/commits/${sha}/status`);
    const byName = new Map<string, CheckResult>();
    for (const run of runs?.check_runs ?? []) {
      const name = str(run.name);
      if (!name || byName.has(name)) continue; // newest first
      const output = (run.output ?? {}) as Raw;
      const state = run.status !== "completed" ? "pending" : PASSING.has(str(run.conclusion)) ? "success" : "failure";
      byName.set(name, { name, state, summary: cut([str(output.title), str(output.summary)].filter(Boolean).join(": ")) });
    }
    for (const s of status?.statuses ?? []) {
      const name = str(s.context);
      if (!name || byName.has(name)) continue;
      byName.set(name, { name, state: STATUS_STATE[str(s.state)] ?? "pending", summary: cut(str(s.description)) });
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async reviews(repo: string, number: number): Promise<Review[]> {
    const list = await this.request<Raw[]>("GET", `/repos/${repo}/pulls/${number}/reviews?per_page=100`);
    return (list ?? []).map((r) => ({ user: str((r.user as Raw | null)?.login), state: str(r.state), commit: str(r.commit_id), body: cut(str(r.body), 2000) }));
  }

  async reviewComments(repo: string, number: number): Promise<ReviewComment[]> {
    const list = await this.request<Raw[]>("GET", `/repos/${repo}/pulls/${number}/comments?per_page=100`);
    return (list ?? []).map((c) => ({ path: str(c.path), line: typeof c.line === "number" ? c.line : null, commit: str(c.commit_id), body: cut(str(c.body), 1000) }));
  }

  /** Creates the comment that carries `marker`, or updates it: one per pull request. */
  async upsertComment(repo: string, number: number, marker: string, body: string): Promise<void> {
    const comments = await this.request<Raw[]>("GET", `/repos/${repo}/issues/${number}/comments?per_page=100`);
    const mine = (comments ?? []).find((c) => str(c.body).includes(marker));
    if (mine) await this.request("PATCH", `/repos/${repo}/issues/comments/${Number(mine.id)}`, { body });
    else await this.request("POST", `/repos/${repo}/issues/${number}/comments`, { body });
  }
}
