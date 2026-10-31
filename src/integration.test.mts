// End-to-end over real git: a local bare repo (file://) stands in for the project's git URL
// (NANODEV_GIT_URL_OVERRIDE) and a tiny HTTP server stands in for the nano-site API.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { main } from "./cli.mjs";

const TOKEN = "ndv_test_token";
const PROJECT_ID = "p1";

let tmp: string;
let bare: string;
let server: Server;
let apiOrigin: string;
let projectType: "store" | "website" = "website";

/** The fake deploy endpoint: what was asked, and a refusal to answer with. */
const deploys: { body: Record<string, unknown>; polls: number }[] = [];
let deployRefusal: { status: number; code: string; error?: string } | null = null;
/** The fake answers with a running job of this mode, whatever was asked. */
let forcedJobMode: "production" | "preview" | null = null;
const onMain = (sha: string): boolean => {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "refs/heads/main"], { cwd: bare });
    return true;
  } catch {
    return false;
  }
};
/** The fake preview builder: how many polls a sha stays "building", and whether it then fails. */
const previewBuild = { pollsBeforeDone: 1, fail: false, rebuilds: 0, unavailable: 0 };
const previewPolls = new Map<string, number>();
const previewOutcomes = new Map<string, string>();
const savedEnv = { ...process.env };

const sh = (cwd: string, ...args: string[]): string => {
  // Never fall back to the process cwd (a filtered run leaves the clones unset): that would be this repo.
  if (!cwd) throw new Error(`sh: no directory for git ${args.join(" ")}`);
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
};

const refSha = (ref: string): string | null => {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: bare, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

const bareHead = (): string | null => refSha("refs/heads/main");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  json: () => Record<string, unknown>;
}

/** Run the CLI in-process and capture what it writes. */
const nanodev = async (...args: string[]): Promise<Run> => {
  let stdout = "";
  let stderr = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  });
  let code: number;
  try {
    code = await main(["node", "nanodev", ...args]);
  } finally {
    out.mockRestore();
    err.mockRestore();
    process.exitCode = 0;
  }
  return { code, stdout, stderr, json: () => JSON.parse(stdout) as Record<string, unknown> };
};

