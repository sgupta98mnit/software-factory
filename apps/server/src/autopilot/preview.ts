// The preview: before a finished run is offered for release, the factory
// runs the app from the integration branch (policy preview.start, with PORT
// set), checks that each page the policy names answers without an error, and
// takes a screenshot of each with a headless Chromium (playwright-core, no
// browser download). The results go into the release decision, so the person
// releasing sees the app, not just a diff. Without a browser, the smoke test
// still runs and the result says why there are no screenshots.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { startService } from "./gates.js";

export interface PreviewPage {
  path: string;
  status: number | null;
  ok: boolean;
  /** The screenshot's file name in the run's preview folder. */
  screenshot: string | null;
  error: string | null;
}

export interface PreviewResult {
  ok: boolean;
  at: string;
  pages: PreviewPage[];
  /** Why there's no result for the pages (the app didn't start), or null. */
  error: string | null;
  /** Why there are no screenshots, or null when there are. */
  noScreenshots: string | null;
  /** The end of the app's output. */
  output: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A port nothing listens on right now, on the loopback. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

/**
 * The Chromium to take screenshots with: SF_PREVIEW_BROWSER, then the one
 * playwright-core expects, then the newest under PLAYWRIGHT_BROWSERS_PATH.
 * null when there's none (no screenshots, the smoke test still runs).
 */
export async function findBrowser(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (env.SF_PREVIEW_BROWSER) return existsSync(env.SF_PREVIEW_BROWSER) ? env.SF_PREVIEW_BROWSER : null;
  try {
    const { chromium } = await import("playwright-core");
    const expected = chromium.executablePath();
    if (expected && existsSync(expected)) return expected;
  } catch {
    // playwright-core missing, or no default for this platform
  }
  const root = env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return null;
  const builds = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  for (const build of builds) {
    for (const exe of ["chrome-linux/chrome", "chrome-linux64/chrome", "chrome-win/chrome.exe", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
      const file = path.join(root, build, exe);
      if (existsSync(file)) return file;
    }
  }
  return null;
}

/** "/claims/status?id=1" -> "claims-status-id-1". */
const slug = (p: string) => p.replace(/^\/+/, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "home";

export async function runPreview(
  dir: string,
  cfg: { start: string; paths: string[]; readyTimeoutSec: number },
  outDir: string,
  opts: { signal?: AbortSignal; browser?: string | null; now?: () => Date } = {},
): Promise<PreviewResult> {
  const at = (opts.now ?? (() => new Date()))().toISOString();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const app = startService(dir, cfg.start, { PORT: String(port), HOST: "127.0.0.1" });
  const result = (r: Omit<PreviewResult, "at" | "output">): PreviewResult => ({ ...r, at, output: app.output() });
  try {
    // Ready once anything answers on the port (a 404 at / still means it's up).
    const deadline = Date.now() + cfg.readyTimeoutSec * 1000;
    for (;;) {
      if (opts.signal?.aborted) return result({ ok: false, pages: [], error: "Stopped.", noScreenshots: null });
      if (app.exited() !== undefined) return result({ ok: false, pages: [], error: `\`${cfg.start}\` exited (code ${app.exited()}) before answering on port ${port}.`, noScreenshots: null });
      const up = await fetch(base, { signal: AbortSignal.timeout(2000), redirect: "manual" }).then(() => true, () => false);
      if (up) break;
      if (Date.now() > deadline) return result({ ok: false, pages: [], error: `Nothing answered on port ${port} within ${cfg.readyTimeoutSec} s of \`${cfg.start}\`.`, noScreenshots: null });
      await sleep(250);
    }
    const pages: PreviewPage[] = [];
    // The app's own pages only: a path a URL reads as another host ("/\host") isn't fetched or screenshot.
    const onApp = (p: string) => (new URL(p, base).origin === base ? new URL(p, base) : null);
    // Each page's wait ends at its timeout or when the preview is stopped, so Pause never waits behind a page that hangs.
    const stopOr = (ms: number) => (opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms));
    for (const p of cfg.paths) {
      if (opts.signal?.aborted) return result({ ok: false, pages, error: "Stopped.", noScreenshots: null });
      const url = onApp(p);
      if (!url) {
        pages.push({ path: p, status: null, ok: false, screenshot: null, error: "This is not a path on the app." });
        continue;
      }
      const res = await fetch(url, { signal: stopOr(10_000) }).then(
        (r) => ({ status: r.status, error: null as string | null }),
        (err: unknown) => ({ status: null, error: err instanceof Error ? err.message : String(err) }),
      );
      pages.push({ path: p, status: res.status, ok: res.status !== null && res.status < 400, screenshot: null, error: res.error });
    }
    let noScreenshots: string | null = null;
    const browser = opts.browser === undefined ? await findBrowser() : opts.browser;
    if (!browser) noScreenshots = "No Chromium for screenshots: set SF_PREVIEW_BROWSER to its path.";
    else {
      try {
        const { chromium } = await import("playwright-core");
        const b = await chromium.launch({ executablePath: browser, headless: true, args: ["--no-sandbox"] });
        const close = () => void b.close().catch(() => undefined); // a page being loaded when the preview is stopped fails at once
        opts.signal?.addEventListener("abort", close, { once: true });
        try {
          const page = await b.newPage({ viewport: { width: 1280, height: 800 } });
          mkdirSync(outDir, { recursive: true });
          for (const [i, p] of pages.entries()) {
            if (opts.signal?.aborted) break;
            const url = onApp(p.path);
            if (!url) continue;
            const file = `${i + 1}-${slug(p.path)}.png`;
            try {
              await page.goto(url.toString(), { waitUntil: "load", timeout: 15_000 });
              await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
              await page.screenshot({ path: path.join(outDir, file) });
              p.screenshot = file;
            } catch (err) {
              p.error ??= `Screenshot: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
            }
          }
        } finally {
          opts.signal?.removeEventListener("abort", close);
          await b.close();
        }
      } catch (err) {
        noScreenshots = `Chromium didn't start: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
      }
    }
    return result({ ok: pages.every((p) => p.ok), pages, error: null, noScreenshots });
  } finally {
    app.stop();
  }
}
