import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { registerAuth } from "./commands/auth.mjs";
import { registerConfig } from "./commands/config.mjs";
import { registerCreate } from "./commands/create.mjs";
import { registerDev } from "./commands/dev.mjs";
import { registerLink } from "./commands/link.mjs";
import { registerPublish } from "./commands/publish.mjs";
import { registerOpen } from "./commands/open.mjs";
import { registerPreview } from "./commands/preview.mjs";
import { registerStatus } from "./commands/status.mjs";
import { registerSync } from "./commands/sync.mjs";

const packageVersion = (): string => {
  const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version;
};

export const buildProgram = (): Command => {
  const program = new Command("nanodev")
    .description("nanodev by nanosite.ai: work on your nano-site store or website locally, with your own editor and AI agent")
    .version(packageVersion(), "-v, --version")
    .option("--json", "print the result as JSON (progress goes to stderr)")
    .option("--verbose", "show the git and HTTP calls nanodev makes")
    .option("--api <origin>", "nano-site API origin (default: $NANODEV_API, the linked project's, ~/.nanodev/config.json, https://api.nanosite.ai)")
    .option("-C, --cwd <dir>", "run as if started in <dir>")
    .showHelpAfterError()
    .addHelpText(
      "after",
      "\nGet started:\n  npm create @nanosite/nanodev@beta my-store   (a new store, running locally)\n  nanodev login\n  nanodev link\n  cd <project> && nanodev dev\n  nanodev push\n  nanodev publish\n  nanodev open\n\nDocs: https://nanosite.ai/docs/develop-locally\nIssues: https://github.com/nanosite-ai/nanodev/issues",
    );
  registerAuth(program);
  registerCreate(program);
  registerLink(program);
  registerDev(program);
  registerSync(program);
  registerPublish(program);
  registerPreview(program);
  registerStatus(program);
  registerOpen(program);
  registerConfig(program);
  return program;
};
