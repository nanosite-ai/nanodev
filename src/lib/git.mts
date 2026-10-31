// The user's own git, wrapped. nanodev never rewrites published history: it commits, rebases local
// work on origin/main, and pushes HEAD to main.
import { existsSync } from "node:fs";
import path from "node:path";
import { CliError } from "./errors.mjs";
import { c, info } from "./output.mjs";
import { capture, type Captured } from "./proc.mjs";
import { parseAheadBehind, parsePorcelain, type AheadBehind } from "./sync.mjs";

export const REMOTE = "origin";
export const MAIN = "main";
export const REMOTE_MAIN = `${REMOTE}/${MAIN}`;
export const LOCKFILE = "package-lock.json";

/** `env` adds variables for this call only (e.g. GIT_INDEX_FILE for a throwaway index). */
export const git = (cwd: string, args: string[], env: Record<string, string> = {}): Captured =>
  // Never let git open an editor or a credential prompt we can't answer.
  capture("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", ...env } });

/** Run git and return trimmed stdout; throw a CliError carrying git's own message on failure. */
export const gitOrThrow = (cwd: string, args: string[], what?: string, env: Record<string, string> = {}): string => {
  const res = git(cwd, args, env);
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout).trim();
    throw new CliError(`${what ?? `git ${args[0]}`} failed${detail ? `:\n${detail}` : ""}`);
  }
  return res.stdout.trim();
};

/** `git version 2.45.1.windows.1` → "2.45.1"; null when git is missing. */
export const gitVersion = (): string | null => {
  const res = capture("git", ["--version"]);
  if (res.code !== 0) return null;
  return /(\d+\.\d+(?:\.\d+)?)/.exec(res.stdout)?.[1] ?? null;
};

export const requireGit = (): void => {
  if (!gitVersion()) throw new CliError("git is not installed or not on PATH: install git (https://git-scm.com) and retry");
};

export const repoRoot = (cwd: string): string | null => {
  const res = git(cwd, ["rev-parse", "--show-toplevel"]);
  return res.code === 0 ? res.stdout.trim() : null;
};

/** The sha `ref` points to, or null when it doesn't exist. */
export const revParse = (cwd: string, ref: string): string | null => {
  const res = git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return res.code === 0 ? res.stdout.trim() : null;
};

/** The blob id of `file` at `ref` (cheap "did the lockfile change?" check), or null. */
export const blobAt = (cwd: string, ref: string, file: string): string | null => {
  const res = git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}:${file}`]);
  return res.code === 0 ? res.stdout.trim() : null;
};

export const hasCommit = (cwd: string, sha: string): boolean => git(cwd, ["cat-file", "-e", `${sha}^{commit}`]).code === 0;

export const isAncestor = (cwd: string, ancestor: string, of: string): boolean =>
  git(cwd, ["merge-base", "--is-ancestor", ancestor, of]).code === 0;

export const currentBranch = (cwd: string): string | null => {
  const res = git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return res.code === 0 ? res.stdout.trim() : null;
};

/** Changed paths (staged, unstaged and untracked). */
export const dirtyFiles = (cwd: string): string[] => {
  // Raw stdout: gitOrThrow trims, which would eat the leading space of " M file" and cut the first path.
  const res = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (res.code !== 0) throw new CliError(`git status failed:\n${(res.stderr || res.stdout).trim()}`);
  return parsePorcelain(res.stdout);
};

/** HEAD vs `upstream` (default origin/main). Null when the upstream ref doesn't exist yet. */
export const aheadBehind = (cwd: string, upstream = REMOTE_MAIN): AheadBehind | null => {
  if (!revParse(cwd, upstream)) return null;
  return parseAheadBehind(gitOrThrow(cwd, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`]));
};

/** Update origin/main only (never touches the working tree). */
export const fetchMain = (cwd: string): void => {
  gitOrThrow(cwd, ["fetch", "--quiet", REMOTE, `+refs/heads/${MAIN}:refs/remotes/${REMOTE}/${MAIN}`], "git fetch");
};

export interface GitIdentity {
  name: string;
  email: string;
}

/** The identity to commit as when git has none: the nanodev login's email (name = its local part). */
export const identityFromEmail = (email: string | null | undefined): GitIdentity | null => {
  const trimmed = email?.trim();
  if (!trimmed) return null;
  return { email: trimmed, name: trimmed.split("@")[0] || trimmed };
};

