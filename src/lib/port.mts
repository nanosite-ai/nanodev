// Is something listening on a local port? Used by `dev` to report "ready" only once the server answers.
import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

/** localhost may bind IPv4 or IPv6 only (Windows + vite: often ::1), so try both. */
const LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const;
const PROBE_TIMEOUT_MS = 500;

const probeHost = (host: string, port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });

export const isPortOpen = async (port: number): Promise<boolean> => {
  const results = await Promise.all(LOOPBACK_HOSTS.map((host) => probeHost(host, port)));
  return results.some(Boolean);
};

/** Resolve true once the port answers, false if `stop()` says to give up (child exited) or on timeout. */
export const waitForPort = async (port: number, opts: { timeoutMs: number; intervalMs?: number; stop?: () => boolean }): Promise<boolean> => {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    if (opts.stop?.()) return false;
    if (await isPortOpen(port)) return true;
    await sleep(opts.intervalMs ?? 250);
  }
  return false;
};
