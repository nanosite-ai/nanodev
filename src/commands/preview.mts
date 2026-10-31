// preview: build this folder's current state as a private cloud preview, without touching main.
import { setTimeout as sleep } from "node:timers/promises";
import type { Command } from "commander";
import { API_PATHS, ApiError, type ApiClient, type MeResponse } from "../lib/api.mjs";
import { openUrl } from "../lib/browser.mjs";
import { authedClient, context } from "../lib/context.mjs";
import { CliError } from "../lib/errors.mjs";
import { REMOTE, dirtyFiles, git } from "../lib/git.mjs";
import { c, event, info, isJsonMode, warn } from "../lib/output.mjs";
import {
  PREVIEW_STATUS,
  decide,
  isTransientError,
  logTail,
  previewRef,
  snapshotWorkingTree,
  type PreviewStatusResponse,
} from "../lib/preview.mjs";
import { remoteMessages } from "../lib/sync.mjs";
import { assertSafeToCommit, ensureLinuxInstallable, workRoot } from "./sync.mjs";

const DEFAULT_TIMEOUT_SEC = 15 * 60;
const DEFAULT_POLL_MS = 2_000;
/** NANODEV_PREVIEW_POLL_MS: tests poll faster. */
const pollMs = (): number => Number(process.env.NANODEV_PREVIEW_POLL_MS) || DEFAULT_POLL_MS;

/** The preview status, or null while the server has nothing for us yet (404). */
export const fetchPreviewStatus = async (api: ApiClient, projectId: string): Promise<PreviewStatusResponse | null> => {
  try {
    return await api.get<PreviewStatusResponse>(API_PATHS.preview(projectId));
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
};

const short = (sha: string): string => sha.slice(0, 7);
const firstLine = (err: unknown): string => (err instanceof Error ? err.message.split("\n")[0]! : String(err));

interface PreviewOpts {
  wait: boolean;
  open?: boolean;
  timeout: string;
}

export const registerPreview = (program: Command): void => {
  program
    .command("preview")
    .description(
      "Build this folder's current state (commits + uncommitted changes) as a private cloud preview. Never changes main, your branch or your files",
    )
    .option("--open", "open the preview in the browser when it's ready")
    .option("--no-wait", "push and return without waiting for the build")
    .option("--timeout <seconds>", "how long to wait for the build", String(DEFAULT_TIMEOUT_SEC))
    .addHelpText(
      "after",
      "\nExamples:\n  nanodev preview\n  nanodev preview --open\n  nanodev preview --no-wait --json\n\nOnly people who can open the project in nano-site can view it; it expires after 7 days without a new preview.",
    )
    .action(async (opts: PreviewOpts, cmd: Command) => {
      const ctx = context(cmd);
      if (!ctx.linked) throw new CliError("this folder isn't linked to a nano-site project: run nanodev link");
      const projectId = ctx.linked.project.projectId;
      const root = workRoot(ctx.cwd);
      const timeoutSec = Number(opts.timeout);
      if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw new CliError(`--timeout must be a positive number of seconds (got ${opts.timeout})`);

      const api = authedClient(ctx);
      const { user } = await api.get<MeResponse>(API_PATHS.me);

      // Same guards as push: nothing that must never leave this machine, a lockfile Linux can install.
      const dirty = dirtyFiles(root);
      if (dirty.length > 0) assertSafeToCommit(root, dirty);
      ensureLinuxInstallable(root, false);

      const snap = snapshotWorkingTree(root);
      event(
        { event: "snapshot", sha: snap.sha, temporary: snap.temporary, uncommitted: dirty.length },
        snap.temporary
          ? `${c.cyan("▶")} Snapshot of ${dirty.length} uncommitted change(s) on top of HEAD: ${short(snap.sha)} (your branch and files are untouched)`
          : `${c.cyan("▶")} Previewing HEAD ${short(snap.sha)}`,
      );

      // What the server has now: pushing a sha it already has runs no hook (so no new build).
      const prior = await fetchPreviewStatus(api, projectId).catch(() => null);

      const ref = previewRef(user.id);
      const res = git(root, ["push", "--force", "--porcelain", REMOTE, `${snap.sha}:${ref}`]);
      const remote = remoteMessages(`${res.stderr}\n${res.stdout}`);
      if (res.code !== 0) {
        const why = remote.length > 0 ? remote.map((l) => `  ${l}`).join("\n") : (res.stderr || res.stdout).trim();
        throw new CliError(`preview push rejected by nano-site:\n${why}`);
      }
      event({ event: "pushed", ref, sha: snap.sha, messages: remote }, `${c.ok("✔")} Pushed ${short(snap.sha)} to ${ref}`);
      // The server's own lines (e.g. "the build could not be queued").
      if (!isJsonMode()) for (const line of remote) info(c.dim(`  ${line}`));

      // Same commit as a failed build (a transient failure, or a plain retry): ask for a fresh build.
      if (prior?.sha === snap.sha && prior.status === PREVIEW_STATUS.failed) {
        await api.post<PreviewStatusResponse>(API_PATHS.previewRebuild(projectId), {});
        event({ event: "rebuild", sha: snap.sha }, `${c.cyan("▶")} Same commit as the failed build: building it again`);
      }

      if (!opts.wait) {
        const status = await fetchPreviewStatus(api, projectId).catch(() => null);
        event({ event: "queued", sha: snap.sha, url: status?.url ?? null }, `${c.ok("✔")} Build queued: ${status?.url ?? "the preview URL"} shows it once it is built`);
        return;
      }

      const deadline = Date.now() + timeoutSec * 1000;
      let announced = false;
      let warnedTransient = false;
      for (;;) {
        let status: PreviewStatusResponse | null;
        try {
          status = await fetchPreviewStatus(api, projectId);
        } catch (err) {
          // A network blip or a restarting server must not abort a long wait: retry until the deadline.
          if (!isTransientError(err) || Date.now() > deadline) throw err;
          if (!warnedTransient) warn(`couldn't check the build (${firstLine(err)}); retrying…`);
          warnedTransient = true;
          await sleep(pollMs());
          continue;
        }
        const decision = decide(status, snap.sha);
        if (decision === "ready" && status) {
          const url = status.url;
          event(
            { event: "ready", sha: snap.sha, url, builtAt: status.builtAt, durationMs: status.durationMs ?? null },
            `${c.ok("✔")} Preview ready (${short(snap.sha)}${status.durationMs ? `, built in ${Math.round(status.durationMs / 1000)}s` : ""}):\n  ${c.bold(url ?? "(no URL for this account)")}\n${c.dim("  Private: you need to be signed in to nano-site with access to the project. Expires after 7 days without a new preview.")}`,
          );
          if (opts.open && url && !(await openUrl(url))) warn(`couldn't open a browser: open ${url}`);
          return;
        }
        if (decision === "failed" && status) {
          const tail = logTail(status.log);
          if (isJsonMode()) event({ event: "failed", sha: snap.sha, error: status.error ?? "build failed", log: tail }, "");
          throw new CliError(`the preview build failed: ${status.error ?? "build failed"}${tail ? `\n\n${tail}` : ""}\n\nFix it and run nanodev preview again.`);
        }
        if (!announced) {
          announced = true;
          event({ event: "building", sha: snap.sha, url: status?.url ?? null }, `${c.cyan("▶")} Building in the cloud…`);
        }
        if (Date.now() > deadline) {
          throw new CliError(`the preview is still building after ${timeoutSec}s: run nanodev preview --no-wait later, or open ${status?.url ?? "the preview URL"}`);
        }
        await sleep(pollMs());
      }
    });
};
