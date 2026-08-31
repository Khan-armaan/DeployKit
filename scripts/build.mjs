import { execFile } from "node:child_process";
import { chmod, rm } from "node:fs/promises";
import process from "node:process";
import { promisify } from "node:util";

import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });
await build({
  entryPoints: ["src/cli.ts", "src/index.ts"],
  outdir: "dist",
  bundle: true,
  splitting: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  sourcemap: false,
  legalComments: "none",
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
});
await chmod("dist/cli.js", 0o755);

await promisify(execFile)(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "--project", "tsconfig.build.json"],
  { maxBuffer: 10 * 1024 * 1024 },
);

await import("./build-server-bundle.mjs");
