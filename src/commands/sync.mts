// pull / push: git as the bridge between this folder and the cloud project.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { context, loginIdentity } from "../lib/context.mjs";
import { CliError } from "../lib/errors.mjs";
import {
  LOCKFILE,
  MAIN,
  REMOTE,
  REMOTE_MAIN,
  aheadBehind,
  blobAt,
  currentBranch,
  dirtyFiles,
  applyGitIdentity,
  fetchMain,
  git,
  gitOrThrow,
  isRebaseInProgress,
  repoRoot,
  requireGit,
  revParse,
  type GitIdentity,
} from "../lib/git.mjs";
import { hasLockfile, npmCi } from "../lib/install.mjs";
import { LOCKFILE_FIX_HINT, checkLinuxLockfile, displayPackage, type Lockfile, type LockfileCheck } from "../lib/lockfile.mjs";
import { c, info, result, step, success, warn } from "../lib/output.mjs";
import { repairLinuxLockfile } from "../lib/lockfileRepair.mjs";
import { GITIGNORE, NEVER_COMMIT, generateCommitMessage, isNeverCommitPath, isNonFastForwardRejection, remoteMessages } from "../lib/sync.mjs";

const PUSH_ATTEMPTS = 2;

/** The git root of the current folder (linked or not). */
export const workRoot = (cwd: string): string => {
  requireGit();
  const root = repoRoot(cwd);
  if (!root) throw new CliError("not inside a git repository: cd into a linked project (nanodev link)");
  if (isRebaseInProgress(root)) {
    throw new CliError("a rebase is in progress: resolve the conflicts, `git add` them and run `git rebase --continue` (or `git rebase --abort`)");
  }
  return root;
};

export interface RebaseOutcome {
  before: string | null;
  after: string | null;
  newCommits: number;
  lockfileChanged: boolean;
}

/** Fetch origin/main and rebase local work onto it. Throws a clear message on a conflict. */
export const fetchAndRebase = (root: string, opts: { autostash?: boolean } = {}): RebaseOutcome => {
  const before = revParse(root, "HEAD");
  const lockBefore = blobAt(root, "HEAD", LOCKFILE);
  step(`git fetch ${REMOTE} ${MAIN}`);
  fetchMain(root);
  const ab = aheadBehind(root);
  if (!ab) throw new CliError(`${REMOTE_MAIN} doesn't exist: the project has no commits yet`);
  if (ab.behind === 0) return { before, after: before, newCommits: 0, lockfileChanged: false };

  step(`git rebase ${REMOTE_MAIN}`);
  const res = git(root, ["rebase", ...(opts.autostash ? ["--autostash"] : []), REMOTE_MAIN]);
  if (res.code !== 0) {
    const detail = (res.stdout + res.stderr).trim();
    if (isRebaseInProgress(root)) {
      throw new CliError(
        `your commits conflict with ${ab.behind} new commit(s) on ${REMOTE_MAIN}.\n${detail}\n\nFix the conflicted files, \`git add\` them and run \`git rebase --continue\` (or \`git rebase --abort\` to undo), then run nanodev push again.`,
      );
    }
    throw new CliError(`git rebase failed:\n${detail}`);
  }
  const after = revParse(root, "HEAD");
  return { before, after, newCommits: ab.behind, lockfileChanged: lockBefore !== blobAt(root, "HEAD", LOCKFILE) };
};

const readLockfile = (root: string): Lockfile | null => {
  if (!hasLockfile(root)) return null;
  try {
    return JSON.parse(readFileSync(path.join(root, LOCKFILE), "utf8")) as Lockfile;
  } catch {
    throw new CliError(`${LOCKFILE} is not valid JSON: run npm install to regenerate it`);
  }
};

const describeMissing = (check: LockfileCheck): string =>
  check.missing.map((m) => `  ${displayPackage(m.parent)} needs: ${m.candidates.join(", ")}`).join("\n");

const LINUX_BINDINGS_COMMIT_MESSAGE = "Add missing Linux native bindings to package-lock.json";

/**
 * The lockfile must install on Linux (the cloud build). When it doesn't, try the version-preserving repair
 * (unless `fix` is off) and commit it on its own; otherwise refuse with the missing packages.
 */
