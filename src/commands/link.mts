// link [project]: clone a nano-site project into a folder and install it.
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { API_PATHS, type CliProject, type DevConfig } from "../lib/api.mjs";
import { ENV } from "../lib/config.mjs";
import { authedClient, context, loginIdentity, type Context } from "../lib/context.mjs";
import { addGitOrigin } from "../lib/credentials.mjs";
import { CliError } from "../lib/errors.mjs";
import { applyGitIdentity, gitOrThrow, requireGit } from "../lib/git.mjs";
import { configureGitHelper, isGitHelperConfigured } from "../lib/gitCredential.mjs";
import { hasLockfile, npmCi } from "../lib/install.mjs";
import { offerLocalPlugin } from "../lib/localPlugin.mjs";
import { c, info, result, step, success, warn } from "../lib/output.mjs";
import { slugify, writeLinked } from "../lib/project.mjs";
import { select } from "../lib/prompt.mjs";

/** Match `query` against id first, then exact name, then a unique case-insensitive name. */
export const matchProject = (projects: readonly CliProject[], query: string): CliProject | null => {
  const byId = projects.find((p) => p.id === query);
  if (byId) return byId;
  const exact = projects.filter((p) => p.name === query);
  if (exact.length === 1) return exact[0];
  const loose = projects.filter((p) => p.name.toLowerCase() === query.toLowerCase());
  return loose.length === 1 ? loose[0] : null;
};

/** Missing or an empty folder. A file, or anything unreadable, counts as "not empty". */
export const isEmptyDir = (dir: string): boolean => {
  if (!existsSync(dir)) return true;
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return false;
  }
};

/** NANODEV_GIT_URL_OVERRIDE (tests, local bare repos) accepts only file:// URLs, so it can't pull the token to another host. */
export const gitUrlOverride = (raw: string | undefined): string | null => {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError(`${ENV.gitUrlOverride} must be a file:// URL`);
  }
  if (url.protocol !== "file:") throw new CliError(`${ENV.gitUrlOverride} must be a file:// URL (got ${url.protocol})`);
  return raw;
};

/** The git origin for credentials ("https://api.nanosite.ai"), or null for file:// and ssh URLs. */
const httpOrigin = (gitUrl: string): string | null => {
  try {
    const url = new URL(gitUrl);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
};

/** What cloning needs to know about a project (a dev config, or what `nanodev create` got back). */
export type CloneSource = Pick<DevConfig, "projectId" | "name" | "type" | "gitUrl">;

/**
 * Clone the project into `target` (missing or empty), write `.nanodev/project.json`, and run `npm ci`
 * when the project has a lockfile. Shared by `nanodev link` and `nanodev create`.
 */
export const cloneLinkedProject = async (
  ctx: Context,
  config: CloneSource,
  target: string,
  opts: { skipInstall?: boolean },
): Promise<{ installed: boolean }> => {
  const gitUrl = gitUrlOverride(process.env[ENV.gitUrlOverride]) ?? config.gitUrl;

  // The git host may differ from the API host: let the same login serve it.
  const gitOrigin = httpOrigin(gitUrl);
  if (gitOrigin && gitOrigin !== ctx.apiOrigin) {
    addGitOrigin(ctx.apiOrigin, gitOrigin);
    if (!isGitHelperConfigured(gitOrigin)) {
      try {
        configureGitHelper(gitOrigin);
      } catch (err) {
        warn(err instanceof Error ? err.message : String(err));
      }
    }
  }

  step(`Cloning ${config.name} into ${target}`);
  gitOrThrow(ctx.cwd, ["clone", "--quiet", "--", gitUrl, target], "git clone");
  writeLinked(target, { projectId: config.projectId, api: ctx.apiOrigin, type: config.type, name: config.name });
  applyGitIdentity(target, loginIdentity(ctx));
  // Plugin testing: offer a local nanodev plugin folder (uncommitted settings.local.json).
  const pluginDir = process.env[ENV.pluginDir];
  if (pluginDir && offerLocalPlugin(target, pluginDir)) info(c.dim(`Offered the local nanodev plugin in ${pluginDir}`));

  if (opts.skipInstall) {
    info(c.dim("Skipped npm ci (--skip-install)"));
    return { installed: false };
  }
  if (!hasLockfile(target)) {
    warn("no package-lock.json in the project: skipped npm ci");
    return { installed: false };
  }
  await npmCi(target);
  return { installed: true };
};

export const registerLink = (program: Command): void => {
  program
    .command("link")
    .description("Clone one of your nano-site projects into a folder, install it and link it to nanodev")
    .argument("[project]", "project id or name (asks when omitted and a terminal is attached)")
    .option("-d, --dir <folder>", "folder to clone into (default: ./<project-name>)")
    .option("--skip-install", "don't run npm ci after cloning")
    .addHelpText(
      "after",
      "\nExamples:\n  nanodev link\n  nanodev link 65f0c0ffee1234567890abcd\n  nanodev link \"My Store\" --dir ./store\n  nanodev link my-store --skip-install --json",
    )
    .action(async (query: string | undefined, opts: { dir?: string; skipInstall?: boolean }, cmd: Command) => {
      requireGit();
      const ctx = context(cmd);
      const client = authedClient(ctx);
      const { projects } = await client.get<{ projects: CliProject[] }>(API_PATHS.projects);
      if (projects.length === 0) throw new CliError("you have no projects yet: run nanodev create (or create one at nanosite.ai)");

      let project: CliProject;
      if (query) {
        const match = matchProject(projects, query);
        if (!match) throw new CliError(`no project matches "${query}": run nanodev link without arguments to choose, or pass its id`);
        project = match;
      } else {
        project = await select(
          "Which project?",
          projects.map((p) => ({ label: `${p.name} ${c.dim(`(${p.type}, ${p.id})`)}`, value: p })),
          `pass the project id, one of: ${projects.map((p) => `${p.id} (${p.name})`).join(", ")}`,
        );
      }

      const config = await client.get<DevConfig>(API_PATHS.devConfig(project.id));
      const target = path.resolve(ctx.cwd, opts.dir ?? slugify(config.name));
      if (!isEmptyDir(target)) throw new CliError(`${target} already exists and isn't an empty folder: pass --dir <folder>`);
      const { installed } = await cloneLinkedProject(ctx, config, target, { skipInstall: opts.skipInstall });

      result({ projectId: config.projectId, name: config.name, type: config.type, dir: target, installed }, () => {
        success(`Linked ${config.name} (${config.type}) in ${target}`);
        const rel = path.relative(process.cwd(), target);
        info(`Next: cd ${rel && rel.length < target.length ? rel : target} && nanodev dev`);
      });
    });
};
