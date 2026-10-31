// `npm ci` in a project folder: the lockfile in git is the only source of truth for dependencies.
import { existsSync } from "node:fs";
import path from "node:path";
import { CliError } from "./errors.mjs";
import { LOCKFILE } from "./git.mjs";
import { isJsonMode, step } from "./output.mjs";
import { runInherit } from "./proc.mjs";

export const hasLockfile = (root: string): boolean => existsSync(path.join(root, LOCKFILE));

export const npmCi = async (root: string): Promise<void> => {
  step("npm ci");
  const code = await runInherit("npm", ["ci", "--no-audit", "--no-fund"], { cwd: root, stdoutToStderr: isJsonMode() });
  if (code !== 0) throw new CliError(`npm ci failed (exit ${code}): fix the error above, then run npm ci in ${root}`);
};
