// login / whoami / doctor / logout against a fake API that follows the CLI token API contract:
// device-code → token polling (400 authorization_pending, 429 slow_down + Retry-After) → /api/cli/me,
// and POST /api/cli/token/revoke on logout.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../cli.mjs";
import { readCredentials, saveCredential } from "../lib/credentials.mjs";

const TOKEN = "ndv_issued_token";
const DEVICE_CODE = "device-code-1";

let tmp: string;
let server: Server;
let apiOrigin: string;
let polls = 0;
let revokeCalls: string[] = [];
let revokeStatus = 200;
let revoked = false;
const savedEnv = { ...process.env };

const run = async (...args: string[]) => {
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
    code = await main(["node", "nanodev", ...args, "--api", apiOrigin]);
  } finally {
    out.mockRestore();
    err.mockRestore();
    process.exitCode = 0;
  }
  return { code, stdout, stderr, json: () => JSON.parse(stdout) as Record<string, unknown> };
};

const readBody = async (req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
};

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "nanodev-auth-"));
  process.env.NANODEV_HOME = path.join(tmp, "home");
  delete process.env.NANODEV_TOKEN;
  delete process.env.NANODEV_API;

  server = createServer((req, res) => {
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    (async () => {
      const url = new URL(req.url ?? "/", "http://x");
      const body = req.method === "POST" ? await readBody(req) : {};
      const bearer = req.headers.authorization?.replace(/^Bearer /, "");
      if (url.pathname === "/api/cli/device-code") {
        return send(200, {
          deviceCode: DEVICE_CODE,
          userCode: "ABCD-1234",
          verificationUrl: `${apiOrigin}/cli/approve?code=ABCD-1234`,
          expiresIn: 600,
          interval: 1,
        });
      }
      if (url.pathname === "/api/cli/token") {
        if (body.deviceCode !== DEVICE_CODE) return send(400, { success: false, error: "expired_token" });
        polls += 1;
        if (polls === 1) return send(400, { success: false, error: "authorization_pending" });
        if (polls === 2) return send(429, { success: false, error: "slow_down" }, { "Retry-After": "1" });
        return send(200, { token: TOKEN, user: { id: "u1", email: "dev@example.test" } });
      }
      if (bearer !== TOKEN || revoked) return send(401, { success: false, error: "Unauthorized" });
      if (url.pathname === "/api/cli/me") return send(200, { user: { id: "u1", email: "dev@example.test", name: "Dev" } });
      if (url.pathname === "/api/cli/token/revoke" && req.method === "POST") {
        revokeCalls.push(bearer);
        if (revokeStatus === 200) revoked = true;
        return send(revokeStatus, revokeStatus === 200 ? { success: true } : { success: false, error: "internal_error" });
      }
      return send(404, { error: "not found" });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.env = savedEnv;
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
});

beforeEach(() => {
  revokeCalls = [];
  revokeStatus = 200;
  revoked = false;
});

describe("nanodev auth against the CLI token API contract", () => {
  it("logs in through the device flow (pending, then slow_down), then whoami + doctor use the token", async () => {
    polls = 0;
    const login = await run("login", "--no-browser", "--no-git-helper", "--json");
    expect(login.code).toBe(0);
    expect(login.json()).toMatchObject({ api: apiOrigin, email: "dev@example.test" });
    expect(polls).toBe(3);
    expect(readCredentials()[apiOrigin]?.token).toBe(TOKEN);

    const me = await run("whoami", "--json");
    expect(me.code).toBe(0);
    expect(me.json()).toMatchObject({ user: { email: "dev@example.test" }, tokenSource: "file" });

    const doctor = await run("doctor", "--json");
    const checks = doctor.json().checks as { name: string; status: string }[];
    expect(checks.find((ch) => ch.name === "auth")?.status).toBe("ok");
  }, 30_000);

  it("logout revokes the token on the server, then forgets it", async () => {
    saveCredential(apiOrigin, { token: TOKEN, email: "dev@example.test" });
    const out = await run("logout", "--json");
    expect(out.code).toBe(0);
    expect(revokeCalls).toEqual([TOKEN]);
    expect(out.json()).toEqual({ api: apiOrigin, removed: true, revoked: true, identityRemoved: false });
    expect(readCredentials()[apiOrigin]).toBeUndefined();
  });

  it("logout still forgets the token locally when the revoke fails", async () => {
    saveCredential(apiOrigin, { token: TOKEN, email: "dev@example.test" });
    revokeStatus = 500;
    const out = await run("logout", "--json");
    expect(out.code).toBe(0);
    expect(out.json()).toEqual({ api: apiOrigin, removed: true, revoked: false, identityRemoved: false });
    expect(readCredentials()[apiOrigin]).toBeUndefined();
  });

  it("logout without a saved token calls nothing", async () => {
    const out = await run("logout", "--json");
    expect(revokeCalls).toEqual([]);
    expect(out.json()).toEqual({ api: apiOrigin, removed: false, revoked: false, identityRemoved: false });
  });
});
