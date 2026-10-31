import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProgram } from "../program.mjs";
import { ApiError, parseRetryAfter, type DeviceCodeResponse } from "./api.mjs";
import { openCommand, safeBrowserUrl } from "./browser.mjs";
import { DEFAULT_API_ORIGIN, normalizeOrigin, resolveApiOrigin } from "./config.mjs";
import { chooseApiOrigin } from "./context.mjs";
import { addGitOrigin, credentialForGitOrigin, credentialsPath, readCredentials, removeCredential, saveCredential, tokenFor } from "./credentials.mjs";
import { pollForToken, slowDownInterval } from "./deviceFlow.mjs";
import { formatCredentialResponse, helperCommand, parseCredentialRequest, requestOrigin } from "./gitCredential.mjs";
import { checkLinuxLockfile, diffLockfiles, displayPackage, isSafeRepair, LOCKFILE_FIX_HINT, type Lockfile } from "./lockfile.mjs";
import { REPAIR_NPM_ARGS, repairLinuxLockfile } from "./lockfileRepair.mjs";
import { slugify } from "./project.mjs";
import { parseChoice } from "./prompt.mjs";
import {
  describeSync,
  generateCommitMessage,
  isNeverCommitPath,
  isNonFastForwardRejection,
  parseAheadBehind,
  parsePorcelain,
  remoteHeadAction,
  remoteMessages,
  syncState,
} from "./sync.mjs";
import { gitUrlOverride, matchProject } from "../commands/link.mjs";
import { devCommand } from "../commands/dev.mjs";
import { versionAtLeast } from "../commands/status.mjs";

describe("API origin", () => {
  it("normalizes to an origin", () => {
    expect(normalizeOrigin("https://API.nanosite.ai/some/path")).toBe("https://api.nanosite.ai");
    expect(normalizeOrigin("http://localhost:3081/")).toBe("http://localhost:3081");
  });
  it("rejects non-http", () => {
    expect(() => normalizeOrigin("ftp://x")).toThrow(/https/);
    expect(() => normalizeOrigin("not a url")).toThrow(/invalid API origin/);
  });
  it("resolves flag > env > config > default", () => {
    expect(resolveApiOrigin({})).toBe(DEFAULT_API_ORIGIN);
    expect(resolveApiOrigin({ config: "https://c.test" })).toBe("https://c.test");
    expect(resolveApiOrigin({ config: "https://c.test", env: "https://e.test" })).toBe("https://e.test");
    expect(resolveApiOrigin({ env: "https://e.test", flag: "https://f.test" })).toBe("https://f.test");
  });
  it("uses a linked folder's api only for an origin the user already logged in to", () => {
    const none = () => false;
    expect(chooseApiOrigin({ explicitOrigin: "https://e.test", configOrigin: "https://c.test", projectApi: "https://evil.test", hasCredentialFor: none })).toBe("https://e.test");
    expect(chooseApiOrigin({ explicitOrigin: null, configOrigin: "https://c.test", projectApi: null, hasCredentialFor: none })).toBe("https://c.test");
    expect(chooseApiOrigin({ explicitOrigin: null, configOrigin: "https://c.test", projectApi: "https://c.test/", hasCredentialFor: none })).toBe("https://c.test");
    expect(chooseApiOrigin({ explicitOrigin: null, configOrigin: "https://c.test", projectApi: "https://p.test", hasCredentialFor: (o) => o === "https://p.test" })).toBe("https://p.test");
    expect(() => chooseApiOrigin({ explicitOrigin: null, configOrigin: "https://c.test", projectApi: "https://evil.test", hasCredentialFor: none })).toThrow(
      "run nanodev login --api https://evil.test",
    );
  });
});

