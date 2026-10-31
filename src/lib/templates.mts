// Picking what `nanodev create` starts from: the templates the server lists for this user.
import path from "node:path";
import { PROJECT_TYPE, type CliTemplate, type ProjectType } from "./api.mjs";
import { CliError } from "./errors.mjs";
import { slugify } from "./project.mjs";

/** `--type store|website` → the type, or a CliError naming the valid values. */
export const parseProjectType = (raw: string | undefined): ProjectType | undefined => {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (value === PROJECT_TYPE.store || value === PROJECT_TYPE.website) return value;
  throw new CliError(`invalid --type "${raw}": use ${PROJECT_TYPE.store} or ${PROJECT_TYPE.website}`);
};

/** Match `--template` against the id, then a unique case-insensitive name. */
export const matchTemplate = (templates: readonly CliTemplate[], query: string): CliTemplate | null => {
  const byId = templates.find((t) => t.id === query);
  if (byId) return byId;
  const q = query.trim().toLowerCase();
  const byName = templates.filter((t) => t.name.toLowerCase() === q);
  return byName.length === 1 ? byName[0] : null;
};

/** "Modern Store (store, starter kit) [ecommerce]" style menu label parts. */
export const templateLabel = (t: CliTemplate): string => `${t.name} (${t.type}${t.starter ? ", starter kit" : ""})`;

/** The ids to name in a "pass --template <id>" hint. */
export const templateHint = (templates: readonly CliTemplate[]): string =>
  `pass --template <id>, one of: ${templates.map((t) => `${t.id} (${t.name})`).join(", ")}`;

/**
 * Project name and folder from the arguments: `create my-store` → name "my-store" in ./my-store;
 * `--name "My Store"` alone → ./my-store; neither → the template's name.
 */
export const resolveNameAndDir = (input: { cwd: string; dir?: string; name?: string; template: CliTemplate }): { name: string; dir: string } => {
  const name = input.name?.trim() || (input.dir ? path.basename(path.resolve(input.cwd, input.dir)) : input.template.name);
  const dir = path.resolve(input.cwd, input.dir ?? slugify(name));
  return { name, dir };
};