const edit = (dir: string, file: string, content: string) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), content);
};

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "nanodev-it-"));
  const gitConfig = path.join(tmp, "gitconfig");
  writeFileSync(gitConfig, "[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n");
  Object.assign(process.env, {
    NANODEV_HOME: path.join(tmp, "home"),
    NANODEV_TOKEN: TOKEN,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Dev",
    GIT_AUTHOR_EMAIL: "dev@example.test",
    GIT_COMMITTER_NAME: "Dev",
    GIT_COMMITTER_EMAIL: "dev@example.test",
  });

  // The "cloud" repo with one commit on main.
  bare = path.join(tmp, "origin.git");
  sh(tmp, "init", "--quiet", "--bare", bare);
  sh(bare, "symbolic-ref", "HEAD", "refs/heads/main");
  const seed = path.join(tmp, "seed");
  sh(tmp, "clone", "--quiet", pathToFileURL(bare).href, seed);
  edit(seed, "package.json", '{ "name": "demo", "private": true }\n');
  edit(seed, ".gitignore", "node_modules/\ndist/\n.env*\n.store-ssr-dev/\n");
  edit(seed, "src/App.tsx", "export const App = () => 'v1';\n");
  sh(seed, "add", "-A");
  sh(seed, "commit", "--quiet", "-m", "Initial");
  sh(seed, "push", "--quiet", "origin", "HEAD:main");
  process.env.NANODEV_GIT_URL_OVERRIDE = pathToFileURL(bare).href;

  server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { success: false, error: "Unauthorized" });
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/api/cli/me") return send(200, { user: { id: "u1", email: "dev@example.test" } });
    if (url.pathname === "/api/cli/projects") {
      return send(200, { projects: [{ id: PROJECT_ID, name: "Demo Shop", type: projectType, updatedAt: "2026-10-30T00:00:00Z" }] });
    }
    if (url.pathname === `/api/cli/projects/${PROJECT_ID}/dev-config`) {
      return send(200, {
        projectId: PROJECT_ID,
        name: "Demo Shop",
        type: projectType,
        gitUrl: "http://unused.invalid/git/p1.git",
        previewUrl: "https://p1-preview.nanosite.live/",
        ...(projectType === "store" ? { publishableKey: "pk_test_1", ecommerceApiUrl: "http://localhost:4999" } : {}),
      });
    }
    if (url.pathname === `/api/projects/${PROJECT_ID}/repo-head`) return send(200, { headSha: bareHead(), parked: [], previewSha: bareHead(), newerOnMain: [] });
    if (url.pathname === `/api/projects/${PROJECT_ID}/deploy` && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
      req.on("end", () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        if (deployRefusal) {
          return send(deployRefusal.status, { success: false, code: deployRefusal.code, error: deployRefusal.error ?? "refused" });
        }
        if (forcedJobMode) {
          return send(202, { success: true, job: { id: "jobX", projectId: PROJECT_ID, mode: forcedJobMode, sha: body.sha, status: "running", logs: [] } });
        }
        if (typeof body.sha !== "string" || !onMain(body.sha)) return send(409, { success: false, code: "sha_not_on_main", error: "no" });
        deploys.push({ body, polls: 0 });
        return send(202, { success: true, job: { id: `job${deploys.length}`, projectId: PROJECT_ID, mode: body.mode, sha: body.sha, status: "pending", logs: [] } });
      });
      return;
    }
    const jobMatch = /^\/api\/projects\/p1\/deploy\/job(\d+)$/.exec(url.pathname);
    if (jobMatch) {
      const d = deploys[Number(jobMatch[1]) - 1];
      d.polls++;
      const logs = [{ at: "t", message: "Installing dependencies…" }, { at: "t", message: "Running production build…" }];
      const sha = d.body.sha as string;
      if (d.polls === 1) return send(200, { success: true, job: { id: `job${jobMatch[1]}`, sha, status: "running", logs: logs.slice(0, 1) } });
      return send(200, {
        success: true,
        job: {
          id: `job${jobMatch[1]}`,
          sha,
          status: "succeeded",
          logs,
          result:
            d.body.mode === "preview"
              ? { url: "https://p1-preview.nanosite.live/", version: "preview", commitSha: sha }
              : { url: "https://p1.nanosite.live/", version: (d.body.version as string) ?? "0.1.1", commitSha: sha },
        },
      });
    }
    if (url.pathname === `/api/projects/${PROJECT_ID}/repo-head`) return send(200, { headSha: bareHead() });
    if (url.pathname === `/api/cli/projects/${PROJECT_ID}/preview/rebuild` && req.method === "POST") {
      const sha = refSha("refs/previews/u1");
      if (!sha) return send(404, { success: false, error: "No preview yet" });
      previewBuild.rebuilds++;
      previewPolls.delete(sha);
      previewOutcomes.delete(sha);
      return send(200, { status: "building", sha, url: null, servedSha: null, builtAt: null, pushedAt: "2026-10-30T00:00:00Z" });
    }
    if (url.pathname === `/api/cli/projects/${PROJECT_ID}/preview`) {
      const sha = refSha("refs/previews/u1");
      if (!sha) return send(404, { success: false, error: "No preview yet" });
      // Simulated restarts start once a rebuild was requested (the pre-push status check must see the failure).
      if (previewBuild.unavailable > 0 && previewBuild.rebuilds > 0) {
        previewBuild.unavailable--;
        return send(503, { success: false, error: "restarting" });
      }
      const polls = (previewPolls.get(sha) ?? 0) + 1;
      previewPolls.set(sha, polls);
      const done = polls > previewBuild.pollsBeforeDone;
      // A finished build keeps its outcome (until a rebuild), like the real state file.
      if (done && !previewOutcomes.has(sha)) previewOutcomes.set(sha, previewBuild.fail ? "failed" : "ready");
      const status = !done ? "building" : previewOutcomes.get(sha)!;
      return send(200, {
        status,
        sha,
        url: "https://project-draft-p1-u1.nanosite.ai/",
        servedSha: status === "ready" ? sha : null,
        builtAt: status === "ready" ? "2026-10-30T00:00:00Z" : null,
        pushedAt: "2026-10-30T00:00:00Z",
        ...(status === "failed" ? { error: "Store SSR build failed", log: ["line 1", "src/App.tsx: Unexpected token"].join("\n") } : {}),
      });
    }
    return send(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.NANODEV_API = apiOrigin;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.env = savedEnv;
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
});

