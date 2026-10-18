// Verifies a backup, and restores it into an empty folder:
//   pnpm --filter @sf/server restore <backup folder> [<empty folder>] [--expect <manifest sha256>]
// Without a folder to restore into, it only verifies. --expect is the manifest
// digest the audit log recorded when the backup was made (factory.backup_created).
import path from "node:path";
import { restoreBackup, verifyBackup } from "./backup.js";

const args = process.argv.slice(2);
const at = args.indexOf("--expect");
const expect = at >= 0 ? args.splice(at, 2)[1] : undefined;
// pnpm runs this in apps/server; paths are relative to where the command was typed.
const where = (p: string | undefined) => (p ? path.resolve(process.env.INIT_CWD ?? process.cwd(), p) : undefined);
const [backup, target] = [where(args[0]), where(args[1])];
if (!backup) {
  console.error("Usage: restore <backup folder> [<empty folder>] [--expect <manifest sha256>]");
  process.exit(2);
}
if (!target) {
  const check = verifyBackup(backup, expect);
  if (check.ok) console.log(`The backup verifies: ${check.manifest?.files.length} files, the audit log up to event ${check.manifest?.audit.checkpoint.seq}.`);
  else console.error(`The backup doesn't verify:\n- ${check.problems.join("\n- ")}`);
  process.exit(check.ok ? 0 : 1);
}
try {
  const { files } = restoreBackup(backup, target, expect);
  console.log(`Restored ${files} files into ${target}. Set SF_DATA_DIR to that folder to use them.`);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
