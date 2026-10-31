// publish: push, then ask nano-site to publish exactly the pushed commit and follow the job.
import type { Command } from "commander";
import { API_PATHS, ApiError, DEPLOY_JOB_STATUS, type DeployJob, type DeployJobResponse } from "../lib/api.mjs";
import { authedClient, context, loginIdentity } from "../lib/context.mjs";
import { CliError } from "../lib/errors.mjs";
import { aheadBehind, dirtyFiles, fetchMain, revParse, REMOTE_MAIN } from "../lib/git.mjs";
import { c, event, info, isJsonMode, step, warn } from "../lib/output.mjs";
import { requireLinked } from "../lib/project.mjs";
import { isTerminal, newLogLines, publishErrorMessage, short } from "../lib/publish.mjs";
import { pushToNanosite, workRoot } from "./sync.mjs";

const POLL_INTERVAL_MS = 2_000;
/** `code` of the terminal `failed` event when the build failed / we stopped following it. */
const PUBLISH_BUILD_FAILED = "build_failed";
const PUBLISH_TIMEOUT = "timeout";

class PublishTimeoutError extends CliError {}
/** Overrides the job status poll interval (tests). */
const POLL_MS_ENV = "NANODEV_PUBLISH_POLL_MS";
const DEFAULT_TIMEOUT_MIN = 20;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PublishOpts {
  push: boolean;
  message?: string;
  as?: string;
  wait: boolean;
  timeout: string;
}

/** The commit to publish when not pushing: HEAD, which nano-site must already have on main. */
const headAlreadyPushed = (root: string): string => {
  fetchMain(root);
  const head = revParse(root, "HEAD");
  if (!head) throw new CliError("this folder has no commits yet: commit your work, then nanodev publish");
  const ab = aheadBehind(root);
  if (!ab || ab.ahead > 0) {
    throw new CliError(`HEAD (${short(head)}) has commits that aren't on ${REMOTE_MAIN}: run nanodev publish without --no-push`);
  }
  const dirty = dirtyFiles(root);
  if (dirty.length > 0) warn(`${dirty.length} uncommitted change(s) won't be published (--no-push publishes ${short(head)})`);
  return head;
};

export const registerPublish = (program: Command): void => {
  program
    .command("publish")
    .description("Push, then publish exactly that commit to your live site and follow the build")
    .option("--no-push", "don't push: publish HEAD, which must already be on nano-site's main")
    .option("-m, --message <text>", "commit message for uncommitted changes (as nanodev push)")
    // Not --version: that is the program's own flag.
    .option("--as <version>", "version to publish as, e.g. 2.0.0 (default: the next patch of the live version)")
    .option("--no-wait", "start the publish and exit without following the build")
    .option("--timeout <minutes>", "stop following the build after this long", String(DEFAULT_TIMEOUT_MIN))
    .addHelpText(
      "after",
      '\nExamples:\n  nanodev publish\n  nanodev publish -m "New hero section"\n  nanodev publish --no-push --as 2.0.0\n  nanodev publish --json',
    )
    .action(async (opts: PublishOpts, cmd: Command) => {
      const state: PublishState = { sha: null, jobId: null };
      try {
        await publish(opts, cmd, state);
      } catch (err) {
        // --json: every run ends with one terminal event, so an agent can tell a refusal, a timeout
        // and a failed build apart without parsing stderr.
        if (isJsonMode() && !state.terminal) {
          const code = err instanceof ApiError ? apiErrorBodyCode(err) : err instanceof PublishTimeoutError ? PUBLISH_TIMEOUT : null;
          process.stdout.write(
            `${JSON.stringify({ event: "failed", jobId: state.jobId, sha: state.sha, code, error: err instanceof Error ? err.message : String(err) })}\n`,
          );
        }
        throw err;
      }
    });
};

interface PublishState {
  sha: string | null;
  jobId: string | null;
  /** A terminal event (published / failed) was already emitted. */
  terminal?: boolean;
}

/** `code` of a refused publish's body, if any. */
const apiErrorBodyCode = (err: ApiError): string | null => {
  const body = err.body as { code?: unknown } | null;
  return body && typeof body.code === "string" ? body.code : null;
};

