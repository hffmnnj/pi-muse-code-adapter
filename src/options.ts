export interface MuseProviderOptions {
  /** Provider ID used in Pi model references. Defaults to muse-code. */
  providerId?: string;
  /** Muse CLI OAuth profile. Defaults to the normal Muse auth.json path. */
  authPath?: string;
  /** Disable ambient CLI login in multi-user servers; use Pi's credential store. */
  useCliAuth?: boolean;
  /** Muse CLI model-catalog directory. Missing files use the bundled catalog. */
  catalogDir?: string;
  /** Explicit trusted HTTP implementation for model and credential requests. */
  fetch?: typeof globalThis.fetch;
}

export interface MuseAuthOptions {
  authPath?: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

export interface MuseCatalogModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  efforts: readonly string[];
  contributor: boolean;
}

export interface PreparedMusePayload {
  payload: unknown;
  /** Maps wire aliases back to the original Pi tool names for this request. */
  aliases: ReadonlyMap<string, string>;
}
