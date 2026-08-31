import { execFile } from "node:child_process";
import { chmod, readFile } from "node:fs/promises";
import process from "node:process";
import { promisify } from "node:util";

import { build } from "esbuild";

await build({
  entryPoints: ["src/server-bundle.ts"],
  outfile: "dist/server-cli.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  packages: "bundle",
  sourcemap: false,
  legalComments: "none",
  logOverride: { "empty-import-meta": "silent" },
  banner: { js: "#!/usr/bin/env node" },
});
await chmod("dist/server-cli.cjs", 0o755);

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const { stdout } = await promisify(execFile)(process.execPath, ["dist/server-cli.cjs", "--version"]);
if (stdout.trim() !== packageJson.version) {
  throw new Error(`standalone server runtime reported ${JSON.stringify(stdout.trim())}, expected ${packageJson.version}`);
}
