import { execFile } from "node:child_process";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import {
  configureProgram,
  localAdvisorSecretValues,
  main,
  normalizeCliError,
  renderCliError,
  runCli,
  validateAdvisorCandidate,
} from "../src/cli.js";
import { DeployKitError } from "../src/errors.js";
import { ManifestFileError, parseManifest, type ProjectManifest } from "../src/manifest.js";
import { ServerError } from "../src/server/errors.js";
import { assertValidManifest } from "../src/validation.js";

const execFileAsync = promisify(execFile);

function manifest(): ProjectManifest {
  return parseManifest({
    apiVersion: "deploykit/v1alpha1",
    metadata: { name: "cli-app", requiredVersion: "0.1.0" },
    services: {},
    routes: [],
    secrets: { required: ["APP_TOKEN"], generated: ["SESSION_SECRET"] },
    targets: {
      production: {
        runnerLabel: "vps-one",
        primaryDomain: "cli.example.com",
        aliases: [],
        environment: "production",
        publicOverrides: {},
        runtimeOverrides: {},
      },
    },
  });
}

function captureStream(): { stream: Writable; output: () => string } {
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

describe("public CLI contract", () => {
  it("exposes every documented command and server entrypoint without parsing on import", () => {
    const program = configureProgram();
    expect(program.commands.map((command) => command.name())).toEqual([
      "init",
      "validate",
      "plan",
      "advise",
      "server",
      "secrets",
      "deploy",
      "retry",
      "status",
      "logs",
    ]);
    expect(program.commands.find((command) => command.name() === "server")?.commands.map((command) => command.name())).toEqual([
      "bootstrap",
      "apply",
      "secrets-write",
      "secrets-check",
      "target-status",
      "target-logs",
    ]);
    expect(program.commands.find((command) => command.name() === "secrets")?.commands.map((command) => command.name())).toEqual([
      "set",
      "check",
    ]);
  });

  it("turns Commander parsing failures into stable DeployKit usage errors", async () => {
    await expect(
      main(["node", "deploykit", "logs", "--target", "production", "--tail", "0", "--json"]),
    ).rejects.toMatchObject({ code: "DK_USAGE", exitCode: 2 });
    await expect(
      main(["node", "deploykit", "init", "--frontend-mode", "typo"]),
    ).rejects.toMatchObject({ code: "DK_USAGE", exitCode: 2 });
    await expect(
      main(["node", "deploykit", "server", "apply", "--manifest", "elsewhere.yaml", "--target", "production", "--commit", "short"]),
    ).rejects.toMatchObject({ code: "DK_USAGE", exitCode: 2, message: expect.stringContaining("--commit") });
  });

  it("prints top-level help successfully when invoked without a command", async () => {
    const writes: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      await expect(main(["node", "deploykit"])).resolves.toBeUndefined();
      expect(writes.join("")).toContain("Usage: deploykit [options] [command]");
    } finally {
      write.mockRestore();
    }
  });

  it("lets bare deploy securely create the one-file configuration without legacy flags", async () => {
    const root = await mkdtemp(join(tmpdir(), "deploykit-cli-config-"));
    await execFileAsync("git", ["init", "--quiet", root]);
    const previousDirectory = process.cwd();
    const writes: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      process.chdir(root);
      await expect(main(["node", "deploykit", "deploy"])).resolves.toBeUndefined();
      expect(writes.join("")).toContain("Created");
      expect(writes.join("")).toContain("deploykit.config.yaml");
      expect((await stat(join(root, "deploykit.config.yaml"))).mode & 0o777).toBe(0o600);
      await expect(main(["node", "deploykit", "deploy"])).rejects.toMatchObject({
        code: "DK_UNSUPPORTED",
        message: expect.stringContaining("orchestrator is not implemented yet"),
      });
    } finally {
      process.chdir(previousDirectory);
      write.mockRestore();
    }
  });

  it("emits one machine-readable error envelope and returns its stable exit code", async () => {
    const capture = captureStream();
    const exitCode = await runCli(
      ["node", "deploykit", "unknown-command", "--json"],
      capture.stream,
    );
    expect(exitCode).toBe(2);
    expect(capture.output().trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(capture.output())).toMatchObject({
      ok: false,
      code: "DK_USAGE",
    });
  });

  it("redacts error messages and verbose/JSON details", () => {
    const rendered = renderCliError(
      new DeployKitError("DK_PREFLIGHT_FAILED", "password=correct-horse", {
        details: { token: "ghp_should-never-print", nested: "api_key=also-secret" },
      }),
      { json: true, verbose: true },
    );
    expect(rendered.exitCode).toBe(4);
    expect(rendered.output).not.toContain("correct-horse");
    expect(rendered.output).not.toContain("ghp_should-never-print");
    expect(rendered.output).not.toContain("also-secret");
    expect(JSON.parse(rendered.output)).toMatchObject({
      ok: false,
      code: "DK_PREFLIGHT_FAILED",
      details: { token: "[REDACTED]" },
    });
  });

  it("maps granular server failures to stable public codes without losing the server code", () => {
    expect(normalizeCliError(new ServerError("SERVER_SECRET_MISSING", "missing"))).toMatchObject({
      code: "DK_SECRET_MISSING",
      exitCode: 6,
      details: { serverCode: "SERVER_SECRET_MISSING" },
    });
    expect(normalizeCliError(new ServerError("SERVER_DOMAIN_COLLISION", "collision"))).toMatchObject({
      code: "DK_CONFLICT",
      exitCode: 4,
      details: { serverCode: "SERVER_DOMAIN_COLLISION" },
    });
    expect(normalizeCliError(new ServerError("SERVER_UNSUPPORTED_OS", "unsupported"))).toMatchObject({
      code: "DK_UNSUPPORTED",
      exitCode: 8,
      details: { serverCode: "SERVER_UNSUPPORTED_OS" },
    });
  });

  it("maps missing, malformed, and semantically invalid manifests to stable public codes", () => {
    expect(normalizeCliError(new ManifestFileError(
      "MANIFEST_READ_FAILED",
      "missing manifest",
      { cause: Object.assign(new Error("missing"), { code: "ENOENT" }), filePath: "/tmp/deploykit.yaml" },
    ))).toMatchObject({ code: "DK_MANIFEST_NOT_FOUND", exitCode: 2 });
    expect(normalizeCliError(new ManifestFileError("MANIFEST_YAML_INVALID", "bad YAML")))
      .toMatchObject({ code: "DK_MANIFEST_INVALID", exitCode: 3 });
    expect(normalizeCliError(expectInvalidManifestError())).toMatchObject({
      code: "DK_VALIDATION_FAILED",
      exitCode: 3,
    });
  });
});

