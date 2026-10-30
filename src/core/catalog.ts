// Local catalog reading adapted from pi-muse-bridge (MIT, ferdousbhai/pi-muse-bridge).
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  MuseAuthOptions,
  MuseCatalogModel,
  MuseProviderOptions,
} from "../options.js";
import { resolveMuseSubscriptionKey } from "./auth.js";
import { MUSE_BASE_URL, MUSE_USER_AGENT } from "./headers.js";

const BASELINE_IDS = [
  "muse-spark-1.1",
  "muse-spark-1.2",
  "muse-spark-1.2-contributor",
  "muse-spark-1.3",
  "muse-spark-1.3-contributor",
  "muse-wonder-1.0",
  "muse-wonder-1.0-contributor",
  "muse-wonder-full-1.0",
  "muse-wonder-full-1.0-contributor",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isChatId(id: string): boolean {
  return (
    /^muse-(?:spark|wonder)(?:-|$)/i.test(id) &&
    !/(?:^|-)(?:image|voice|sam)(?:-|$)/i.test(id)
  );
}
function limits(
  id: string,
): Pick<MuseCatalogModel, "contextWindow" | "maxTokens"> {
  // Muse 1.2/1.3 and Wonder catalog limits; unknown models use a conservative fallback.
  return /^(?:muse-spark-1\.[23]|muse-wonder(?:-full)?-1\.0)(?:-contributor)?$/i.test(
    id,
  )
    ? { contextWindow: 1_007_997, maxTokens: 128_000 }
    : { contextWindow: 128_000, maxTokens: 8_192 };
}
function fallback(id: string): MuseCatalogModel {
  return {
    id,
    name: id,
    ...limits(id),
    efforts: [],
    contributor: /-contributor$/i.test(id),
  };
}
function positiveNumber(value: unknown, fallbackValue: number): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallbackValue;
}

export function getMuseCatalog(
  options: Pick<MuseProviderOptions, "catalogDir"> = {},
): MuseCatalogModel[] {
  const dir =
    options.catalogDir ??
    join(
      process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local/share"),
      "muse/model-catalog",
    );
  const models = new Map(BASELINE_IDS.map((id) => [id, fallback(id)]));
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .sort();
  } catch {
    return [...models.values()];
  }
  const current = new Set<string>();
  for (const file of files) {
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(data) || !Array.isArray(data.rows)) continue;
    for (const row of data.rows) {
      if (
        !isRecord(row) ||
        typeof row.model_id !== "string" ||
        !isChatId(row.model_id)
      )
        continue;
      const id = row.model_id;
      if (current.has(id) && !row.is_current) continue;
      const previous = models.get(id) ?? fallback(id);
      const efforts = Array.isArray(row.reasoning_effort_variants)
        ? row.reasoning_effort_variants.flatMap((variant: unknown) =>
            isRecord(variant) && typeof variant.tier === "string"
              ? [variant.tier]
              : [],
          )
        : previous.efforts;
      models.set(id, {
        id,
        name:
          typeof row.display_label === "string" && row.display_label
            ? row.display_label
            : previous.name,
        contextWindow: positiveNumber(
          row.context_limit,
          previous.contextWindow,
        ),
        maxTokens: positiveNumber(row.output_limit, previous.maxTokens),
        efforts: [...new Set(efforts)],
        contributor:
          previous.contributor ||
          /contributor/i.test(id) ||
          (typeof row.data_use === "string" && /contribut/i.test(row.data_use)),
      });
      if (row.is_current) current.add(id);
    }
  }
  return [...models.values()];
}

export async function fetchMuseCatalog(
  options: MuseAuthOptions & { catalogDir?: string; modelApiKey?: string } = {},
): Promise<MuseCatalogModel[]> {
  const models = new Map(
    getMuseCatalog(options).map((model) => [model.id, model]),
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
    : AbortSignal.timeout(15_000);
  signal.throwIfAborted();
  const key =
    options.modelApiKey ??
    (await resolveMuseSubscriptionKey({ ...options, signal }));
  if (!key)
    throw new Error(
      "Muse Code OAuth login is required to fetch the model catalog.",
    );
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(
      `${MUSE_BASE_URL}/models`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${key}`,
          "user-agent": MUSE_USER_AGENT,
          "x-client-id": "tbh:exec",
          accept: "application/json",
        },
        redirect: "error",
        signal,
      },
    );
  } catch {
    options.signal?.throwIfAborted();
    throw new Error("Unable to fetch the Muse Code model catalog.");
  }
  if (!response.ok)
    throw new Error("Unable to fetch the Muse Code model catalog.");
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    options.signal?.throwIfAborted();
    throw new Error("Muse Code returned an invalid model catalog.");
  }
  if (!isRecord(body) || !Array.isArray(body.data))
    throw new Error("Muse Code returned an invalid model catalog.");
  for (const row of body.data) {
    if (
      isRecord(row) &&
      typeof row.id === "string" &&
      isChatId(row.id) &&
      !models.has(row.id)
    )
      models.set(row.id, fallback(row.id));
  }
  return [...models.values()];
}
