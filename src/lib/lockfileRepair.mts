// Add missing Linux native bindings to package-lock.json without changing any resolved version.
//
// `npm install --package-lock-only` (npm 10.9+/11) re-adds the optional platform entries a Windows or
// macOS npm dropped, keeping every locked version. It is still npm resolving, so we verify instead of
// trusting it: snapshot the lockfile (and package.json), run it, and keep the result only when the ONLY
// difference is new platform-specific entries and the Linux check now passes. Otherwise restore both
// files byte for byte. "We never change a project's dependencies automatically" holds either way.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LOCKFILE } from "./git.mjs";
import { checkLinuxLockfile, diffLockfiles, isSafeRepair, type Lockfile, type LockfileDiff } from "./lockfile.mjs";
import { capture } from "./proc.mjs";

export const REPAIR_NPM_ARGS = ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"];

export interface RepairResult {
  repaired: boolean;
  /** Why the repair was rolled back (when it was). */
  reason?: string;
  diff?: LockfileDiff;
}

export type NpmRunner = (cwd: string, args: string[]) => { code: number; output: string };

const defaultNpm: NpmRunner = (cwd, args) => {
  const res = capture("npm", args, { cwd });
  return { code: res.code, output: `${res.stdout}${res.stderr}` };
};

export const repairLinuxLockfile = (root: string, npm: NpmRunner = defaultNpm): RepairResult => {
  const lockPath = path.join(root, LOCKFILE);
  const pkgPath = path.join(root, "package.json");
  const lockText = readFileSync(lockPath, "utf8");
  const pkgText = existsSync(pkgPath) ? readFileSync(pkgPath, "utf8") : null;
  const restore = (reason: string, diff?: LockfileDiff): RepairResult => {
    writeFileSync(lockPath, lockText);
    if (pkgText !== null) writeFileSync(pkgPath, pkgText);
    return { repaired: false, reason, diff };
  };

  const run = npm(root, REPAIR_NPM_ARGS);
  if (run.code !== 0) return restore(`npm install --package-lock-only failed: ${run.output.trim().split("\n").slice(-3).join(" ")}`);
  if (pkgText !== null && readFileSync(pkgPath, "utf8") !== pkgText) return restore("npm changed package.json");

  let after: Lockfile;
  try {
    after = JSON.parse(readFileSync(lockPath, "utf8")) as Lockfile;
  } catch {
    return restore("npm wrote an unreadable lockfile");
  }
  const diff = diffLockfiles(JSON.parse(lockText) as Lockfile, after);
  if (!isSafeRepair(diff)) {
    const what = [
      diff.changed.length ? `${diff.changed.length} version change(s)` : "",
      diff.removed.length ? `${diff.removed.length} removed package(s)` : "",
      diff.addedOther.length ? `${diff.addedOther.length} new non-platform package(s)` : "",
    ].filter(Boolean);
    return restore(`it would also have made ${what.join(", ")}`, diff);
  }
  if (!checkLinuxLockfile(after).ok) return restore("this npm still leaves Linux bindings out", diff);
  if (diff.addedBindings.length === 0) return restore("npm added nothing", diff);
  return { repaired: true, diff };
};
