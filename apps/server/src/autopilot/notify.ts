// Tells people when Autopilot needs them, the way Factory does it: the first
// decision that opens gets one alert right away; anything after that waits for
// one daily digest at policy.notify.digestHour (local time). A digest resets
// the rule, so the next decision alerts again.
//
// The webhook URL is a secret, so it comes from the environment
// (SF_NOTIFY_WEBHOOK), never from policy.yml in the repo. Slack and Teams
// incoming webhooks are detected by host; anything else gets plain JSON.
// Messages carry inbox titles and a link to the Inbox, never goals, notes,
// prompts or the URL itself, and every send is audited.
import type { InboxItem, Ledger } from "./ledger.js";

export type Channel = "slack" | "teams" | "json";

export interface NotifyConfig {
  webhook: string | null;
  /** Where the Inbox opens for the person reading the message. */
  inboxUrl: string;
  digestHour: number;
}

export function channelOf(url: string): Channel {
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  })();
  if (host === "hooks.slack.com") return "slack";
  if (host.endsWith(".webhook.office.com") || host === "outlook.office.com" || host.endsWith(".logic.azure.com")) return "teams";
  return "json";
}

/** The body each channel expects for a title and lines of text. */
export function payload(channel: Channel, title: string, lines: string[], link: string): unknown {
  const text = [title, ...lines.map((l) => `• ${l}`), link].join("\n");
  if (channel === "slack") return { text };
  if (channel === "teams") {
    // An Adaptive Card in the shape Teams Workflows and connectors both accept.
    return {
      type: "message",
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          content: {
            type: "AdaptiveCard",
            version: "1.4",
            body: [
              { type: "TextBlock", text: title, weight: "Bolder", wrap: true },
              ...lines.map((l) => ({ type: "TextBlock", text: `• ${l}`, wrap: true, spacing: "Small" })),
            ],
            actions: [{ type: "Action.OpenUrl", title: "Open the Inbox", url: link }],
          },
        },
      ],
    };
  }
  return { title, lines, link, text };
}

const ALERTED = "notify.alerted_at"; // the last alert, ISO
const DIGESTED = "notify.digested_at"; // the last digest, ISO

/** Local calendar day as YYYY-MM-DD. */
const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function createNotifier(deps: {
  ledger: Ledger;
  config: () => NotifyConfig;
  record: (action: string, data: Record<string, unknown>) => void;
  fetch?: typeof fetch;
  now?: () => Date;
}) {
  const send = deps.fetch ?? fetch;
  const clock = deps.now ?? (() => new Date());
  let sending: Promise<unknown> = Promise.resolve();

  async function post(cfg: NotifyConfig & { webhook: string }, kind: "alert" | "digest", title: string, lines: string[]): Promise<boolean> {
    const channel = channelOf(cfg.webhook);
    try {
      const res = await send(cfg.webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload(channel, title, lines, cfg.inboxUrl)),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      deps.record("autopilot.notification_sent", { kind, channel, items: lines.length });
      return true;
    } catch (err) {
      // Not audited as sent; the next tick tries again.
      console.warn(`[notify] ${kind} failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  const line = (i: InboxItem) => i.title;

  /** An item just opened: alert now if nothing was alerted since the last digest. */
  async function opened(item: InboxItem) {
    const cfg = deps.config();
    if (!cfg.webhook) return;
    const alerted = deps.ledger.getMeta(ALERTED);
    const digested = deps.ledger.getMeta(DIGESTED);
    if (alerted && (!digested || alerted > digested)) return; // waits for the digest
    const ok = await post({ ...cfg, webhook: cfg.webhook }, "alert", "Autopilot needs you", [line(item)]);
    if (!ok) return;
    const at = clock().toISOString();
    deps.ledger.setMeta(ALERTED, at);
    deps.ledger.markNotified([item.id], at);
  }

  /** Once a day at digestHour: every open item nobody has been told about yet. */
  async function digest(now = clock()) {
    const cfg = deps.config();
    if (!cfg.webhook || now.getHours() < cfg.digestHour) return;
    const digested = deps.ledger.getMeta(DIGESTED);
    if (digested && day(new Date(digested)) === day(now)) return;
    const waiting = deps.ledger.listInbox({ state: "open" }).filter((i) => !i.notifiedAt);
    const at = now.toISOString();
    if (waiting.length) {
      const all = deps.ledger.openInboxCount();
      const ok = await post({ ...cfg, webhook: cfg.webhook }, "digest", `Autopilot: ${all} decision(s) wait for you`, waiting.map(line));
      if (!ok) return;
      deps.ledger.markNotified(waiting.map((i) => i.id), at);
    }
    deps.ledger.setMeta(DIGESTED, at);
  }

  /** One send at a time, so two openings can't both alert. Never throws. */
  const serial = (fn: () => Promise<void>) => {
    const next = sending.then(fn, fn).catch(() => undefined);
    sending = next;
    return next;
  };

  return {
    opened: (item: InboxItem) => serial(() => opened(item)),
    tick: (now?: Date) => serial(() => digest(now)),
    idle: () => sending,
  };
}

export type Notifier = ReturnType<typeof createNotifier>;
