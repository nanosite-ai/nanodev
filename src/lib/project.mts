// The linked folder: `.nanodev/project.json` at the root of a clone.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ProjectType } from "./api.mjs";
import { readJsonFile } from "./config.mjs";
import { CliError } from "./errors.mjs";

export const PROJECT_DIR = ".nanodev";
export const PROJECT_FILE = "project.json";

export interface LinkedProject {
  projectId: string;
  api: string;
  type: ProjectType;
  name: string;
}

export interface Linked {
  root: string;
  project: LinkedProject;
}

export const projectFilePath = (root: string): string => path.join(root, PROJECT_DIR, PROJECT_FILE);

/** Walk up from `start` to the folder that has `.nanodev/project.json`. */
export const findLinkedRoot = (start: string): string | null => {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(projectFilePath(dir))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

export const readLinked = (start: string): Linked | null => {
  const root = findLinkedRoot(start);
  if (!root) return null;
  const project = readJsonFile<LinkedProject>(projectFilePath(root));
  if (!project?.projectId) throw new CliError(`${projectFilePath(root)} has no projectId: run nanodev link again`);
  return { root, project };
};

export const requireLinked = (start: string): Linked => {
  const linked = readLinked(start);
  if (!linked) throw new CliError("not inside a linked project: run nanodev link <project> first (or cd into one)");
  return linked;
};

/** Write `.nanodev/project.json` and keep `.nanodev/` out of commits via .git/info/exclude. */
export const writeLinked = (root: string, project: LinkedProject): void => {
  mkdirSync(path.join(root, PROJECT_DIR), { recursive: true });
  writeFileSync(projectFilePath(root), `${JSON.stringify(project, null, 2)}\n`);
  const exclude = path.join(root, ".git", "info", "exclude");
  if (!existsSync(path.join(root, ".git"))) return;
  mkdirSync(path.dirname(exclude), { recursive: true });
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  const entry = `/${PROJECT_DIR}/`;
  if (!current.split(/\r?\n/).includes(entry)) {
    writeFileSync(exclude, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${entry}\n`);
  }
};

/** "My Cool Store!" → "my-cool-store" (the default clone folder). */
export const slugify = (name: string): string =>
  name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "nanosite-project";