function expectInvalidManifestError(): unknown {
  try {
    assertValidManifest({
      apiVersion: "deploykit/v1alpha1",
      metadata: { name: "invalid", requiredVersion: "0.1.0" },
      services: {},
      secrets: { required: ["CERTBOT_EMAIL"] },
      targets: { production: { runnerLabel: "vps-one", primaryDomain: "invalid.example.com" } },
    });
  } catch (error) {
    return error;
  }
  throw new Error("expected invalid manifest");
}

describe("advisor CLI safety", () => {
  it("collects only relevant local values for exact redaction and deduplicates them", () => {
    expect(localAdvisorSecretValues(manifest(), {
      APP_TOKEN: "same-secret",
      SESSION_SECRET: "same-secret",
      OPENAI_API_KEY: "openai-secret",
      ANTHROPIC_API_KEY: "anthropic-secret",
      UNRELATED_SECRET: "must-not-be-read",
    })).toEqual(["same-secret", "openai-secret", "anthropic-secret"]);
  });

  it("rejects schema-valid advisor candidates that violate manifest semantics", () => {
    const invalid = {
      ...manifest(),
      routes: [{
        hostname: "@primary",
        path: "/api/",
        match: "prefix",
        target: "missing-service",
        preservePrefix: true,
        websocket: false,
      }],
    };
    expect(() => validateAdvisorCandidate(invalid)).toThrow(/Manifest validation failed/);
  });
});
