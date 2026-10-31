// nanodev as a git credential helper: `git config --global credential.<origin>.helper "!… git-credential"`.
// Scoped to the API (and git) origin, so plain `git fetch/push` to nano-site works with the CLI token
// and no other host ever sees it. Protocol: https://git-scm.com/docs/git-credential
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { capture } from "./proc.mjs";

/** Fixed username: the server only reads the password (the ndv_ token). */
export const GIT_USERNAME = "nanodev";

export const parseCredentialRequest = (input: string): Record<string, string> => {
  const fields: Record<string, string> = {};
  for (const line of input.split(/\r?\n/)) {
    const idx = line.indexOf("=");
    if (idx > 0) fields[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return fields;
};

/** `protocol=https`, `host=api.nanosite.ai:8443` → "https://api.nanosite.ai:8443". */
export const requestOrigin = (fields: Record<string, string>): string | null => {
  if (!fields.protocol || !fields.host) return null;
  try {
    return new URL(`${fields.protocol}://${fields.host}`).origin;
  } catch {
    return null;
  }
};

export const formatCredentialResponse = (token: string): string => `username=${GIT_USERNAME}\npassword=${token}\n`;

/** The path of this package's bin, from dist/lib (or src/lib in tests). */
export const binPath = (): string => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "nanodev.mjs");

/** Is this copy of nanodev the npm-global install (so `nanodev` on PATH is this same CLI)? */
export const isGlobalInstall = (bin = binPath()): boolean => {
  const res = capture("npm", ["root", "-g"]);
  if (res.code !== 0) return false;
  const globalRoot = path.resolve(res.stdout.trim());
  let real = bin;
  try {
    real = realpathSync(bin);
  } catch {
    // keep the unresolved path
  }
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  return norm(real).startsWith(norm(globalRoot + path.sep));
};

/**
 * The helper git runs (through sh, also on Windows). A global install is called by name, so the helper
 * survives upgrades and npx cache eviction; otherwise node + this file's absolute path (forward slashes
 * survive sh).
 */
export const helperCommand = (opts: { global?: boolean; node?: string; bin?: string } = {}): string => {
  if (opts.global ?? isGlobalInstall(opts.bin)) return "!nanodev git-credential";
  const slash = (p: string) => p.split(path.sep).join("/");
  return `!"${slash(opts.node ?? process.execPath)}" "${slash(opts.bin ?? binPath())}" git-credential`;
};

const configKey = (origin: string): string => `credential.${origin}.helper`;

/**
 * Point git at nanodev for `origin` (global config). The empty first value resets helpers inherited from
 * broader config (e.g. Git Credential Manager), so git never stores or prompts for this host's token.
 */
export const configureGitHelper = (origin: string): void => {
  const key = configKey(origin);
  capture("git", ["config", "--global", "--unset-all", key]);
  const reset = capture("git", ["config", "--global", "--add", key, ""]);
  const add = capture("git", ["config", "--global", "--add", key, helperCommand()]);
  if (reset.code !== 0 || add.code !== 0) {
    throw new Error(`couldn't configure git's credential helper: ${(add.stderr || reset.stderr).trim()}`);
  }
};

export const removeGitHelper = (origin: string): void => {
  capture("git", ["config", "--global", "--unset-all", configKey(origin)]);
};

/** The helpers git has for `origin` (the last non-empty one is nanodev's when configured). */
export const configuredHelpers = (origin: string): string[] => {
  const res = capture("git", ["config", "--global", "--get-all", configKey(origin)]);
  return res.code === 0 ? res.stdout.split(/\r?\n/).filter((l) => l.length > 0) : [];
};

export const isGitHelperConfigured = (origin: string): boolean =>
  configuredHelpers(origin).some((h) => h.endsWith(" git-credential"));
