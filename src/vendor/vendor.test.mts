// The vendored copies (src/vendor/) must match their nano-site sources byte for byte (after the header).
// Outside the monorepo (the public nanodev repo) the sources aren't there and the check is skipped.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs build script without type declarations
import { VENDORED, expectedVendored } from "../../scripts/vendor.mjs";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("vendored modules", () => {
  for (const [target, source] of Object.entries(VENDORED as Record<string, string>)) {
    const expected = (expectedVendored as (s: string) => string | null)(source);
    it.skipIf(expected === null)(`${target} matches ${source} (run npm run vendor -w @nanosite/nanodev)`, () => {
      const current = readFileSync(path.join(PACKAGE_ROOT, target), "utf8").replace(/\r\n/g, "\n");
      expect(current).toBe(expected);
    });
  }
});
