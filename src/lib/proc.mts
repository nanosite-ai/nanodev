// Subprocesses. Windows reaches npm and node_modules/.bin shims (.cmd) only through a shell, so those
// calls fold their args into one quoted command string (args + shell:true is deprecated, DEP0190).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { debug } from "./output.mjs";

export const IS_WIN = process.platform === "win32";

/** cmd.exe-safe quoting for one argument. */
export const quoteForShell = (arg: string): string => (/^[\w./:=@\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`);

const shellCommand = (cmd: string, args: string[]): string => [cmd, ...args].map(quoteForShell).join(" ");

/** Does `cmd` need a shell to start on this OS (npm, npx, a .cmd shim)? */
export const needsShell = (cmd: string): boolean => IS_WIN && (cmd === "npm" || cmd === "npx" || /\.(cmd|bat)$/i.test(cmd));

export interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run to completion and capture output. Never throws (a missing binary is code 127). */
export const capture = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}): Captured => {
  debug(`$ ${cmd} ${args.join(" ")}`);
  const shell = needsShell(cmd);
  const res = shell
    ? spawnSync(shellCommand(cmd, args), { cwd: opts.cwd, env: opts.env, input: opts.input, encoding: "utf8", shell: true })
    : spawnSync(cmd, args, { cwd: opts.cwd, env: opts.env, input: opts.input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) return { code: 127, stdout: "", stderr: res.error.message };
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
};

/**
 * Run with inherited stdio and resolve with the exit code. In --json mode stdout must stay clean, so the
 * child's stdout is sent to our stderr instead.
 */
export const runInherit = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdoutToStderr?: boolean } = {},
): Promise<number> =>
  new Promise((resolve) => {
    const child = startChild(cmd, args, opts);
    child.on("error", () => resolve(127));
    child.on("exit", (code) => resolve(code ?? 1));
  });

/** Start a long-running child with inherited stdio (see runInherit for --json). */
export const startChild = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdoutToStderr?: boolean } = {},
): ChildProcess => {
  debug(`$ ${cmd} ${args.join(" ")}`);
  const stdio: ["inherit", "inherit" | number, "inherit"] = ["inherit", opts.stdoutToStderr ? 2 : "inherit", "inherit"];
  return needsShell(cmd)
    ? spawn(shellCommand(cmd, args), { cwd: opts.cwd, env: opts.env, stdio, shell: true })
    : spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio });
};
