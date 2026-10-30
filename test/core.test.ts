import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readMuseOAuthToken,
  resolveMuseSubscriptionKey,
} from "../src/core/auth.js";
import {
  MUSE_RESPONSES_URL,
  museHeaders,
  validateMuseRequestURL,
} from "../src/core/headers.js";
import { fetchMuseCatalog, getMuseCatalog } from "../src/core/catalog.js";
import { prepareMusePayload } from "../src/core/payload.js";

async function fixture(
  files: Record<string, unknown>,
  run: (dir: string) => Promise<void> | void,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-muse-core-"));
  try {
    for (const [name, value] of Object.entries(files))
      await writeFile(join(dir, name), JSON.stringify(value));
    await run(dir);
  } finally {
    for (const name of Object.keys(files)) await unlink(join(dir, name));
    await rmdir(dir);
  }
}
const oauth = {
  providers: {
    meta: {
      mechanism: "oauth",
      access_token: "oauth-secret",
      api_key: "cached-key",
    },
  },
};

test("OAuth exchange uses the OAuth token only for the fixed key endpoint and returns the minted subscription key", async () => {
  await fixture({ "auth.json": oauth }, async (dir) => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(url, "https://api.meta.ai/muse-code/key");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer oauth-secret",
      );
      return Response.json({
        is_subs_active: true,
        api_key: "minted-key",
        base_url: "https://api.meta.ai/v1/",
      });
    };
    const authPath = join(dir, "auth.json");
    assert.equal(await readMuseOAuthToken({ authPath }), "oauth-secret");
    assert.equal(
      await resolveMuseSubscriptionKey({ authPath, fetch }),
      "minted-key",
    );
    assert.equal(calls, 1);
    const headers = museHeaders("minted-key", "/unsafe/session");
    assert.equal(headers.authorization, "Bearer minted-key");
    assert.match(headers["x-tbh-session-id"]!, /^[0-9a-f-]{36}$/);
    assert.equal(headers["x-tbh-session-id"], headers["x-tbh-thread-id"]);
    assert.equal(
      headers["x-tbh-session-id"],
      headers["x-meta-ai-gateway-session-id"],
    );
    assert.equal(headers["x-tbh-session-id"], headers["x-tbh-root-session-id"]);
    assert.match(headers.traceparent!, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const id = "61ee5bc8-f85e-4d06-bad0-3a376bc72fd2";
    assert.equal(museHeaders("key", id)["x-tbh-session-id"], id);
  });
});

test("billing credentials are never used and invalid minted subscriptions or destinations fail safely", async () => {
  await fixture(
    {
      "auth.json": {
        providers: {
          meta: {
            mechanism: "api_key",
            api_key: "cached-secret",
            access_token: "not-oauth",
          },
        },
      },
    },
    async (dir) => {
      const fetch: typeof globalThis.fetch = async () => {
        assert.fail("must not contact mint endpoint");
      };
      assert.equal(
        await resolveMuseSubscriptionKey({
          authPath: join(dir, "auth.json"),
          fetch,
        }),
        undefined,
      );
    },
  );
  await fixture({ "auth.json": oauth }, async (dir) => {
    for (const body of [
      { is_subs_active: false, api_key: "secret" },
      {
        is_subs_active: true,
        api_key: "secret",
        base_url: "https://evil.example/v1",
      },
    ]) {
      await assert.rejects(
        resolveMuseSubscriptionKey({
          authPath: join(dir, "auth.json"),
          fetch: async () => Response.json(body),
        }),
        (error: Error) => !error.message.includes("secret"),
      );
    }
  });
  validateMuseRequestURL(MUSE_RESPONSES_URL);
  for (const url of [
    "https://api.meta.ai.evil.example/v1/responses",
    "https://api.meta.ai/v1/responses?token=x",
    "https://api.meta.ai/v1/responses#x",
    "https://name@api.meta.ai/v1/responses",
    "https://api.meta.ai/v1/models",
  ]) {
    assert.throws(
      () => validateMuseRequestURL(url),
      /Refusing to send Muse credentials/,
    );
  }
});

test("catalog cancellation stops before requests, and transport errors do not expose credentials", async () => {
  await fixture({ "auth.json": oauth }, async (dir) => {
    const authPath = join(dir, "auth.json");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      fetchMuseCatalog({
        authPath,
        catalogDir: dir,
        signal: controller.signal,
        fetch: async () => {
          assert.fail("must not fetch after cancellation");
        },
      }),
      { name: "AbortError" },
    );
    await assert.rejects(
      resolveMuseSubscriptionKey({
        authPath,
        fetch: async () => {
          throw new Error("oauth-secret");
        },
      }),
      (error: Error) =>
        error.message.includes("Unable to refresh") &&
        !error.message.includes("oauth-secret"),
    );
  });
});

