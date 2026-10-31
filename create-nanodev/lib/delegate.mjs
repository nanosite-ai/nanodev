// Find the nanodev CLI installed next to this package and run `nanodev create <args…>` in-process.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const NANODEV_PACKAGE = "@nanosite/nanodev";

/** `create-nanodev my-store --template x` → the argv nanodev's `main` expects. */
export const nanodevArgv = (args, node = process.execPath) => [node, "nanodev", "create", ...args];

/** The compiled CLI entry (`dist/cli.mjs`) of the nanodev package `resolveFrom` resolves to. */
export const resolveNanodevEntry = (resolveFrom = import.meta.url) => {
  const require = createRequire(resolveFrom);
  let pkgJson;
  try {
    pkgJson = require.resolve(`${NANODEV_PACKAGE}/package.json`);
  } catch {
    throw new Error(`${NANODEV_PACKAGE} isn't installed next to @nanosite/create-nanodev: reinstall with npm create @nanosite/nanodev@beta`);
  }
  const root = path.dirname(pkgJson);
  const { name } = JSON.parse(readFileSync(pkgJson, "utf8"));
  if (name !== NANODEV_PACKAGE) throw new Error(`expected ${NANODEV_PACKAGE} at ${root}, found ${name}`);
  const entry = path.join(root, "dist", "cli.mjs");
  if (!existsSync(entry)) throw new Error(`${NANODEV_PACKAGE} at ${root} isn't built (dist/cli.mjs is missing)`);
  return entry;
};

/** Run `nanodev create <args…>`. Resolves with the exit code. */
export const runCreate = async (args, opts = {}) => {
  let entry;
  try {
    entry = opts.entry ?? resolveNanodevEntry(opts.resolveFrom);
  } catch (err) {
    process.stderr.write(`create-nanodev: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const { main } = await import(pathToFileURL(entry).href);
  return main(nanodevArgv(args));
};
