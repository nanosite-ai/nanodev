import { CommanderError } from "commander";
import { CliError } from "./lib/errors.mjs";
import { c, setJsonMode, setVerbose } from "./lib/output.mjs";
import { buildProgram } from "./program.mjs";

/** Run the CLI. Resolves with the exit code (also set on process.exitCode). */
export const main = async (argv: string[]): Promise<number> => {
  process.exitCode = undefined;
  const program = buildProgram();
  program.exitOverride();
  program.hook("preAction", (_root, action) => {
    const opts = action.optsWithGlobals<{ json?: boolean; verbose?: boolean }>();
    setJsonMode(Boolean(opts.json));
    setVerbose(Boolean(opts.verbose));
  });
  try {
    await program.parseAsync(argv);
    return Number(process.exitCode ?? 0);
  } catch (err) {
    // exitCode, not process.exit(): exiting while fetch() sockets close aborts Node on Windows.
    if (err instanceof CommanderError) {
      process.exitCode = err.exitCode;
      return err.exitCode;
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${c.err("✖")} ${message}\n`);
    const code = err instanceof CliError ? err.exitCode : 1;
    process.exitCode = code;
    return code;
  }
};
