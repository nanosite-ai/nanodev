// Is this package-lock.json installable on Linux (what the cloud builds on: Alpine, so musl)?
//
// npm records a package's platform-specific optional dependencies (native bindings such as
// @rolldown/binding-*, @esbuild/*, @rollup/rollup-*, sharp's @img/*, lightningcss-*) in the lockfile.
// Some npm versions drop the other platforms' variants when the lock is written on Windows or macOS,
// and `npm ci` on Linux then installs without the binary. The rule is the server's own
// (`checkLockfileInstallableOnLinux` in @nanosite/contracts, vendored into src/vendor/, also the push policy): every Linux x64
// optional dependency, glibc AND musl, must resolve to a lockfile entry. This module only adapts it to
// the CLI's output and keeps the lockfileVersion 1 hint.
import { checkLockfileInstallableOnLinux } from "../vendor/lockfile.mjs";

export interface LockPackage {
  version?: string;
  optionalDependencies?: Record<string, string>;
  os?: string[];
  cpu?: string[];
  libc?: string[];
  link?: boolean;
}

export interface Lockfile {
  lockfileVersion?: number;
  packages?: Record<string, LockPackage>;
}

export interface MissingBinding {
  /** Lockfile path of the package that wants the binding ("" = the project root). */
  parent: string;
  /** The Linux x64 optional dependencies it declares that are not in the lockfile. */
  candidates: string[];
}

export interface LockfileCheck {
  ok: boolean;
  missing: MissingBinding[];
  /** Why the check couldn't run (old lockfile format), when it couldn't. */
  skipped?: string;
}

const NODE_MODULES = "node_modules/";

export const checkLinuxLockfile = (lock: Lockfile): LockfileCheck => {
  const packages = lock.packages;
  if (!packages) return { ok: true, missing: [], skipped: "lockfileVersion 1 has no `packages` map: run npm install to upgrade it" };
  // The shared check wants a v2+ lockfile with a root entry; a `packages` map is all this rule reads.
  const result = checkLockfileInstallableOnLinux({ ...lock, lockfileVersion: Math.max(lock.lockfileVersion ?? 2, 2), packages: { "": {}, ...packages } });
  const byParent = new Map<string, string[]>();
  for (const { package: parent, binding } of result.missing) byParent.set(parent, [...(byParent.get(parent) ?? []), binding]);
  return { ok: result.ok, missing: [...byParent].map(([parent, candidates]) => ({ parent, candidates })) };
};

export interface LockfileDiff {
  /** Entries whose resolved version changed. */
  changed: string[];
  /** Entries that disappeared. */
  removed: string[];
  /** New entries that are platform-specific (os/cpu/libc restricted): the only kind a repair may add. */
  addedBindings: string[];
  /** New entries that are NOT platform-specific (a repair must never add these). */
  addedOther: string[];
}

/** Compare two lockfiles' `packages` maps. A safe repair has only `addedBindings`. */
export const diffLockfiles = (before: Lockfile, after: Lockfile): LockfileDiff => {
  const a = before.packages ?? {};
  const b = after.packages ?? {};
  const diff: LockfileDiff = { changed: [], removed: [], addedBindings: [], addedOther: [] };
  for (const [key, pkg] of Object.entries(a)) {
    if (!b[key]) diff.removed.push(key);
    else if (pkg.version !== b[key].version) diff.changed.push(key);
  }
  for (const [key, pkg] of Object.entries(b)) {
    if (a[key]) continue;
    if (pkg.os || pkg.cpu || pkg.libc) diff.addedBindings.push(key);
    else diff.addedOther.push(key);
  }
  return diff;
};

export const isSafeRepair = (diff: LockfileDiff): boolean =>
  diff.changed.length === 0 && diff.removed.length === 0 && diff.addedOther.length === 0;

/** "node_modules/rolldown" → "rolldown"; "" → "(project root)". */
export const displayPackage = (lockPath: string): string => {
  if (!lockPath) return "(project root)";
  const idx = lockPath.lastIndexOf(NODE_MODULES);
  return idx >= 0 ? lockPath.slice(idx + NODE_MODULES.length) : lockPath;
};

export const LOCKFILE_FIX_HINT =
  "add the missing entries without changing any version: run `npm install --package-lock-only` with npm 10.9 or newer, check that `git diff package-lock.json` only adds platform packages, and commit it";
