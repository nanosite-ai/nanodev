// Pure helpers for `nanodev publish`, unit-tested without a server.
import { ApiError, DEPLOY_JOB_STATUS, type DeployJob } from "./api.mjs";

/** Stable `code`s the deploy endpoint refuses a publish with. */
export const PUBLISH_ERROR = {
  agentChangeParked: "agent_change_parked",
  projectBusy: "project_busy",
  shaNotOnMain: "sha_not_on_main",
  commitNotFound: "commit_not_found",
  invalidSha: "invalid_sha",
  shaUnsupported: "sha_unsupported",
  deployInProgress: "deploy_in_progress",
  planRequired: "plan_required",
  previewPlanRequired: "preview_plan_required",
  invalidVersion: "invalid_version",
  versionExists: "version_exists",
  versionNotHigher: "version_not_higher",
} as const;

const MESSAGES: Record<string, (sha: string, serverError: string | null) => string> = {
  [PUBLISH_ERROR.agentChangeParked]: () =>
    "nano-site refused: the project shows an agent change that conflicted with newer commits. Open the project in nano-site and ask the agent to redo it, then publish again",
  [PUBLISH_ERROR.projectBusy]: () => "nano-site is busy with another change to this project (an agent turn or a job). Try again in a moment",
  [PUBLISH_ERROR.shaNotOnMain]: (sha) =>
    `commit ${sha.slice(0, 7)} is not on nano-site's main. Run nanodev pull, then nanodev publish (it pushes first)`,
  [PUBLISH_ERROR.commitNotFound]: (sha) =>
    `nano-site doesn't have commit ${sha.slice(0, 7)}. Run nanodev publish without --no-push, or nanodev push first`,
  [PUBLISH_ERROR.invalidSha]: (sha) => `"${sha}" is not a full commit id`,
  [PUBLISH_ERROR.shaUnsupported]: () =>
    "this project can't publish a commit yet (git isn't enabled for it on nano-site). Publish from the nano-site editor",
  // The server's text names what is running (a live publish or a preview link build).
  [PUBLISH_ERROR.deployInProgress]: (_sha, serverError) =>
    serverError ??
    "another publish of this project is still running. Wait for it to finish (nanodev status), then publish again",
  [PUBLISH_ERROR.previewPlanRequired]: () =>
    "the preview link is part of a plan: choose a plan in nano-site, or publish live during the free trial (nanodev publish)",
  [PUBLISH_ERROR.planRequired]: () => "the free trial has ended: choose a plan in nano-site to publish the site live",
  [PUBLISH_ERROR.invalidVersion]: () => "--as takes a version like 1.2.3",
  [PUBLISH_ERROR.versionExists]: () => "that version is already published: pass a higher one with --as, or leave --as out to use the next patch",
  [PUBLISH_ERROR.versionNotHigher]: () =>
    "that version isn't higher than the published one: pass a higher one with --as, or leave --as out to use the next patch",
};

/** A clear message for a refused publish; null when the error is not one we know (shown as is). */
export const publishErrorMessage = (err: unknown, sha: string): string | null => {
  if (!(err instanceof ApiError)) return null;
  const body = err.body as { code?: unknown; error?: unknown } | null;
  const code = body && typeof body.code === "string" ? body.code : null;
  const serverError = body && typeof body.error === "string" && body.error ? body.error : null;
  const message = code ? MESSAGES[code] : undefined;
  return message ? message(sha, serverError) : null;
};

export const isTerminal = (job: Pick<DeployJob, "status">): boolean =>
  job.status === DEPLOY_JOB_STATUS.succeeded || job.status === DEPLOY_JOB_STATUS.failed;

/** The log lines of `job` not printed yet (logs only grow). */
export const newLogLines = (job: Pick<DeployJob, "logs">, printed: number): string[] =>
  (job.logs ?? []).slice(printed).map((l) => l.message);

/** Short sha for humans. */
export const short = (sha: string | null | undefined): string => (sha ? sha.slice(0, 7) : "?");
