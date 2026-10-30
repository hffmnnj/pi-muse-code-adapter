import { randomUUID } from "node:crypto";

export const MUSE_BASE_URL = "https://api.meta.ai/v1";
export const MUSE_RESPONSES_URL = `${MUSE_BASE_URL}/responses`;
export const MUSE_USER_AGENT =
  "muse-build/1.4.14 (non-interactive; linux-x86_64; build dec7d7497fecdad135ec5835a8161dbc92e55b58)";

export function validateMuseRequestURL(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "Refusing to send Muse credentials to an invalid endpoint.",
    );
  }
  if (
    url.origin !== "https://api.meta.ai" ||
    url.pathname !== "/v1/responses" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error(
      `Refusing to send Muse credentials to an unexpected endpoint. Expected ${MUSE_RESPONSES_URL}.`,
    );
  }
}

export function museHeaders(
  apiKey: string,
  sessionId?: string,
): Record<string, string> {
  const id =
    sessionId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      sessionId,
    )
      ? sessionId
      : randomUUID();
  const trace = randomUUID().replaceAll("-", "");
  const span = randomUUID().replaceAll("-", "").slice(0, 16);
  return {
    authorization: `Bearer ${apiKey}`,
    "user-agent": MUSE_USER_AGENT,
    "x-client-id": "tbh:exec",
    "x-tbh-session-id": id,
    "x-meta-ai-gateway-session-id": id,
    "x-tbh-thread-id": id,
    "x-tbh-root-session-id": id,
    "x-tbh-agent-role": "main",
    accept: "text/event-stream",
    "accept-encoding": "gzip,deflate,br",
    traceparent: `00-${trace}-${span}-01`,
  };
}