describe("credentials file", () => {
  let home: string;
  const prevHome = process.env.NANODEV_HOME;
  const prevToken = process.env.NANODEV_TOKEN;
  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "nanodev-home-"));
    process.env.NANODEV_HOME = home;
    delete process.env.NANODEV_TOKEN;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.NANODEV_HOME;
    else process.env.NANODEV_HOME = prevHome;
    if (prevToken === undefined) delete process.env.NANODEV_TOKEN;
    else process.env.NANODEV_TOKEN = prevToken;
  });

  it("saves per origin, owner-only, and removes", () => {
    saveCredential("https://a.test", { token: "ndv_a", email: "a@x.test" });
    saveCredential("https://b.test", { token: "ndv_b", email: "b@x.test" });
    expect(readCredentials()).toEqual({
      "https://a.test": { token: "ndv_a", email: "a@x.test" },
      "https://b.test": { token: "ndv_b", email: "b@x.test" },
    });
    if (process.platform !== "win32") expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
    expect(removeCredential("https://a.test")).toBe(true);
    expect(removeCredential("https://a.test")).toBe(false);
    expect(Object.keys(JSON.parse(readFileSync(credentialsPath(), "utf8")))).toEqual(["https://b.test"]);
  });

  it("sends NANODEV_TOKEN only to the explicitly chosen origin", () => {
    saveCredential("https://a.test", { token: "ndv_a", email: "a@x.test" });
    expect(tokenFor("https://a.test", null)).toEqual({ token: "ndv_a", email: "a@x.test", source: "file" });
    expect(tokenFor("https://other.test", null)).toBeNull();
    process.env.NANODEV_TOKEN = "ndv_env";
    expect(tokenFor("https://e.test", "https://e.test")).toEqual({ token: "ndv_env", source: "env" });
    // A folder-chosen origin never gets the env token.
    expect(tokenFor("https://evil.test", "https://e.test")).toBeNull();
    expect(tokenFor("https://evil.test", null)).toBeNull();
    expect(tokenFor("https://a.test", null)?.source).toBe("file");
  });

  it("maps extra git origins to the API credential", () => {
    saveCredential("https://api.test", { token: "ndv_a", email: "a@x.test" });
    addGitOrigin("https://api.test", "https://git.test");
    addGitOrigin("https://api.test", "https://git.test");
    const file = readCredentials();
    expect(file["https://api.test"].gitOrigins).toEqual(["https://git.test"]);
    expect(credentialForGitOrigin("https://git.test", file)?.token).toBe("ndv_a");
    expect(credentialForGitOrigin("https://api.test", file)?.token).toBe("ndv_a");
    expect(credentialForGitOrigin("https://evil.test", file)).toBeNull();
  });

  it("throws a clear error on a corrupt file", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(credentialsPath(), "{nope");
    expect(() => readCredentials()).toThrow(/not valid JSON/);
  });
});

describe("git credential helper protocol", () => {
  it("parses the request and builds the origin", () => {
    const fields = parseCredentialRequest("protocol=https\nhost=api.nanosite.ai:8443\npath=git/p.git\n\n");
    expect(requestOrigin(fields)).toBe("https://api.nanosite.ai:8443");
    expect(requestOrigin({ protocol: "https" })).toBeNull();
  });
  it("answers with username + password", () => {
    expect(formatCredentialResponse("ndv_x")).toBe("username=nanodev\npassword=ndv_x\n");
  });
  it("calls the global bin by name, else node + absolute path with forward slashes", () => {
    expect(helperCommand({ global: true })).toBe("!nanodev git-credential");
    expect(helperCommand({ global: false, node: "/usr/bin/node", bin: "/opt/nanodev/bin/nanodev.mjs" })).toBe('!"/usr/bin/node" "/opt/nanodev/bin/nanodev.mjs" git-credential');
  });
});

