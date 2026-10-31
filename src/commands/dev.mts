// dev: run the project locally (store: store-runtime SSR dev server; website: vite) and tell the user
// when nano-site has new commits. It never changes files on its own.
import { existsSync } from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Command } from "commander";
import { API_PATHS, ApiError, PROJECT_TYPE, type ApiClient, type DevConfig, type RepoHead } from "../lib/api.mjs";
import { ENV } from "../lib/config.mjs";
import { authedClient, context, type Context } from "../lib/context.mjs";
import { openUrl } from "../lib/browser.mjs";
import { CliError } from "../lib/errors.mjs";
import { REMOTE_MAIN, fetchMain, hasCommit, isAncestor, git, revParse } from "../lib/git.mjs";
import { debug, event, isJsonMode, warn } from "../lib/output.mjs";
import { isPortOpen, waitForPort } from "../lib/port.mjs";
import { IS_WIN, startChild } from "../lib/proc.mjs";
import { requireLinked } from "../lib/project.mjs";
import { REMOTE_HEAD_ACTION, remoteHeadAction } from "../lib/sync.mjs";

export const DEFAULT_DEV_PORT = 5173;
export const REPO_HEAD_POLL_MS = 10_000;
/** How long `dev` waits for the dev server to answer before warning. */
const READY_TIMEOUT_MS = 60_000;
/** Poll interval: 10s, overridable for tests only. */
const pollMs = (): number => Number(process.env[ENV.repoHeadPollMs]) || REPO_HEAD_POLL_MS;
const STORE_RUNTIME_BIN = "store-runtime";
const VITE_BIN = "vite";

