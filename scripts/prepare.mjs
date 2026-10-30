import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const compiler = new URL("../node_modules/typescript/bin/tsc", import.meta.url);

// Pi loads the TypeScript entry directly and installs Git extensions without dev dependencies.
if (existsSync(compiler)) {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(compiler),
      "-p",
      fileURLToPath(new URL("../tsconfig.json", import.meta.url)),
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
