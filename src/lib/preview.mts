// nanodev preview: snapshot the working tree as a throwaway commit (never moving HEAD, the branch, the
// index or any file) and the pure rules for following the cloud build.
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApiError } from "./api.mjs";
import { CliError } from "./errors.mjs";
import { git, gitOrThrow, revParse } from "./git.mjs";

/** The only ref a preview push may update: `refs/previews/<your user id>` (force-pushed). */
export const previewRef = (userId: string): string => `refs/previews/${userId}`;

export const PREVIEW_STATUS = { building: "building", ready: "ready", failed: "failed" } as const;
export type PreviewStatus = (typeof PREVIEW_STATUS)[keyof typeof PREVIEW_STATUS];

/** `GET /api/cli/projects/:projectId/preview`. */
export interface PreviewStatusResponse {
  status: PreviewStatus;
  sha: string;
  url: string | null;
  servedSha: string | null;
  builtAt: string | null;
  pushedAt: string;
  error?: string;
  log?: string;
  durationMs?: number;
}

export const PREVIEW_COMMIT_MESSAGE = "nanodev preview (uncommitted changes)";

/** Used only when the user's git has no identity: the snapshot commit is throwaway either way. */
const FALLBACK_IDENT = { GIT_AUTHOR_NAME: "nanodev", GIT_AUTHOR_EMAIL: "nanodev@localhost", GIT_COMMITTER_NAME: "nanodev", GIT_COMMITTER_EMAIL: "nanodev@localhost" };

export interface Snapshot {
  /** The commit to preview: HEAD when the tree is clean, else a new commit on top of HEAD. */
  sha: string;
  /** True when uncommitted work was folded into a throwaway commit. */
  temporary: boolean;
}

/**
 * Commit everything `git add -A` would stage (tracked changes, deletions, new files; .gitignore
 * respected) WITHOUT touching the user's state: a copy of the index in a temp dir takes the `add`,
 * `write-tree` makes the tree and `commit-tree` the commit. HEAD, the branch, the real index and the
 * working tree are untouched; the commit is only reachable from the preview ref once pushed.
 */
export const snapshotWorkingTree = (root: string): Snapshot => {
  const head = revParse(root, "HEAD");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "nanodev-preview-"));
  try {
    const index = path.join(tmp, "index");
    const realIndex = path.resolve(root, gitOrThrow(root, ["rev-parse", "--git-path", "index"]));
    if (existsSync(realIndex)) copyFileSync(realIndex, index);
    const env = { GIT_INDEX_FILE: index };
    gitOrThrow(root, ["add", "-A"], "git add (preview snapshot)", env);
    const tree = gitOrThrow(root, ["write-tree"], "git write-tree", env);
    if (head && tree === gitOrThrow(root, ["rev-parse", "HEAD^{tree}"])) return { sha: head, temporary: false };
    const ident = git(root, ["var", "GIT_COMMITTER_IDENT"]).code === 0 ? {} : FALLBACK_IDENT;
    const parent = head ? ["-p", head] : [];
    // --no-gpg-sign: a throwaway commit must never prompt for a signing key.
    const sha = gitOrThrow(root, ["commit-tree", "--no-gpg-sign", tree, ...parent, "-m", PREVIEW_COMMIT_MESSAGE], "git commit-tree", { ...env, ...ident });
    return { sha, temporary: true };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};

export type PollDecision = "wait" | "ready" | "failed";

/** Keep polling until the server reports on exactly the pushed sha. */
export const decide = (status: PreviewStatusResponse | null, pushedSha: string): PollDecision => {
  if (!status || status.sha !== pushedSha) return "wait";
  if (status.status === PREVIEW_STATUS.ready) return "ready";
  if (status.status === PREVIEW_STATUS.failed) return "failed";
  return "wait";
};

/** The last `lines` lines of a build log. */
export const logTail = (log: string | undefined, lines = 40): string => {
  if (!log) return "";
  const all = log.trimEnd().split(/\r?\n/);
  return all.slice(-lines).join("\n");
};

/** Worth retrying while waiting: the server unreachable (network), restarting (5xx) or busy (429). */
export const isTransientError = (err: unknown): boolean => {
  if (err instanceof ApiError) return err.status >= 500 || err.status === 429;
  return err instanceof CliError && err.message.startsWith("can't reach ");
};
