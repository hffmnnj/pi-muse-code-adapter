// Opt-in: npm run test:live. Requires an existing Muse CLI login.
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { Type, type Message, type Tool } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  AssistantEntry,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { createMuseProvider } from "../src/index.ts";

const modelId = "muse-spark-1.3-contributor";
const command = "get-smoke-nonce";
const parameters = Type.Object({ command: Type.String() });
const tool: Tool = {
  name: "bash",
  description: `Return a smoke-test nonce. Only command ${command} is accepted.`,
  parameters,
};
const prompt = `Call the bash tool with command exactly ${command}. Then repeat the tool's complete returned value in your final answer.`;
const models = createModels();
models.setProvider(createMuseProvider());
const model = models.getModel("muse-code", modelId);
if (!model) throw new Error("Muse model unavailable");

function executor(nonce: string, args: { command: string }): string {
  if (args.command !== command)
    throw new Error("Unexpected smoke tool request");
  return nonce;
}
function text(message: {
  content: readonly { type: string; text?: string }[];
}): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}
function nonce(): string {
  return `smoke-${randomBytes(16).toString("hex")}`;
}

async function programmatic(): Promise<void> {
  const value = nonce();
  const signal = AbortSignal.timeout(90_000);
  const messages: Message[] = [
    { role: "user", content: prompt, timestamp: Date.now() },
  ];
  const first = await models.completeSimple(
    model!,
    { messages, tools: [tool] },
    { signal, reasoning: "low" },
  );
  if (first.stopReason !== "toolUse")
    throw new Error("Programmatic tool call missing");
  const calls = first.content.filter((part) => part.type === "toolCall");
  if (
    calls.length !== 1 ||
    calls[0]!.name !== "bash" ||
    typeof calls[0]!.arguments.command !== "string"
  )
    throw new Error("Unexpected programmatic tool call");
  const call = calls[0]!;
  const output = executor(value, { command: call.arguments.command as string });
  messages.push(first, {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: output }],
    isError: false,
    timestamp: Date.now(),
  });
  const answer = await models.completeSimple(
    model!,
    { messages, tools: [tool] },
    { signal, reasoning: "low" },
  );
  if (answer.stopReason !== "stop" || !text(answer).includes(value))
    throw new Error(
      "Programmatic continuation did not return the observed nonce",
    );
  console.log("programmatic: tool round trip passed (1 tool call)");
}

async function durable(): Promise<void> {
  const value = nonce();
  let executions = 0;
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "smoke",
      tools: [
        defineTool({
          ...tool,
          parameters,
          execute: async (args) => {
            const output = executor(value, args);
            executions++;
            return { output: [{ type: "text", text: output }] };
          },
        }),
      ],
    }),
  );
  const signal = AbortSignal.timeout(120_000);
  const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
  const directory = await mkdtemp(join(tmpdir(), "pi-muse-durable-"));
  try {
    const conversationId = await (async () => {
      const harness = await Harness.open(
        await openNodeJsonlStorage(directory, context),
        { models, registry },
        context,
      );
      try {
        const root = await harness.root(context, {
          agent: {
            model: { provider: "muse-code", modelId },
            thinkingLevel: "low",
          },
        });
        try {
          const submission = await root.submit(
            { type: "input", content: prompt },
            context,
          );
          const settled = await submission.wait(context);
          if (settled.status !== "done" || settled.type !== "input")
            throw new Error("Durable submission failed");
          const entry = await root.commit(
            (tx) => tx.entry(AssistantEntry, settled.answer),
            context,
          );
          const answer = entry?.model?.[0];
          if (
            executions !== 1 ||
            answer?.role !== "assistant" ||
            !text(answer).includes(value)
          )
            throw new Error(
              "Durable continuation did not return the observed nonce",
            );
          console.log(
            `durable: tool round trip passed (${executions} tool call)`,
          );
          return root.id;
        } catch (error) {
          await root.abort(
            withAbortSignal(AbortSignal.timeout(15_000), BACKGROUND_CONTEXT),
          );
          throw error;
        }
      } finally {
        await harness.close(
          withAbortSignal(AbortSignal.timeout(15_000), BACKGROUND_CONTEXT),
        );
      }
    })();

    const reopened = await Harness.open(
      await openNodeJsonlStorage(directory, context),
      { models, registry },
      context,
    );
    try {
      const conversation = await reopened.conversation(conversationId, context);
      if (!conversation) throw new Error("Persisted conversation missing");
      const submission = await conversation.submit(
        {
          type: "input",
          content:
            "Repeat the exact value returned by the earlier bash tool. Do not call any tools.",
        },
        context,
      );
      const settled = await submission.wait(context);
      if (settled.status !== "done" || settled.type !== "input")
        throw new Error("Replay continuation failed");
      const entry = await conversation.commit(
        (tx) => tx.entry(AssistantEntry, settled.answer),
        context,
      );
      const answer = entry?.model?.[0];
      if (
        answer?.role !== "assistant" ||
        !text(answer).includes(value) ||
        executions !== 1
      )
        throw new Error("Persisted tool history did not survive reopen");
      console.log(
        "durable: persisted history and continuation after reopen passed (no tool re-execution)",
      );
    } finally {
      await reopened.close(
        withAbortSignal(AbortSignal.timeout(15_000), BACKGROUND_CONTEXT),
      );
    }
  } finally {
    for (const file of await readdir(directory, { withFileTypes: true })) {
      if (file.isFile()) await unlink(join(directory, file.name));
    }
    await rmdir(directory);
  }
}

try {
  await programmatic();
  await durable();
} catch {
  // Provider errors may contain private request data; do not print them.
  console.error("live smoke failed or timed out");
  process.exitCode = 1;
}
