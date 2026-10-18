// A stand-in for GitHub's REST API, enough for delivery: pull requests whose
// head follows the branch in a real bare repository (the remote the factory
// pushes to), check runs per commit, reviews, review comments and issue
// comments. Every request needs the token; every request is kept.
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakePull {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
  state: "open" | "closed";
  merged: boolean;
}

export async function startFakeGitHub(opts: { token: string; repo: string; remoteDir: string }) {
  const state = {
    pulls: [] as FakePull[],
    checks: new Map<string, { name: string; status: string; conclusion: string | null; output?: { title: string; summary: string } }[]>(),
    reviews: [] as { user: string; state: string; commit: string; body: string }[],
    reviewComments: [] as { path: string; line: number; commit: string; body: string }[],
    comments: [] as { id: number; issue: number; body: string }[],
    requests: [] as { method: string; path: string; authorization: string }[],
  };
  const shaOf = (branch: string) => {
    try {
      return execFileSync("git", ["rev-parse", `refs/heads/${branch}`], { cwd: opts.remoteDir, encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  const pullJson = (p: FakePull) => ({
    number: p.number,
    html_url: `https://github.example/${opts.repo}/pull/${p.number}`,
    state: p.state,
    merged: p.merged,
    draft: p.draft,
    body: p.body,
    head: { ref: p.head, sha: shaOf(p.head) },
    base: { ref: p.base },
  });

  async function route(req: IncomingMessage, url: URL): Promise<[number, unknown]> {
    const method = req.method ?? "GET";
    state.requests.push({ method, path: url.pathname + url.search, authorization: String(req.headers.authorization ?? "") });
    if (req.headers.authorization !== `Bearer ${opts.token}`) return [401, { message: "Bad credentials" }];
    const prefix = `/repos/${opts.repo}`;
    if (!url.pathname.startsWith(prefix)) return [404, { message: "Not Found" }];
    const p = url.pathname.slice(prefix.length);
    if (method === "GET" && p === "") return [200, { full_name: opts.repo, default_branch: "main", permissions: { push: true, pull: true } }];
    if (method === "GET" && p === "/pulls") {
      const head = url.searchParams.get("head")?.split(":")[1];
      const base = url.searchParams.get("base");
      return [200, state.pulls.filter((x) => x.state === "open" && (!head || x.head === head) && (!base || x.base === base)).map(pullJson)];
    }
    if (method === "POST" && p === "/pulls") {
      const body = (await readJson(req)) as { title: string; head: string; base: string; body: string; draft: boolean };
      const pull: FakePull = { number: state.pulls.length + 1, head: body.head, base: body.base, title: body.title, body: body.body, draft: body.draft, state: "open", merged: false };
      state.pulls.push(pull);
      return [201, pullJson(pull)];
    }
    let m = /^\/pulls\/(\d+)$/.exec(p);
    if (method === "GET" && m) {
      const pull = state.pulls.find((x) => x.number === Number(m![1]));
      return pull ? [200, pullJson(pull)] : [404, { message: "Not Found" }];
    }
    if (method === "GET" && /^\/pulls\/\d+\/reviews$/.test(p)) return [200, state.reviews.map((r, i) => ({ id: i + 1, user: { login: r.user }, state: r.state, commit_id: r.commit, body: r.body }))];
    if (method === "GET" && /^\/pulls\/\d+\/comments$/.test(p)) return [200, state.reviewComments.map((c) => ({ path: c.path, line: c.line, commit_id: c.commit, body: c.body }))];
    m = /^\/commits\/([0-9a-f]+)\/check-runs$/.exec(p);
    if (method === "GET" && m) return [200, { total_count: (state.checks.get(m[1]!) ?? []).length, check_runs: [...(state.checks.get(m[1]!) ?? [])].reverse() }];
    if (method === "GET" && /^\/commits\/[0-9a-f]+\/status$/.test(p)) return [200, { state: "pending", statuses: [] }];
    m = /^\/issues\/(\d+)\/comments$/.exec(p);
    if (m && method === "GET") return [200, state.comments.filter((c) => c.issue === Number(m![1])).map((c) => ({ id: c.id, body: c.body }))];
    if (m && method === "POST") {
      const { body } = (await readJson(req)) as { body: string };
      const comment = { id: state.comments.length + 100, issue: Number(m[1]), body };
      state.comments.push(comment);
      return [201, { id: comment.id, body }];
    }
    m = /^\/issues\/comments\/(\d+)$/.exec(p);
    if (m && method === "PATCH") {
      const comment = state.comments.find((c) => c.id === Number(m![1]));
      if (!comment) return [404, { message: "Not Found" }];
      comment.body = ((await readJson(req)) as { body: string }).body;
      return [200, { id: comment.id, body: comment.body }];
    }
    return [404, { message: "Not Found" }];
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    route(req, new URL(req.url ?? "/", "http://fake"))
      .catch((err: unknown) => [500, { message: String(err) }] as [number, unknown])
      .then(([status, body]) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    shaOf,
    /** Reports a check run on `sha`; the newest of a name counts. */
    check(sha: string, name: string, conclusion: "success" | "failure" | null, summary = "") {
      const list = state.checks.get(sha) ?? [];
      list.push({ name, status: conclusion ? "completed" : "in_progress", conclusion, output: { title: name, summary } });
      state.checks.set(sha, list);
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
}
