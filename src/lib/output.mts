// Human vs machine output. Colors come from node's built-in styleText and are dropped when stdout is
// not a TTY or --json is on, so scripts and agents always get plain, parseable text.
import { styleText } from "node:util";

let jsonMode = false;
let verboseMode = false;

export const setJsonMode = (on: boolean): void => {
  jsonMode = on;
};
export const isJsonMode = (): boolean => jsonMode;
export const setVerbose = (on: boolean): void => {
  verboseMode = on;
};
export const isVerbose = (): boolean => verboseMode;

const useColor = (): boolean => !jsonMode && Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

type Style = Parameters<typeof styleText>[0];
const paint = (style: Style, text: string): string => (useColor() ? styleText(style, text) : text);

export const c = {
  ok: (t: string) => paint("green", t),
  warn: (t: string) => paint("yellow", t),
  err: (t: string) => paint("red", t),
  dim: (t: string) => paint("dim", t),
  bold: (t: string) => paint("bold", t),
  cyan: (t: string) => paint("cyan", t),
};

/** Progress line. Goes to stderr in --json mode so stdout stays one JSON document. */
export const info = (msg: string): void => {
  if (jsonMode) {
    process.stderr.write(`${msg}\n`);
    return;
  }
  process.stdout.write(`${msg}\n`);
};
export const success = (msg: string): void => info(`${c.ok("✔")} ${msg}`);
export const step = (msg: string): void => info(`${c.cyan("▶")} ${msg}`);
export const warn = (msg: string): void => {
  process.stderr.write(`${c.warn("!")} ${msg}\n`);
};
/** `--verbose` only: the git and HTTP calls nanodev makes. */
export const debug = (msg: string): void => {
  if (verboseMode) process.stderr.write(`${c.dim(`· ${msg}`)}\n`);
};

/** The command's result: JSON in --json mode, otherwise the human rendering. */
export const result = (data: unknown, human?: () => void): void => {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  if (human) human();
  else if (typeof data === "string") process.stdout.write(`${data}\n`);
};

/** One event of a long-running command (`dev`): a JSON line in --json mode, else the human line. */
export const event = (data: Record<string, unknown>, human: string): void => {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(data)}\n`);
    return;
  }
  process.stdout.write(`${human}\n`);
};
