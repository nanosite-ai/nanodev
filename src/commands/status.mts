// status: where this folder stands against nano-site; doctor: is everything nanodev needs in place.
import type { Command } from "commander";
import { ApiClient, API_PATHS, ApiError, type DevConfig, type MeResponse } from "../lib/api.mjs";
import { context, contextToken, type Context } from "../lib/context.mjs";
import { CliError } from "../lib/errors.mjs";
import { aheadBehind, currentBranch, dirtyFiles, fetchMain, gitVersion, repoRoot, requireGit, revParse } from "../lib/git.mjs";
import { isGitHelperConfigured } from "../lib/gitCredential.mjs";
import { PLUGIN_CHECK, checkPluginOffer } from "../lib/localPlugin.mjs";
import { c, info, result, warn } from "../lib/output.mjs";
import { describeSync, syncState } from "../lib/sync.mjs";
import type { PreviewStatusResponse } from "../lib/preview.mjs";
import { fetchPreviewStatus } from "./preview.mjs";

const MIN_NODE = [22, 12] as const;
const MIN_GIT = [2, 30] as const;

/** "2.45.1" ≥ [2, 30]? */
export const versionAtLeast = (version: string, min: readonly [number, number]): boolean => {
  const [major, minor] = version.split(".").map(Number);
  return major > min[0] || (major === min[0] && minor >= min[1]);
};

