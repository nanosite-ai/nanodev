// Pure helpers for the sync commands (pull / push / status / dev), unit-tested without git.

export interface AheadBehind {
  /** Local commits not on origin/main. */
  ahead: number;
  /** origin/main commits not in HEAD. */
  behind: number;
}

/** Parse `git rev-list --left-right --count HEAD...origin/main` ("<ahead>\t<behind>"). */
export const parseAheadBehind = (stdout: string): AheadBehind => {
  const [ahead, behind] = stdout.trim().split(/\s+/).map(Number);
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) throw new Error(`unexpected rev-list output: "${stdout.trim()}"`);
  return { ahead, behind };
};

/** Paths from `git status --porcelain=v1 -z` (renames report the new path). */
export const parsePorcelain = (stdout: string): string[] => {
  const files: string[] = [];
  const parts = stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    files.push(entry.slice(3));
    // A rename/copy entry is followed by its original path: skip it.
    if (status.includes("R") || status.includes("C")) i++;
  }
  return files;
};

const MAX_FILES_IN_SUBJECT = 3;

/** Commit subject for `nanodev push` without -m: "Update src/App.tsx, src/main.tsx and 2 more files". */
export const generateCommitMessage = (files: readonly string[]): string => {
  if (files.length === 0) return "Update project";
  const shown = files.slice(0, MAX_FILES_IN_SUBJECT);
  const rest = files.length - shown.length;
  if (rest > 0) return `Update ${shown.join(", ")} and ${rest} more file${rest === 1 ? "" : "s"}`;
  if (shown.length === 1) return `Update ${shown[0]}`;
  return `Update ${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
};

export const SYNC_STATE = {
  upToDate: "up-to-date",
  ahead: "ahead",
  behind: "behind",
  diverged: "diverged",
  noRemote: "no-remote",
} as const;
export type SyncState = (typeof SYNC_STATE)[keyof typeof SYNC_STATE];

export const syncState = (ab: AheadBehind | null): SyncState => {
  if (!ab) return SYNC_STATE.noRemote;
  if (ab.ahead > 0 && ab.behind > 0) return SYNC_STATE.diverged;
  if (ab.ahead > 0) return SYNC_STATE.ahead;
  if (ab.behind > 0) return SYNC_STATE.behind;
  return SYNC_STATE.upToDate;
};

export const describeSync = (ab: AheadBehind | null): string => {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  switch (syncState(ab)) {
    case SYNC_STATE.noRemote:
      return "origin/main not fetched yet";
    case SYNC_STATE.upToDate:
      return "up to date with origin/main";
    case SYNC_STATE.ahead:
      return `${plural(ab!.ahead, "local commit")} to push`;
    case SYNC_STATE.behind:
      return `${plural(ab!.behind, "new commit")} on origin/main: run nanodev pull`;
    default:
      return `${plural(ab!.ahead, "local commit")} to push, ${plural(ab!.behind, "new commit")} to pull`;
  }
};

/**
 * What `nanodev dev` does after polling repo-head. Cheap checks first: nothing when the remote head is
 * already in HEAD or was already reported; count locally when origin/main already is that commit; fetch
 * (refs only, never the working tree) only when the remote moved to a commit we don't have.
 */
export const REMOTE_HEAD_ACTION = { none: "none", count: "count", fetch: "fetch" } as const;
export type RemoteHeadAction = (typeof REMOTE_HEAD_ACTION)[keyof typeof REMOTE_HEAD_ACTION];

export const remoteHeadAction = (input: {
  remoteHead: string | null;
  localOriginMain: string | null;
  /** remoteHead is a commit we have and it is an ancestor of HEAD (we pushed it or already pulled it). */
  containedInHead: boolean;
  /** The remote head we last told the user about (don't repeat ourselves every 10s). */
  lastNotified: string | null;
}): RemoteHeadAction => {
  const { remoteHead, localOriginMain, containedInHead, lastNotified } = input;
  if (!remoteHead || remoteHead === lastNotified || containedInHead) return REMOTE_HEAD_ACTION.none;
  return remoteHead === localOriginMain ? REMOTE_HEAD_ACTION.count : REMOTE_HEAD_ACTION.fetch;
};

/** Git's hints for "the remote has commits you don't have" (someone pushed first). */
export const isNonFastForwardRejection = (stderr: string): boolean => /non-fast-forward|fetch first/i.test(stderr);

/** The `remote: …` lines of a push (the server's explanation of a rejection). */
export const remoteMessages = (stderr: string): string[] =>
  stderr
    .split(/\r?\n/)
    .filter((line) => line.startsWith("remote:"))
    .map((line) => line.replace(/^remote:\s?/, "").trimEnd())
    .filter((line) => line.length > 0);

export const GITIGNORE = ".gitignore";

/** What `nanodev push` never commits, whatever the project's .gitignore says (the server ignore list). */
export const NEVER_COMMIT = ["node_modules/", "dist/", ".env*", ".store-ssr-dev/"] as const;
const NEVER_COMMIT_DIRS = new Set(["node_modules", "dist", ".store-ssr-dev"]);

/** `src/node_modules/x.js`, `dist/index.html`, `.env.local`, `apps/.store-ssr-dev/a` -> true. */
export const isNeverCommitPath = (file: string): boolean => {
  const parts = file.replace(/\\/g, "/").split("/").filter(Boolean);
  const base = parts.at(-1) ?? "";
  if (base === ".env" || base.startsWith(".env.")) return true;
  return parts.slice(0, -1).some((dir) => NEVER_COMMIT_DIRS.has(dir));
};
