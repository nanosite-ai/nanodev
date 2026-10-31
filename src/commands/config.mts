// config: per-folder nanodev settings. Today only removing the git identity nanodev set from the login.
import type { Command } from "commander";
import { context } from "../lib/context.mjs";
import { CliError } from "../lib/errors.mjs";
import { repoRoot, requireGit, unsetLoginIdentity } from "../lib/git.mjs";
import { info, result, success } from "../lib/output.mjs";

export const registerConfig = (program: Command): void => {
  program
    .command("config")
    .description("Change nanodev's settings for this folder")
    .option("--unset-identity", "remove the git user.name/user.email nanodev set from your login in this folder")
    .addHelpText("after", "\nExamples:\n  nanodev config --unset-identity\n  nanodev config --unset-identity --json")
    .action((opts: { unsetIdentity?: boolean }, cmd: Command) => {
      if (!opts.unsetIdentity) throw new CliError("nothing to change: pass --unset-identity");
      requireGit();
      const root = repoRoot(context(cmd).cwd);
      if (!root) throw new CliError("not inside a git repository: cd into a linked project");
      const removed = unsetLoginIdentity(root);
      result({ root, identityRemoved: removed }, () => {
        if (removed) success("Removed the git identity nanodev set for this folder; set your own with git config user.email");
        else info("This folder has no git identity set by nanodev");
      });
    });
};
