import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { configureServerProgram, runServerCli } from "../src/server-cli.js";

function sink(): { stream: Writable; output: () => string } {
  const chunks: string[] = [];
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    }),
    output: () => chunks.join(""),
  };
}

describe("standalone VPS command surface", () => {
  it("contains only the restricted gateway and the internal server operations", () => {
    const program = configureServerProgram();
    expect(program.commands.map((command) => command.name())).toEqual(["gateway", "server"]);
    const gateway = program.commands.find((command) => command.name() === "gateway");
    // The forced command is exactly `deploykit gateway`: no options, no
    // arguments, and no subcommands a caller could reach.
    expect(gateway?.options).toEqual([]);
    expect(gateway?.registeredArguments).toEqual([]);
    expect(gateway?.commands).toEqual([]);
    expect(program.commands[1]?.commands.map((command) => command.name())).toEqual([
      "apply",
      "secrets-write",
      "secrets-check",
      "target-status",
      "target-logs",
    ]);
  });

  it("rejects local-only advisor and bootstrap commands with a stable usage error", async () => {
    for (const command of ["advise", "bootstrap"]) {
      const capture = sink();
      const exitCode = await runServerCli(["node", "deploykit", command, "--json"], capture.stream);
      expect(exitCode).toBe(2);
      expect(JSON.parse(capture.output())).toMatchObject({ ok: false, code: "DK_USAGE" });
    }
  });
});