describe("browser launcher", () => {
  it("accepts only http(s)", () => {
    expect(safeBrowserUrl("https://nanosite.ai/cli/approve?code=ABCD-1234")).toBe("https://nanosite.ai/cli/approve?code=ABCD-1234");
    expect(() => safeBrowserUrl("file:///C:/Windows/System32/calc.exe")).toThrow(/non-http/);
    expect(() => safeBrowserUrl("javascript:alert(1)")).toThrow(/non-http/);
    expect(() => safeBrowserUrl("calc.exe")).toThrow(/invalid URL/);
  });
  it("passes a hostile URL as one argument to a non-shell launcher", () => {
    const hostile = safeBrowserUrl('http://evil.test/x|calc.exe&whoami"&echo pwned%PATH%^<a>');
    for (const platform of ["win32", "darwin", "linux"] as const) {
      const [cmd, args] = openCommand(hostile, platform);
      expect(["cmd", "cmd.exe", "sh", "bash", "powershell"]).not.toContain(cmd);
      // The whole URL is exactly one argv entry, and quotes/angle brackets are percent-encoded.
      expect(args.at(-1)).toBe(hostile);
      expect(args.filter((a) => a.includes("evil.test"))).toHaveLength(1);
    }
    expect(hostile).not.toMatch(/["<>]/);
    expect(openCommand(hostile, "win32")).toEqual(["rundll32", ["url.dll,FileProtocolHandler", hostile]]);
    expect(openCommand(hostile, "darwin")).toEqual(["open", [hostile]]);
    expect(openCommand(hostile, "linux")).toEqual(["xdg-open", [hostile]]);
  });
});

describe("device flow", () => {
  const device: DeviceCodeResponse = { deviceCode: "dc", userCode: "ABCD-1234", verificationUrl: "https://x.test/cli/approve", expiresIn: 600, interval: 3 };
  const err = (code: string, status = 400, retryAfter: number | null = null) => new ApiError(code, status, { error: code }, retryAfter);
  const run = async (responses: (unknown | Error)[], dev = device) => {
    const waits: number[] = [];
    let clock = 0;
    let i = 0;
    const client = {
      post: async <T,>(): Promise<T> => {
        const next = responses[i++];
        if (next instanceof Error) throw next;
        return next as T;
      },
    };
    const outcome = pollForToken(client, dev, {
      sleepMs: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      now: () => clock,
    });
    return { outcome, waits, calls: () => i };
  };

  it("keeps polling while pending, then returns the token", async () => {
    const { outcome, waits } = await run([err("authorization_pending"), err("authorization_pending"), { token: "ndv_x", user: { id: "u", email: "e" } }]);
    await expect(outcome).resolves.toMatchObject({ token: "ndv_x" });
    expect(waits).toEqual([3000, 3000, 3000]);
  });
  it("slows down by 5s, or to Retry-After when longer", async () => {
    const { outcome, waits } = await run([err("slow_down", 429), err("slow_down", 429, 20), { token: "ndv_x", user: { id: "u", email: "e" } }]);
    await outcome;
    expect(waits).toEqual([3000, 8000, 20000]);
    expect(slowDownInterval(28, null)).toBe(30);
    expect(slowDownInterval(3, 500)).toBe(120);
  });
  it("stops on denied and on expired", async () => {
    await expect((await run([err("access_denied")])).outcome).rejects.toThrow(/denied/);
    await expect((await run([err("expired_token")])).outcome).rejects.toThrow(/expired/);
  });
  it("gives up when the code's lifetime runs out", async () => {
    const { outcome, calls } = await run(Array(100).fill(err("authorization_pending")), { ...device, expiresIn: 10 });
    await expect(outcome).rejects.toThrow(/expired/);
    expect(calls()).toBe(4);
  });
  it("rethrows anything else", async () => {
    await expect((await run([err("boom", 500)])).outcome).rejects.toThrow("boom");
  });
  it("parses Retry-After", () => {
    expect(parseRetryAfter("7")).toBe(7);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 0)).toBe(10);
  });
});

