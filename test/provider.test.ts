import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import { createModels, type Provider } from "@earendil-works/pi-ai/models";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import extension, { createMuseProvider } from "../src/index.ts";

function responseStream(): Response {
  const reasoning = {
    type: "reasoning",
    id: "rs_1",
    summary: [{ type: "summary_text", text: "A short summary" }],
    encrypted_content: "opaque",
  };
  const text = {
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Working", annotations: [] }],
  };
  const calls = [
    {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "execute_command",
      arguments: '{"command":"echo hello"}',
    },
    {
      type: "function_call",
      id: "fc_2",
      call_id: "call_2",
      name: "run_command",
      arguments: '{"command":"shell"}',
    },
  ];
  const events: object[] = [
    { type: "response.output_item.added", output_index: 0, item: reasoning },
    {
      type: "response.reasoning_summary_text.delta",
      output_index: 0,
      delta: "A short summary",
    },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    { type: "response.output_item.added", output_index: 1, item: text },
    { type: "response.output_text.delta", output_index: 1, delta: "Working" },
    { type: "response.output_item.done", output_index: 1, item: text },
    ...calls.flatMap((item, index) => [
      {
        type: "response.output_item.added",
        output_index: index + 2,
        item: { ...item, arguments: "" },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: index + 2,
        delta: item.arguments,
      },
      { type: "response.output_item.done", output_index: index + 2, item },
    ]),
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        output: [reasoning, text, ...calls],
        usage: {
          input_tokens: 20,
          output_tokens: 9,
          total_tokens: 29,
          input_tokens_details: { cached_tokens: 4 },
          output_tokens_details: { reasoning_tokens: 3 },
        },
      },
    },
  ];
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("native transport mints credentials, adapts tools and restores streamed calls without losing content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muse-provider-"));
  const authPath = join(dir, "auth.json");
  await writeFile(
    authPath,
    JSON.stringify({
      providers: {
        meta: { mechanism: "oauth", access_token: "synthetic-oauth" },
      },
    }),
  );
  try {
    let payload: Record<string, unknown> | undefined;
    let requests = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      requests++;
      if (input === "https://api.meta.ai/muse-code/key") {
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          "Bearer synthetic-oauth",
        );
        return Response.json({
          is_subs_active: true,
          api_key: "synthetic-minted",
          base_url: "https://api.meta.ai/v1",
        });
      }
      if (input === "https://api.meta.ai/v1/models") {
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          "Bearer synthetic-minted",
        );
        return Response.json({ data: [{ id: "muse-spark-2.0" }] });
      }
      assert.ok(input instanceof Request);
      assert.equal(input.url, "https://api.meta.ai/v1/responses");
      assert.equal(input.redirect, "error");
      assert.equal(
        input.headers.get("authorization"),
        "Bearer synthetic-minted",
      );
      assert.equal(input.headers.get("x-client-id"), "tbh:exec");
      assert.equal(input.headers.get("x-tbh-agent-role"), "main");
      assert.equal(
        input.headers.get("x-tbh-session-id"),
        "61ee5bc8-f85e-4d06-bad0-3a376bc72fd2",
      );
      assert.equal(
        input.headers.get("x-tbh-thread-id"),
        input.headers.get("x-tbh-session-id"),
      );
      payload = (await input.json()) as Record<string, unknown>;
      return responseStream();
    };
    const models = createModels();
    models.setProvider(
      createMuseProvider({ authPath, catalogDir: dir, fetch }),
    );
    const model = models.getModel("muse-code", "muse-spark-1.3-contributor");
    assert.ok(model);
    let callbackCount = 0;
    let providerEvents = 0;
    const stream = models.streamSimple(
      model,
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Use tools" },
              { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
            ],
            timestamp: 1,
          },
        ],
        tools: ["bash", "shell"].map((name) => ({
          name,
          description: "private tool description",
          parameters: Type.Object({
            command: Type.String({
              description: "private argument description",
            }),
          }),
        })),
      },
      {
        sessionId: "61ee5bc8-f85e-4d06-bad0-3a376bc72fd2",
        onPayload: (value) => {
          callbackCount++;
          return { ...(value as Record<string, unknown>), temperature: 0.25 };
        },
        onProviderStreamEvent: () => {
          providerEvents++;
        },
      },
    );
    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();
    assert.equal(requests, 2);
    assert.equal(callbackCount, 1);
    assert.equal(providerEvents, 13);
    assert.ok(payload);
    assert.equal(payload.temperature, 0.25);
    assert(
      JSON.stringify(payload.input).includes("data:image/png;base64,aW1hZ2U="),
    );
    const tools = payload.tools as Array<{
      name: string;
      description: string;
      parameters: { properties: { command: { description: string } } };
    }>;
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["execute_command", "run_command"],
    );
    for (const tool of tools) {
      assert.notEqual(tool.description, "private tool description");
      assert.notEqual(
        tool.parameters.properties.command.description,
        "private argument description",
      );
    }
    assert.ok(
      (payload.include as string[]).includes("reasoning.encrypted_content"),
    );
    assert.equal((payload.reasoning as { summary: string }).summary, "auto");
    assert.equal(result.stopReason, "toolUse", result.errorMessage);
    const calls = result.content.filter((block) => block.type === "toolCall");
    assert.deepEqual(
      calls.map(({ id, name, arguments: args }) => ({ id, name, args })),
      [
        { id: "call_1|fc_1", name: "bash", args: { command: "echo hello" } },
        { id: "call_2|fc_2", name: "shell", args: { command: "shell" } },
      ],
    );
    assert.deepEqual(
      events
        .filter((event) => event.type === "toolcall_end")
        .map((event) => event.toolCall.name),
      ["bash", "shell"],
    );
    const thinking = result.content.find((block) => block.type === "thinking");
    assert.equal(thinking?.thinking, "A short summary");
    assert.equal(
      JSON.parse(thinking!.thinkingSignature!).encrypted_content,
      "opaque",
    );
    assert.equal(
      result.content.find((block) => block.type === "text")?.text,
      "Working",
    );
    assert.deepEqual(
      {
        input: result.usage.input,
        output: result.usage.output,
        cacheRead: result.usage.cacheRead,
        reasoning: result.usage.reasoning,
        total: result.usage.totalTokens,
      },
      { input: 16, output: 9, cacheRead: 4, reasoning: 3, total: 29 },
    );
    const refresh = await models.refresh({
      providers: ["muse-code"],
      allowNetwork: true,
      force: true,
    });
    assert.equal(refresh.errors.size, 0);
    assert.equal(
      requests,
      4,
      "refresh must mint once and then fetch the catalog",
    );
    assert(models.getModel("muse-code", "muse-spark-2.0"));
  } finally {
    await unlink(authPath);
    await rmdir(dir);
  }
});

