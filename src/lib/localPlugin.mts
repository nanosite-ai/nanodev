// The nanodev Claude Code plugin, as the CLI sees it. nano-site writes the agent guide (AGENTS.md block,
// CLAUDE.md import, the plugin offer in .claude/settings.json) into the project itself; the CLI
// only offers a local plugin folder for testing and checks the committed offer.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { git } from "./git.mjs";

/** The official marketplace: nanosite.ai's plugin catalog (public nanosite-ai/claude-plugins). Same values the server writes. */
export const PLUGIN_MARKETPLACE = "nanosite";
export const PLUGIN_ID = `nanodev@${PLUGIN_MARKETPLACE}`;
export const OFFICIAL_PLUGIN_SOURCE = { source: "github", repo: "nanosite-ai/claude-plugins" } as const;
/** nanodev's own marketplace: what earlier kits committed, and the name of the local plugin folder's marketplace. */
export const LEGACY_PLUGIN_MARKETPLACE = "nanodev";
export const LEGACY_PLUGIN_ID = `nanodev@${LEGACY_PLUGIN_MARKETPLACE}`;
export const LEGACY_PLUGIN_SOURCE = { source: "github", repo: "nanosite-ai/nanodev" } as const;
/** The local plugin folder (NANODEV_PLUGIN_DIR) is its own marketplace, named in its .claude-plugin/marketplace.json. */
export const LOCAL_PLUGIN_MARKETPLACE = LEGACY_PLUGIN_MARKETPLACE;
export const LOCAL_PLUGIN_ID = LEGACY_PLUGIN_ID;

export const CLAUDE_SETTINGS_FILE = ".claude/settings.json";
export const CLAUDE_LOCAL_SETTINGS_FILE = ".claude/settings.local.json";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** The indent unit of a JSON file (its first indented key), 2 spaces when there is none. */
export const jsonIndent = (text: string): string => /^([ \t]+)"/m.exec(text)?.[1] ?? "  ";

/**
 * settings.local.json pointing the local marketplace at a local plugin folder and enabling it, with the committed
 * catalog plugin turned off so the two don't both load. Other keys, the file's indent and line endings are kept. Null when the existing file isn't a JSON object (left alone).
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
    extraKnownMarketplaces: { ...marketplaces, [LOCAL_PLUGIN_MARKETPLACE]: { source: { source: "directory", path: pluginDir } } },
    enabledPlugins: { ...plugins, [LOCAL_PLUGIN_ID]: true, [PLUGIN_ID]: false },
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

export const PLUGIN_CHECK = { ok: "ok", missing: "missing", legacy: "legacy", other: "other" } as const;
export type PluginCheck = (typeof PLUGIN_CHECK)[keyof typeof PLUGIN_CHECK];

const sameGithubSource = (source: unknown, expected: { source: string; repo: string }): boolean =>
  isObject(source) && source.source === expected.source && source.repo === expected.repo;

/** Does the committed `.claude/settings.json` offer nanodev from the official catalog? */
export const checkCommittedPluginSource = (settingsText: string | null): { status: PluginCheck; detail: string } => {
  if (settingsText === null) return { status: PLUGIN_CHECK.missing, detail: `${CLAUDE_SETTINGS_FILE} doesn't offer the nanodev plugin yet (nano-site adds it)` };
  let source: unknown;
  let legacySource: unknown;
  try {
    const parsed: unknown = JSON.parse(settingsText);
    const markets = isObject(parsed) && isObject(parsed.extraKnownMarketplaces) ? parsed.extraKnownMarketplaces : {};
    source = isObject(markets[PLUGIN_MARKETPLACE]) ? markets[PLUGIN_MARKETPLACE].source : undefined;
    legacySource = isObject(markets[LEGACY_PLUGIN_MARKETPLACE]) ? markets[LEGACY_PLUGIN_MARKETPLACE].source : undefined;
  } catch {
    return { status: PLUGIN_CHECK.other, detail: `${CLAUDE_SETTINGS_FILE} isn't valid JSON` };
  }
  if (source === undefined && sameGithubSource(legacySource, LEGACY_PLUGIN_SOURCE)) {
    return {
      status: PLUGIN_CHECK.legacy,
      detail: `${CLAUDE_SETTINGS_FILE} offers the older ${LEGACY_PLUGIN_ID}; nano-site moves it to ${PLUGIN_ID} on its next agent-kit refresh`,
    };
  }
  if (source === undefined) return { status: PLUGIN_CHECK.missing, detail: `${CLAUDE_SETTINGS_FILE} doesn't offer the nanodev plugin yet (nano-site adds it)` };
  if (sameGithubSource(source, OFFICIAL_PLUGIN_SOURCE)) {
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
