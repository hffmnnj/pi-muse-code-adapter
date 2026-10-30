import type { PreparedMusePayload } from "../options.js";

const descriptions: Readonly<Record<string, string>> = {
  edit: "Apply specified changes to an existing file.",
  glob: "Find file paths matching a glob pattern.",
  grep: "Find matching text in files and report its location.",
  question: "Ask the user to choose or provide an answer.",
  read: "Read a file or directory, optionally selecting a range.",
  shell:
    "Run a command in a chosen directory with an optional execution deadline or asynchronous completion. For background work, wait for its completion event rather than polling.",
  bash: "Run a command with an optional execution deadline.",
  skill: "Load instructions for a named available skill.",
  subagent:
    "Assign a task to an available registered worker, subject to current model-selection permissions.",
  todowrite: "Create or update the current task list.",
  webfetch: "Retrieve content from an HTTP or HTTPS address.",
  websearch: "Search the web for relevant information.",
  write: "Write content to a file.",
  execute: "Run JavaScript to compose available tool calls and their results.",
};
const parameterDescriptions: Readonly<Record<string, string>> = {
  command: "Command to run.",
  workdir: "Directory in which to run the command.",
  timeout: "Maximum time allowed for the operation.",
  background: "Whether to run the operation asynchronously.",
  path: "File or directory path.",
  offset: "Starting position for the requested range.",
  limit: "Maximum number of results or items.",
  pattern: "Pattern used to match results.",
  name: "Name of the requested item.",
  code: "Code to execute.",
  description: "Description of the item.",
};
const schemaMaps = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies",
];
const singleSchemas = [
  "items",
  "additionalItems",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
];
const schemaArrays = ["allOf", "anyOf", "oneOf", "prefixItems"];
const wireNames: Readonly<Record<string, string>> = {
  shell: "run_command",
  bash: "execute_command",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function maskSchema(schema: unknown, name?: string): void {
  if (!isRecord(schema)) return;
  if (typeof schema.description === "string") {
    const original = schema.description;
    schema.description =
      name === "timeout" && /milliseconds?/i.test(original)
        ? "Execution time limit in milliseconds."
        : name === "timeout" && /seconds?/i.test(original)
          ? "Execution time limit in seconds."
          : name
            ? Object.hasOwn(parameterDescriptions, name)
              ? parameterDescriptions[name]
              : "Value for this parameter."
            : "Schema for the declared arguments.";
  }
  for (const key of schemaMaps) {
    const entries = schema[key];
    if (isRecord(entries))
      for (const [name, child] of Object.entries(entries))
        maskSchema(child, name);
  }
  for (const key of singleSchemas) {
    const child = schema[key];
    if (key === "items" && Array.isArray(child))
      for (const item of child) maskSchema(item);
    else maskSchema(child);
  }
  for (const key of schemaArrays) {
    const children = schema[key];
    if (Array.isArray(children))
      for (const child of children) maskSchema(child);
  }
}

export function prepareMusePayload(input: unknown): PreparedMusePayload {
  const payload: unknown = structuredClone(input);
  const aliases = new Map<string, string>();
  if (!isRecord(payload)) return { payload, aliases };
  const tools = Array.isArray(payload.tools)
    ? payload.tools
        .filter(isRecord)
        .filter(
          (tool) => tool.type === "function" && typeof tool.name === "string",
        )
    : [];
  const independentNames = new Set(tools.map((tool) => tool.name as string));
  const replacements: Array<{ object: Record<string, unknown>; name: string }> =
    [];
  function select(object: Record<string, unknown>): void {
    if (object.namespace !== undefined) return;
    if (
      typeof object.name === "string" &&
      Object.hasOwn(wireNames, object.name)
    )
      replacements.push({ object, name: object.name });
  }
  for (const tool of tools) {
    const name = tool.name as string;
    tool.description = Object.hasOwn(descriptions, name)
      ? descriptions[name]
      : "Invoke this function using its declared arguments.";
    maskSchema(tool.parameters);
    select(tool);
  }
  if (Array.isArray(payload.input))
    for (const item of payload.input) {
      if (isRecord(item) && item.type === "function_call") select(item);
    }
  function selectChoice(choice: unknown): void {
    if (!isRecord(choice)) return;
    if (choice.type === "function") {
      select(choice);
      if (isRecord(choice.function)) select(choice.function);
    }
    if (choice.type === "allowed_tools" && Array.isArray(choice.tools))
      for (const tool of choice.tools) selectChoice(tool);
  }
  selectChoice(payload.tool_choice);
  for (const { name } of replacements) {
    const alias = wireNames[name]!;
    if (independentNames.has(alias))
      throw new Error(
        `Cannot alias tool ${name}: ${alias} is already an independent function tool.`,
      );
    aliases.set(alias, name);
  }
  for (const { object, name } of replacements) object.name = wireNames[name]!;
  return { payload, aliases };
}
