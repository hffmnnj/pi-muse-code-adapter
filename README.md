# pi-muse-code-adapter

**Muse Code subscription models for Pi and Pi Durable.**

Use Spark, Wonder, Wonder Full, and contributor models through one native Pi
provider. Pi keeps your tools, approvals, conversation history, and durable
execution. Requests go directly to Meta's Responses API using your Muse login.

[Quick start](#quick-start) · [Models](#models) · [Pi Durable](#pi-durable) ·
[API](#configuration) · [Authentication](#authentication) · [Development](#development)

## What you get

- **Regular Pi extension** and **programmatic provider** from the same package.
- **Nine bundled chat models**, plus discovery of new Spark and Wonder models.
- **Text and image input**, incremental answers, readable reasoning summaries,
  tool-call streaming, token usage, prompt caching, and cancellation.
- **Host-owned tools.** Pi executes calls and enforces its own approval policy.
  No hidden Muse agent, child CLI, session host, or second permission system.
- **Durable-friendly history.** Native Pi preserves call IDs, tool results,
  images, and encrypted reasoning replay data instead of folding a transcript
  into a shortened text prompt.
- **Subscription authentication.** Reuse `muse login` or Pi's Muse OAuth login;
  no silent fallback to pay-as-you-go environment keys.

This is an unofficial adapter. Your subscription entitlements, contributor
data-use terms, and Meta's service terms still apply.

## Quick start

Requires **Node.js 22.19+** and **Pi 1.3+** from `@earendil-works/pi-coding-agent`.

```bash
# Already signed in with Muse Code? Skip this step.
muse login

pi install git:github.com/hffmnnj/pi-muse-code-adapter
```

Reload Pi with `/reload`, then select a `muse-code` model with `/model`.
You can also start directly:

```bash
pi --model muse-code/muse-spark-1.3-contributor --thinking high
```

Remove an older Muse extension first if it also registers `muse-code`:

```bash
pi remove git:github.com/zereight/pi-muse-code
```

For a local checkout:

```bash
npm install
pi install /absolute/path/to/pi-muse-code-adapter
```

The package is installable from GitHub; it is not yet published to npm.

## Models

Every model below is registered without requiring a local model-cache file.
Hidden contributor entries are included deliberately.

| Family          | Model IDs                                                  |
| --------------- | ---------------------------------------------------------- |
| Spark 1.1       | `muse-spark-1.1`                                           |
| Spark 1.2       | `muse-spark-1.2`, `muse-spark-1.2-contributor`             |
| Spark 1.3       | `muse-spark-1.3`, `muse-spark-1.3-contributor`             |
| Wonder 1.0      | `muse-wonder-1.0`, `muse-wonder-1.0-contributor`           |
| Wonder Full 1.0 | `muse-wonder-full-1.0`, `muse-wonder-full-1.0-contributor` |

The provider merges these defaults with Muse's local model catalog. Pi's model
refresh also discovers new chat-capable Spark and Wonder IDs from Meta's live
catalog. Registration does not grant access: model availability still depends
on your plan, account, region, and current service policy. Wonder Full requires
an eligible higher-tier plan.

**Contributor privacy:** contributor models carry Muse's notice that your
content, including inter-session messages, may be used for product improvement.
Choose a non-contributor model when that policy does not fit your work.

Local catalog limits take precedence. The current Spark 1.2/1.3 and Wonder
defaults are **1,007,997 context tokens / 128,000 output tokens**. Unknown models
and Spark 1.1 use conservative **128,000 / 8,192** limits until local metadata
supplies better values. Token usage is reported by the native provider; price
estimates are not a statement of subscription billing, and missing prices are
not a promise of free access.

### Reasoning

Pi's `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` controls are supported.
`max` is clamped to a model's effective supported tier. Because Meta does not
support disabling reasoning for these models, `off` maps to `minimal`.

Readable summaries are requested automatically. They may be omitted by the
service. Encrypted reasoning data is retained for replay and is never presented
as readable chain-of-thought.

### What “all models” means here

This provider exposes **chat-capable Muse models**. Image-generation,
transcription, and segmentation endpoints such as `muse-image-1.0`,
`muse-voice-transcribe-1.0`, and `sam-3.1` are not misrepresented as chat models.
Image **input** to Spark/Wonder is supported through Pi's normal image blocks.

## Programmatic Pi

Install the package alongside Pi AI:

```bash
npm install github:hffmnnj/pi-muse-code-adapter @earendil-works/pi-ai
```

```ts
import { createModels } from "@earendil-works/pi-ai/models";
import { createMuseProvider } from "pi-muse-code-adapter";

const models = createModels();
models.setProvider(createMuseProvider());

const model = models.getModel("muse-code", "muse-spark-1.3-contributor");
if (!model) throw new Error("Muse model unavailable");

const stream = models.streamSimple(
  model,
  {
    messages: [
      { role: "user", content: "Hello, Muse.", timestamp: Date.now() },
    ],
  },
  { reasoning: "high", signal: AbortSignal.timeout(90_000) },
);

for await (const event of stream) {
  if (event.type === "text_delta") process.stdout.write(event.delta);
}

const answer = await stream.result();
if (answer.stopReason === "error" || answer.stopReason === "aborted") {
  throw new Error(answer.errorMessage ?? "Muse request failed");
}
```

Use the usual Pi tool definitions and tool-result messages. The adapter changes
neither tool arguments nor the executor. See [examples/programmatic.ts](examples/programmatic.ts).

## Pi Durable

Register the same provider in the `Models` collection supplied to your Harness:

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
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
      thinkingLevel: "high",
    },
  });
  const submission = await root.submit(
    { type: "input", content: "Hello, Muse." },
    BACKGROUND_CONTEXT,
  );
  await submission.wait(BACKGROUND_CONTEXT);
} finally {
  await harness.close(BACKGROUND_CONTEXT);
}
```

Install your tools in the Durable registry as usual. Durable owns scheduling,
approval, storage, and recovery; this package supplies model inference. Use a
persistent Pi Durable storage implementation for conversations that must survive
process restarts. [examples/durable.ts](examples/durable.ts) includes answer extraction.

### Existing `meta` model references

If an application already selects `{ provider: "meta", modelId: ... }`, replace
its `metaProvider()` registration without changing saved references:

```ts
models.setProvider(
  createMuseProvider({
    providerId: "meta",
    useCliAuth: false,
  }),
);
```

**Multi-user servers:** keep your existing per-user Pi `CredentialStore` and
set `useCliAuth: false`. This prevents a missing user credential from falling
back to the server operator's ambient Muse CLI login. Do not share an operator's
credential file across tenants or copy credentials into tool sandboxes.

## Authentication

With CLI authentication enabled, the adapter reads:

```text
MUSE_AUTH_PATH
  or ${XDG_CONFIG_HOME:-~/.config}/muse/auth.json
