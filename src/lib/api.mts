// The nano-site API, as nanodev uses it. Every URL is built with the URL API from the API origin.
import { CliError } from "./errors.mjs";
import { debug } from "./output.mjs";

export const API_PATHS = {
  deviceCode: "/api/cli/device-code",
  token: "/api/cli/token",
  me: "/api/cli/me",
  /** The calling token revokes itself (`nanodev logout`). */
  revokeToken: "/api/cli/token/revoke",
  /** GET: the user's projects; POST `{ template, name }`: create one (`nanodev create`). */
  projects: "/api/cli/projects",
  /** Templates the user can start a project from, optionally only one type. */
  templates: (type?: ProjectType) => (type ? `/api/cli/templates?${new URLSearchParams({ type })}` : "/api/cli/templates"),
  devConfig: (projectId: string) => `/api/cli/projects/${encodeURIComponent(projectId)}/dev-config`,
  /** The caller's nanodev preview of a project. */
  preview: (projectId: string) => `/api/cli/projects/${encodeURIComponent(projectId)}/preview`,
  /** Build the caller's preview sha again (same sha as a failed build: a push changes nothing). */
  previewRebuild: (projectId: string) => `/api/cli/projects/${encodeURIComponent(projectId)}/preview/rebuild`,
  repoHead: (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/repo-head`,
  /** Start a publish (POST) or read the project's deploy info (GET). */
  deploy: (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/deploy`,
  deployJob: (projectId: string, jobId: string) =>
    `/api/projects/${encodeURIComponent(projectId)}/deploy/${encodeURIComponent(jobId)}`,
} as const;

/** Device-flow polling errors (RFC 8628 style), sent by `POST /api/cli/token`. */
export const DEVICE_ERROR = {
  pending: "authorization_pending",
  slowDown: "slow_down",
  expired: "expired_token",
  denied: "access_denied",
} as const;

/** 403 body error when a CLI token lacks the scope a route needs. */
export const INSUFFICIENT_SCOPE_ERROR = "insufficient_scope";

export const PROJECT_TYPE = { store: "store", website: "website" } as const;
export type ProjectType = (typeof PROJECT_TYPE)[keyof typeof PROJECT_TYPE];

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}
export interface TokenResponse {
  token: string;
  user: { id: string; email: string };
}
export interface MeResponse {
  user: { id: string; email: string; name?: string };
}
export interface CliProject {
  id: string;
  name: string;
  type: ProjectType;
  updatedAt: string;
}
export interface DevConfig {
  projectId: string;
  name: string;
  type: ProjectType;
  publishableKey?: string;
  ecommerceApiUrl?: string;
  gitUrl: string;
  previewUrl?: string;
  liveUrl?: string;
  /** The project in the nano-site editor (with the AI chat). */
  webUrl?: string;
}
export interface CliTemplate {
  id: string;
  name: string;
  type: ProjectType;
  description: string;
  previewImage: string | null;
  previewUrl: string | null;
  /** The starter kit (listed first). */
  starter: boolean;
}
export interface CliTemplateList {
  templates: CliTemplate[];
  allowedTypes: ProjectType[];
  /** Set when a requested type (or websites) isn't on the user's plan. */
  upgradeUrl?: string;
}
/** Steps after creation that the server couldn't finish yet (`POST /api/cli/projects` `warnings`). */
export const CREATE_WARNING = {
  sandboxPending: "sandbox_pending",
  repoPending: "repo_pending",
  storePending: "store_pending",
  demoProductsSkipped: "demo_products_skipped",
} as const;
export type CreateWarning = (typeof CREATE_WARNING)[keyof typeof CREATE_WARNING];

/** `POST /api/cli/projects` → 201 (always, once the project exists). */
export interface CreatedProject {
  projectId: string;
  name: string;
  type: ProjectType;
  gitUrl: string;
  previewUrl: string;
  webUrl: string;
  /** `pending` when some step is still settling (see `warnings`). */
  status?: "ready" | "pending";
  warnings?: CreateWarning[];
}
/** A chat turn of the web agent that conflicted with a newer `main` and was kept on its own branch. */
export interface ParkedTurn {
  branch: string;
  sha: string;
  at: string;
  reported?: boolean;
}

/** One commit as the API lists it. */
export interface CommitInfo {
  sha: string;
  authorName: string;
  authorEmail: string;
  date: string;
  subject: string;
}

