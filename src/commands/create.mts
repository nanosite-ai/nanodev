// create [dir]: start a new project from a template (or the starter kit), clone it, install it and run it.
// `npm create @nanosite/nanodev@beta my-store` (packages/create-nanodev) runs exactly this.
import { existsSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import {
  ApiClient,
  ApiError,
  API_PATHS,
  CREATE_WARNING,
  PROJECT_TYPE,
  type CliTemplate,
  type CliTemplateList,
  type CreatedProject,
  type CreateWarning,
} from "../lib/api.mjs";
import { authedClient, context, contextForFolder, contextToken, type Context } from "../lib/context.mjs";
import { ENV } from "../lib/config.mjs";
import { CliError, NeedsInputError } from "../lib/errors.mjs";
import { requireGit } from "../lib/git.mjs";
import { c, event, info, isJsonMode, result, step, success, warn } from "../lib/output.mjs";
import { canPrompt, select } from "../lib/prompt.mjs";
import { projectFilePath } from "../lib/project.mjs";
import { matchTemplate, parseProjectType, resolveNameAndDir, templateHint, templateLabel } from "../lib/templates.mjs";
import { deviceLogin } from "./auth.mjs";
import { DEFAULT_DEV_PORT, runDev } from "./dev.mjs";
import { cloneLinkedProject, isEmptyDir } from "./link.mjs";

/** The server bounds its own wait (sandbox seed ≤ 60s, then best-effort steps); allow it all and more. */
const CREATE_TIMEOUT_MS = 180_000;

/** Server error codes `POST /api/cli/projects` answers with that deserve their own message. */
export const CREATE_ERROR = {
  planRequired: "plan_required",
  projectLimit: "project_limit",
  templateNotFound: "template_not_found",
} as const;

interface CreateErrorBody {
  error?: string;
  message?: string;
  upgradeUrl?: string;
}

/** A create failure → one actionable line (upgrade link for the plan rule). Pure. */
export const describeCreateError = (err: ApiError): string => {
  const body = (err.body ?? {}) as CreateErrorBody;
  const message = body.message ?? err.message;
  if (body.error === CREATE_ERROR.planRequired && body.upgradeUrl) return `${message}: upgrade at ${body.upgradeUrl}`;
  if (body.error === CREATE_ERROR.projectLimit) return `${message} Upgrade your plan or delete it on nanosite.ai, or run nanodev link to work on it.`;
  return message;
};

/** What a "still settling" warning means for the user. Pure. */
export const describeWarning = (warning: CreateWarning): string => {
  switch (warning) {
    case CREATE_WARNING.sandboxPending:
      return "nano-site is still preparing the project's files: if the download fails, retry it in a minute with nanodev link";
    case CREATE_WARNING.repoPending:
      return "the project's git repository isn't ready yet: it is made on the first download";
    case CREATE_WARNING.storePending:
      return "the store's commerce backend isn't ready: open the project once at nanosite.ai to finish it";
    case CREATE_WARNING.demoProductsSkipped:
      return "the demo products weren't loaded: the store starts empty";
    default:
      return String(warning);
  }
};

/**
 * Logged in already (saved login or NANODEV_TOKEN)? Otherwise run the browser device login first, but
 * only with a terminal: a script or agent gets an immediate "log in first" instead of a 10-minute wait.
 */
const ensureLoggedIn = async (ctx: Context, browser: boolean): Promise<void> => {
  if (contextToken(ctx)) return;
  if (!canPrompt()) throw new NeedsInputError(`not logged in to ${ctx.apiOrigin}: run nanodev login (or set ${ENV.token})`);
  info(`Not logged in to ${ctx.apiOrigin} yet: logging in first.`);
  const { email } = await deviceLogin(ctx, { browser, gitHelper: true });
  success(`Logged in to ${ctx.apiOrigin} as ${email}`);
};

const pickTemplate = async (list: CliTemplateList, query: string | undefined): Promise<CliTemplate> => {
  const { templates } = list;
  if (templates.length === 0) {
    throw new CliError(list.upgradeUrl ? `no templates you can start from on your plan: upgrade at ${list.upgradeUrl}` : "no templates are available right now");
  }
  if (query) {
    const match = matchTemplate(templates, query);
    if (!match) throw new CliError(`no template matches "${query}": ${templateHint(templates)}`);
    return match;
  }
  return select(
    "Start from which template?",
    templates.map((t) => ({ label: `${templateLabel(t)} ${c.dim(t.id)}`, value: t })),
    templateHint(templates),
  );
};

const assertEmptyFolder = (target: string): void => {
  if (!isEmptyDir(target)) throw new CliError(`${target} already exists and isn't an empty folder: pick another folder`);
};

/** POST the create. A lost answer (timeout, network) may still have created it: say how to find it. */
const postCreate = async (ctx: Context, body: { template: string; name: string; orgId?: string }): Promise<CreatedProject> => {
  const client = new ApiClient({ origin: ctx.apiOrigin, token: contextToken(ctx)!.token, timeoutMs: CREATE_TIMEOUT_MS });
  try {
    return await client.post<CreatedProject>(API_PATHS.projects, body);
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 401) throw err;
      throw new CliError(describeCreateError(err));
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new CliError(`${reason}\nThe project may have been created anyway: check with nanodev link (it lists your projects) before creating it again`);
  }
};