/** git can commit here: user.name/user.email are configured (or git can work them out). */
export const hasGitIdentity = (cwd: string): boolean => git(cwd, ["var", "GIT_COMMITTER_IDENT"]).code === 0;

/** Repo-local key marking an identity nanodev set from the login; its value is the email it set. */
export const IDENTITY_MARKER_KEY = "nanodev.identityFromLogin";

export const IDENTITY_ACTION = { set: "set", removed: "removed" } as const;
export type IdentityAction = (typeof IDENTITY_ACTION)[keyof typeof IDENTITY_ACTION];

const localConfig = (cwd: string, key: string): string | null => {
  const res = git(cwd, ["config", "--local", "--get", key]);
  return res.code === 0 ? res.stdout.trim() : null;
};

/** The repo-local identity is the one nanodev set (marker present and user.email unchanged since). */
export const isLoginIdentity = (cwd: string): boolean => {
  const marked = localConfig(cwd, IDENTITY_MARKER_KEY);
  return Boolean(marked) && localConfig(cwd, "user.email") === marked;
};

/** git knows who the user is without our repo-local identity: global/system config, or the env. */
export const hasOwnIdentity = (cwd: string): boolean => {
  if (process.env.GIT_AUTHOR_EMAIL && process.env.GIT_COMMITTER_EMAIL) return true;
  const res = git(cwd, ["config", "--show-scope", "--get-all", "user.email"]);
  if (res.code !== 0) return false;
  return res.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .some((line) => !/^(local|worktree)\t/.test(line));
};

/** Remove the identity nanodev set (only that one: never a user.email the user set or changed). */
export const unsetLoginIdentity = (cwd: string): boolean => {
  if (!localConfig(cwd, IDENTITY_MARKER_KEY)) return false;
  if (!isLoginIdentity(cwd)) {
    // A stale marker (the user changed user.email since) goes; their identity stays.
    git(cwd, ["config", "--local", "--unset", IDENTITY_MARKER_KEY]);
    return false;
  }
  for (const key of ["user.email", "user.name", IDENTITY_MARKER_KEY]) git(cwd, ["config", "--local", "--unset", key]);
  return true;
};

/**
 * On a machine where git was never told who the user is, `git commit` (and a rebase) fail with "Author
 * identity unknown". Then set this repository's own identity from the nanodev login (never the global
 * config) and mark it. On later runs, once git has an identity of its own (the user configured one),
 * remove ours again. Returns what it did, or null.
 */
export const ensureGitIdentity = (cwd: string, identity: GitIdentity | null): IdentityAction | null => {
  if (isLoginIdentity(cwd)) {
    if (!hasOwnIdentity(cwd)) return null;
    unsetLoginIdentity(cwd);
    return IDENTITY_ACTION.removed;
  }
  if (!identity || hasGitIdentity(cwd)) return null;
  gitOrThrow(cwd, ["config", "--local", "user.email", identity.email], "git config user.email");
  gitOrThrow(cwd, ["config", "--local", "user.name", identity.name], "git config user.name");
  gitOrThrow(cwd, ["config", "--local", IDENTITY_MARKER_KEY, identity.email], "git config");
  return IDENTITY_ACTION.set;
};

/** The one-line notice for what ensureGitIdentity did (null: nothing to say). */
export const identityNotice = (action: IdentityAction | null, identity: GitIdentity | null): string | null => {
  if (action === IDENTITY_ACTION.set && identity) {
    return `git has no user.name/user.email: this folder commits as your nanodev login (${identity.email}). Set your own with git config --global user.email, or remove this one with nanodev config --unset-identity`;
  }
  if (action === IDENTITY_ACTION.removed) return "git has your own user.email now: removed the identity nanodev had set for this folder";
  return null;
};

/** ensureGitIdentity, saying so on stderr whenever it set or removed the identity (any command). */
export const applyGitIdentity = (cwd: string, identity: GitIdentity | null): IdentityAction | null => {
  const action = ensureGitIdentity(cwd, identity);
  const notice = identityNotice(action, identity);
  if (notice) info(c.dim(notice));
  return action;
};

/** A rebase stopped on a conflict (left for the user to resolve). */
export const isRebaseInProgress = (cwd: string): boolean =>
  ["rebase-merge", "rebase-apply"].some((name) => {
    const res = git(cwd, ["rev-parse", "--git-path", name]);
    return res.code === 0 && existsSync(path.resolve(cwd, res.stdout.trim()));
  });
