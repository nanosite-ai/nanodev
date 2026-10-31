import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  IDENTITY_ACTION,
  IDENTITY_MARKER_KEY,
  ensureGitIdentity,
  hasGitIdentity,
  identityFromEmail,
  identityNotice,
  isLoginIdentity,
  unsetLoginIdentity,
} from "./git.mjs";

const IDENTITY_ENV = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"];
const LOGIN = identityFromEmail("ana@example.com");

describe("git identity fallback", () => {
  let dir: string;
  let repo: string;
  let globalConfig: string;
  const saved: Record<string, string | undefined> = {};
  const gitIn = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const local = (key: string) => {
    try {
      return gitIn(["config", "--local", "--get", key]);
    } catch {
      return null;
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "nanodev-ident-"));
    // A machine where git was never configured: an empty global config, no system config, no env identity.
    globalConfig = path.join(dir, "gitconfig");
    writeFileSync(globalConfig, "");
    for (const key of [...IDENTITY_ENV, "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) saved[key] = process.env[key];
    for (const key of IDENTITY_ENV) delete process.env[key];
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    execFileSync("git", ["init", "--quiet", "repo"], { cwd: dir });
    repo = path.join(dir, "repo");
    // Make git's auto-detection fail the way it does on a fresh Windows/Linux machine.
    gitIn(["config", "--local", "user.useConfigOnly", "true"]);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("derives the identity from the login email", () => {
    expect(identityFromEmail("ana@example.com")).toEqual({ email: "ana@example.com", name: "ana" });
    expect(identityFromEmail(" ")).toBeNull();
    expect(identityFromEmail(undefined)).toBeNull();
  });

  it("sets a marked repo-local identity only when git has none, so commits work", () => {
    expect(hasGitIdentity(repo)).toBe(false);
    expect(ensureGitIdentity(repo, LOGIN)).toBe(IDENTITY_ACTION.set);
    expect(hasGitIdentity(repo)).toBe(true);
    expect(local("user.email")).toBe("ana@example.com");
    expect(local(IDENTITY_MARKER_KEY)).toBe("ana@example.com");
    expect(isLoginIdentity(repo)).toBe(true);
    gitIn(["commit", "--allow-empty", "--quiet", "-m", "x"]);
    // The global config is never touched.
    expect(execFileSync("git", ["config", "--global", "--list"], { cwd: repo, encoding: "utf8" }).trim()).toBe("");
    // A second run with nothing changed does nothing (and says nothing).
    expect(ensureGitIdentity(repo, LOGIN)).toBeNull();
  });

  it("removes its identity once git has one of its own", () => {
    ensureGitIdentity(repo, LOGIN);
    writeFileSync(globalConfig, "[user]\n\temail = own@example.com\n\tname = Own\n");
    expect(ensureGitIdentity(repo, LOGIN)).toBe(IDENTITY_ACTION.removed);
    expect(local("user.email")).toBeNull();
    expect(local(IDENTITY_MARKER_KEY)).toBeNull();
    expect(gitIn(["var", "GIT_COMMITTER_IDENT"])).toMatch(/own@example\.com/);
  });

  it("never removes a user.email the user changed after nanodev set one", () => {
    ensureGitIdentity(repo, LOGIN);
    gitIn(["config", "--local", "user.email", "mine@example.com"]);
    expect(isLoginIdentity(repo)).toBe(false);
    expect(unsetLoginIdentity(repo)).toBe(false);
    expect(local("user.email")).toBe("mine@example.com");
    expect(local(IDENTITY_MARKER_KEY)).toBeNull();
  });

  it("leaves an existing identity alone", () => {
    gitIn(["config", "--local", "user.email", "own@example.com"]);
    gitIn(["config", "--local", "user.name", "Own"]);
    expect(ensureGitIdentity(repo, LOGIN)).toBeNull();
    expect(local("user.email")).toBe("own@example.com");
  });

  it("unsets on request (nanodev config --unset-identity / logout)", () => {
    ensureGitIdentity(repo, LOGIN);
    expect(unsetLoginIdentity(repo)).toBe(true);
    expect(local("user.email")).toBeNull();
    expect(hasGitIdentity(repo)).toBe(false);
  });

  it("does nothing without a login identity, and explains what it did", () => {
    expect(ensureGitIdentity(repo, null)).toBeNull();
    expect(identityNotice(IDENTITY_ACTION.set, LOGIN)).toMatch(/ana@example\.com.*--unset-identity/);
    expect(identityNotice(IDENTITY_ACTION.removed, LOGIN)).toMatch(/removed/);
    expect(identityNotice(null, LOGIN)).toBeNull();
  });
});