```

Only an OAuth profile is accepted. Its identity token is exchanged at
`https://api.meta.ai/muse-code/key`; only the returned active-subscription model
key reaches `/v1/responses`. The profile is not rewritten. Cached CLI API keys,
`META_API_KEY`, and `MUSE_API_KEY` are not automatic fallbacks.

Pi's existing Meta OAuth implementation is also available through the provider's
normal login UI. That path uses Pi's credential store and does not require a
Muse CLI profile. Ambient CLI authentication is a convenience for single-user
workstations; disable it in hosted applications as shown above.

Model requests are restricted to the trusted Meta Responses endpoint, with
redirects refused. Keep credentials server-side. An explicitly injected `fetch`
implementation is trusted application code and must not forward requests or
headers to an untrusted destination.

## Configuration

```ts
createMuseProvider({
  providerId: "muse-code", // use "meta" to preserve existing model references
  useCliAuth: true, // false for per-user credential-store-only servers
  authPath: "/secure/path/to/muse/auth.json", // optional CLI profile override
  catalogDir: "/path/to/muse/model-catalog", // optional metadata override
  fetch: globalThis.fetch, // optional trusted transport, e.g. instrumentation
});
```

Caller timeouts, abort signals, retry settings, session IDs, and payload/response
callbacks are preserved. Payload callbacks run before compatibility adaptation;
raw provider-event observers remain read-only and can see wire-level aliases.

### Tool compatibility

The current Muse gateway rejects some standalone command-tool names. For this
provider only, `shell` is advertised as `run_command` and `bash` as
`execute_command`. Returned names are restored before Pi dispatches them.
History and explicit selectors use the same reversible mapping. A colliding
independent function causes an explicit error rather than incorrect dispatch.

Tool and nested schema descriptions receive neutral alternatives. Names inside
arguments, schema literals, validation rules, user instructions, and permissions
are preserved. The adapter does not replace Pi's system prompt.

## Development

Run these commands from a source checkout; test and smoke scripts are not
included in the package tarball.

```bash
npm install
npm run build
npm test
npm run typecheck
npm run format:check

# Opt-in checks using your login and subscription allowance:
npm run test:live
npm run test:cli
```

Offline tests use synthetic credentials and injected HTTP responses. Live smoke
checks verify host-owned tool execution and model continuation; they never print
credentials or private reasoning. Pi 1.3.0 is the compatibility baseline.

### Verified coverage

| Check                                                                            | Result                                                     |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| All nine bundled chat models                                                     | Real subscription responses on the test account            |
| Regular Pi CLI 1.3.0                                                             | Native `bash` execution, final answer, clean process exit  |
| Pi AI + Pi Durable 1.3.0                                                         | Tool round trips and file-backed close/reopen continuation |
| Packed install with Pi AI + Pi Durable 1.4.0                                     | Tool round trips and persisted history replay              |
| Images, summaries, usage, aliases, callbacks, cancellation, credential isolation | Offline native-transport regressions                       |

The live tool checks use Spark 1.3 Contributor. Model availability can differ for
your account; the nine-model check does not promise every plan has every model.

Pi 1.3 currently reports a cancellation during its pre-provider authentication
setup as an `error`. Once this provider is running, cancellation is reported as
`aborted` and propagates to the native HTTP transport. This upstream classification
does not cause a model request after a pre-aborted signal.

The pinned Pi 1.3 CLI used for development currently inherits `undici` audit
advisories. The adapter adds no runtime dependencies beyond its Pi AI peer;
keep the host Pi installation updated. Do not use `npm audit fix --force` to
downgrade Pi below this adapter's supported API version.

## Origin and license

Forked from [zereight/pi-muse-code](https://github.com/zereight/pi-muse-code).
Its Muse model-catalog work originated in
[ferdousbhai/pi-muse-bridge](https://github.com/ferdousbhai/pi-muse-bridge).
The upstream Git history and MIT license are retained.

This fork replaces the MSP-driven Muse agent with direct Pi-owned inference;
the original child-host/session-fold implementation is no longer used.

[MIT](LICENSE)