test("catalog keeps baseline contributors, merges current local metadata, and excludes non-chat models", async () => {
  await fixture(
    {
      "catalog.json": {
        rows: [
          {
            model_id: "muse-spark-1.3-contributor",
            display_label: "Spark contributor",
            context_limit: 1007997,
            output_limit: 128000,
            is_current: true,
            reasoning_effort_variants: [{ tier: "low" }, { tier: "high" }],
          },
          { model_id: "muse-spark-1.3-contributor", display_label: "Older" },
          { model_id: "muse-image-1.0" },
          { model_id: "muse-voice-1.0" },
          { model_id: "muse-sam-1.0" },
        ],
      },
    },
    async (dir) => {
      const local = getMuseCatalog({ catalogDir: dir });
      assert.equal(local.length, 9);
      assert.deepEqual(
        local.find((model) => model.id === "muse-spark-1.3-contributor"),
        {
          id: "muse-spark-1.3-contributor",
          name: "Spark contributor",
          contextWindow: 1007997,
          maxTokens: 128000,
          efforts: ["low", "high"],
          contributor: true,
        },
      );
      assert.equal(local.filter((m) => m.contributor).length, 4);
      assert.equal(
        getMuseCatalog({ catalogDir: join(dir, "missing") }).length,
        9,
      );
      const authPath = join(dir, "auth.json");
      await writeFile(authPath, JSON.stringify(oauth));
      try {
        const fetch: typeof globalThis.fetch = async (url, init) => {
          if (url === "https://api.meta.ai/muse-code/key")
            return Response.json({ is_subs_active: true, api_key: "minted" });
          assert.equal(url, "https://api.meta.ai/v1/models");
          assert.equal(init?.redirect, "error");
          assert.equal(
            new Headers(init?.headers).get("authorization"),
            "Bearer minted",
          );
          return Response.json({
            data: [
              { id: "muse-spark-2.0" },
              { id: "muse-image-2.0" },
              { id: "muse-spark-1.3-contributor" },
            ],
          });
        };
        const remote = await fetchMuseCatalog({
          catalogDir: dir,
          authPath,
          fetch,
        });
        assert.equal(remote.length, 10);
        assert.equal(
          remote.find((m) => m.id === "muse-spark-2.0")?.contextWindow,
          128000,
        );
        assert.equal(
          remote.find((m) => m.id === "muse-spark-1.3-contributor")?.name,
          "Spark contributor",
        );
      } finally {
        await unlink(authPath);
      }
    },
  );
});

test("payload aliases are reversible and schema validation, arguments, and messages remain unchanged", () => {
  const input = {
    tools: [
      {
        type: "function",
        name: "shell",
        description: "sensitive text",
        parameters: {
          type: "object",
          required: ["command"],
          properties: {
            command: {
              type: "string",
              description: "sensitive",
              enum: ["shell", "bash"],
              default: "shell",
              examples: ["bash"],
            },
          },
        },
      },
      {
        type: "function",
        name: "bash",
        description: "private description",
        parameters: { type: "object" },
      },
    ],
    input: [
      {
        type: "function_call",
        name: "shell",
        arguments: '{"command":"shell"}',
      },
      { type: "message", content: "shell bash" },
      {
        type: "function_call",
        name: "bash",
        namespace: "custom",
        arguments: '{"command":"unchanged"}',
      },
    ],
    tool_choice: {
      type: "allowed_tools",
      tools: [
        { type: "function", name: "shell" },
        { type: "function", name: "bash" },
      ],
    },
  };
  const before = structuredClone(input);
  const result = prepareMusePayload(input);
  const payload = result.payload as typeof input;
  assert.deepEqual(input, before);
  assert.deepEqual(
    [...result.aliases],
    [
      ["run_command", "shell"],
      ["execute_command", "bash"],
    ],
  );
  assert.deepEqual(
    payload.tools.map((tool) => tool.name),
    ["run_command", "execute_command"],
  );
  assert.equal(
    payload.tools[0]!.parameters.properties!.command.description,
    "Command to run.",
  );
  assert.deepEqual(payload.tools[0]!.parameters.properties!.command.enum, [
    "shell",
    "bash",
  ]);
  assert.equal(
    payload.tools[0]!.parameters.properties!.command.default,
    "shell",
  );
  assert.deepEqual(payload.tools[0]!.parameters.properties!.command.examples, [
    "bash",
  ]);
  assert.deepEqual(payload.tools[0]!.parameters.required, ["command"]);
  assert.notEqual(payload.tools[1]!.description, "private description");
  assert.equal(payload.input[0]!.name, "run_command");
  assert.equal(payload.input[0]!.arguments, '{"command":"shell"}');
  assert.deepEqual(payload.input[1], input.input[1]);
  assert.deepEqual(payload.input[2], input.input[2]);
  assert.deepEqual(
    payload.tool_choice.tools.map((tool) => tool.name),
    ["run_command", "execute_command"],
  );
  assert.throws(
    () =>
      prepareMusePayload({
        tools: [
          { type: "function", name: "shell" },
          { type: "function", name: "run_command" },
        ],
      }),
    /already an independent function tool/,
  );
  assert.equal(
    prepareMusePayload({ tools: [{ type: "function", name: "run_command" }] })
      .aliases.size,
    0,
  );
});