/** Why `nanodev dev` can't start right after creating, or null when it can. Pure. */
export const devBlocker = (created: Pick<CreatedProject, "type" | "warnings">, installed: boolean): string | null => {
  if (created.type === PROJECT_TYPE.store && created.warnings?.includes(CREATE_WARNING.storePending)) {
    return "the store's commerce backend isn't ready yet";
  }
  if (!installed) return "the dependencies aren't installed";
  return null;
};

interface CreateOpts {
  template?: string;
  name?: string;
  type?: string;
  org?: string;
  skipInstall?: boolean;
  dev: boolean;
  browser: boolean;
  port: string;
}

export const registerCreate = (program: Command): void => {
  program
    .command("create")
    .description("Start a new store (or website) from a template or the starter kit, clone it here, install it and run it")
    .argument("[dir]", "folder to create (default: ./<project-name>)")
    .option("-t, --template <id>", "template id or name (asks when omitted and a terminal is attached)")
    .option("-n, --name <name>", "project name (default: the folder name, or the template's name)")
    .option("--type <type>", "only offer store or website templates")
    .option("--org <orgId>", "your organization's id (default: your organization, if you belong to one, like on nanosite.ai)")
    .option("--skip-install", "don't run npm ci after cloning")
    .option("--no-dev", "don't start nanodev dev afterwards")
    .option("--no-browser", "don't open a browser (login approval, the running store)")
    .option("-p, --port <port>", "local port for nanodev dev", String(DEFAULT_DEV_PORT))
    .addHelpText(
      "after",
      "\nExamples:\n  npm create @nanosite/nanodev@beta my-store\n  nanodev create my-store\n  nanodev create my-store --template ecommerce --no-dev\n  nanodev create --type website --name \"My Site\"\n  nanodev create shop --template store-beauty --no-dev --json",
    )
    .action(async (dir: string | undefined, opts: CreateOpts, cmd: Command) => {
      requireGit();
      const ctx = context(cmd);
      const type = parseProjectType(opts.type);
      // A folder named up front is checked before any login or browser round-trip.
      if (dir) assertEmptyFolder(path.resolve(ctx.cwd, dir));
      await ensureLoggedIn(ctx, opts.browser);
      const client = authedClient(ctx);

      const list = await client.get<CliTemplateList>(API_PATHS.templates(type));
      const template = await pickTemplate(list, opts.template);
      const { name, dir: target } = resolveNameAndDir({ cwd: ctx.cwd, dir, name: opts.name, template });
      assertEmptyFolder(target);

      step(`Creating ${name} from ${template.name}`);
      const created = await postCreate(ctx, { template: template.id, name, ...(opts.org ? { orgId: opts.org } : {}) });
      const warnings = created.warnings ?? [];
      for (const w of warnings) warn(describeWarning(w));

      let installed: boolean;
      try {
        ({ installed } = await cloneLinkedProject(ctx, created, target, { skipInstall: opts.skipInstall }));
      } catch (err) {
        // The project exists on nano-site now: say how to pick it up instead of creating another one.
        if (existsSync(projectFilePath(target))) throw err;
        const reason = err instanceof Error ? err.message : String(err);
        throw new CliError(`${reason}\n${created.name} was created on nano-site (${created.projectId}): retry the download with nanodev link ${created.projectId} --dir ${target}`);
      }

      // The agent kit (AGENTS.md, CLAUDE.md, .claude/settings.json with the plugin offer) comes with the
      // clone: the server writes and commits it when it creates the project.

      const summary = { ...created, warnings, template: template.id, dir: target, installed };
      const blocker = opts.dev ? devBlocker(created, installed) : null;
      if (!opts.dev || blocker) {
        result(summary, () => {
          success(`Created ${created.name} (${created.type}) in ${target}`);
          if (blocker) warn(`not starting nanodev dev: ${blocker}`);
          info(installed ? `Next: cd ${target} && nanodev dev` : `Next: cd ${target}, install the dependencies, then nanodev dev`);
          info(c.dim(`On nano-site: ${created.webUrl}`));
        });
        return;
      }
      if (isJsonMode()) event({ event: "created", ...summary }, "");
      else success(`Created ${created.name} (${created.type}) in ${target}`);
      await runDev(contextForFolder(ctx, target), { port: opts.port, watch: true, open: opts.browser });
    });
};
