// Where nanodev keeps its files, and which API origin a command talks to.
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "./errors.mjs";

/** nano-site's public API (override with --api, NANODEV_API or the config file). */
export const DEFAULT_API_ORIGIN = "https://api.nanosite.ai";

/** Environment variables nanodev reads. */
export const ENV = {
  /** API origin override (below `--api`). */
  api: "NANODEV_API",
  /** Use this token instead of the saved credentials (CI, tests). */
  token: "NANODEV_TOKEN",
  /** Directory for config.json / credentials.json (default ~/.nanodev). */
  home: "NANODEV_HOME",
  /** Clone from this URL instead of the project's gitUrl (tests, local bare repos). */
  gitUrlOverride: "NANODEV_GIT_URL_OVERRIDE",
  /** Run this file instead of the project's `store-runtime` bin (tests). */
  storeRuntimeBin: "NANODEV_STORE_RUNTIME_BIN",
  /** repo-head poll interval for `nanodev dev`, in ms (tests). */
  repoHeadPollMs: "NANODEV_REPO_HEAD_POLL_MS",
  /** A local nanodev plugin marketplace folder to offer instead of the public one (plugin testing). */
  pluginDir: "NANODEV_PLUGIN_DIR",
} as const;

export const nanodevHome = (): string => process.env[ENV.home] || path.join(os.homedir(), ".nanodev");
export const userConfigPath = (): string => path.join(nanodevHome(), "config.json");

export interface UserConfig {
  api?: string;
}

export const readJsonFile = <T,>(file: string): T | null => {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    throw new CliError(`${file} is not valid JSON: fix or delete it`);
  }
};

export const readUserConfig = (): UserConfig => readJsonFile<UserConfig>(userConfigPath()) ?? {};

/** `https://Api.Example.com/` → `https://api.example.com`. Throws a CliError on anything that isn't http(s). */
export const normalizeOrigin = (raw: string): string => {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new CliError(`invalid API origin "${raw}": expected e.g. https://api.nanosite.ai`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CliError(`invalid API origin "${raw}": must start with https:// (or http:// for local dev)`);
  }
  return url.origin;
};

export interface ApiOriginSources {
  flag?: string;
  env?: string;
  config?: string;
}

/** `--api` > NANODEV_API > ~/.nanodev/config.json > the default (a linked folder's api: see context.mts). */
export const resolveApiOrigin = (sources: ApiOriginSources): string => {
  const raw = sources.flag || sources.env || sources.config || DEFAULT_API_ORIGIN;
  return normalizeOrigin(raw);
};
