// Opt-in: runs the real Pi CLI using the existing Muse CLI login.
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";

const root = process.cwd();
const scratch = await mkdtemp(join(tmpdir(), "pi-muse-cli-check-"));
const command = `node -p "require('./package.json').name"`;
const expected = "pi-muse-code-adapter";
const common = [
  "--offline",
  "--no-extensions",
  "--no-mcp",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--no-session",
  "--extension",
  join(root, "src/index.ts"),
];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter(record)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

async function run(
  label: string,
  args: string[],
  timeoutMs: number,
  line: (value: string) => void,
): Promise<{ code: number | null; timedOut: boolean }> {
  const start = Date.now();
  console.log(`${label}: starting`);
  const child = spawn(join(root, "node_modules/.bin/pi"), args, {
    cwd: root,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: scratch,
      PI_CODING_AGENT_SESSION_DIR: join(scratch, "sessions"),
      PI_TELEMETRY: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let timedOut = false;
  let stderrSeen = false;
  child.stderr.on("data", () => {
    if (!stderrSeen)
      console.log(`${label}: stderr received (content suppressed)`);
    stderrSeen = true;
  });
  const reader = createInterface({ input: child.stdout });
  reader.on("line", line);
  const timer = setTimeout(() => {
    timedOut = true;
    console.log(
      `${label}: timed out after ${Date.now() - start}ms; stopping child`,
    );
    child.kill("SIGTERM");
  }, timeoutMs);
  let forceTimer: NodeJS.Timeout | undefined;
  child.on("error", () =>
    console.log(`${label}: child spawn error (details suppressed)`),
  );
  try {
    const code = await new Promise<number | null>((resolve) => {
      child.on("exit", () =>
        console.log(`${label}: process exited after ${Date.now() - start}ms`),
      );
      child.on("close", resolve);
      forceTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, timeoutMs + 2000);
    });
    console.log(`${label}: close code=${code} timedOut=${timedOut}`);
    return { code, timedOut };
  } finally {
    clearTimeout(timer);
    if (forceTimer) clearTimeout(forceTimer);
    reader.close();
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
}

let modelListed = false;
const list = await run(
  "model-list",
  [...common, "--list-models", "muse-code"],
  12_000,
  (line) => {
    if (line.includes("muse-spark-1.3-contributor")) modelListed = true;
  },
);
console.log(`model-list: target model found=${modelListed}`);
if (list.code !== 0 || list.timedOut || !modelListed) {
  console.error(
    "Smoke failed during startup, extension loading, or model resolution.",
  );
  process.exitCode = 1;
} else {
  const starts = new Map<string, boolean>();
  const milestones = new Set<string>();
  let bashComplete = false;
  let assistantOutputCorrect = false;
  let agentEnded = false;
  let assistantError = false;
  const result = await run(
    "inference",
    [
      ...common,
      "--model",
      "muse-code/muse-spark-1.3-contributor",
      "--thinking",
      "low",
      "--tools",
      "bash",
      "--print",
      "--mode",
      "json",
      `Use the native bash tool exactly once. Its command argument must be ${JSON.stringify(command)}. The current directory is already the package root; do not prefix cd. Then return only its observed output.`,
    ],
    55_000,
    (line) => {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        console.log("inference: non-JSON stdout (content suppressed)");
        return;
      }
      if (!record(event) || typeof event.type !== "string") return;
      if (
        [
          "agent_start",
          "turn_start",
          "tool_execution_start",
          "tool_execution_end",
          "agent_end",
        ].includes(event.type) &&
        !milestones.has(event.type)
      ) {
        milestones.add(event.type);
        console.log(`inference: ${event.type}`);
      }
      if (
        event.type === "message_update" &&
        record(event.assistantMessageEvent) &&
        typeof event.assistantMessageEvent.type === "string"
      ) {
        const type = event.assistantMessageEvent.type;
        if (
          [
            "start",
            "text_start",
            "thinking_start",
            "toolcall_start",
            "toolcall_end",
            "error",
          ].includes(type) &&
          !milestones.has(type)
        ) {
          milestones.add(type);
          console.log(`inference: provider ${type}`);
        }
      }
      if (
        event.type === "tool_execution_start" &&
        event.toolName === "bash" &&
        typeof event.toolCallId === "string" &&
        record(event.args)
      ) {
        const exact = event.args.command === command;
        starts.set(event.toolCallId, exact);
        const actual = event.args.command;
        console.log(
          `inference: bash command exact=${exact}; contains requested command=${typeof actual === "string" && actual.includes(command)}; contains cwd=${typeof actual === "string" && actual.includes(root)}; command type=${typeof actual}`,
        );
      }
      if (
        event.type === "tool_execution_end" &&
        event.toolName === "bash" &&
        typeof event.toolCallId === "string" &&
        record(event.result)
      ) {
        const outputCorrect =
          contentText(event.result.content).trim() === expected;
        bashComplete =
          starts.get(event.toolCallId) === true &&
          event.isError === false &&
          outputCorrect;
        console.log(
          `inference: bash completed=${bashComplete}; output matches package name=${outputCorrect}`,
        );
        if (bashComplete)
          console.log(`inference: observed tool output: ${expected}`);
      }
      if (
        event.type === "message_end" &&
        record(event.message) &&
        event.message.role === "assistant"
      ) {
        assistantError ||=
          event.message.stopReason === "error" ||
          event.message.stopReason === "aborted";
        if (event.message.stopReason === "stop")
          assistantOutputCorrect =
            contentText(event.message.content).trim() === expected;
        console.log(
          `inference: assistant ended stopReason=${typeof event.message.stopReason === "string" ? event.message.stopReason : "unknown"}; final output matches=${assistantOutputCorrect}`,
        );
      }
      if (event.type === "agent_end") agentEnded = true;
    },
  );
  console.log(
    `inference: agent ended=${agentEnded}; assistant error=${assistantError}`,
  );
  if (
    result.code !== 0 ||
    result.timedOut ||
    !bashComplete ||
    !assistantOutputCorrect ||
    !agentEnded ||
    assistantError
  ) {
    console.error(
      "Smoke failed: native tool round trip or clean shutdown incomplete.",
    );
    process.exitCode = 1;
  } else
    console.log("Smoke passed: native bash round trip and clean shutdown.");
}
