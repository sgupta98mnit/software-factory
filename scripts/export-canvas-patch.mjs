// Rewrites patches/canvas-factory.patch from your work in canvas/.
//
//   pnpm export:canvas-patch
//
// The patch is everything on canvas/ (committed or not) compared with the
// pinned OpenHands commit, so a fresh `pnpm setup:canvas` reproduces it.
// Commit the patch in this repo whenever you change the Canvas side.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const lock = JSON.parse(readFileSync(path.join(root, "canvas.lock.json"), "utf8"));
const canvas = path.join(root, "canvas");
const git = (args) => execFileSync("git", ["-C", canvas, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

// Include new files that aren't committed yet, without staging them for real.
git(["add", "--intent-to-add", "--all"]);
const diff = git(["diff", "--binary", lock.commit, "--", ".", ":(exclude).env"]);
writeFileSync(path.join(root, lock.patch), diff);
const files = diff.match(/^diff --git /gm)?.length ?? 0;
console.log(`[export] Wrote ${lock.patch} (${files} files changed from ${lock.commit.slice(0, 7)}).`);