/** `GET /api/projects/:id/repo-head`: the project branch head nano-site has. */
export interface RepoHead {
  /** `main`'s commit, or null before the project has a repository. */
  headSha: string | null;
  /** Agent turns parked on `agent/<turn>` branches (conflicted with `main`), newest first. */
  parked: ParkedTurn[];
  /** The commit the web editor preview is built from (on `main`), or null. */
  previewSha?: string | null;
  /** Commits `main` has on top of `previewSha`, newest first (capped). */
  newerOnMain?: CommitInfo[];
}

export const DEPLOY_JOB_STATUS = { pending: "pending", running: "running", succeeded: "succeeded", failed: "failed" } as const;
export type DeployJobStatus = (typeof DEPLOY_JOB_STATUS)[keyof typeof DEPLOY_JOB_STATUS];

/** A deploy job as `POST/GET /api/projects/:id/deploy[/:jobId]` returns it. */
export interface DeployJob {
  id: string;
  projectId: string;
  mode: "preview" | "production";
  /** The commit asked for. */
  sha?: string;
  status: DeployJobStatus;
  logs: { at: string; message: string }[];
  result?: { url: string; version: string; commitSha?: string };
  error?: string;
}

export interface DeployJobResponse {
  success: boolean;
  job?: DeployJob;
  error?: string;
  code?: string;
}

/** A non-2xx response. `body` is the parsed JSON body when there is one. */
export class ApiError extends CliError {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    /** Seconds from a `Retry-After` header (429 slow_down), when the server sent one. */
    readonly retryAfterSec: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** `Retry-After: 7` → 7; an HTTP date → seconds from now; anything else → null. */
export const parseRetryAfter = (value: string | null, now = Date.now()): number | null => {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
};

export interface ApiClientOptions {
  origin: string;
  token?: string;
  timeoutMs?: number;
}

const errorText = (body: unknown): string | null => {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") return body.error;
  return null;
};

export class ApiClient {
  constructor(private readonly opts: ApiClientOptions) {}

  get origin(): string {
    return this.opts.origin;
  }

  url(pathname: string): URL {
    return new URL(pathname, this.opts.origin);
  }

  /**
   * `retry`: retry once when the request fails before any response (a pooled keep-alive socket the
   * server already closed). Always on for GET; opt-in for a POST the server treats as idempotent.
   */
  async request<T>(method: "GET" | "POST" | "DELETE", pathname: string, body?: unknown, opts: { retry?: boolean } = {}): Promise<T> {
    const url = this.url(pathname);
    const headers: Record<string, string> = { accept: "application/json", "user-agent": "nanodev" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`;
    debug(`${method} ${url.href}`);
    const send = () =>
      fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    let res: Response;
    try {
      try {
        res = await send();
      } catch (err) {
        // A pooled keep-alive socket the server already closed fails once; GETs are safe to retry.
        if (method !== "GET" && !opts.retry) throw err;
        debug(`${method} ${url.pathname} failed (${err instanceof Error ? err.message : String(err)}), retrying once`);
        res = await send();
      }
    } catch (err) {
      const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : "";
      const reason = `${err instanceof Error ? err.message : String(err)}${cause}`;
      throw new CliError(`can't reach ${this.opts.origin} (${reason}): check your network or --api`);
    }
    debug(`${method} ${url.pathname} → ${res.status}`);
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (res.status === 401) {
      throw new ApiError(`not logged in to ${this.opts.origin} (or the token expired): run nanodev login`, 401, parsed);
    }
    if (res.status === 403 && errorText(parsed) === INSUFFICIENT_SCOPE_ERROR) {
      throw new ApiError(`the saved token for ${this.opts.origin} can't do this (missing scope): run nanodev login`, 403, parsed);
    }
    if (!res.ok) {
      throw new ApiError(
        `${method} ${url.pathname} failed (${res.status}${errorText(parsed) ? `: ${errorText(parsed)}` : ""})`,
        res.status,
        parsed,
        parseRetryAfter(res.headers.get("retry-after")),
      );
    }
    return parsed as T;
  }

  get<T>(pathname: string): Promise<T> {
    return this.request<T>("GET", pathname);
  }

  post<T>(pathname: string, body: unknown, opts: { retry?: boolean } = {}): Promise<T> {
    return this.request<T>("POST", pathname, body, opts);
  }
}

/** The `error` string of an ApiError body (device-flow polling uses it as a state). */
export const apiErrorCode = (err: unknown): string | null => (err instanceof ApiError ? errorText(err.body) : null);
