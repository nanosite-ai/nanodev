// open [web|preview|live]: jump from the terminal to the same project on nano-site.
import type { Command } from "commander";
import { API_PATHS, type DevConfig } from "../lib/api.mjs";
import { openUrl } from "../lib/browser.mjs";
import { authedClient, context } from "../lib/context.mjs";
import { CliError } from "../lib/errors.mjs";
import { c, info, result, warn } from "../lib/output.mjs";
import { requireLinked } from "../lib/project.mjs";
import { PREVIEW_STATUS, type PreviewStatusResponse } from "../lib/preview.mjs";
import { fetchPreviewStatus } from "./preview.mjs";

export const OPEN_TARGET = { web: "web", preview: "preview", live: "live" } as const;
export type OpenTarget = (typeof OPEN_TARGET)[keyof typeof OPEN_TARGET];

export const parseOpenTarget = (raw: string | undefined): OpenTarget => {
  const value = (raw ?? OPEN_TARGET.web).trim().toLowerCase();
  const target = Object.values(OPEN_TARGET).find((t) => t === value);
  if (!target) throw new CliError(`unknown target "${raw}": use ${Object.values(OPEN_TARGET).join(", ")}`);
  return target;
};

/**
 * The URL for `target`, or a CliError saying why there is none. Pure. `preview` is your private preview
 * from `nanodev preview` (dev-config's previewUrl is a host that exists for every project, built or not).
 */
export const urlForTarget = (config: DevConfig, target: OpenTarget, preview: PreviewStatusResponse | null = null): string => {
  if (target === OPEN_TARGET.web) {
    if (!config.webUrl) throw new CliError("this server doesn't report the project's web URL yet: open it from nanosite.ai");
    return config.webUrl;
  }
  if (target === OPEN_TARGET.preview) {
    if (!preview?.url) throw new CliError("you have no preview of this project yet: run nanodev preview");
    return preview.url;
  }
  if (!config.liveUrl) throw new CliError("this project isn't published yet: nothing is live");
  return config.liveUrl;
};

export const registerOpen = (program: Command): void => {
  program
    .command("open")
    .description("Open the linked project on nano-site: the editor with the AI chat (web), your private preview from nanodev preview, or the live site")
    .argument("[target]", "web | preview | live", OPEN_TARGET.web)
    .option("--no-browser", "print the URL instead of opening a browser")
    .addHelpText("after", "\nExamples:\n  nanodev open\n  nanodev open preview\n  nanodev open live --no-browser\n  nanodev open web --json")
    .action(async (rawTarget: string | undefined, opts: { browser: boolean }, cmd: Command) => {
      const target = parseOpenTarget(rawTarget);
      const ctx = context(cmd);
      const { project } = requireLinked(ctx.cwd);
      const api = authedClient(ctx);
      const config = await api.get<DevConfig>(API_PATHS.devConfig(project.projectId));
      const preview = target === OPEN_TARGET.preview ? await fetchPreviewStatus(api, project.projectId) : null;
      const url = urlForTarget(config, target, preview);
      if (preview && preview.status !== PREVIEW_STATUS.ready) {
        warn(
          preview.status === PREVIEW_STATUS.failed
            ? `your last preview (${preview.sha.slice(0, 7)}) failed to build: the page may be an older build. Run nanodev preview to see why`
            : `your preview (${preview.sha.slice(0, 7)}) is still building: the page may show the previous build`,
        );
      }
      const opened = opts.browser ? await openUrl(url) : false;
      result({ target, url, opened }, () => {
        info(`${config.name} (${target}): ${c.cyan(url)}`);
        if (opts.browser && !opened) warn("couldn't open a browser: open the URL above yourself");
      });
    });
};
