import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { nanodevArgv, resolveNanodevEntry, runCreate } from "./delegate.mjs";

const tmp = mkdtempSync(path.join(os.tmpdir(), "create-nanodev-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A fake install: <tmp>/<case>/node_modules/@nanosite/nanodev with (or without) dist/cli.mjs. */
const fakeInstall = (name, { built = true, pkgName = "@nanosite/nanodev" } = {}) => {
  const base = path.join(tmp, name);
  const pkg = path.join(base, "node_modules", "@nanosite", "nanodev");
  mkdirSync(path.join(pkg, "dist"), { recursive: true });
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: pkgName, version: "0.0.0", type: "module" }));
  if (built) writeFileSync(path.join(pkg, "dist", "cli.mjs"), "export const main = async (argv) => { globalThis.__nanodevArgv = argv; return 7; };\n");
  return pathToFileURL(path.join(base, "index.mjs")).href;
};

describe("create-nanodev", () => {
  it("turns its arguments into nanodev create", () => {
    expect(nanodevArgv(["my-store", "--template", "ecommerce"], "node")).toEqual(["node", "nanodev", "create", "my-store", "--template", "ecommerce"]);
    expect(nanodevArgv([], "node")).toEqual(["node", "nanodev", "create"]);
  });

  it("resolves the nanodev package installed next to it", () => {
    const from = fakeInstall("ok");
    expect(resolveNanodevEntry(from)).toBe(path.join(tmp, "ok", "node_modules", "@nanosite", "nanodev", "dist", "cli.mjs"));
  });

  it("fails with a clear message when nanodev is missing or unbuilt", () => {
    expect(() => resolveNanodevEntry(pathToFileURL(path.join(tmp, "nowhere", "x.mjs")).href)).toThrow(/isn't installed/);
    expect(() => resolveNanodevEntry(fakeInstall("unbuilt", { built: false }))).toThrow(/isn't built/);
  });

  it("runs nanodev's main with create and returns its exit code", async () => {
    const entry = resolveNanodevEntry(fakeInstall("run"));
    expect(await runCreate(["shop", "--no-dev"], { entry })).toBe(7);
    expect(globalThis.__nanodevArgv.slice(1)).toEqual(["nanodev", "create", "shop", "--no-dev"]);
  });

  it("returns 1 and explains when nanodev can't be found", async () => {
    let stderr = "";
    const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
    try {
      const from = pathToFileURL(path.join(tmp, "nowhere", "x.mjs")).href;
      expect(await runCreate([], { resolveFrom: from })).toBe(1);
    } finally {
      write.mockRestore();
    }
    expect(stderr).toMatch(/create-nanodev: .*isn't installed/);
  });
});