describe("nanodev against a local bare repo", () => {
  let a: string;
  let b: string;

  it("whoami and doctor talk to the API with the token", async () => {
    const who = await nanodev("whoami", "--json");
    expect(who.code).toBe(0);
    expect(who.json()).toMatchObject({ api: apiOrigin, user: { email: "dev@example.test" }, tokenSource: "env" });
    const doc = await nanodev("doctor", "--json", "-C", tmp);
    const checks = doc.json().checks as { name: string; status: string }[];
    expect(checks.find((ch) => ch.name === "auth")?.status).toBe("ok");
    expect(checks.find((ch) => ch.name === "git")?.status).toBe("ok");
  });

  it("links two clones", async () => {
    const first = await nanodev("link", PROJECT_ID, "--dir", "a", "--json", "-C", tmp);
    expect(first.code, first.stderr).toBe(0);
    expect(first.json()).toMatchObject({ projectId: PROJECT_ID, type: "website", installed: false });
    a = first.json().dir as string;
    const linked = JSON.parse(readFileSync(path.join(a, ".nanodev", "project.json"), "utf8"));
    expect(linked).toEqual({ projectId: PROJECT_ID, api: apiOrigin, type: "website", name: "Demo Shop" });
    // .nanodev/ is never committed.
    expect(readFileSync(path.join(a, ".git", "info", "exclude"), "utf8")).toContain("/.nanodev/");
    expect(sh(a, "status", "--porcelain")).toBe("");

    const second = await nanodev("link", "demo shop", "--dir", "b", "--json", "-C", tmp);
    expect(second.code, second.stderr).toBe(0);
    b = second.json().dir as string;

    const again = await nanodev("link", PROJECT_ID, "--dir", "a", "-C", tmp);
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/isn't an empty folder/);
  });

  it("link without a project fails fast when there is no TTY", async () => {
    const res = await nanodev("link", "--json", "-C", tmp);
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/pass the project id/);
  });

  it("push commits local edits and pushes them; the other clone pulls them", async () => {
    edit(a, "src/App.tsx", "export const App = () => 'v2';\n");
    const push = await nanodev("push", "-m", "Edit from a", "--json", "-C", a);
    expect(push.code, push.stderr).toBe(0);
    expect(push.json()).toMatchObject({ pushed: true, pulled: 0 });
    expect(bareHead()).toBe(sh(a, "rev-parse", "HEAD"));
    expect(sh(bare, "log", "-1", "--format=%s", "main")).toBe("Edit from a");

    const status = await nanodev("status", "--json", "-C", b);
    // No `nanodev preview` yet: no preview URL (dev-config's previewUrl host is not shown as one).
    expect(status.json()).toMatchObject({ ahead: 0, behind: 1, state: "behind", previewUrl: null, preview: null });

    const pull = await nanodev("pull", "--json", "-C", b);
    expect(pull.code, pull.stderr).toBe(0);
    expect(pull.json()).toMatchObject({ newCommits: 1, lockfileChanged: false, installed: false });
    expect(readFileSync(path.join(b, "src/App.tsx"), "utf8")).toContain("v2");
  });

  it("nothing to push is a no-op", async () => {
    const push = await nanodev("push", "--json", "-C", b);
    expect(push.json()).toMatchObject({ pushed: false });
  });

  it("push --no-rebase is refused when behind; pull then push works and nothing is lost", async () => {
    edit(a, "a.txt", "from a\n");
    expect((await nanodev("push", "-C", a)).code).toBe(0);

    edit(b, "b.txt", "from b\n");
    const refused = await nanodev("push", "--no-rebase", "-m", "From b", "-C", b);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/1 new commit\(s\).*run nanodev pull/);

    expect((await nanodev("pull", "-C", b)).code).toBe(0);
    const pushed = await nanodev("push", "--json", "-C", b);
    expect(pushed.code, pushed.stderr).toBe(0);
    expect(sh(bare, "show", "main:a.txt")).toBe("from a");
    expect(sh(bare, "show", "main:b.txt")).toBe("from b");
  });

  it("push rebases automatically when someone pushed first", async () => {
    edit(a, "a2.txt", "a2\n");
    expect((await nanodev("push", "-C", a)).code).toBe(0);
    edit(b, "b2.txt", "b2\n");
    const pushed = await nanodev("push", "--json", "-C", b);
    expect(pushed.code, pushed.stderr).toBe(0);
    expect(pushed.json()).toMatchObject({ pushed: true, pulled: 1 });
    expect(sh(bare, "show", "main:a2.txt")).toBe("a2");
    expect(sh(bare, "show", "main:b2.txt")).toBe("b2");
  });

  it("pull refuses a dirty tree unless --autostash", async () => {
    edit(a, "src/App.tsx", "export const App = () => 'local wip';\n");
    const refused = await nanodev("pull", "-C", a);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/uncommitted change.*--autostash/);
    const stashed = await nanodev("pull", "--autostash", "--json", "-C", a);
    expect(stashed.code, stashed.stderr).toBe(0);
    expect(stashed.json()).toMatchObject({ newCommits: 1 });
    expect(readFileSync(path.join(a, "src/App.tsx"), "utf8")).toContain("local wip");
    expect(existsSync(path.join(a, "b2.txt"))).toBe(true);
    sh(a, "checkout", "--", "src/App.tsx");
  });

  it("pull runs npm ci when package-lock.json changed", async () => {
    const lock = { name: "demo", lockfileVersion: 3, requires: true, packages: { "": { name: "demo" } } };
    edit(a, "package-lock.json", `${JSON.stringify(lock, null, 2)}\n`);
    expect((await nanodev("push", "-m", "Add lockfile", "-C", a)).code).toBe(0);
    const pull = await nanodev("pull", "--json", "-C", b);
    expect(pull.code, pull.stderr).toBe(0);
    expect(pull.json()).toMatchObject({ newCommits: 1, lockfileChanged: true, installed: true });
  });

  it("push refuses other branches, a detached HEAD and files that must never be committed", async () => {
    sh(a, "switch", "--quiet", "-c", "feature");
    const branch = await nanodev("push", "-C", a);
    expect(branch.code).toBe(1);
    expect(branch.stderr).toMatch(/on branch "feature".*publishes main/);
    sh(a, "switch", "--quiet", "--detach", "main");
    const detached = await nanodev("push", "-C", a);
    expect(detached.stderr).toMatch(/HEAD is detached/);
    sh(a, "switch", "--quiet", "main");
    sh(a, "branch", "--quiet", "-D", "feature");

    // .gitignore keeps .env out; force a secret past it with a renamed ignore file.
    rmSync(path.join(a, ".gitignore"));
    edit(a, "src/x.ts", "x\n");
    const noIgnore = await nanodev("push", "-C", a);
    expect(noIgnore.code).toBe(1);
    expect(noIgnore.stderr).toMatch(/no \.gitignore/);
    sh(a, "checkout", "--", ".gitignore");
    edit(a, ".gitignore", "node_modules/\n");
    edit(a, ".env.local", "SECRET=1\n");
    const secret = await nanodev("push", "-C", a);
    expect(secret.code).toBe(1);
    expect(secret.stderr).toMatch(/refusing to commit 1 file[\s\S]*\.env\.local/);
    expect(sh(a, "log", "-1", "--format=%H")).toBe(bareHead());
    rmSync(path.join(a, ".env.local"));
    rmSync(path.join(a, "src/x.ts"));
    sh(a, "checkout", "--", ".gitignore");
  });

  it("refuses a lockfile that can't install on Linux, before pushing", async () => {
    const before = bareHead();
    const lock = {
      lockfileVersion: 3,
      packages: {
        "": { name: "demo" },
        "node_modules/rolldown": { optionalDependencies: { "@rolldown/binding-linux-x64-gnu": "1.0.0", "@rolldown/binding-win32-x64-msvc": "1.0.0" } },
        "node_modules/@rolldown/binding-win32-x64-msvc": { version: "1.0.0" },
      },
    };
    const text = JSON.stringify(lock, null, 2);
    edit(a, "package-lock.json", text);
    const res = await nanodev("push", "-m", "Add lockfile", "--no-fix-lockfile", "-C", a);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/can't install on Linux[\s\S]*rolldown needs: @rolldown\/binding-linux-x64-gnu/);
    expect(res.stderr).not.toMatch(/delete/i);
    expect(bareHead()).toBe(before);

    // The automatic repair runs npm, which here would also drop packages package.json doesn't list:
    // that isn't a safe repair, so it is rolled back and the lockfile stays byte-identical.
    const repair = await nanodev("push", "-C", a);
    expect(repair.code).toBe(1);
    expect(repair.stderr).toMatch(/Automatic repair rolled back \(it would also have made .*removed package/);
    expect(readFileSync(path.join(a, "package-lock.json"), "utf8")).toBe(text);
    expect(bareHead()).toBe(before);
    // Drop the bad commit so later steps start clean.
    sh(a, "reset", "--quiet", "--hard", "origin/main");
  });

  it("prints the server's message when a push is rejected", async () => {
    const hook = path.join(bare, "hooks", "pre-receive");
    writeFileSync(hook, '#!/bin/sh\necho "Push rejected: test policy says no"\nexit 1\n', { mode: 0o755 });
    try {
      edit(a, "x.txt", "x\n");
      const res = await nanodev("push", "-C", a);
      expect(res.code).toBe(1);
      expect(res.stderr).toMatch(/push rejected by nano-site:\s+Push rejected: test policy says no/);
    } finally {
      rmSync(hook);
      sh(a, "reset", "--quiet", "--hard", "origin/main");
    }
  });

  it("preview pushes a snapshot of uncommitted work to refs/previews/<me>; HEAD, index, files and main untouched", async () => {
    process.env.NANODEV_PREVIEW_POLL_MS = "20";
    try {
      // Clean tree: previews HEAD itself.
      const clean = await nanodev("preview", "--json", "-C", a);
      expect(clean.code, clean.stderr).toBe(0);
      const cleanEvents = clean.stdout.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      const head = sh(a, "rev-parse", "HEAD");
      expect(cleanEvents[0]).toMatchObject({ event: "snapshot", sha: head, temporary: false });
      expect(cleanEvents.at(-1)).toMatchObject({ event: "ready", sha: head, url: "https://project-draft-p1-u1.nanosite.ai/" });

      // Staged, unstaged, new and deleted files.
      edit(a, "src/App.tsx", "export const App = () => 'preview wip';\n");
      edit(a, "staged.txt", "staged\n");
      sh(a, "add", "staged.txt");
      edit(a, "src/new.ts", "export const n = 1;\n");
      rmSync(path.join(a, "a.txt"));
      const statusBefore = sh(a, "status", "--porcelain");
      const indexBefore = sh(a, "ls-files", "--stage");
      const mainBefore = bareHead();

      const res = await nanodev("preview", "--json", "-C", a);
      expect(res.code, res.stderr).toBe(0);
      const events = res.stdout.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(events.map((e) => e.event)).toEqual(["snapshot", "pushed", "building", "ready"]);
      const sha = events[0]!.sha as string;
      expect(events[0]).toMatchObject({ temporary: true, uncommitted: 4 });
      expect(refSha("refs/previews/u1")).toBe(sha);
      expect(events.at(-1)).toMatchObject({ event: "ready", sha });

      // The preview commit sits on top of HEAD with every change; nothing local moved.
      expect(sh(bare, "rev-parse", `${sha}^`)).toBe(head);
      expect(sh(bare, "show", `${sha}:src/App.tsx`)).toContain("preview wip");
      expect(sh(bare, "show", `${sha}:staged.txt`)).toBe("staged");
      expect(sh(bare, "show", `${sha}:src/new.ts`)).toContain("n = 1");
      expect(() => sh(bare, "cat-file", "-e", `${sha}:a.txt`)).toThrow();
      expect(sh(a, "rev-parse", "HEAD")).toBe(head);
      expect(sh(a, "symbolic-ref", "--short", "HEAD")).toBe("main");
      expect(sh(a, "status", "--porcelain")).toBe(statusBefore);
      expect(sh(a, "ls-files", "--stage")).toBe(indexBefore);
      expect(sh(a, "stash", "list")).toBe("");
      expect(readFileSync(path.join(a, "src/App.tsx"), "utf8")).toContain("preview wip");
      expect(bareHead()).toBe(mainBefore);

      // A failed build: exit 1 with the error and the log tail.
      edit(a, "src/App.tsx", "export const App = () => 'broken';\n");
      previewBuild.fail = true;
      const failed = await nanodev("preview", "-C", a);
      expect(failed.code).toBe(1);
      expect(failed.stderr).toMatch(/preview build failed: Store SSR build failed[\s\S]*Unexpected token/);
      expect(bareHead()).toBe(mainBefore);

      // Retrying the exact same commit after a failure: the push changes nothing, so it asks for a rebuild.
      // The status endpoint is briefly unavailable (503) while waiting: the CLI retries instead of failing.
      sh(a, "add", "-A");
      sh(a, "commit", "--quiet", "-m", "local commit, not pushed to main");
      previewBuild.fail = true;
      expect((await nanodev("preview", "-C", a)).code).toBe(1);
      previewBuild.fail = false;
      previewBuild.unavailable = 2;
      const retried = await nanodev("preview", "--json", "-C", a);
      expect(retried.code, retried.stderr).toBe(0);
      const retryEvents = retried.stdout.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(retryEvents.map((e) => e.event), retried.stdout + retried.stderr).toEqual(["snapshot", "pushed", "rebuild", "building", "ready"]);
      expect(retryEvents[0]).toMatchObject({ temporary: false, sha: sh(a, "rev-parse", "HEAD") });
      expect(previewBuild.rebuilds).toBe(1);
      expect(retried.stderr).toMatch(/retrying/);
      expect(bareHead()).toBe(mainBefore);
      sh(a, "reset", "--quiet", "--hard", "HEAD~1");
    } finally {
      previewBuild.fail = false;
      delete process.env.NANODEV_PREVIEW_POLL_MS;
      sh(a, "reset", "--quiet", "--hard", "HEAD");
      sh(a, "clean", "--quiet", "-fd", "src", "staged.txt");
    }
  });

  it("preview refuses an unlinked folder and files that must never leave the machine", async () => {
    const unlinked = await nanodev("preview", "-C", tmp);
    expect(unlinked.code).toBe(1);
    expect(unlinked.stderr).toMatch(/isn't linked/);
    edit(a, ".gitignore", "node_modules/\n");
    edit(a, ".env.local", "SECRET=1\n");
    const before = refSha("refs/previews/u1");
    const secret = await nanodev("preview", "-C", a);
    expect(secret.code).toBe(1);
    expect(secret.stderr).toMatch(/refusing to commit 1 file[\s\S]*\.env\.local/);
    expect(refSha("refs/previews/u1")).toBe(before);
    rmSync(path.join(a, ".env.local"));
    sh(a, "checkout", "--", ".gitignore");
  });

  it("dev starts the store runtime with PK / ECOMMERCE_API_URL / PORT and reports new commits", async () => {
    projectType = "store";
    const envOut = path.join(tmp, "runtime-env.json");
    const fake = path.join(tmp, "fake-runtime.mjs");
    writeFileSync(
      fake,
      `import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
const { PK, ECOMMERCE_API_URL, PORT } = process.env;
writeFileSync(${JSON.stringify(envOut)}, JSON.stringify({ argv: process.argv.slice(2), PK, ECOMMERCE_API_URL, PORT }));
// Listen only after a moment, like a real dev server warming up.
setTimeout(() => createServer((_q, r) => r.end("ok")).listen(Number(PORT), "127.0.0.1"), 400);
setTimeout(() => process.exit(0), 3000);
`,
    );
    // b falls one commit behind.
    edit(a, "c.txt", "c\n");
    expect((await nanodev("push", "-C", a)).code).toBe(0);

    process.env.NANODEV_STORE_RUNTIME_BIN = fake;
    process.env.NANODEV_REPO_HEAD_POLL_MS = "200";
    try {
      const dev = await nanodev("dev", "--port", "5299", "--json", "-C", b);
      expect(dev.code, dev.stderr).toBe(0);
      const events = dev.stdout.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(events[0]).toMatchObject({ event: "ready", url: "http://localhost:5299/", type: "store" });
      expect(events.find((e) => e.event === "behind")).toMatchObject({ behind: 1, headSha: bareHead() });
      expect(events.filter((e) => e.event === "behind")).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ event: "exit", code: 0 });
      expect(JSON.parse(readFileSync(envOut, "utf8"))).toEqual({ argv: ["dev"], PK: "pk_test_1", ECOMMERCE_API_URL: "http://localhost:4999", PORT: "5299" });
      // dev never touches the working tree.
      expect(existsSync(path.join(b, "c.txt"))).toBe(false);
    } finally {
      delete process.env.NANODEV_STORE_RUNTIME_BIN;
      delete process.env.NANODEV_REPO_HEAD_POLL_MS;
      projectType = "website";
    }
  });

  it("publish pushes first, then publishes exactly the pushed commit and streams the build", async () => {
    sh(b, "pull", "--quiet", "--rebase", "origin", "main");
    edit(b, "src/Publish.tsx", "export const P = 1;\n");
    process.env.NANODEV_PUBLISH_POLL_MS = "20";
    try {
      const res = await nanodev("publish", "-m", "Ready to ship", "--json", "-C", b);
      expect(res.code, res.stderr).toBe(0);
      const head = sh(b, "rev-parse", "HEAD");
      expect(bareHead()).toBe(head);
      expect(sh(bare, "log", "-1", "--format=%s", "main")).toBe("Ready to ship");
      expect(deploys.at(-1)?.body).toEqual({ mode: "production", sha: head });
      const events = res.stdout.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(events.map((e) => e.event)).toEqual(["pushed", "queued", "log", "status", "log", "published"]);
      expect(events.at(-1)).toMatchObject({ sha: head, version: "0.1.1", url: "https://p1.nanosite.live/" });

      // Nothing new: publishes the same head again, with an explicit version, without pushing.
      const again = await nanodev("publish", "--no-push", "--as", "2.0.0", "-C", b);
      expect(again.code, again.stderr).toBe(0);
      expect(again.stdout).toMatch(/Published [0-9a-f]{7} as 2\.0\.0/);
      expect(again.stdout).toContain("live    https://p1.nanosite.live/");
      expect(deploys.at(-1)?.body).toEqual({ mode: "production", sha: head, version: "2.0.0" });
    } finally {
      delete process.env.NANODEV_PUBLISH_POLL_MS;
    }
  });

  it("publish --preview-link pushes, then builds exactly that commit to the preview link", async () => {
    edit(b, "src/PreviewLink.tsx", "export const L = 1;\n");
    process.env.NANODEV_PUBLISH_POLL_MS = "20";
    try {
      const res = await nanodev("publish", "--preview-link", "-m", "Try it on the preview link", "--json", "-C", b);
      expect(res.code, res.stderr).toBe(0);
      const head = sh(b, "rev-parse", "HEAD");
      expect(bareHead()).toBe(head);
      expect(deploys.at(-1)?.body).toEqual({ mode: "preview", sha: head });
      const events = res.stdout.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(events.map((e) => e.event)).toEqual(["pushed", "queued", "log", "status", "log", "published"]);
      expect(events.find((e) => e.event === "queued")).toMatchObject({ mode: "preview", sha: head });
      expect(events.at(-1)).toMatchObject({ mode: "preview", sha: head, version: null, url: "https://p1-preview.nanosite.live/" });

      const human = await nanodev("publish", "--preview-link", "--no-push", "-C", b);
      expect(human.code, human.stderr).toBe(0);
      expect(human.stdout).toMatch(/Published [0-9a-f]{7} to the preview link/);
      expect(human.stdout).toContain("preview https://p1-preview.nanosite.live/");

      const withVersion = await nanodev("publish", "--preview-link", "--no-push", "--as", "3.0.0", "-C", b);
      expect(withVersion.code).toBe(1);
      expect(withVersion.stderr).toMatch(/the preview link has none/);
    } finally {
      delete process.env.NANODEV_PUBLISH_POLL_MS;
    }
  });

  it("publish --preview-link --as is refused before anything is committed or pushed", async () => {
    const before = bareHead();
    const localBefore = sh(b, "rev-parse", "HEAD");
    edit(b, "src/NotYet.tsx", "export const N = 1;\n");
    const res = await nanodev("publish", "--preview-link", "--as", "3.0.0", "-m", "should not be committed", "-C", b);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/the preview link has none/);
    expect(bareHead()).toBe(before);
    expect(sh(b, "rev-parse", "HEAD")).toBe(localBefore);
    expect(sh(b, "status", "--porcelain")).toContain("src/NotYet.tsx");
    rmSync(path.join(b, "src", "NotYet.tsx"));
  });

  it("publish refuses a running job of the other target instead of reporting it as its own", async () => {
    for (const [args, running, text] of [
      [["publish", "--no-push"], "preview", /answered with a preview link build/],
      [["publish", "--preview-link", "--no-push"], "production", /answered with a live site publish/],
    ] as const) {
      forcedJobMode = running;
      try {
        const res = await nanodev(...args, "--json", "-C", b);
        expect(res.code).toBe(1);
        const events = res.stdout.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
        expect(events.some((e) => e.event === "published")).toBe(false);
        expect(events.at(-1)).toMatchObject({ event: "failed" });
        expect(String(events.at(-1)?.error)).toMatch(text);
      } finally {
        forcedJobMode = null;
      }
    }
  });

  it("publish --preview-link without a plan gets a clear message and a terminal failed event", async () => {
    deployRefusal = { status: 403, code: "preview_plan_required" };
    try {
      const res = await nanodev("publish", "--preview-link", "--no-push", "--json", "-C", b);
      expect(res.code).toBe(1);
      const last = JSON.parse(res.stdout.trim().split("\n").at(-1)!) as Record<string, unknown>;
      expect(last).toMatchObject({ event: "failed", code: "preview_plan_required" });
      expect(String(last.error)).toMatch(/preview link is part of a plan/);
    } finally {
      deployRefusal = null;
    }
  });

  it("publish --no-push refuses unpushed commits; refusals from nano-site get clear messages", async () => {
    const count = deploys.length;
    edit(b, "local.txt", "local\n");
    sh(b, "add", "-A");
    sh(b, "commit", "--quiet", "-m", "local only");
    const unpushed = await nanodev("publish", "--no-push", "-C", b);
    expect(unpushed.code).toBe(1);
    expect(unpushed.stderr).toMatch(/aren't on origin\/main: run nanodev publish without --no-push/);
    expect(deploys.length).toBe(count);
    sh(b, "reset", "--quiet", "--hard", "origin/main");

    for (const [code, text] of [
      ["agent_change_parked", /agent change that conflicted/],
      ["project_busy", /busy with another change/],
      ["deploy_in_progress", /A preview link build of commit abc is running/],
      ["version_exists", /already published/],
    ] as const) {
      deployRefusal = { status: 409, code, ...(code === "deploy_in_progress" ? { error: "A preview link build of commit abc is running for this project." } : {}) };
      try {
        const res = await nanodev("publish", "--no-push", "-C", b);
        expect(res.code).toBe(1);
        expect(res.stderr).toMatch(text);
        // --json always ends with one terminal event carrying the refusal code.
        const json = await nanodev("publish", "--no-push", "--json", "-C", b);
        expect(json.code).toBe(1);
        const last = JSON.parse(json.stdout.trim().split("\n").at(-1)!) as Record<string, unknown>;
        expect(last).toMatchObject({ event: "failed", code, sha: sh(b, "rev-parse", "HEAD") });
        expect(String(last.error)).toMatch(text);
      } finally {
        deployRefusal = null;
      }
    }
  });

  it("publish outside a linked folder fails fast", async () => {
    const res = await nanodev("publish", "-C", tmp);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/not inside a linked project/);
  });

  it("NANODEV_PLUGIN_DIR offers a local plugin without dirtying the clone; doctor checks the committed offer", async () => {
    process.env.NANODEV_PLUGIN_DIR = path.join(tmp, "plugin");
    try {
      const res = await nanodev("link", PROJECT_ID, "--dir", "c", "--json", "-C", tmp);
      expect(res.code, res.stderr).toBe(0);
      const dir = res.json().dir as string;
      const local = JSON.parse(readFileSync(path.join(dir, ".claude", "settings.local.json"), "utf8"));
      expect(local.extraKnownMarketplaces.nanodev).toEqual({ source: { source: "directory", path: path.join(tmp, "plugin") } });
      expect(sh(dir, "status", "--porcelain")).toBe("");

      const missing = (await nanodev("doctor", "--json", "-C", dir)).json().checks as { name: string; status: string }[];
      expect(missing.find((ch) => ch.name === "plugin")?.status).toBe("warn");
      edit(dir, ".claude/settings.json", JSON.stringify({ extraKnownMarketplaces: { nanodev: { source: { source: "github", repo: "nanosite-ai/nanodev" } } } }));
      const ok = (await nanodev("doctor", "--json", "-C", dir)).json().checks as { name: string; status: string }[];
      expect(ok.find((ch) => ch.name === "plugin")?.status).toBe("ok");
    } finally {
      delete process.env.NANODEV_PLUGIN_DIR;
    }
  });
});