describe("lockfile linux check", () => {
  const base = (): Lockfile => ({
    lockfileVersion: 3,
    packages: {
      "": { optionalDependencies: {} },
      "node_modules/rolldown": {
        version: "1.0.0",
        optionalDependencies: {
          "@rolldown/binding-darwin-arm64": "1.0.0",
          "@rolldown/binding-linux-x64-gnu": "1.0.0",
          "@rolldown/binding-linux-x64-musl": "1.0.0",
          "@rolldown/binding-win32-x64-msvc": "1.0.0",
        },
      },
      "node_modules/@rolldown/binding-linux-x64-gnu": { version: "1.0.0", os: ["linux"], cpu: ["x64"], libc: ["glibc"] },
      "node_modules/@rolldown/binding-linux-x64-musl": { version: "1.0.0", os: ["linux"], cpu: ["x64"], libc: ["musl"] },
      "node_modules/@rolldown/binding-win32-x64-msvc": { version: "1.0.0", os: ["win32"] },
      "node_modules/esbuild": { version: "0.25.0", optionalDependencies: { "@esbuild/linux-x64": "0.25.0", "@esbuild/win32-x64": "0.25.0" } },
      "node_modules/vite/node_modules/esbuild": { version: "0.21.0", optionalDependencies: { "@esbuild/linux-x64": "0.21.0" } },
      "node_modules/vite/node_modules/@esbuild/linux-x64": { version: "0.21.0", os: ["linux"] },
      "node_modules/@esbuild/linux-x64": { version: "0.25.0", os: ["linux"] },
      "node_modules/plain": { version: "1.0.0" },
    },
  });

  it("passes a complete lockfile", () => {
    expect(checkLinuxLockfile(base())).toEqual({ ok: true, missing: [] });
  });

  it("flags every missing Linux binding, musl included (the build image is Alpine)", () => {
    const lock = base();
    delete lock.packages!["node_modules/@rolldown/binding-linux-x64-musl"];
    delete lock.packages!["node_modules/vite/node_modules/@esbuild/linux-x64"];
    const res = checkLinuxLockfile(lock);
    expect(res.ok).toBe(false);
    expect(res.missing).toEqual([{ parent: "node_modules/rolldown", candidates: ["@rolldown/binding-linux-x64-musl"] }]);
    // The nested esbuild falls back to the hoisted @esbuild/linux-x64, like npm.
  });

  it("resolves nested node_modules like npm", () => {
    const lock = base();
    // The nested esbuild has its own @esbuild/linux-x64; drop the hoisted one: only the top-level esbuild breaks.
    delete lock.packages!["node_modules/@esbuild/linux-x64"];
    expect(checkLinuxLockfile(lock).missing).toEqual([{ parent: "node_modules/esbuild", candidates: ["@esbuild/linux-x64"] }]);
  });

  it("follows the server rule: x64 glibc + musl required, other architectures optional", () => {
    const lock = base();
    lock.packages!["node_modules/esbuild"]!.optionalDependencies!["@esbuild/linux-arm64"] = "0.25.0";
    expect(checkLinuxLockfile(lock).ok).toBe(true);
  });

  it("skips v1 lockfiles and names packages", () => {
    expect(checkLinuxLockfile({ lockfileVersion: 1 }).skipped).toMatch(/lockfileVersion 1/);
    expect(displayPackage("node_modules/a/node_modules/@b/c")).toBe("@b/c");
    expect(displayPackage("")).toBe("(project root)");
  });

  it("never tells the user to delete the lockfile", () => {
    expect(LOCKFILE_FIX_HINT).not.toMatch(/\bdelete\b|\bremove\b|\brm\b/i);
    expect(LOCKFILE_FIX_HINT).toMatch(/--package-lock-only/);
  });

  it("diffs lockfiles: only new platform entries are a safe repair", () => {
    const before = base();
    delete before.packages!["node_modules/@rolldown/binding-linux-x64-musl"];
    const repaired = base();
    expect(diffLockfiles(before, repaired)).toEqual({ changed: [], removed: [], addedBindings: ["node_modules/@rolldown/binding-linux-x64-musl"], addedOther: [] });
    expect(isSafeRepair(diffLockfiles(before, repaired))).toBe(true);

    const bumped = base();
    bumped.packages!["node_modules/esbuild"] = { ...bumped.packages!["node_modules/esbuild"], version: "0.25.12" };
    expect(diffLockfiles(base(), bumped).changed).toEqual(["node_modules/esbuild"]);
    const withNew = base();
    withNew.packages!["node_modules/left-pad"] = { version: "1.3.0" };
    const removed = base();
    delete removed.packages!["node_modules/plain"];
    expect(isSafeRepair(diffLockfiles(base(), bumped))).toBe(false);
    expect(isSafeRepair(diffLockfiles(base(), withNew))).toBe(false);
    expect(isSafeRepair(diffLockfiles(base(), removed))).toBe(false);
  });

  describe("repairLinuxLockfile", () => {
    let dir: string;
    const broken = (): Lockfile => {
      const lock = base();
      delete lock.packages!["node_modules/@rolldown/binding-linux-x64-musl"];
      return lock;
    };
    const lockText = () => readFileSync(path.join(dir, "package-lock.json"), "utf8");
    beforeEach(() => {
      dir = mkdtempSync(path.join(os.tmpdir(), "nanodev-lock-"));
      writeFileSync(path.join(dir, "package.json"), '{ "name": "demo" }\n');
      writeFileSync(path.join(dir, "package-lock.json"), `${JSON.stringify(broken(), null, 2)}\n`);
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));
    const npmWriting = (lock: Lockfile, code = 0) => (cwd: string, args: string[]) => {
      expect(args).toEqual(REPAIR_NPM_ARGS);
      writeFileSync(path.join(cwd, "package-lock.json"), JSON.stringify(lock));
      return { code, output: code ? "npm ERR! network" : "" };
    };

    it("keeps a repair that only adds the missing bindings", () => {
      const res = repairLinuxLockfile(dir, npmWriting(base()));
      expect(res.repaired).toBe(true);
      expect(checkLinuxLockfile(JSON.parse(lockText())).ok).toBe(true);
    });
    it("restores the original lockfile byte for byte if any version changed", () => {
      const original = lockText();
      const bumped = base();
      bumped.packages!["node_modules/esbuild"].version = "0.25.12";
      const res = repairLinuxLockfile(dir, npmWriting(bumped));
      expect(res).toMatchObject({ repaired: false, reason: expect.stringMatching(/version change/) });
      expect(lockText()).toBe(original);
    });
    it("restores when npm fails or doesn't fix it", () => {
      const original = lockText();
      expect(repairLinuxLockfile(dir, npmWriting(base(), 1))).toMatchObject({ repaired: false, reason: expect.stringMatching(/failed/) });
      expect(lockText()).toBe(original);
      expect(repairLinuxLockfile(dir, npmWriting(broken()))).toMatchObject({ repaired: false, reason: expect.stringMatching(/still leaves/) });
      expect(lockText()).toBe(original);
    });
  });
});

