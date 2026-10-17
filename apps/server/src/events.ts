// Tells open Canvas tabs when something changed, over Server-Sent Events.
// SSE is plain HTTP, so it passes through Canvas's ingress and Vite proxies
// without any WebSocket setup. The UI refetches what changed.
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

export type FactoryEvent =
  | { type: "workorders.changed" }
  | { type: "specs.changed" }
  | { type: "audit.appended"; seq: number }
  | { type: "autopilot.changed"; runId?: string };

type Listener = (event: FactoryEvent) => void;
const listeners = new Set<Listener>();

export function broadcast(event: FactoryEvent) {
  for (const listener of listeners) listener(event);
}

export function eventStream(c: Context) {
  return streamSSE(c, async (stream) => {
    const send: Listener = (event) => {
      void stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
    };
    listeners.add(send);
    await stream.writeSSE({ event: "hello", data: "{}" });
    // Keep proxies from closing an idle connection.
    const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: "{}" }), 20_000);
    await new Promise<void>((resolve) => stream.onAbort(resolve));
    clearInterval(ping);
    listeners.delete(send);
  });
}
