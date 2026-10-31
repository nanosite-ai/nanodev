// The nanodev Claude Code plugin, as the CLI sees it. nano-site writes the agent guide (AGENTS.md block,
// CLAUDE.md import, the plugin offer in .claude/settings.json) into the project itself; the CLI
// only offers a local plugin folder for testing and checks the committed offer.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { git } from "./git.mjs";

export const PLUGIN_MARKETPLACE = "nanodev";
export const PLUGIN_ID = `nanodev@${PLUGIN_MARKETPLACE}`;
/** The official marketplace (the public nanosite-ai/nanodev repo). Same value the server writes. */
export const OFFICIAL_PLUGIN_SOURCE = { source: "github", repo: "nanosite-ai/nanodev" } as const;

export const CLAUDE_SETTINGS_FILE = ".claude/settings.json";
export const CLAUDE_LOCAL_SETTINGS_FILE = ".claude/settings.local.json";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** The indent unit of a JSON file (its first indented key), 2 spaces when there is none. */
export const jsonIndent = (text: string): string => /^([ \t]+)"/m.exec(text)?.[1] ?? "  ";

/**
 * settings.local.json pointing the nanodev marketplace at a local plugin folder (and enabling it). Other keys,
 * the file's indent and line endings are kept. Null when the existing file isn't a JSON object (left alone).
 */
export const mergeLocalPluginSettings = (existing: string | null, pluginDir: string): string | null => {
  let settings: Json = {};
  if (existing && existing.trim()) {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (!isObject(parsed)) return null;
      settings = parsed;
    } catch {
      return null;
    }
  }
  const marketplaces = isObject(settings.extraKnownMarketplaces) ? settings.extraKnownMarketplaces : {};
  const plugins = isObject(settings.enabledPlugins) ? settings.enabledPlugins : {};
  const next = {
    ...settings,
    extraKnownMarketplaces: { ...marketplaces, [PLUGIN_MARKETPLACE]: { source: { source: "directory", path: pluginDir } } },
    enabledPlugins: { ...plugins, [PLUGIN_ID]: true },
  };
  const eol = existing?.includes("\r\n") ? "\r\n" : "\n";
  return `${JSON.stringify(next, null, existing ? jsonIndent(existing) : "  ")}\n`.replace(/\n/g, eol);
};

/** Keep `entry` out of commits via the repo's info/exclude (works in worktrees and submodules too). */
export const excludeFromGit = (root: string, entry: string): void => {
  const res = git(root, ["rev-parse", "--git-path", "info/exclude"]);
  if (res.code !== 0) return;
  const exclude = path.resolve(root, res.stdout.trim());
  mkdirSync(path.dirname(exclude), { recursive: true });
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (current.split(/\r?\n/).includes(entry)) return;
  writeFileSync(exclude, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${entry}\n`);
};

/**
 * NANODEV_PLUGIN_DIR: offer a local plugin folder instead of the official marketplace, through the
 * uncommitted `.claude/settings.local.json` (which outranks the committed settings). Returns the file
 * written, or null when it was left alone.
 */
export const offerLocalPlugin = (root: string, pluginDir: string): string | null => {
  const file = path.join(root, ...CLAUDE_LOCAL_SETTINGS_FILE.split("/"));
  const merged = mergeLocalPluginSettings(existsSync(file) ? readFileSync(file, "utf8") : null, path.resolve(pluginDir));
  if (merged === null) return null;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, merged);
  excludeFromGit(root, `/${CLAUDE_LOCAL_SETTINGS_FILE}`);
  return CLAUDE_LOCAL_SETTINGS_FILE;
};

export const PLUGIN_CHECK = { ok: "ok", missing: "missing", other: "other" } as const;
export type PluginCheck = (typeof PLUGIN_CHECK)[keyof typeof PLUGIN_CHECK];

/** Does the committed `.claude/settings.json` offer the official nanodev marketplace? */
export const checkCommittedPluginSource = (settingsText: string | null): { status: PluginCheck; detail: string } => {
  if (settingsText === null) return { status: PLUGIN_CHECK.missing, detail: `${CLAUDE_SETTINGS_FILE} doesn't offer the nanodev plugin yet (nano-site adds it)` };
  let source: unknown;
  try {
    const parsed: unknown = JSON.parse(settingsText);
    const markets = isObject(parsed) && isObject(parsed.extraKnownMarketplaces) ? parsed.extraKnownMarketplaces : {};
    source = isObject(markets[PLUGIN_MARKETPLACE]) ? markets[PLUGIN_MARKETPLACE].source : undefined;
  } catch {
    return { status: PLUGIN_CHECK.other, detail: `${CLAUDE_SETTINGS_FILE} isn't valid JSON` };
  }
  if (source === undefined) return { status: PLUGIN_CHECK.missing, detail: `${CLAUDE_SETTINGS_FILE} doesn't offer the nanodev plugin yet (nano-site adds it)` };
  if (isObject(source) && source.source === OFFICIAL_PLUGIN_SOURCE.source && source.repo === OFFICIAL_PLUGIN_SOURCE.repo) {
    return { status: PLUGIN_CHECK.ok, detail: `${PLUGIN_ID} from github ${OFFICIAL_PLUGIN_SOURCE.repo}` };
  }
  return {
    status: PLUGIN_CHECK.other,
    detail: `${CLAUDE_SETTINGS_FILE} points the "${PLUGIN_MARKETPLACE}" marketplace at ${JSON.stringify(source)}, not github ${OFFICIAL_PLUGIN_SOURCE.repo}: check who changed it (use .claude/settings.local.json for local overrides)`,
  };
};

/** Read and check the committed settings of a linked folder. */
export const checkPluginOffer = (root: string): { status: PluginCheck; detail: string } => {
  const file = path.join(root, ...CLAUDE_SETTINGS_FILE.split("/"));
  return checkCommittedPluginSource(existsSync(file) ? readFileSync(file, "utf8") : null);
};
