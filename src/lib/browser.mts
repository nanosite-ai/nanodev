// Open a URL in the default browser with the OS's own launcher (no dependency). Never through a shell:
// the URL comes from the API, so it is validated as http(s) and passed as ONE argv entry.
import { spawn } from "node:child_process";
import { CliError } from "./errors.mjs";
import { debug } from "./output.mjs";

/** Parse and require http(s). Returns the normalized href (spaces, quotes and the like percent-encoded). */
export const safeBrowserUrl = (raw: string): string => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError(`the server sent an invalid URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CliError(`refusing to open a non-http(s) URL: ${JSON.stringify(raw)}`);
  }
  return url.href;
};

/** The launcher and its argv for this platform. Spawned without a shell, so no metacharacter is special. */
export const openCommand = (href: string, platform: NodeJS.Platform = process.platform): [string, string[]] => {
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", href]];
  if (platform === "darwin") return ["open", [href]];
  return ["xdg-open", [href]];
};

/** Best effort: false when no launcher could start (headless box, SSH): the caller prints the URL. */
export const openUrl = (raw: string): Promise<boolean> => {
  const href = safeBrowserUrl(raw);
  return new Promise((resolve) => {
    const [cmd, args] = openCommand(href);
    debug(`$ ${cmd} ${args.join(" ")}`);
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true, shell: false });
      child.on("error", () => resolve(false));
      child.on("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
};
