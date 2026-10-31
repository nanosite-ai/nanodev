import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dirtyFiles } from "./git.mjs";
import {
  LEGACY_PLUGIN_MARKETPLACE,
  LEGACY_PLUGIN_SOURCE,
  LOCAL_PLUGIN_ID,
  LOCAL_PLUGIN_MARKETPLACE,
  OFFICIAL_PLUGIN_SOURCE,
  PLUGIN_CHECK,
  PLUGIN_ID,
  PLUGIN_MARKETPLACE,
  checkCommittedPluginSource,
  jsonIndent,
  mergeLocalPluginSettings,
  offerLocalPlugin,
} from "./localPlugin.mjs";

describe("mergeLocalPluginSettings", () => {
  it("points the local marketplace at the folder, enables it and turns the catalog plugin off", () => {
    expect(JSON.parse(mergeLocalPluginSettings(null, "/p")!)).toEqual({
      extraKnownMarketplaces: { [LOCAL_PLUGIN_MARKETPLACE]: { source: { source: "directory", path: "/p" } } },
      enabledPlugins: { [LOCAL_PLUGIN_ID]: true, [PLUGIN_ID]: false },
    });
  });

  it("keeps other keys, the indent and CRLF; leaves non-objects alone", () => {
    const out = mergeLocalPluginSettings('{\r\n\t"model": "opus"\r\n}\r\n', "/p")!;
    expect(jsonIndent(out)).toBe("\t");
    expect(out).toContain('\r\n\t"model": "opus"');
    expect(mergeLocalPluginSettings("[1]", "/p")).toBeNull();
    expect(mergeLocalPluginSettings("{ nope", "/p")).toBeNull();
  });
});

describe("checkCommittedPluginSource", () => {
  const settings = (source: unknown) => JSON.stringify({ extraKnownMarketplaces: { [PLUGIN_MARKETPLACE]: { source } } });

  it("names the nanosite catalog", () => {
    expect(PLUGIN_ID).toBe("nanodev@nanosite");
    expect(OFFICIAL_PLUGIN_SOURCE).toEqual({ source: "github", repo: "nanosite-ai/claude-plugins" });
  });

  it("calls an earlier kit's nanodev@nanodev offer legacy", () => {
    const legacy = JSON.stringify({ extraKnownMarketplaces: { [LEGACY_PLUGIN_MARKETPLACE]: { source: LEGACY_PLUGIN_SOURCE } } });
    const res = checkCommittedPluginSource(legacy);
    expect(res.status).toBe(PLUGIN_CHECK.legacy);
    expect(res.detail).toMatch(/nanodev@nanosite/);
  });

  it("is ok for the official source and warns about anything else", () => {
    expect(checkCommittedPluginSource(settings(OFFICIAL_PLUGIN_SOURCE)).status).toBe(PLUGIN_CHECK.ok);
    const other = checkCommittedPluginSource(settings({ source: "github", repo: "evil/fork" }));
    expect(other.status).toBe(PLUGIN_CHECK.other);
    expect(other.detail).toMatch(/evil\/fork/);
    expect(checkCommittedPluginSource(null).status).toBe(PLUGIN_CHECK.missing);
    expect(checkCommittedPluginSource("{}").status).toBe(PLUGIN_CHECK.missing);
    expect(checkCommittedPluginSource("{ nope").status).toBe(PLUGIN_CHECK.other);
  });
});

describe("on disk", () => {
  let dir: string;
  const sh = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "nanodev-plugin-"));
    sh(dir, "init", "--quiet", "-b", "main");
    sh(dir, "config", "user.name", "Owner");
    sh(dir, "config", "user.email", "owner@example.test");
    writeFileSync(path.join(dir, "a.txt"), "a\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "--quiet", "-m", "Initial");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

  it("offerLocalPlugin writes settings.local.json and keeps it out of git", () => {
    expect(offerLocalPlugin(dir, path.join(dir, "..", "plugin"))).toBe(".claude/settings.local.json");
    expect(sh(dir, "status", "--porcelain")).toBe("");
    expect(readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8")).toContain("/.claude/settings.local.json");
  });

  it("offerLocalPlugin works in a worktree, where .git is a file", () => {
    const wt = path.join(dir, "..", `${path.basename(dir)}-wt`);
    sh(dir, "worktree", "add", "--quiet", "-b", "wt", wt);
    try {
      offerLocalPlugin(wt, "/plugin");
      expect(sh(wt, "status", "--porcelain")).toBe("");
    } finally {
      rmSync(wt, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("dirtyFiles keeps the first path whole (an unstaged change starts with a space)", () => {
    writeFileSync(path.join(dir, "a.txt"), "changed\n");
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "src", "new.txt"), "new\n");
    expect(dirtyFiles(dir).sort()).toEqual(["a.txt", "src/new.txt"]);
  });
});
