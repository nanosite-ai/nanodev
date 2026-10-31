#!/usr/bin/env node
// nanodev entry shim: hands off to the compiled CLI in dist/ (`npm run build` produces it).
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.mjs");
if (!existsSync(entry)) {
  process.stderr.write("nanodev: dist/ is missing, run `npm run build` in the nanodev package first\n");
  process.exit(1);
}
const { main } = await import(pathToFileURL(entry).href);
await main(process.argv);
