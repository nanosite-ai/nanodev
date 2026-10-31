// Device-flow polling (RFC 8628 style) against POST /api/cli/token.
import { setTimeout as sleep } from "node:timers/promises";
import { API_PATHS, ApiError, DEVICE_ERROR, apiErrorCode, type DeviceCodeResponse, type TokenResponse } from "./api.mjs";
import { CliError } from "./errors.mjs";

export const MAX_INTERVAL_SEC = 30;
/** RFC 8628: on slow_down, add 5 seconds to the polling interval. */
export const SLOW_DOWN_STEP_SEC = 5;
/** Never wait longer than this between polls, whatever Retry-After says. */
export const MAX_RETRY_AFTER_SEC = 120;

export interface TokenPoster {
  post<T>(pathname: string, body: unknown): Promise<T>;
}

export interface PollDeps {
  sleepMs?: (ms: number) => Promise<unknown>;
  now?: () => number;
}

/** The next interval after a slow_down: interval + 5s (capped), or Retry-After when that is longer. */
export const slowDownInterval = (interval: number, retryAfterSec: number | null): number =>
  Math.max(Math.min(interval + SLOW_DOWN_STEP_SEC, MAX_INTERVAL_SEC), Math.min(retryAfterSec ?? 0, MAX_RETRY_AFTER_SEC));

/** Poll until the user approves (token), denies, or the code expires. */
export const pollForToken = async (client: TokenPoster, device: DeviceCodeResponse, deps: PollDeps = {}): Promise<TokenResponse> => {
  const wait = deps.sleepMs ?? ((ms: number) => sleep(ms));
  const now = deps.now ?? Date.now;
  const deadline = now() + device.expiresIn * 1000;
  let interval = Math.min(Math.max(device.interval, 1), MAX_INTERVAL_SEC);
  while (now() < deadline) {
    await wait(interval * 1000);
    try {
      return await client.post<TokenResponse>(API_PATHS.token, { deviceCode: device.deviceCode });
    } catch (err) {
      const code = apiErrorCode(err);
      if (code === DEVICE_ERROR.pending) continue;
      if (code === DEVICE_ERROR.slowDown) {
        interval = slowDownInterval(interval, err instanceof ApiError ? err.retryAfterSec : null);
        continue;
      }
      if (code === DEVICE_ERROR.denied) throw new CliError("login was denied in the browser");
      if (code === DEVICE_ERROR.expired) break;
      throw err;
    }
  }
  throw new CliError("the login code expired before it was approved: run nanodev login again");
};
