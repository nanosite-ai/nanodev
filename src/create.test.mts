// `nanodev create` / `nanodev open` end to end: a tiny HTTP server stands in for the nano-site API and a
// local bare repo (file://, NANODEV_GIT_URL_OVERRIDE) for the new project's git URL.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli.mjs";

const TOKEN = "ndv_test_token";
const PROJECT_ID = "p42";
const WEB_URL = `https://app.example.test/backoffice/projects/${PROJECT_ID}/edit`;

let tmp: string;
let server: Server;
let apiOrigin: string;
/** What the fake server does on POST /api/cli/projects. */
let createReply: { status: number; body: unknown; drop?: boolean };
let creates: Record<string, unknown>[] = [];
const savedEnv = { ...process.env };

const sh = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const TEMPLATES = [
  { id: "ecommerce", name: "Modern Store", type: "store", description: "", previewImage: null, previewUrl: null, starter: true },
  { id: "store-beauty", name: "Beauty", type: "store", description: "", previewImage: null, previewUrl: null, starter: false },
];

const nanodev = async (...args: string[]) => {
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

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "nanodev-create-"));
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

  // The new project's repository: its first commit is the template, lockfile included.
  const bare = path.join(tmp, "project.git");
  sh(tmp, "init", "--quiet", "--bare", bare);
  sh(bare, "symbolic-ref", "HEAD", "refs/heads/main");
  const seed = path.join(tmp, "seed");
  sh(tmp, "clone", "--quiet", pathToFileURL(bare).href, seed);
  writeFileSync(path.join(seed, "package.json"), '{ "name": "my-test-store", "version": "0.0.0", "private": true }\n');
  writeFileSync(
    path.join(seed, "package-lock.json"),
    `${JSON.stringify({ name: "my-test-store", version: "0.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "my-test-store", version: "0.0.0" } } }, null, 2)}\n`,
  );
  mkdirSync(path.join(seed, "src"));
  writeFileSync(path.join(seed, "src", "App.tsx"), "export const App = () => 'template';\n");
  sh(seed, "add", "-A");
  sh(seed, "commit", "--quiet", "-m", "Import from nano-site");
  sh(seed, "push", "--quiet", "origin", "HEAD:main");
  process.env.NANODEV_GIT_URL_OVERRIDE = pathToFileURL(bare).href;

  server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { success: false, error: "Unauthorized" });
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/api/cli/templates") {
      const type = url.searchParams.get("type");
      if (type === "website") return send(200, { templates: [], allowedTypes: ["store"], upgradeUrl: "https://app.example.test/backoffice/subscription" });
      return send(200, { templates: TEMPLATES, allowedTypes: ["store"], upgradeUrl: "https://app.example.test/backoffice/subscription" });
    }
    if (url.pathname === "/api/cli/projects" && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
      req.on("end", () => {
        creates.push(JSON.parse(raw) as Record<string, unknown>);
        if (createReply.drop) {
          req.socket.destroy();
          return;
        }
        send(createReply.status, createReply.body);
      });
      return;
    }
    if (url.pathname === `/api/cli/projects/${PROJECT_ID}/dev-config`) {
      return send(200, {
        projectId: PROJECT_ID,
        name: "my-test-store",
        type: "store",
        gitUrl: "http://unused.invalid/git/p42.git",
        previewUrl: "https://p42-preview.nanosite.live/",
        webUrl: WEB_URL,
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

beforeEach(() => {
  creates = [];
  createReply = {
    status: 201,
    body: {
      projectId: PROJECT_ID,
      name: "my-test-store",
      type: "store",
      gitUrl: "http://unused.invalid/git/p42.git",
      previewUrl: "https://p42-preview.nanosite.live/",
      webUrl: WEB_URL,
    },
  };
});

describe("nanodev create", () => {
  it("creates the project, clones the template, installs it and links the folder", async () => {
    const run = await nanodev("create", "my-test-store", "--template", "ecommerce", "--no-dev", "--json", "-C", tmp);
    expect(run.code, run.stderr).toBe(0);
    const dir = path.join(tmp, "my-test-store");
    expect(creates).toEqual([{ template: "ecommerce", name: "my-test-store" }]);
    expect(run.json()).toMatchObject({ projectId: PROJECT_ID, type: "store", template: "ecommerce", dir, installed: true, webUrl: WEB_URL });
    expect(readFileSync(path.join(dir, "src", "App.tsx"), "utf8")).toContain("template");
    expect(JSON.parse(readFileSync(path.join(dir, ".nanodev", "project.json"), "utf8"))).toEqual({
      projectId: PROJECT_ID,
      api: apiOrigin,
      type: "store",
      name: "my-test-store",
    });
    // .nanodev/ stays out of commits; `installed` = npm ci ran from the template's lockfile.
    expect(sh(dir, "status", "--porcelain")).toBe("");
  });

  it("matches a template by name and derives the folder from --name", async () => {
    const run = await nanodev("create", "--template", "beauty", "--name", "Glow Shop", "--no-dev", "--skip-install", "--json", "-C", tmp);
    expect(run.code, run.stderr).toBe(0);
    expect(creates).toEqual([{ template: "store-beauty", name: "Glow Shop" }]);
    expect(run.json()).toMatchObject({ dir: path.join(tmp, "glow-shop"), installed: false });
  });

  it("without a terminal, asks for --template instead of prompting", async () => {
    const run = await nanodev("create", "x1", "--no-dev", "-C", tmp);
    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/pass --template <id>, one of: ecommerce \(Modern Store\), store-beauty \(Beauty\)/);
    expect(creates).toEqual([]);
  });

  it("refuses a non-empty folder before creating anything", async () => {
    mkdirSync(path.join(tmp, "taken"));
    writeFileSync(path.join(tmp, "taken", "file.txt"), "x");
    const run = await nanodev("create", "taken", "--template", "ecommerce", "--no-dev", "-C", tmp);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/isn't an empty folder/);
    expect(creates).toEqual([]);
  });

  it("explains the plan rule with the upgrade link", async () => {
    createReply = {
      status: 403,
      body: {
        success: false,
        error: "plan_required",
        message: "Your plan does not allow creating a website",
        upgradeUrl: "https://app.example.test/backoffice/subscription",
      },
    };
    const run = await nanodev("create", "site", "--template", "ecommerce", "--no-dev", "-C", tmp);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/Your plan does not allow creating a website: upgrade at https:\/\/app\.example\.test\/backoffice\/subscription/);
    expect(existsSync(path.join(tmp, "site"))).toBe(false);
  });

  it("names the created project and the link command when the download fails", async () => {
    const saved = process.env.NANODEV_GIT_URL_OVERRIDE;
    process.env.NANODEV_GIT_URL_OVERRIDE = pathToFileURL(path.join(tmp, "missing.git")).href;
    try {
      const run = await nanodev("create", "lost", "--template", "ecommerce", "--no-dev", "-C", tmp);
      expect(run.code).toBe(1);
      expect(run.stderr).toMatch(/git clone failed/);
      expect(run.stderr).toContain(`was created on nano-site (${PROJECT_ID}): retry the download with nanodev link ${PROJECT_ID} --dir ${path.join(tmp, "lost")}`);
    } finally {
      process.env.NANODEV_GIT_URL_OVERRIDE = saved;
    }
  });

  it("passes --org and reports what is still settling, then skips dev when nothing could be installed", async () => {
    createReply = {
      status: 201,
      body: {
        projectId: PROJECT_ID,
        name: "org-shop",
        type: "store",
        gitUrl: "http://unused.invalid/git/p42.git",
        previewUrl: "https://p42-preview.nanosite.live/",
        webUrl: WEB_URL,
        status: "pending",
        warnings: ["repo_pending", "demo_products_skipped"],
      },
    };
    // dev is on (no --no-dev): it must not start because --skip-install left nothing installed.
    const run = await nanodev("create", "org-shop", "--template", "ecommerce", "--org", "o1", "--skip-install", "-C", tmp);
    expect(run.code, run.stderr).toBe(0);
    expect(creates).toEqual([{ template: "ecommerce", name: "org-shop", orgId: "o1" }]);
    expect(run.stderr).toMatch(/git repository isn't ready yet/);
    expect(run.stderr).toMatch(/demo products weren't loaded/);
    expect(run.stderr).toMatch(/not starting nanodev dev: the dependencies aren't installed/);
  });

  it("says the project may exist when the create answer is lost", async () => {
    createReply = { status: 0, body: null, drop: true };
    const run = await nanodev("create", "dropped", "--template", "ecommerce", "--no-dev", "-C", tmp);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/may have been created anyway: check with nanodev link/);
  });

  it("without a token and a terminal, fails fast naming nanodev login", async () => {
    const saved = { token: process.env.NANODEV_TOKEN, home: process.env.NANODEV_HOME };
    delete process.env.NANODEV_TOKEN;
    process.env.NANODEV_HOME = path.join(tmp, "empty-home");
    try {
      const started = Date.now();
      const run = await nanodev("create", "anon", "--template", "ecommerce", "--no-dev", "-C", tmp);
      expect(run.code).toBe(2);
      expect(run.stderr).toMatch(/not logged in to .*: run nanodev login \(or set NANODEV_TOKEN\)/);
      expect(Date.now() - started).toBeLessThan(5_000);
      // A bad folder fails before any login attempt.
      mkdirSync(path.join(tmp, "busy"));
      writeFileSync(path.join(tmp, "busy", "x"), "x");
      expect((await nanodev("create", "busy", "-C", tmp)).stderr).toMatch(/isn't an empty folder/);
    } finally {
      process.env.NANODEV_TOKEN = saved.token;
      process.env.NANODEV_HOME = saved.home;
    }
    expect(creates).toEqual([]);
  });

  it("says when the plan has no templates of the asked type", async () => {
    const run = await nanodev("create", "w", "--type", "website", "--no-dev", "-C", tmp);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/upgrade at https:\/\/app\.example\.test\/backoffice\/subscription/);
  });

  it("rejects an unknown --type and an unknown --template", async () => {
    expect((await nanodev("create", "--type", "blog", "-C", tmp)).stderr).toMatch(/invalid --type "blog"/);
    expect((await nanodev("create", "--template", "nope", "--no-dev", "-C", tmp)).stderr).toMatch(/no template matches "nope"/);
  });
});

describe("nanodev open", () => {
  it("prints the project's editor URL from inside the linked folder", async () => {
    const run = await nanodev("open", "--no-browser", "--json", "-C", path.join(tmp, "my-test-store"));
    expect(run.code, run.stderr).toBe(0);
    expect(run.json()).toEqual({ target: "web", url: WEB_URL, opened: false });
  });

  it("explains a target that has no URL yet", async () => {
    const run = await nanodev("open", "live", "--no-browser", "-C", path.join(tmp, "my-test-store"));
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/isn't published yet/);
  });
});
