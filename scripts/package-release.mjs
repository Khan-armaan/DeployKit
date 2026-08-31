import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import process from "node:process";

const output = await new Promise((resolve, reject) => {
  const child = spawn("npm", ["pack", "--json"], { stdio: ["ignore", "pipe", "inherit"] });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.once("error", reject);
  child.once("close", (code) => {
    if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
    else reject(new Error(`npm pack exited with code ${code}`));
  });
});

const entries = JSON.parse(output);
const filename = entries[0]?.filename;
if (typeof filename !== "string" || filename.includes("/") || !filename.endsWith(".tgz")) {
  throw new Error("npm pack did not return a safe tarball filename");
}
const checksum = createHash("sha256").update(await readFile(filename)).digest("hex");
const checksumFile = `${filename}.sha256`;
await writeFile(checksumFile, `${checksum}  ${filename}\n`, { mode: 0o644 });
const result = { filename, sha256: checksum, checksumFile };
if (process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_OUTPUT) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `filename=${filename}\nchecksum_file=${checksumFile}\nsha256=${checksum}\n`,
  );
}
process.stdout.write(`${JSON.stringify(result)}\n`);