describe("sync helpers", () => {
  it("parses ahead/behind", () => {
    expect(parseAheadBehind("2\t3\n")).toEqual({ ahead: 2, behind: 3 });
    expect(() => parseAheadBehind("garbage")).toThrow();
  });
  it("classifies and describes", () => {
    expect(syncState(null)).toBe("no-remote");
    expect(syncState({ ahead: 0, behind: 0 })).toBe("up-to-date");
    expect(syncState({ ahead: 1, behind: 0 })).toBe("ahead");
    expect(syncState({ ahead: 0, behind: 2 })).toBe("behind");
    expect(syncState({ ahead: 1, behind: 2 })).toBe("diverged");
    expect(describeSync({ ahead: 0, behind: 1 })).toBe("1 new commit on origin/main: run nanodev pull");
    expect(describeSync({ ahead: 2, behind: 0 })).toBe("2 local commits to push");
  });
  it("parses porcelain -z including renames and spaces", () => {
    const out = " M src/App.tsx\0?? new file.txt\0R  b.ts\0a.ts\0";
    expect(parsePorcelain(out)).toEqual(["src/App.tsx", "new file.txt", "b.ts"]);
    expect(parsePorcelain("")).toEqual([]);
  });
  it("generates commit messages", () => {
    expect(generateCommitMessage([])).toBe("Update project");
    expect(generateCommitMessage(["a"])).toBe("Update a");
    expect(generateCommitMessage(["a", "b"])).toBe("Update a and b");
    expect(generateCommitMessage(["a", "b", "c"])).toBe("Update a, b and c");
    expect(generateCommitMessage(["a", "b", "c", "d", "e"])).toBe("Update a, b, c and 2 more files");
    expect(generateCommitMessage(["a", "b", "c", "d"])).toBe("Update a, b, c and 1 more file");
  });
  it("decides when dev should fetch", () => {
    const none = { remoteHead: "abc", localOriginMain: "abc", containedInHead: false, lastNotified: null };
    expect(remoteHeadAction({ ...none, remoteHead: null })).toBe("none");
    expect(remoteHeadAction({ ...none, containedInHead: true })).toBe("none");
    expect(remoteHeadAction({ ...none, lastNotified: "abc" })).toBe("none");
    expect(remoteHeadAction(none)).toBe("count");
    expect(remoteHeadAction({ ...none, localOriginMain: "old" })).toBe("fetch");
  });
  it("reads push rejections", () => {
    const stderr = "remote: Push rejected: package.json adds a package outside the allowlist\nremote: \nTo https://x/git/p.git\n ! [rejected]        HEAD -> main (fetch first)\nerror: failed to push some refs";
    expect(isNonFastForwardRejection(stderr)).toBe(true);
    expect(isNonFastForwardRejection("remote: denied\n ! [remote rejected] HEAD -> main (pre-receive hook declined)")).toBe(false);
    expect(remoteMessages(stderr)).toEqual(["Push rejected: package.json adds a package outside the allowlist"]);
  });
  it("knows what must never be committed", () => {
    for (const f of ["node_modules/react/index.js", "dist/index.html", "src/dist/x.js", ".env", ".env.local", "apps/.env.production", ".store-ssr-dev/entry.js"]) {
      expect(isNeverCommitPath(f), f).toBe(true);
    }
    for (const f of ["src/App.tsx", "README.md", "src/distance.ts", "environment.ts", ".gitignore", "dist"]) {
      expect(isNeverCommitPath(f), f).toBe(false);
    }
  });
});

