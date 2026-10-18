// Tells people about decisions waiting for them. With SF_NOTIFY_WEBHOOK
// (https, or http on this machine), each new Inbox item is posted once and a
// daily digest goes out at the policy's notify.digestHour. Posts carry item
// titles and kinds, run changes and states, and links, never goals, notes,
// item bodies or prompts. They're JSON with a `text` line, so Slack and Teams
// incoming webhooks show them too. A failed post is tried again later,
// backing off, and nothing already sent is sent again.
import type { Ledger } from "./ledger.js";

const BATCH = 20; // items per post
const TERMINAL = new Set(["done", "failed", "cancelled"]);

export interface Notifier {
  enabled: boolean;
  /** At most one post: new items first, then the day's digest once its hour has come. */
  step(digestHour: number, now: { day: string; hour: number }): Promise<void>;
  /** Why the last post failed, while posts are failing. */
  failing(): string | null;
}

export function createNotifier(deps: {
  ledger: Ledger;
  url: string | undefined;
  canvasUrl: string;
  record: (action: string, data: Record<string, unknown>) => void;
  retryMs?: number; // first retry delay after a failure (doubles, at most 30 minutes)
}): Notifier {
  const url = deps.url && /^(https:\/\/\S+|http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/\S*)?)$/.test(deps.url) ? deps.url : undefined;
  if (deps.url && !url) console.warn("[notify] SF_NOTIFY_WEBHOOK must be an https URL (http only on this machine); not notifying.");
  const base = deps.retryMs ?? 60_000;
  let nextAt = 0;
  let failures = 0;
  let lastError: string | null = null;
  const link = (runId: string) => `${deps.canvasUrl}/autopilot/runs/${runId}`;
  const inbox = `${deps.canvasUrl}/inbox`;

  async function post(body: Record<string, unknown>) {
    const res = await fetch(url as string, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`The notification webhook answered ${res.status}.`);
  }

  async function step(digestHour: number, now: { day: string; hour: number }) {
    if (!url || Date.now() < nextAt) return;
    const runs = new Map(deps.ledger.listRuns().map((r) => [r.id, r]));
    const open = deps.ledger.listInbox().reverse(); // oldest first
    const fresh = open.filter((i) => !i.notifiedAt).slice(0, BATCH);
    const due = !fresh.length && now.hour >= digestHour && deps.ledger.getKv("notify.digest") !== now.day;
    if (!fresh.length && !due) return;
    const item = (i: (typeof open)[number]) => ({ id: i.id, kind: i.kind, title: i.title, run: i.runId, change: runs.get(i.runId)?.change ?? null, link: link(i.runId) });
    try {
      if (fresh.length) {
        await post({
          type: "software-factory.inbox",
          text: `Software Factory: ${fresh.length === 1 ? "a decision needs you" : `${fresh.length} decisions need you`}: ${fresh.map((i) => i.title).join("; ")}. ${inbox}`,
          items: fresh.map(item),
        });
        deps.ledger.markNotified(fresh.map((i) => i.id));
        deps.record("autopilot.notified", { kind: "inbox", items: fresh.length });
      } else {
        const active = [...runs.values()].filter((r) => !TERMINAL.has(r.state));
        await post({
          type: "software-factory.digest",
          date: now.day,
          text: `Software Factory, ${now.day}: ${open.length} open decision(s), ${active.length} run(s) going. ${inbox}`,
          open: open.map(item),
          runs: active.map((r) => ({ id: r.id, change: r.change, state: r.state, link: link(r.id) })),
        });
        deps.ledger.setKv("notify.digest", now.day);
        deps.record("autopilot.notified", { kind: "digest", day: now.day, open: open.length, runs: active.length });
      }
      failures = 0;
      lastError = null;
    } catch (err) {
      failures++;
      lastError = err instanceof Error ? err.message : String(err);
      nextAt = Date.now() + Math.min(base * 2 ** (failures - 1), 30 * 60_000);
      console.warn(`[notify] ${lastError}`);
    }
  }

  return { enabled: !!url, step, failing: () => lastError };
}
