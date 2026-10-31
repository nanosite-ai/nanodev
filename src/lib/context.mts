// What every command needs: the global flags, the working folder, the API origin and a client.
import path from "node:path";
import type { Command } from "commander";
import { ApiClient } from "./api.mjs";
import { ENV, normalizeOrigin, readUserConfig, resolveApiOrigin } from "./config.mjs";
import { readCredentials, tokenFor } from "./credentials.mjs";
import { CliError } from "./errors.mjs";
import { identityFromEmail, type GitIdentity } from "./git.mjs";
import { warn } from "./output.mjs";
import { readLinked, type Linked } from "./project.mjs";

export interface GlobalOpts {
  json?: boolean;
  verbose?: boolean;
  api?: string;
  cwd?: string;
}

export const globals = (cmd: Command): GlobalOpts => cmd.optsWithGlobals<GlobalOpts>();

export interface Context {
  cwd: string;
  /** The API origin. Throws (lazily, so offline git commands still work) when it can't be trusted. */
  readonly apiOrigin: string;
  /** The origin the user named explicitly (--api / NANODEV_API): the only one NANODEV_TOKEN is sent to. */
  explicitOrigin: string | null;
  linked: Linked | null;
}

/**
 * `--api` > NANODEV_API > ~/.nanodev/config.json > default. A linked folder's `.nanodev/project.json`
 * `api` is only honoured when nothing explicit was given AND the user already logged in to exactly that
 * origin: the file lives in a folder that may come from someone else, so it must never redirect requests
 * (or tokens) to a host the user didn't choose.
 */
export const chooseApiOrigin = (input: {
  explicitOrigin: string | null;
  configOrigin: string;
  projectApi: string | null;
  hasCredentialFor: (origin: string) => boolean;
}): string => {
  const { explicitOrigin, configOrigin, projectApi, hasCredentialFor } = input;
  if (explicitOrigin) return explicitOrigin;
  if (!projectApi) return configOrigin;
  const projectOrigin = normalizeOrigin(projectApi);
  if (projectOrigin === configOrigin || hasCredentialFor(projectOrigin)) return projectOrigin;
  throw new CliError(`this folder is linked to ${projectOrigin}, which you aren't logged in to: run nanodev login --api ${projectOrigin}`);
};

export const context = (cmd: Command): Context => {
  const opts = globals(cmd);
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const linked = readLinked(cwd);
  const rawExplicit = opts.api || process.env[ENV.api];
  const explicitOrigin = rawExplicit ? normalizeOrigin(rawExplicit) : null;
  let resolved: string | null = null;
  return {
    cwd,
    explicitOrigin,
    linked,
    get apiOrigin(): string {
      resolved ??= chooseApiOrigin({
        explicitOrigin,
        configOrigin: resolveApiOrigin({ config: readUserConfig().api }),
        projectApi: linked?.project.api ?? null,
        hasCredentialFor: (origin) => Boolean(readCredentials()[origin]),
      });
      return resolved;
    },
  };
};

/** The same context, working in `folder` (e.g. the clone `nanodev create` just made). */
export const contextForFolder = (ctx: Context, folder: string): Context => {
  const cwd = path.resolve(folder);
  const apiOrigin = ctx.apiOrigin;
  return { cwd, explicitOrigin: ctx.explicitOrigin, linked: readLinked(cwd), apiOrigin };
};

/** The token for the context's origin (NANODEV_TOKEN only for the explicit origin), or null. */
export const contextToken = (ctx: Context) => {
  const resolved = tokenFor(ctx.apiOrigin, ctx.explicitOrigin);
  if (!resolved && process.env[ENV.token] && ctx.explicitOrigin !== ctx.apiOrigin) {
    warn(`${ENV.token} is only sent to the origin given by --api or ${ENV.api}`);
  }
  return resolved;
};

/** The git identity of the saved login (null with NANODEV_TOKEN, no login, or an untrusted origin). */
export const loginIdentity = (ctx: Context): GitIdentity | null => {
  try {
    return identityFromEmail(contextToken(ctx)?.email);
  } catch {
    return null;
  }
};

/** A client for the context's API origin, with the saved token (throws when not logged in). */
export const authedClient = (ctx: Context): ApiClient => {
  const resolved = contextToken(ctx);
  if (!resolved) throw new CliError(`not logged in to ${ctx.apiOrigin}: run nanodev login --api ${ctx.apiOrigin}`);
  return new ApiClient({ origin: ctx.apiOrigin, token: resolved.token });
};