describe("misc", () => {
  it("parses menu choices", () => {
    expect(parseChoice("2", 3)).toBe(1);
    expect(parseChoice("0", 3)).toBeNull();
    expect(parseChoice("4", 3)).toBeNull();
    expect(parseChoice("x", 3)).toBeNull();
  });
  it("slugifies project names", () => {
    expect(slugify("Café Store!! 2")).toBe("cafe-store-2");
    expect(slugify("***")).toBe("nanosite-project");
  });
  it("matches projects by id, then name", () => {
    const projects = [
      { id: "1", name: "Shop", type: "store" as const, updatedAt: "" },
      { id: "2", name: "shop", type: "website" as const, updatedAt: "" },
      { id: "3", name: "Blog", type: "website" as const, updatedAt: "" },
    ];
    expect(matchProject(projects, "3")?.name).toBe("Blog");
    expect(matchProject(projects, "Shop")?.id).toBe("1");
    expect(matchProject(projects, "blog")?.id).toBe("3");
    expect(matchProject(projects, "SHOP")).toBeNull();
    expect(matchProject(projects, "nope")).toBeNull();
  });
  it("accepts only file:// git URL overrides", () => {
    expect(gitUrlOverride(undefined)).toBeNull();
    expect(gitUrlOverride("file:///C:/tmp/origin.git")).toBe("file:///C:/tmp/origin.git");
    expect(() => gitUrlOverride("https://evil.test/x.git")).toThrow(/file:\/\//);
    expect(() => gitUrlOverride("/tmp/origin.git")).toThrow(/file:\/\//);
  });
  it("compares versions", () => {
    expect(versionAtLeast("2.45.1", [2, 30])).toBe(true);
    expect(versionAtLeast("2.29.0", [2, 30])).toBe(false);
    expect(versionAtLeast("3.0", [2, 30])).toBe(true);
    expect(versionAtLeast("22.12.0", [22, 12])).toBe(true);
    expect(versionAtLeast("20.18.0", [22, 12])).toBe(false);
  });
  it("builds the dev command per project type", () => {
    const store = devCommand({
      root: "/p",
      config: { projectId: "1", name: "S", type: "store", gitUrl: "", publishableKey: "pk_1", ecommerceApiUrl: "https://c.test" },
      port: 5180,
      env: {},
    });
    expect(store.args).toEqual(["dev"]);
    expect(store.cmd).toMatch(/node_modules[\\/]\.bin[\\/]store-runtime/);
    expect(store.env).toMatchObject({ PK: "pk_1", ECOMMERCE_API_URL: "https://c.test", PORT: "5180" });
    const override = devCommand({ root: "/p", config: { projectId: "1", name: "S", type: "store", gitUrl: "" }, port: 1, env: {}, storeRuntimeOverride: "/x/fake.mjs" });
    expect(override.cmd).toBe(process.execPath);
    expect(override.args).toEqual(["/x/fake.mjs", "dev"]);
    const site = devCommand({ root: "/p", config: { projectId: "1", name: "W", type: "website", gitUrl: "" }, port: 5181, env: {} });
    expect(site.cmd).toMatch(/vite/);
    expect(site.args).toEqual(["--port", "5181", "--strictPort"]);
  });
});

describe("--help", () => {
  it("every command has examples", () => {
    for (const cmd of buildProgram().commands) {
      let help = "";
      cmd.configureOutput({ writeOut: (s) => (help += s) });
      cmd.outputHelp();
      expect(help, `nanodev ${cmd.name()} --help`).toMatch(/Examples:\n {2}/);
    }
  });
  it("brands the top-level help", () => {
    let help = "";
    const program = buildProgram();
    program.configureOutput({ writeOut: (s) => (help += s) });
    program.outputHelp();
    expect(help).toMatch(/by nanosite\.ai/);
  });
});
