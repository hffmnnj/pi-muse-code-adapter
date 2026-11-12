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

const MINT_ATTEMPTS = 3;
const MINT_TIMEOUT_MS = 10_000;
const MINT_RETRY_DELAY_MS = 250;
const MINT_MAX_RETRY_AFTER_MS = 2_000;
// The mint endpoint returns the same key for the same login, so a short cache
// only removes redundant round trips; it never extends a key's lifetime.
const KEY_CACHE_TTL_MS = 5 * 60_000;

const keyCache = new Map<string, { key: string; expiresAt: number }>();
const pendingMints = new Map<string, Promise<string>>();

/** Forget minted keys, e.g. after the model API rejected one. */
export function invalidateMuseSubscriptionKeys(): void {
  keyCache.clear();
}

export async function resolveMuseSubscriptionKey(
  options: MuseAuthOptions = {},
): Promise<string | undefined> {
  options.signal?.throwIfAborted();
  const token = await readMuseOAuthToken({
    authPath: options.authPath,
    signal: options.signal,
  });
  if (!token) return undefined;

  const cacheKey = `${options.authPath ?? ""}\n${token}`;
  const cached = keyCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.key;

  // Concurrent sessions share one mint, which runs on its own timeout so one
  // caller's cancellation cannot fail the others.
  let pending = pendingMints.get(cacheKey);
  if (!pending) {
    const started = mintWithRetry(
      token,
      options.fetch ?? globalThis.fetch,
      options.retryDelayMs ?? MINT_RETRY_DELAY_MS,
    )
      .then((key) => {
        keyCache.set(cacheKey, {
          key,
          expiresAt: Date.now() + KEY_CACHE_TTL_MS,
        });
        return key;
      })
      .finally(() => {
        if (pendingMints.get(cacheKey) === started)
          pendingMints.delete(cacheKey);
      });
    pendingMints.set(cacheKey, started);
    pending = started;
  }
  return untilAborted(pending, options.signal);
}

type MintAttempt =
  | { kind: "response"; response: Response }
  | { kind: "transport"; reason: string };

async function mintWithRetry(
  token: string,
  fetchImpl: typeof globalThis.fetch,
  retryDelayMs: number,
): Promise<string> {
  let lastFailure = "";
  let lastFailureWasHttp = false;
  for (let attempt = 1; attempt <= MINT_ATTEMPTS; attempt++) {
    const result = await attemptMint(token, fetchImpl);
    let wait = retryDelayMs * attempt;
    if (result.kind === "transport") {
      lastFailure = result.reason;
      lastFailureWasHttp = false;
    } else {
      const { response } = result;
      if (response.status === 401 || response.status === 403) {
        await discardBody(response);
        throw new Error(
          "Muse Code login was rejected. Run `muse login` again.",
        );
      }
      if (response.ok) return parseMintedKey(response);
      await discardBody(response);
      lastFailure = `HTTP ${response.status}`;
      lastFailureWasHttp = true;
      if (!isTransientStatus(response.status)) break;
      wait = retryAfterMs(response) ?? wait;
    }
    if (attempt < MINT_ATTEMPTS) await delay(wait);
  }
  throw new Error(
    lastFailureWasHttp
      ? `Unable to refresh Muse Code subscription credentials (${lastFailure}). Try again later.`
      : `Unable to refresh Muse Code subscription credentials (${lastFailure}). Check the connection and try again.`,
  );
}

async function attemptMint(
  token: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<MintAttempt> {
  try {
    const response = await fetchImpl(KEY_URL, {
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
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    });
    return { kind: "response", response };
  } catch (error) {
    return { kind: "transport", reason: describeTransportError(error) };
  }
}

async function parseMintedKey(response: Response): Promise<string> {
  let minted: unknown;
  try {
    minted = await response.json();
  } catch {
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

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, MINT_MAX_RETRY_AFTER_MS)
    : undefined;
}

/** A short, credential-free label for a failed fetch (never the message). */
function describeTransportError(error: unknown): string {
  if (record(error) && error.name === "TimeoutError") return "timeout";
  for (const candidate of [error, record(error) ? error.cause : undefined]) {
    if (
      record(candidate) &&
      typeof candidate.code === "string" &&
      /^[A-Z][A-Z0-9_]{1,40}$/.test(candidate.code)
    )
      return candidate.code;
  }
  return "network error";
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Releasing the socket is best-effort.
  }
}

function delay(ms: number): Promise<void> {
  return ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();
}

function untilAborted<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}