const publish = async (opts: PublishOpts, cmd: Command, state: PublishState): Promise<void> => {
  const ctx = context(cmd);
  const linked = requireLinked(ctx.cwd);
  const { projectId } = linked.project;
  const root = workRoot(ctx.cwd);
  const client = authedClient(ctx);

  let sha: string;
  if (opts.push) {
    const pushed = pushToNanosite(root, { message: opts.message, rebase: true, fixLockfile: true, identity: loginIdentity(ctx) });
    if (!pushed.head) throw new CliError("nothing to publish: this folder has no commits");
    sha = pushed.head;
    state.sha = sha;
    event(
      { event: "pushed", pushed: pushed.pushed, commits: pushed.commits, pulled: pushed.pulled, sha },
      pushed.pushed ? `${c.ok("✔")} Pushed ${pushed.commits ?? ""} commit(s) (${short(sha)})`.replace("  ", " ") : `${c.ok("✔")} Up to date with nano-site (${short(sha)})`,
    );
  } else {
    sha = headAlreadyPushed(root);
    state.sha = sha;
  }

  step(`Publishing ${short(sha)} to ${linked.project.name}`);
  let job: DeployJob;
  try {
    const res = await client.post<DeployJobResponse>(API_PATHS.deploy(projectId), {
      mode: "production",
      sha,
      ...(opts.as ? { version: opts.as } : {}),
      // Safe to repeat: for the same commit nano-site answers with the publish already running.
    }, { retry: true });
    if (!res?.job) throw new CliError(`nano-site didn't start the publish${res?.error ? `: ${res.error}` : ""}`);
    job = res.job;
  } catch (err) {
    const clear = publishErrorMessage(err, sha);
    if (clear && err instanceof ApiError) throw new ApiError(clear, err.status, err.body);
    throw err;
  }
  if (job.sha && job.sha !== sha) {
    // The server can only add sandbox files on top for web publishes; the CLI asks for the exact one.
    warn(`nano-site is publishing ${short(job.sha)}, not ${short(sha)}`);
  }
  state.jobId = job.id;
  event({ event: "queued", jobId: job.id, sha: job.sha ?? sha }, `${c.dim("·")} Publish queued (job ${job.id})`);
  if (!opts.wait) return;

  const pollMs = Math.max(50, Number(process.env[POLL_MS_ENV]) || POLL_INTERVAL_MS);
  const deadline = Date.now() + Math.max(1, Number(opts.timeout) || DEFAULT_TIMEOUT_MIN) * 60_000;
  let printed = 0;
  let lastStatus = job.status;
  for (;;) {
    for (const line of newLogLines(job, printed)) event({ event: "log", message: line }, c.dim(`  ${line}`));
    printed = job.logs?.length ?? printed;
    if (job.status !== lastStatus) {
      lastStatus = job.status;
      if (job.status === DEPLOY_JOB_STATUS.running) event({ event: "status", status: job.status }, `${c.cyan("▶")} Building…`);
    }
    if (isTerminal(job)) break;
    if (Date.now() > deadline) {
      throw new PublishTimeoutError(
        `stopped following the publish after ${opts.timeout} min; it is still running on nano-site (job ${job.id}). Open the project in nano-site to see when it is live`,
      );
    }
    await sleep(pollMs);
    const res = await client.get<DeployJobResponse>(API_PATHS.deployJob(projectId, job.id));
    if (!res?.job) throw new CliError(`lost track of publish job ${job.id}`);
    job = res.job;
  }

  if (job.status === DEPLOY_JOB_STATUS.failed) {
    state.terminal = true;
    event({ event: "failed", jobId: job.id, sha, code: PUBLISH_BUILD_FAILED, error: job.error ?? null }, `${c.err("✖")} Publish failed`);
    throw new CliError(`publish failed: ${job.error ?? "unknown error"}`);
  }
  const built = job.result?.commitSha ?? job.sha ?? sha;
  event(
    { event: "published", jobId: job.id, sha: built, version: job.result?.version ?? null, url: job.result?.url ?? null },
    `${c.ok("✔")} Published ${short(built)}${job.result?.version ? ` as ${job.result.version}` : ""}`,
  );
  if (job.result?.url) info(`live    ${job.result.url}`);
};
