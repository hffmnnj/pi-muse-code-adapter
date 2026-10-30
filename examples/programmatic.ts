// Run after installing the package and signing in with `muse login`.
import { createModels } from "@earendil-works/pi-ai/models";
import { createMuseProvider } from "pi-muse-code-adapter";

const models = createModels();
models.setProvider(createMuseProvider());
const model = models.getModel("muse-code", "muse-spark-1.3-contributor");
if (!model) throw new Error("Muse model is unavailable");

const stream = models.streamSimple(
  model,
  {
    messages: [
      {
        role: "user",
        content: "Say hello in one sentence.",
        timestamp: Date.now(),
      },
    ],
  },
  { signal: AbortSignal.timeout(90_000) },
);
for await (const event of stream) {
  if (event.type === "text_delta") process.stdout.write(event.delta);
}
const answer = await stream.result();
if (answer.stopReason === "error" || answer.stopReason === "aborted")
  throw new Error("Muse request failed");
process.stdout.write("\n");