test("Pi Models reports a pre-auth cancellation as a setup error without contacting upstream", async () => {
  const controller = new AbortController();
  controller.abort();
  const models = createModels();
  models.setProvider(
    createMuseProvider({
      authPath: "/nonexistent/synthetic-profile",
      fetch: async () => {
        assert.fail("unexpected fetch");
      },
    }),
  );
  const model = models.getModel("muse-code", "muse-spark-1.3-contributor");
  assert.ok(model);
  const result = await models.completeSimple(
    model,
    { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
    { signal: controller.signal },
  );
  assert.equal(result.stopReason, "error");
});

test("direct provider reports pre-aborted requests without network traffic", async () => {
  const controller = new AbortController();
  controller.abort();
  const provider = createMuseProvider({
    authPath: "/nonexistent/synthetic-profile",
    fetch: async () => {
      assert.fail("unexpected fetch");
    },
  });
  const model = provider
    .getModels()
    .find((item) => item.id === "muse-spark-1.3-contributor");
  assert.ok(model);
  const result = await provider
    .streamSimple(
      model,
      normalizeContext({
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
      }),
      { signal: controller.signal },
    )
    .result();
  assert.equal(result.stopReason, "aborted");
});

test(
  "cancelling an in-flight request aborts the native transport",
  { timeout: 10000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-provider-abort-"));
    const authPath = join(dir, "auth.json");
    await writeFile(
      authPath,
      JSON.stringify({
        providers: {
          meta: { mechanism: "oauth", access_token: "synthetic-oauth" },
        },
      }),
    );
    try {
      const controller = new AbortController();
      let started!: () => void;
      const reachedFetch = new Promise<void>((resolve) => {
        started = resolve;
      });
      const models = createModels();
      models.setProvider(
        createMuseProvider({
          authPath,
          catalogDir: dir,
          fetch: async (input) => {
            if (input === "https://api.meta.ai/muse-code/key")
              return Response.json({
                is_subs_active: true,
                api_key: "synthetic-minted",
              });
            assert.ok(input instanceof Request);
            started();
            return await new Promise<Response>((_resolve, reject) => {
              if (input.signal.aborted) return reject(input.signal.reason);
              input.signal.addEventListener(
                "abort",
                () => reject(input.signal.reason),
                { once: true },
              );
            });
          },
        }),
      );
      const model = models.getModel("muse-code", "muse-spark-1.3-contributor");
      assert.ok(model);
      const pending = models.completeSimple(
        model,
        { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
        { signal: controller.signal },
      );
      await Promise.race([
        reachedFetch,
        pending.then((result) => {
          throw new Error(
            `Transport did not start: ${result.stopReason} ${result.errorMessage}`,
          );
        }),
      ]);
      controller.abort();
      const result = await pending;
      assert.equal(result.stopReason, "aborted");
    } finally {
      await unlink(authPath);
      await rmdir(dir);
    }
  },
);

test("regular extension registers the full catalog under its public provider ID", () => {
  let provider: Provider | undefined;
  extension({
    registerProvider(value: Provider) {
      provider = value;
    },
  });
  assert.ok(provider);
  assert.equal(provider.id, "muse-code");
  assert.equal(provider.getModels().length, 9);
  assert.ok(
    provider.getModels().every((model) => model.provider === "muse-code"),
  );
  assert.ok(
    provider
      .getModels()
      .some((model) => model.id === "muse-spark-1.3-contributor"),
  );
  assert.equal(createMuseProvider({ providerId: "meta" }).id, "meta");
});

test("server mode never falls back to an operator's ambient CLI profile", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muse-server-auth-"));
  const authPath = join(dir, "auth.json");
  await writeFile(
    authPath,
    JSON.stringify({
      providers: {
        meta: { mechanism: "oauth", access_token: "synthetic-operator-login" },
      },
    }),
  );
  try {
    const models = createModels();
    const fetch: typeof globalThis.fetch = async () => {
      assert.fail("availability checks must not contact a service");
    };
    models.setProvider(
      createMuseProvider({ providerId: "workstation", authPath, fetch }),
    );
    models.setProvider(
      createMuseProvider({
        providerId: "server",
        authPath,
        fetch,
        useCliAuth: false,
      }),
    );
    assert.equal((await models.getAvailable("workstation")).length, 9);
    assert.equal((await models.getAvailable("server")).length, 0);
    const credential = {
      type: "oauth" as const,
      access: "synthetic-user-model-key",
      refresh: "synthetic-user-identity",
      expires: Date.now() + 3600000,
    };
    let userRequests = 0;
    const perUser = createModels({
      credentials: {
        read: async () => credential,
        list: async () => [],
        modify: async (_id, operation) => operation(credential),
        delete: async () => {},
      },
    });
    perUser.setProvider(
      createMuseProvider({
        providerId: "server",
        authPath,
        useCliAuth: false,
        fetch: async (input) => {
          assert(input instanceof Request);
          assert.equal(
            input.headers.get("authorization"),
            "Bearer synthetic-user-model-key",
          );
          userRequests++;
          return responseStream();
        },
      }),
    );
    const model = perUser.getModel("server", "muse-spark-1.3-contributor");
    assert(model);
    const result = await perUser.completeSimple(model, {
      messages: [{ role: "user", content: "Use tools", timestamp: 1 }],
    });
    assert.equal(result.stopReason, "toolUse");
    assert.equal(userRequests, 1);
  } finally {
    await unlink(authPath);
    await rmdir(dir);
  }
});
