import {
  createAssistantMessageEventStream,
  createProvider,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type ProviderStreams,
  type Provider,
  type StreamOptions,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { readMuseOAuthToken, resolveMuseSubscriptionKey } from "./core/auth.ts";
import { fetchMuseCatalog, getMuseCatalog } from "./core/catalog.ts";
import {
  MUSE_BASE_URL,
  museHeaders,
  validateMuseRequestURL,
} from "./core/headers.ts";
import { prepareMusePayload } from "./core/payload.ts";
import type { MuseCatalogModel, MuseProviderOptions } from "./options.ts";

function restoreCall(
  call: ToolCall,
  aliases: ReadonlyMap<string, string>,
): ToolCall {
  const original =
    call.namespace === undefined ? aliases.get(call.name) : undefined;
  return original ? { ...call, name: original } : call;
}

function restoreMessage(
  message: AssistantMessage,
  aliases: ReadonlyMap<string, string>,
): AssistantMessage {
  return {
    ...message,
    content: message.content.map((block) =>
      block.type === "toolCall" ? restoreCall(block, aliases) : block,
    ),
  };
}

function restoreEvent(
  event: AssistantMessageEvent,
  aliases: ReadonlyMap<string, string>,
): AssistantMessageEvent {
  if (aliases.size === 0) return event;
  if (event.type === "done")
    return { ...event, message: restoreMessage(event.message, aliases) };
  if (event.type === "error")
    return { ...event, error: restoreMessage(event.error, aliases) };
  if (event.type === "toolcall_end")
    return {
      ...event,
      partial: restoreMessage(event.partial, aliases),
      toolCall: restoreCall(event.toolCall, aliases),
    };
  return { ...event, partial: restoreMessage(event.partial, aliases) };
}

function errorMessage(
  model: Model<Api>,
  error: unknown,
  aborted: boolean,
): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [],
    timestamp: Date.now(),
    stopReason: aborted ? "aborted" : "error",
    errorMessage:
      error instanceof Error ? error.message : "Muse Code request failed.",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelDefinition(
  entry: MuseCatalogModel,
  providerId: string,
  baseline?: Model<"openai-responses">,
): Model<"openai-responses"> {
  const wonder = entry.id.includes("wonder");
  const max =
    baseline?.thinkingLevelMap?.max ??
    (wonder || (!entry.contributor && entry.efforts.includes("max"))
      ? "max"
      : "xhigh");
  return {
    ...baseline,
    id: entry.id,
    name:
      entry.name === entry.id
        ? entry.id
            .split("-")
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(" ")
        : entry.name,
    api: "openai-responses",
    provider: providerId,
    baseUrl: MUSE_BASE_URL,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    cost: baseline?.cost ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    thinkingLevelMap: {
      off: "minimal",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max,
    },
    compat: {
      ...baseline?.compat,
      supportsStrictMode: false,
      supportsDeveloperRole: false,
      supportsLongCacheRetention: false,
      supportsExplicitPromptCacheMode: false,
    },
  };
}

/** Creates an isolated native Pi provider. Pi retains tools, approvals and persistence. */
export function createMuseProvider(
  options: MuseProviderOptions = {},
): Provider<"openai-responses"> {
  const providerId = options.providerId ?? "muse-code";
  // Pi injects these public SDK entrypoints for dependency-free Git extensions.
  const meta = builtinProviders().find((provider) => provider.id === "meta");
  if (!meta)
    throw new Error(
      "This Pi installation does not provide the native Meta transport.",
    );
  const native: ProviderStreams = meta;
  const baseline = new Map(
    meta
      .getModels()
      .filter(
        (model): model is Model<"openai-responses"> =>
          model.api === "openai-responses",
      )
      .map((model) => [model.id, model]),
  );
  const models = (catalog: MuseCatalogModel[]) =>
    catalog.map((entry) =>
      modelDefinition(entry, providerId, baseline.get(entry.id)),
    );

  const forward = (
    method: "stream" | "streamSimple",
    ...args: Parameters<ProviderStreams["stream"]>
  ) => {
    const [selected, context, requestOptions] = args;
    const stream = createAssistantMessageEventStream();
    void (async () => {
      try {
        let aliases: ReadonlyMap<string, string> = new Map();
        const trustedFetch =
          requestOptions?.fetch ?? options.fetch ?? globalThis.fetch;
        const key =
          requestOptions?.apiKey ??
          (options.useCliAuth === false
            ? undefined
            : await resolveMuseSubscriptionKey({
                ...options,
                fetch: trustedFetch,
                signal: requestOptions?.signal,
              }));
        if (!key)
          throw new Error(
            "No Muse Code subscription login found. Run `muse login` or sign in with Pi's Muse Code OAuth login.",
          );
        const guardedFetch: typeof globalThis.fetch = async (input, init) => {
          const request = new Request(input, init);
          validateMuseRequestURL(request.url);
          const headers = new Headers(request.headers);
          for (const [name, value] of Object.entries(
            museHeaders(key, requestOptions?.sessionId),
          ))
            headers.set(name, value);
          return trustedFetch(
            new Request(request, { headers, redirect: "error" }),
          );
        };
        const adaptedOptions: StreamOptions = {
          ...requestOptions,
          apiKey: key,
          fetch: guardedFetch,
          onPayload: async (payload, model) => {
            const replacement = await requestOptions?.onPayload?.(
              payload,
              model,
            );
            const prepared = prepareMusePayload(
              replacement === undefined ? payload : replacement,
            );
            aliases = prepared.aliases;
            if (record(prepared.payload)) {
              const reasoning: Record<string, unknown> = record(
                prepared.payload.reasoning,
              )
                ? { ...prepared.payload.reasoning }
                : { effort: selected.id.includes("wonder") ? "medium" : "low" };
              if (reasoning.effort === "none" || reasoning.effort === "off")
                reasoning.effort = "minimal";
              reasoning.summary ??= "auto";
              prepared.payload.reasoning = reasoning;
              const include = Array.isArray(prepared.payload.include)
                ? prepared.payload.include
                : [];
              prepared.payload.include = [
                ...new Set([...include, "reasoning.encrypted_content"]),
              ];
            }
            return prepared.payload;
          },
        };
        const source = native[method](
          { ...selected, baseUrl: MUSE_BASE_URL },
          context,
          adaptedOptions,
        );
        for await (const event of source)
          stream.push(restoreEvent(event, aliases));
        stream.end(restoreMessage(await source.result(), aliases));
      } catch (error) {
        const message = errorMessage(
          selected,
          error,
          requestOptions?.signal?.aborted === true,
        );
        stream.push({
          type: "error",
          reason: message.stopReason === "aborted" ? "aborted" : "error",
          error: message,
        });
        stream.end(message);
      }
    })();
    return stream;
  };

  return createProvider({
    id: providerId,
    name: "Muse Code",
    baseUrl: MUSE_BASE_URL,
    auth: {
      apiKey: {
        name: "Muse Code CLI OAuth login",
        check: async ({ signal }) =>
          options.useCliAuth !== false &&
          (await readMuseOAuthToken({ ...options, signal }))
            ? { type: "api_key", source: "Muse Code CLI OAuth" }
            : undefined,
        resolve: async ({ signal }) => {
          if (options.useCliAuth === false) return undefined;
          const key = await resolveMuseSubscriptionKey({ ...options, signal });
          return key
            ? { auth: { apiKey: key }, source: "Muse Code CLI OAuth" }
            : undefined;
        },
      },
      oauth: meta.auth.oauth,
    },
    models: models(getMuseCatalog(options)),
    fetchModels: async ({ signal, credential }) => {
      const auth =
        credential?.type === "oauth"
          ? await meta.auth.oauth?.toAuth(credential)
          : credential?.type === "api_key" && options.useCliAuth !== false
            ? { apiKey: credential.key }
            : undefined;
      if (options.useCliAuth === false && !auth?.apiKey)
        throw new Error(
          "A Pi Muse Code OAuth login is required to refresh this catalog.",
        );
      return models(
        await fetchMuseCatalog({
          ...options,
          signal,
          modelApiKey: auth?.apiKey,
        }),
      );
    },
    api: {
      stream: (...args) => forward("stream", ...args),
      streamSimple: (...args) => forward("streamSimple", ...args),
    },
  });
}

export type { MuseProviderOptions } from "./options.ts";
