import type { Provider } from "@earendil-works/pi-ai/models";
import { createMuseProvider } from "./provider.ts";

interface MuseExtensionAPI {
  registerProvider(provider: Provider): void;
}

export default function museCode(pi: MuseExtensionAPI): void {
  pi.registerProvider(createMuseProvider());
}

export { createMuseProvider } from "./provider.ts";
export type { MuseProviderOptions } from "./options.ts";
