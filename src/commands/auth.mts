// login / logout / whoami, and the git credential helper git calls back into.
import os from "node:os";
import type { Command } from "commander";
import { ApiClient, ApiError, API_PATHS, type DeviceCodeResponse, type MeResponse } from "../lib/api.mjs";
import { openUrl, safeBrowserUrl } from "../lib/browser.mjs";
import { authedClient, context, contextToken, type Context } from "../lib/context.mjs";
import { credentialForGitOrigin, readCredentials, removeCredential, saveCredential } from "../lib/credentials.mjs";
import { pollForToken } from "../lib/deviceFlow.mjs";
import { CliError } from "../lib/errors.mjs";
import { configureGitHelper, formatCredentialResponse, parseCredentialRequest, removeGitHelper, requestOrigin } from "../lib/gitCredential.mjs";
import { c, debug, info, result, success, warn } from "../lib/output.mjs";
import { ENV, normalizeOrigin } from "../lib/config.mjs";
import { repoRoot, unsetLoginIdentity } from "../lib/git.mjs";

const TOKEN_PREFIX = "ndv_";

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

/** Best effort: the token revokes itself (`POST /api/cli/token/revoke`). False when that failed. */
const revokeOnServer = async (apiOrigin: string, token: string): Promise<boolean> => {
  try {
    await new ApiClient({ origin: apiOrigin, token }).post(API_PATHS.revokeToken, {});
    return true;
  } catch (err) {
    // 401: already revoked or expired, so there is nothing left to revoke.
    if (err instanceof ApiError && err.status === 401) return true;
    debug(`token revoke failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
};

const finishLogin = (apiOrigin: string, token: string, email: string, gitHelper: boolean): { gitHelper: boolean } => {
  saveCredential(apiOrigin, { token, email });
  if (!gitHelper) return { gitHelper: false };
  try {
    configureGitHelper(apiOrigin);
    return { gitHelper: true };
  } catch (err) {
    warn(`${err instanceof Error ? err.message : String(err)} (git fetch/push will ask for a password; use your token)`);
    return { gitHelper: false };
  }
};

/**
 * The browser device login: show the code, open the approval page, wait for the approval, save the
 * token and (optionally) set git up for the host. `nanodev create` runs it when there is no login yet.
 */
export const deviceLogin = async (ctx: Context, opts: { browser: boolean; gitHelper: boolean }): Promise<{ email: string; gitHelper: boolean }> => {
  const client = new ApiClient({ origin: ctx.apiOrigin });
  const device = await client.post<DeviceCodeResponse>(API_PATHS.deviceCode, { deviceName: `nanodev on ${os.hostname()}` });
  info(`Your code: ${c.bold(device.userCode)}`);
  const approveUrl = safeBrowserUrl(device.verificationUrl);
  info(`Approve it at ${c.cyan(approveUrl)}`);
  if (opts.browser && !(await openUrl(approveUrl))) warn("couldn't open a browser: open the URL above yourself");
  info(c.dim("Waiting for approval…"));
  const granted = await pollForToken(client, device);
  const { gitHelper } = finishLogin(ctx.apiOrigin, granted.token, granted.user.email, opts.gitHelper);
  return { email: granted.user.email, gitHelper };
};

export const registerAuth = (program: Command): void => {
  program
    .command("login")
    .description("Log in through your browser (device code), save the token and set up git for nano-site")
    .option("--with-token", "read a token (ndv_…) from stdin instead of opening the browser")
    .option("--no-browser", "print the approval URL instead of opening a browser")
    .option("--no-git-helper", "don't configure git's credential helper for the API host")
    .addHelpText(
      "after",
      "\nExamples:\n  nanodev login\n  nanodev login --no-browser\n  echo $NANODEV_TOKEN | nanodev login --with-token\n  nanodev login --api http://localhost:3000",
    )
    .action(async (opts: { withToken?: boolean; browser: boolean; gitHelper: boolean }, cmd: Command) => {
      const ctx = context(cmd);
      if (opts.withToken) {
        const token = (await readStdin()).trim();
        if (!token.startsWith(TOKEN_PREFIX)) throw new CliError(`expected a token starting with ${TOKEN_PREFIX} on stdin`);
        const me = await new ApiClient({ origin: ctx.apiOrigin, token }).get<MeResponse>(API_PATHS.me);
        const { gitHelper } = finishLogin(ctx.apiOrigin, token, me.user.email, opts.gitHelper);
        result({ api: ctx.apiOrigin, email: me.user.email, gitHelper }, () => success(`Logged in to ${ctx.apiOrigin} as ${me.user.email}`));
        return;
      }

      const { email, gitHelper } = await deviceLogin(ctx, opts);
      result({ api: ctx.apiOrigin, email, gitHelper }, () => {
        success(`Logged in to ${ctx.apiOrigin} as ${email}`);
        if (gitHelper) info(c.dim(`git is set up to use this login for ${ctx.apiOrigin}`));
      });
    });

  program
    .command("logout")
    .description("Revoke the saved token on the server, forget it and remove its git credential helper")
    .addHelpText("after", "\nExamples:\n  nanodev logout\n  nanodev logout --api http://localhost:3000 --json")
    .action(async (_opts: unknown, cmd: Command) => {
      const ctx = context(cmd);
      const saved = readCredentials()[ctx.apiOrigin];
      const revoked = saved ? await revokeOnServer(ctx.apiOrigin, saved.token) : false;
      const gitOrigins = saved?.gitOrigins ?? [];
      const removed = removeCredential(ctx.apiOrigin);
      for (const origin of [ctx.apiOrigin, ...gitOrigins]) removeGitHelper(origin);
      // Inside a project folder: drop the git identity nanodev set from this login too.
      const root = repoRoot(ctx.cwd);
      const identityRemoved = root ? unsetLoginIdentity(root) : false;
      result({ api: ctx.apiOrigin, removed, revoked, identityRemoved }, () => {
        if (identityRemoved) info("Removed the git identity nanodev set for this folder");
        if (!removed) {
          info(`Not logged in to ${ctx.apiOrigin}`);
          return;
        }
        success(`Logged out of ${ctx.apiOrigin}.`);
        if (!revoked) warn("couldn't revoke the token on the server: remove it in your nanosite.ai account settings.");
      });
    });

  program
    .command("whoami")
    .description("Show the account the saved token belongs to")
    .addHelpText("after", "\nExamples:\n  nanodev whoami\n  nanodev whoami --json")
    .action(async (_opts: unknown, cmd: Command) => {
      const ctx = context(cmd);
      const me = await authedClient(ctx).get<MeResponse>(API_PATHS.me);
      const source = contextToken(ctx)?.source;
      result({ api: ctx.apiOrigin, user: me.user, tokenSource: source }, () =>
        info(`${me.user.email}${me.user.name ? ` (${me.user.name})` : ""} on ${ctx.apiOrigin}${source === "env" ? c.dim(` [${ENV.token}]`) : ""}`),
      );
    });

  program
    .command("git-credential")
    .description("git credential helper (git runs this; you don't need to)")
    .argument("<operation>", "get | store | erase")
    .addHelpText("after", "\nExamples:\n  printf 'protocol=https\\nhost=api.nanosite.ai\\n\\n' | nanodev git-credential get")
    .action(async (operation: string) => {
      // store / erase: nothing to do, the token lives in credentials.json.
      if (operation !== "get") return;
      const origin = requestOrigin(parseCredentialRequest(await readStdin()));
      if (!origin) return;
      // NANODEV_TOKEN only for the host NANODEV_API names; otherwise the saved login for this host.
      const envToken = process.env[ENV.token];
      const envApi = process.env[ENV.api];
      const envOrigin = envApi ? normalizeOrigin(envApi) : null;
      const token = (envToken && envOrigin === origin ? envToken : null) ?? credentialForGitOrigin(origin, readCredentials())?.token;
      // Print nothing when we have no token: git then falls through to its normal behaviour.
      if (token) process.stdout.write(formatCredentialResponse(token));
    });
};
