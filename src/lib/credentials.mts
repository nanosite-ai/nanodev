// ~/.nanodev/credentials.json: { "<apiOrigin>": { token, email, gitOrigins? } }, file mode 0600.
// An OS keychain is a follow-up (needs approval for a native dependency).
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ENV, nanodevHome, readJsonFile } from "./config.mjs";

export interface Credential {
  token: string;
  email: string;
  /** Extra origins (besides the API origin) whose git URLs use this token, e.g. a separate git host. */
  gitOrigins?: string[];
}

export type CredentialsFile = Record<string, Credential>;

export const CREDENTIALS_FILE_MODE = 0o600;

export const credentialsPath = (): string => path.join(nanodevHome(), "credentials.json");

export const readCredentials = (): CredentialsFile => readJsonFile<CredentialsFile>(credentialsPath()) ?? {};

/** Write the whole file atomically (temp file + rename), owner-only. */
export const writeCredentials = (data: CredentialsFile): void => {
  const file = credentialsPath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}
`, { mode: CREDENTIALS_FILE_MODE });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  // writeFileSync's mode only applies on create; enforce it on every write. On Windows chmod is a
  // no-op: the file inherits the user profile's ACL (the user, SYSTEM and Administrators).
  chmodSync(file, CREDENTIALS_FILE_MODE);
};

export const saveCredential = (origin: string, credential: Credential): void => {
  writeCredentials({ ...readCredentials(), [origin]: credential });
};

/** Remove one origin's entry. Returns false when there was none. */
export const removeCredential = (origin: string): boolean => {
  const all = readCredentials();
  if (!all[origin]) return false;
  delete all[origin];
  writeCredentials(all);
  return true;
};

/** Add `gitOrigin` to the credential of `apiOrigin` (when the git host differs from the API host). */
export const addGitOrigin = (apiOrigin: string, gitOrigin: string): void => {
  const all = readCredentials();
  const cred = all[apiOrigin];
  if (!cred || gitOrigin === apiOrigin || cred.gitOrigins?.includes(gitOrigin)) return;
  all[apiOrigin] = { ...cred, gitOrigins: [...(cred.gitOrigins ?? []), gitOrigin] };
  writeCredentials(all);
};

export interface ResolvedToken {
  token: string;
  email?: string;
  source: "env" | "file";
}

/**
 * The token for `origin`. NANODEV_TOKEN is used only when `origin` is the one the user named explicitly
 * (--api / NANODEV_API), so a CI or agent token never goes to a host picked up from a folder.
 */
export const tokenFor = (
  origin: string,
  explicitOrigin: string | null,
  file: CredentialsFile = existsSync(credentialsPath()) ? readCredentials() : {},
): ResolvedToken | null => {
  const envToken = process.env[ENV.token];
  if (envToken && explicitOrigin && origin === explicitOrigin) return { token: envToken, source: "env" };
  const cred = file[origin];
  return cred ? { token: cred.token, email: cred.email, source: "file" } : null;
};

/** The credential that serves git requests to `gitOrigin` (the API origin itself, or a listed git origin). */
export const credentialForGitOrigin = (gitOrigin: string, file: CredentialsFile): Credential | null => {
  if (file[gitOrigin]) return file[gitOrigin];
  return Object.values(file).find((cred) => cred.gitOrigins?.includes(gitOrigin)) ?? null;
};