export const ensureLinuxInstallable = (root: string, fix: boolean): { fixedCommit: string | null } => {
  const lock = readLockfile(root);
  if (!lock) return { fixedCommit: null };
  const check = checkLinuxLockfile(lock);
  if (check.skipped) warn(`lockfile check skipped: ${check.skipped}`);
  if (check.ok) return { fixedCommit: null };
  const problem = `${LOCKFILE} can't install on Linux (the cloud build): missing native bindings\n${describeMissing(check)}`;
  if (!fix) throw new CliError(`${problem}\nFix: ${LOCKFILE_FIX_HINT}`);

  step(`Adding the missing Linux bindings to ${LOCKFILE} (npm install --package-lock-only, versions unchanged)`);
  const repair = repairLinuxLockfile(root);
  if (!repair.repaired) {
    throw new CliError(`${problem}\nAutomatic repair rolled back (${repair.reason}); ${LOCKFILE} is unchanged.\nFix: ${LOCKFILE_FIX_HINT}`);
  }
  gitOrThrow(root, ["add", "--", LOCKFILE], "git add");
  gitOrThrow(root, ["commit", "--quiet", "-m", LINUX_BINDINGS_COMMIT_MESSAGE, "--", LOCKFILE], "git commit");
  const added = repair.diff?.addedBindings.length ?? 0;
  success(`Added ${added} Linux binding entr${added === 1 ? "y" : "ies"} to ${LOCKFILE}`);
  return { fixedCommit: revParse(root, "HEAD") };
};

/** Refuse to push anything but local `main` to main (a feature branch or detached HEAD is a mistake). */
const requireMainBranch = (root: string): void => {
  const branch = currentBranch(root);
  if (branch === MAIN) return;
  throw new CliError(
    branch
      ? `you're on branch "${branch}": nanodev push publishes ${MAIN}. Merge your work into ${MAIN} (git switch ${MAIN} && git merge ${branch}), then push`
      : `HEAD is detached: nanodev push publishes ${MAIN}. Run git switch ${MAIN} first`,
  );
};

/** Refuse a commit that would include build output, dependencies or secrets. */
export const assertSafeToCommit = (root: string, files: readonly string[]): void => {
  if (!existsSync(path.join(root, GITIGNORE))) {
    throw new CliError(
      `this project has no ${GITIGNORE}, so committing everything could include node_modules, build output or .env secrets.\nAdd one (pull the latest from nano-site, or create it with at least: ${NEVER_COMMIT.join(" ")}), or commit the files you want yourself with git`,
    );
  }
  const blocked = files.filter(isNeverCommitPath);
  if (blocked.length > 0) {
    const list = blocked.slice(0, 10).map((f) => `  ${f}`).join("\n");
    throw new CliError(
      `refusing to commit ${blocked.length} file(s) that must never be pushed (dependencies, build output or secrets):\n${list}${blocked.length > 10 ? "\n  ..." : ""}\nAdd them to ${GITIGNORE} (or delete them), then run nanodev push again`,
    );
  }
};

export const registerSync = (program: Command): void => {
  program
    .command("pull")
    .description("Get the newest commits from nano-site (fetch + rebase your local commits on top)")
    .option("--autostash", "stash uncommitted changes before rebasing and restore them after")
    .option("--skip-install", "don't run npm ci even when package-lock.json changed")
    .addHelpText("after", "\nExamples:\n  nanodev pull\n  nanodev pull --autostash\n  nanodev pull --json")
    .action(async (opts: { autostash?: boolean; skipInstall?: boolean }, cmd: Command) => {
      const ctx = context(cmd);
      const root = workRoot(ctx.cwd);
      const dirty = dirtyFiles(root);
      if (dirty.length > 0 && !opts.autostash) {
        throw new CliError(
          `you have ${dirty.length} uncommitted change(s) (${dirty.slice(0, 3).join(", ")}${dirty.length > 3 ? ", …" : ""}): commit them, run nanodev push, or re-run with --autostash`,
        );
      }
      // A rebase writes commits too: it needs an identity on a machine where git has none.
      applyGitIdentity(root, loginIdentity(ctx));
      const outcome = fetchAndRebase(root, { autostash: opts.autostash });
      let installed = false;
      if (outcome.lockfileChanged && hasLockfile(root)) {
        if (opts.skipInstall) warn(`${LOCKFILE} changed: run npm ci`);
        else {
          await npmCi(root);
          installed = true;
        }
      }
      result({ ...outcome, installed }, () => {
        if (outcome.newCommits === 0) success("Already up to date");
        else success(`Pulled ${outcome.newCommits} new commit(s) (${outcome.after?.slice(0, 7)})${installed ? ", dependencies reinstalled" : ""}`);
      });
    });

  program
    .command("push")
    .description("Commit your changes (if any), rebase on new commits, check the lockfile and push to nano-site")
    .option("-m, --message <text>", "commit message for uncommitted changes (default: generated from the changed files)")
    .option("--no-rebase", "refuse instead of rebasing when nano-site has new commits")
    .option("--no-fix-lockfile", "only check package-lock.json for missing Linux bindings, don't repair it")
    .addHelpText(
      "after",
      '\nExamples:\n  nanodev push\n  nanodev push -m "New hero section"\n  nanodev push --no-rebase --json',
    )
    .action(async (opts: { message?: string; rebase: boolean; fixLockfile: boolean }, cmd: Command) => {
      const ctx = context(cmd);
      const outcome = pushToNanosite(workRoot(ctx.cwd), { ...opts, identity: loginIdentity(ctx) });
      const { lockfileChanged, ...data } = outcome;
      result(outcome.pushed ? data : { pushed: false, committed: data.committed, pulled: data.pulled, head: data.head }, () => {
        if (!outcome.pushed) {
          success("Nothing to push: up to date with nano-site");
          return;
        }
        success(`Pushed ${outcome.commits ?? ""} commit(s) to nano-site (${outcome.head?.slice(0, 7)})`.replace("  ", " "));
        if (lockfileChanged) warn(`${LOCKFILE} changed in the pulled commits: run npm ci`);
      });
    });
};