const tryDevConfig = async (ctx: Context, projectId: string): Promise<DevConfig | null> => {
  const resolved = contextToken(ctx);
  if (!resolved) return null;
  try {
    return await new ApiClient({ origin: ctx.apiOrigin, token: resolved.token }).get<DevConfig>(API_PATHS.devConfig(projectId));
  } catch (err) {
    warn(`couldn't load the project's URLs: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
};

/** Your private preview (from `nanodev preview`), or null when there is none or it can't be read. */
const tryPreview = async (ctx: Context, projectId: string): Promise<PreviewStatusResponse | null> => {
  const resolved = contextToken(ctx);
  if (!resolved) return null;
  try {
    return await fetchPreviewStatus(new ApiClient({ origin: ctx.apiOrigin, token: resolved.token }), projectId);
  } catch {
    return null;
  }
};

export const CHECK_STATUS = { ok: "ok", warn: "warn", fail: "fail" } as const;
type CheckStatus = (typeof CHECK_STATUS)[keyof typeof CHECK_STATUS];
interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export const registerStatus = (program: Command): void => {
  program
    .command("status")
    .description("Show local vs nano-site: commits to push or pull, uncommitted files, head, preview/live URLs")
    .option("--offline", "don't fetch or call the API (use what git already knows)")
    .addHelpText("after", "\nExamples:\n  nanodev status\n  nanodev status --offline\n  nanodev status --json")
    .action(async (opts: { offline?: boolean }, cmd: Command) => {
      requireGit();
      const ctx = context(cmd);
      const root = repoRoot(ctx.cwd);
      if (!root) throw new CliError("not inside a git repository: cd into a linked project (nanodev link)");
      if (!opts.offline) {
        try {
          fetchMain(root);
        } catch (err) {
          warn(`couldn't fetch, showing the last known state: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
        }
      }
      const ab = aheadBehind(root);
      const dirty = dirtyFiles(root);
      const config = !opts.offline && ctx.linked ? await tryDevConfig(ctx, ctx.linked.project.projectId) : null;
      const preview = config && ctx.linked ? await tryPreview(ctx, ctx.linked.project.projectId) : null;
      const data = {
        project: ctx.linked?.project ?? null,
        root,
        branch: currentBranch(root),
        head: revParse(root, "HEAD"),
        originMain: revParse(root, "origin/main"),
        ahead: ab?.ahead ?? null,
        behind: ab?.behind ?? null,
        state: syncState(ab),
        dirty,
        previewUrl: preview?.url ?? null,
        preview: preview ? { status: preview.status, sha: preview.sha, url: preview.url } : null,
        liveUrl: config?.liveUrl ?? null,
      };
      result(data, () => {
        if (data.project) info(`${c.bold(data.project.name)} ${c.dim(`(${data.project.type}, ${data.project.projectId})`)}`);
        else warn("this folder isn't linked to a nano-site project (nanodev link)");
        info(`head    ${data.head?.slice(0, 7) ?? "(no commits)"} on ${data.branch ?? "(detached)"}`);
        info(`sync    ${describeSync(ab)}`);
        info(`changes ${dirty.length === 0 ? "none" : `${dirty.length} uncommitted: ${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", …" : ""}`}`);
        if (preview?.url) info(`preview ${preview.url} ${c.dim(`(${preview.status}, ${preview.sha.slice(0, 7)})`)}`);
        if (data.liveUrl) info(`live    ${data.liveUrl}`);
      });
    });

  program
    .command("doctor")
    .description("Check git, Node, network, login and the linked project")
    .addHelpText("after", "\nExamples:\n  nanodev doctor\n  nanodev doctor --json")
    .action(async (_opts: unknown, cmd: Command) => {
      const ctx = context(cmd);
      const checks: Check[] = [];
      const add = (name: string, status: CheckStatus, detail: string) => checks.push({ name, status, detail });

      const gv = gitVersion();
      if (!gv) add("git", CHECK_STATUS.fail, "git not found on PATH: install it from https://git-scm.com");
      else if (versionAtLeast(gv, MIN_GIT)) add("git", CHECK_STATUS.ok, gv);
      else add("git", CHECK_STATUS.warn, `${gv} (update to ${MIN_GIT.join(".")}+)`);

      const nodeOk = versionAtLeast(process.versions.node, MIN_NODE);
      add("node", nodeOk ? CHECK_STATUS.ok : CHECK_STATUS.fail, `${process.versions.node}${nodeOk ? "" : ` (needs ${MIN_NODE.join(".")}+)`}`);

      const resolved = contextToken(ctx);
      const anon = new ApiClient({ origin: ctx.apiOrigin, token: resolved?.token });
      let reachable = true;
      try {
        const me = await anon.get<MeResponse>(API_PATHS.me);
        add("api", CHECK_STATUS.ok, ctx.apiOrigin);
        add("auth", CHECK_STATUS.ok, `${me.user.email}${resolved?.source === "env" ? " (NANODEV_TOKEN)" : ""}`);
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          add("api", CHECK_STATUS.ok, ctx.apiOrigin);
          const why = err.status === 403 ? "token lacks the projects:read scope" : "token rejected";
          add("auth", CHECK_STATUS.fail, resolved ? `${why}: run nanodev login` : "not logged in: run nanodev login");
        } else if (err instanceof ApiError) {
          add("api", CHECK_STATUS.warn, `${ctx.apiOrigin} answered ${err.status} for ${API_PATHS.me}: is this a nano-site API with nanodev support?`);
          add("auth", CHECK_STATUS.warn, "couldn't verify the token");
        } else {
          reachable = false;
          add("api", CHECK_STATUS.fail, err instanceof Error ? err.message : String(err));
          add("auth", CHECK_STATUS.warn, "skipped (API unreachable)");
        }
      }

      if (gv && resolved?.source === "file") {
        add("git-helper", isGitHelperConfigured(ctx.apiOrigin) ? CHECK_STATUS.ok : CHECK_STATUS.warn, isGitHelperConfigured(ctx.apiOrigin) ? `credential helper set for ${ctx.apiOrigin}` : "not configured: run nanodev login again");
      }

      if (ctx.linked) {
        const config = reachable && resolved ? await tryDevConfig(ctx, ctx.linked.project.projectId) : null;
        add("project", config || !reachable ? CHECK_STATUS.ok : CHECK_STATUS.warn, `${ctx.linked.project.name} (${ctx.linked.project.projectId}) in ${ctx.linked.root}`);
        const plugin = checkPluginOffer(ctx.linked.root);
        add("plugin", plugin.status === PLUGIN_CHECK.ok ? CHECK_STATUS.ok : CHECK_STATUS.warn, plugin.detail);
      } else add("project", CHECK_STATUS.warn, "this folder isn't linked (nanodev link)");

      const failed = checks.some((ch) => ch.status === CHECK_STATUS.fail);
      result({ ok: !failed, checks }, () => {
        const mark = { ok: c.ok("✔"), warn: c.warn("!"), fail: c.err("✖") };
        for (const ch of checks) info(`${mark[ch.status]} ${ch.name.padEnd(10)} ${ch.detail}`);
      });
      if (failed) process.exitCode = 1;
    });
};
