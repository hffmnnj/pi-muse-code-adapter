// Run after installing the package and signing in with `muse login`.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  AssistantEntry,
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { createMuseProvider } from "pi-muse-code-adapter";

const models = createModels();
models.setProvider(createMuseProvider());
const harness = await Harness.open(
  new MemoryStorage(),
  { models, registry: createRegistry() },
  BACKGROUND_CONTEXT,
);
try {
  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: {
      model: { provider: "muse-code", modelId: "muse-spark-1.3-contributor" },
      thinkingLevel: "low",
    },
  });
  const submission = await root.submit(
    { type: "input", content: "Say hello in one sentence." },
    BACKGROUND_CONTEXT,
  );
  const result = await submission.wait(BACKGROUND_CONTEXT);
  if (result.status !== "done" || result.type !== "input")
    throw new Error("Durable submission failed");
  const entry = await root.commit(
    (tx) => tx.entry(AssistantEntry, result.answer),
    BACKGROUND_CONTEXT,
  );
  const reply = entry?.model?.[0];
  if (reply?.role !== "assistant") throw new Error("Missing assistant answer");
  console.log(
    reply.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
  );
} finally {
  await harness.close(BACKGROUND_CONTEXT);
}