export interface PushOptions {
  message?: string;
  /** Rebase on new commits (default) instead of refusing. */
  rebase: boolean;
  /** Repair a lockfile that can't install on Linux (default) instead of refusing. */
  fixLockfile: boolean;
  /** Commit as this when git has no identity of its own (the nanodev login). */
  identity?: GitIdentity | null;
}

export interface PushOutcome {
  pushed: boolean;
  /** The commit made from uncommitted changes, if any. */
  committed: string | null;
  lockfileFixed: string | null;
  /** New commits from nano-site that local work was rebased onto. */
  pulled: number;
  /** Local HEAD after the push: what nano-site's main now is (or already was). */
  head: string | null;
  /** Commits pushed. */
  commits: number | null;
  lockfileChanged: boolean;
}

/**
 * `nanodev push` as a function (also the first step of `nanodev publish`): commit uncommitted changes,
 * rebase on new commits, check the lockfile, push HEAD to main. Prints progress, returns the outcome.
 */
export const pushToNanosite = (root: string, opts: PushOptions): PushOutcome => {
  requireMainBranch(root);
  applyGitIdentity(root, opts.identity ?? null);

  let committed: string | null = null;
  const dirty = dirtyFiles(root);
  if (dirty.length > 0) {
    assertSafeToCommit(root, dirty);
    const message = opts.message?.trim() || generateCommitMessage(dirty);
    step(`Committing ${dirty.length} file(s): ${message}`);
    for (const file of dirty.slice(0, 20)) info(c.dim(`  ${file}`));
    if (dirty.length > 20) info(c.dim(`  ... and ${dirty.length - 20} more`));
    gitOrThrow(root, ["add", "-A"], "git add");
    gitOrThrow(root, ["commit", "--quiet", "-m", message], "git commit");
    committed = revParse(root, "HEAD");
  }

  let pulled = 0;
  let lockfileChanged = false;
  let lockfileFixed: string | null = null;
  for (let attempt = 1; ; attempt++) {
    if (opts.rebase) {
      const outcome = fetchAndRebase(root);
      pulled += outcome.newCommits;
      lockfileChanged ||= outcome.lockfileChanged;
    } else {
      fetchMain(root);
      const ab = aheadBehind(root);
      if (ab && ab.behind > 0) {
        throw new CliError(`nano-site has ${ab.behind} new commit(s) you don't have: run nanodev pull, then nanodev push`);
      }
    }

    if (aheadBehind(root)?.ahead === 0) {
      return { pushed: false, committed, lockfileFixed, pulled, head: revParse(root, "HEAD"), commits: 0, lockfileChanged };
    }

    const { fixedCommit } = ensureLinuxInstallable(root, opts.fixLockfile);
    lockfileFixed ??= fixedCommit;
    const ab = aheadBehind(root);

    step(`git push ${REMOTE} HEAD:${MAIN}`);
    const res = git(root, ["push", "--porcelain", REMOTE, `HEAD:refs/heads/${MAIN}`]);
    if (res.code === 0) {
      const head = revParse(root, "HEAD");
      // Keep origin/main in step without another fetch.
      git(root, ["update-ref", `refs/remotes/${REMOTE_MAIN}`, head ?? "HEAD"]);
      return { pushed: true, committed, lockfileFixed, pulled, head, commits: ab?.ahead ?? null, lockfileChanged };
    }

    const stderr = `${res.stderr}\n${res.stdout}`;
    const remote = remoteMessages(stderr);
    if (isNonFastForwardRejection(stderr) && opts.rebase && attempt < PUSH_ATTEMPTS) {
      info(c.dim("Someone pushed in the meantime: rebasing again…"));
      continue;
    }
    const why = remote.length > 0 ? `\n${remote.map((l) => `  ${l}`).join("\n")}` : `\n${stderr.trim()}`;
    const hint = isNonFastForwardRejection(stderr) ? "\nRun nanodev pull, then nanodev push again." : "";
    throw new CliError(`push rejected by nano-site:${why}${hint}`);
  }
};
