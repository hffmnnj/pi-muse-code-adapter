import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MuseAuthOptions } from "../options.js";
import { MUSE_BASE_URL, MUSE_USER_AGENT } from "./headers.js";

const KEY_URL = "https://api.meta.ai/muse-code/key";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readMuseOAuthToken(
  options: Pick<MuseAuthOptions, "authPath" | "signal"> = {},
): Promise<string | undefined> {
  options.signal?.throwIfAborted();
  const authPath =
    options.authPath ??
    (process.env.MUSE_AUTH_PATH ||
      join(
        process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
        "muse",
        "auth.json",
      ));
  try {
    if (!(await stat(authPath)).isFile()) return undefined;
    const raw: unknown = JSON.parse(
      await readFile(authPath, { encoding: "utf8", signal: options.signal }),
    );
    if (!record(raw) || !record(raw.providers) || !record(raw.providers.meta))
      return undefined;
    const meta = raw.providers.meta;
    return meta.mechanism === "oauth" &&
      typeof meta.access_token === "string" &&
      meta.access_token.trim()
      ? meta.access_token
      : undefined;
  } catch {
    options.signal?.throwIfAborted();
    return undefined;
  }
}

function validateBaseURL(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "string")
    throw new Error("Muse Code returned an invalid subscription credential.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Muse requests must use ${MUSE_BASE_URL}.`);
  }
  if (
    url.origin !== "https://api.meta.ai" ||
    url.pathname.replace(/\/+$/, "") !== "/v1" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error(
      `Muse requests must use ${MUSE_BASE_URL}; custom endpoints are not supported.`,
    );
  }
}

export async function resolveMuseSubscriptionKey(
  options: MuseAuthOptions = {},
): Promise<string | undefined> {
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
    : AbortSignal.timeout(15_000);
  const token = await readMuseOAuthToken({
    authPath: options.authPath,
    signal,
  });
  if (!token) return undefined;
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(KEY_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "user-agent": MUSE_USER_AGENT,
        "x-client-id": "tbh:exec",
        accept: "application/json",
        "content-type": "application/json",
      },
      body: "{}",
      redirect: "error",
      signal,
    });
  } catch {
    options.signal?.throwIfAborted();
    throw new Error(
      "Unable to refresh Muse Code subscription credentials. Check the connection and try again.",
    );
  }
  if (response.status === 401 || response.status === 403)
    throw new Error("Muse Code login was rejected. Run `muse login` again.");
  if (!response.ok)
    throw new Error(
      "Unable to refresh Muse Code subscription credentials. Try again later.",
    );
  let minted: unknown;
  try {
    minted = await response.json();
  } catch {
    options.signal?.throwIfAborted();
    throw new Error("Muse Code returned an invalid subscription credential.");
  }
  if (!record(minted))
    throw new Error("Muse Code returned an invalid subscription credential.");
  if (minted.is_subs_active !== true)
    throw new Error("An active Muse Code subscription is required.");
  if (typeof minted.api_key !== "string" || !minted.api_key.trim())
    throw new Error("Muse Code returned an invalid subscription credential.");
  validateBaseURL(minted.base_url);
  return minted.api_key;
}