export interface DevCommand {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** A node_modules/.bin entry (the .cmd shim on Windows). */
export const localBin = (root: string, name: string): string => path.join(root, "node_modules", ".bin", IS_WIN ? `${name}.cmd` : name);

/** What to start for this project. Pure (no spawning) so it is unit-testable. */
export const devCommand = (input: {
  root: string;
  config: DevConfig;
  port: number;
  env: NodeJS.ProcessEnv;
  storeRuntimeOverride?: string;
}): DevCommand => {
  const { root, config, port, env, storeRuntimeOverride } = input;
  if (config.type === PROJECT_TYPE.store) {
    const childEnv = { ...env, PORT: String(port), PK: config.publishableKey ?? "", ECOMMERCE_API_URL: config.ecommerceApiUrl ?? "" };
    if (storeRuntimeOverride) {
      // A .js/.mjs override runs with this node; anything else is executed directly.
      return /\.(c|m)?js$/.test(storeRuntimeOverride)
        ? { cmd: process.execPath, args: [storeRuntimeOverride, "dev"], env: childEnv }
        : { cmd: storeRuntimeOverride, args: ["dev"], env: childEnv };
    }
    return { cmd: localBin(root, STORE_RUNTIME_BIN), args: ["dev"], env: childEnv };
  }
  return { cmd: localBin(root, VITE_BIN), args: ["--port", String(port), "--strictPort"], env: { ...env } };
};

/** Poll repo-head and report new commits once per remote head. Returns a stop function. */
const watchRepoHead = (client: ApiClient, projectId: string, root: string): (() => void) => {
  let lastNotified: string | null = null;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async () => {
    try {
      const { headSha } = await client.get<RepoHead>(API_PATHS.repoHead(projectId));
      const localOriginMain = revParse(root, REMOTE_MAIN);
      const containedInHead = Boolean(headSha) && hasCommit(root, headSha!) && isAncestor(root, headSha!, "HEAD");
      const action = remoteHeadAction({ remoteHead: headSha, localOriginMain, containedInHead, lastNotified });
      if (action === REMOTE_HEAD_ACTION.none) return;
      // Refs only (origin/main): the working tree is never touched.
      if (action === REMOTE_HEAD_ACTION.fetch) fetchMain(root);
      const count = git(root, ["rev-list", "--count", `HEAD..${REMOTE_MAIN}`]);
      const behind = count.code === 0 ? Number(count.stdout.trim()) : 0;
      lastNotified = headSha;
      if (behind > 0) {
        event({ event: "behind", behind, headSha }, `\n↓ ${behind} new commit${behind === 1 ? "" : "s"} on nano-site, run nanodev pull\n`);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        warn("this server doesn't report repo-head yet: new-commit notices are off");
        stopped = true;
        return;
      }
      debug(`repo-head poll failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (!stopped) timer = setTimeout(tick, pollMs());
    }
  };
  timer = setTimeout(tick, pollMs());
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
};

const waitForExit = (child: ChildProcess): Promise<number> =>
  new Promise((resolve) => {
    child.on("error", (err) => {
      warn(err.message);
      resolve(127);
    });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 130 : 1)));
  });

export const registerDev = (program: Command): void => {
  program
    .command("dev")
    .description("Run the linked project locally (stores: SSR dev server with live store data; websites: vite)")
    .option("-p, --port <port>", "local port", String(DEFAULT_DEV_PORT))
    .option("--no-watch", "don't check nano-site for new commits")
    .option("--open", "open the running project in the browser once it answers")
    .addHelpText("after", "\nExamples:\n  nanodev dev\n  nanodev dev --port 3000 --open\n  nanodev dev --json   # NDJSON events: ready, behind, exit")
    .action(async (opts: { port: string; watch: boolean; open?: boolean }, cmd: Command) => {
      await runDev(context(cmd), opts);
    });
};

/** Run the linked project in `ctx.cwd` until the dev server exits. `nanodev create` ends with it. */
export const runDev = async (ctx: Context, opts: { port: string; watch: boolean; open?: boolean }): Promise<void> => {
  const { root, project } = requireLinked(ctx.cwd);
  const port = Number(opts.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CliError(`invalid --port "${opts.port}"`);

  const client = authedClient(ctx);
  const config = await client.get<DevConfig>(API_PATHS.devConfig(project.projectId));
  if (config.type === PROJECT_TYPE.store && (!config.publishableKey || !config.ecommerceApiUrl)) {
    throw new CliError("this store has no commerce backend yet (no publishable key): open it once at nanosite.ai, then retry");
  }
  const run = devCommand({ root, config, port, env: process.env, storeRuntimeOverride: process.env[ENV.storeRuntimeBin] });
  const isOverride = config.type === PROJECT_TYPE.store && Boolean(process.env[ENV.storeRuntimeBin]);
  if (!isOverride && !existsSync(run.cmd)) {
    throw new CliError(`${path.basename(run.cmd)} isn't installed in this project: run npm ci (or nanodev pull)`);
  }

  // Something else on the port would answer our readiness probe: refuse up front.
  if (await isPortOpen(port)) throw new CliError(`port ${port} is already in use: stop that server or pass --port <other>`);

  const child = startChild(run.cmd, run.args, { cwd: root, env: run.env, stdoutToStderr: isJsonMode() });
  let exited = false;
  const exit = waitForExit(child).then((code) => {
    exited = true;
    return code;
  });
  const url = new URL(`http://localhost:${port}/`).href;
  // "ready" only once the dev server answers on the port (vite runs with --strictPort, store-runtime
  // binds PORT), so the URL we print is the one that works.
  if (await waitForPort(port, { timeoutMs: READY_TIMEOUT_MS, stop: () => exited })) {
    event({ event: "ready", url, type: config.type, projectId: project.projectId }, `\n  ${config.name} running at ${url}\n`);
    if (opts.open && !(await openUrl(url))) warn("couldn't open a browser: open the URL above yourself");
  } else if (!exited) {
    warn(`the dev server hasn't answered on port ${port} after ${READY_TIMEOUT_MS / 1000}s; still waiting`);
  }

  const stopWatch = opts.watch ? watchRepoHead(client, project.projectId, root) : () => {};
  const forward = (signal: NodeJS.Signals) => () => {
    if (!child.killed) child.kill(signal);
  };
  const onInt = forward("SIGINT");
  const onTerm = forward("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  const code = await exit;
  stopWatch();
  process.off("SIGINT", onInt);
  process.off("SIGTERM", onTerm);
  event({ event: "exit", code }, code === 0 ? "dev server stopped" : `dev server exited with code ${code}`);
  if (code !== 0) process.exitCode = code;
};
