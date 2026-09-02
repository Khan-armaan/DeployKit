import { chmod, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { join, resolve } from "node:path";

import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { DeployKitError, exitCodeFor, type ErrorCode } from "../src/errors.js";
import {
  confirmGatewayBinding,
  createGatewayOperations,
  encodeGatewayFrames,
  inputStreamFrom,
  parseCanonicalRuntimeManifest,
  parseGatewayOutputStream,
  parseGatewayRequestStream,
  readBoundedInput,
  readGatewayBinding,
  runGatewayCommand,
  runGatewaySession,
  assertRestrictedInvocation,
  minimalGatewayEnvironment,
  readGatewayHostFacts,
  type GatewayApplyContext,
  type GatewayInspectContext,
  type GatewayOperations,
  type GatewayRequestStream,
} from "../src/gateway/index.js";
import { compileRuntimeManifest } from "../src/orchestrator/compile.js";
import { VERSION } from "../src/version.js";
import { parseOperatorConfig } from "../src/orchestrator/config-schema.js";
import {
  GATEWAY_PROTOCOL_LIMITS,
  type GatewayDeploymentResult,
  type GatewayHandshakeResult,
  type RootOwnedGatewayBinding,
} from "../src/orchestrator/contracts.js";
import { RECOVERY_INSTRUCTIONS } from "../src/orchestrator/failures.js";
import { configureServerProgram } from "../src/server-cli.js";
import type { ServerRoots } from "../src/server/paths.js";

const FIXTURE_ROOT = resolve("test", "fixtures", "orchestrator");
const CLOCK = (): Date => new Date("2026-01-05T09:00:00.000Z");

interface ExpectationCase {
  readonly fixture: string;
  readonly code: ErrorCode;
  readonly recovery: string;
}

interface Expectations {
  readonly canaries: readonly string[];
  readonly cases: readonly ExpectationCase[];
}

let expectations: Expectations;
let binding: RootOwnedGatewayBinding;

async function fixture(...segments: string[]): Promise<string> {
  return readFile(join(FIXTURE_ROOT, ...segments), "utf8");
}

beforeAll(async () => {
  expectations = JSON.parse(await fixture("expectations.json")) as Expectations;
  binding = JSON.parse(await fixture("binding", "valid", "binding.json")) as RootOwnedGatewayBinding;
});

function isOutputStream(text: string): boolean {
  try {
    const first = JSON.parse(text.slice(0, text.indexOf("\n"))) as { frame?: string };
    return first.frame === "progress" || first.frame === "result";
  } catch {
    return false;
  }
}

/** Parses, then confirms the binding, exactly as a real session does. */
function acceptStream(text: string): GatewayRequestStream {
  const stream = parseGatewayRequestStream(text);
  confirmGatewayBinding(stream, binding);
  return stream;
}

function rejection(run: () => unknown): DeployKitError {
  try {
    run();
  } catch (error) {
    if (error instanceof DeployKitError) return error;
    throw error;
  }
  throw new Error("expected the gateway to refuse this input");
}

function containsCanary(text: string): string | undefined {
  return expectations.canaries.find((canary) => text.includes(canary));
}

// ------------------------------------------------------------- valid input --

describe("gateway request streams", () => {
  it("accepts every frozen valid stream and re-derives its claims", async () => {
    const apply = acceptStream(await fixture("protocol", "valid", "apply.jsonl"));
    expect(apply.operation).toBe("apply");
    expect(apply.dryRun).toBe(false);
    expect(apply.requestId).toBe("9f1c0a2b-3d4e-4f50-8a1b-2c3d4e5f6071");
    // Frozen, not derived: the point is that these exact bytes still hash to
    // this exact value. A release moves it, through
    // `scripts/refreeze-protocol-fixtures.mjs`, and nothing else may.
    expect(apply.manifestDigest?.value).toBe(
      "32ae720818174f5184e0c5e5cc270a31d0cb2ec4e1e791627436082e20e2d657",
    );
    expect(apply.manifest?.target.targetId).toBe(binding.targetId);
    expect([...apply.secrets.keys()]).toEqual(["CERTBOT_EMAIL", "DATABASE_URL", "POSTGRES_PASSWORD"]);

    const retry = acceptStream(await fixture("protocol", "valid", "retry.jsonl"));
    expect(retry.operation).toBe("retry");
    expect(retry.secrets.size).toBe(3);

    const dryRun = acceptStream(await fixture("protocol", "valid", "apply-dry-run.jsonl"));
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.secrets.size).toBe(0);

    const handshake = acceptStream(await fixture("protocol", "valid", "handshake.jsonl"));
    expect(handshake.operation).toBe("handshake");
    expect(handshake.manifest).toBeNull();
    expect(handshake.manifestBytes).toBeNull();

    const inspect = acceptStream(await fixture("protocol", "valid", "inspect.jsonl"));
    expect(inspect.operation).toBe("inspect");
    expect(inspect.manifest).toBeNull();
    expect(inspect.request.commitSha).toBe("3f0a1b2c4d5e6f708192a3b4c5d6e7f809a1b2c3");
  });

  it("recomputes the manifest digest from the bytes rather than believing it", async () => {
    const text = await fixture("protocol", "valid", "apply.jsonl");
    const stream = acceptStream(text);
    const compiled = compileRuntimeManifest(
      parseOperatorConfig(
        parseYaml(await readFile(resolve("test", "fixtures", "static-compose", "deploykit.config.fixture.yaml"), "utf8")),
      ),
    );
    expect(stream.manifestBytes?.equals(compiled.canonicalBytes)).toBe(true);
    expect(stream.manifestDigest?.value).toBe(compiled.digest.value);
    expect(stream.manifest).toEqual(compiled.manifest);
  });

  it("reassembles a stream delivered in arbitrary chunks", async () => {
    const text = await fixture("protocol", "valid", "apply.jsonl");
    const bytes = Buffer.from(text, "utf8");
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += 97) {
      chunks.push(bytes.subarray(offset, offset + 97));
    }
    expect(chunks.length).toBeGreaterThan(20);
    expect(await readBoundedInput(Readable.from(chunks))).toBe(text);
  });
});

// ------------------------------------------------------------ hostile input --

describe("gateway protocol refusals", () => {
  it("rejects every hostile fixture with its frozen code and recovery", async () => {
    const cases = expectations.cases.filter((entry) => entry.fixture.startsWith("protocol/invalid/"));
    expect(cases.length).toBeGreaterThan(15);
    for (const entry of cases) {
      const text = await fixture(...entry.fixture.split("/"));
      const error = rejection(() => {
        if (isOutputStream(text)) parseGatewayOutputStream(text);
        else acceptStream(text);
      });
      expect(error.code, entry.fixture).toBe(entry.code);
      expect((error.details as { recovery?: string }).recovery, entry.fixture).toBe(entry.recovery);
      expect(error.exitCode, entry.fixture).toBe(exitCodeFor(entry.code));
    }
  });

  it("covers every hostile protocol fixture with an expectation", async () => {
    const files = (await readdir(join(FIXTURE_ROOT, "protocol", "invalid"))).sort();
    const declared = expectations.cases
      .filter((entry) => entry.fixture.startsWith("protocol/invalid/"))
      .map((entry) => entry.fixture.split("/").at(-1));
    expect(files).toEqual(declared);
  });

  it("never leaks a secret canary through a refusal", async () => {
    const cases = expectations.cases.filter((entry) => entry.fixture.startsWith("protocol/invalid/"));
    for (const entry of cases) {
      const text = await fixture(...entry.fixture.split("/"));
      const error = rejection(() => {
        if (isOutputStream(text)) parseGatewayOutputStream(text);
        else acceptStream(text);
      });
      const rendered = `${error.message}\n${JSON.stringify(error.details)}`;
      expect(containsCanary(rendered), entry.fixture).toBeUndefined();
    }
  });

  it("refuses a stream that is empty, unterminated, or over the input bound", () => {
    expect(rejection(() => parseGatewayRequestStream("")).code).toBe("DK_GATEWAY_PROTOCOL_INVALID");
    expect(rejection(() => parseGatewayRequestStream("{}")).code).toBe("DK_GATEWAY_PROTOCOL_INVALID");
    const oversized = `${"x".repeat(GATEWAY_PROTOCOL_LIMITS.maxInputBytes)}\n`;
    expect(rejection(() => parseGatewayRequestStream(oversized)).code).toBe("DK_GATEWAY_PROTOCOL_INVALID");
  });

  it("refuses more input than the frozen bound before buffering it", async () => {
    const stream = inputStreamFrom("x".repeat(1_024));
    await expect(readBoundedInput(stream, 16)).rejects.toMatchObject({
      code: "DK_GATEWAY_PROTOCOL_INVALID",
    });
  });

  it("refuses a request that declares more secret frames than the bound allows", async () => {
    const text = await fixture("protocol", "valid", "apply.jsonl");
    const lines = text.trimEnd().split("\n");
    const request = JSON.parse(lines[0]!) as Record<string, unknown>;
    const expected = request.expectedPayload as Record<string, number>;
    expected.secretFrames = GATEWAY_PROTOCOL_LIMITS.maxSecretFrames + 1;
    const error = rejection(() => parseGatewayRequestStream(`${JSON.stringify(request)}\n`));
    expect(error.code).toBe("DK_GATEWAY_PROTOCOL_INVALID");
  });

  it("refuses an output frame smuggled into a request stream", async () => {
    const request = (await fixture("protocol", "valid", "handshake.jsonl")).trimEnd().split("\n");
    const progress = (await fixture("protocol", "valid", "output-success.jsonl")).split("\n")[0]!;
    const error = rejection(() =>
      parseGatewayRequestStream(`${request[0]!}\n${progress}\n${request[1]!}\n`));
    expect(error.code).toBe("DK_GATEWAY_PROTOCOL_INVALID");
  });
});

// --------------------------------------------------------------- output side --

describe("gateway output streams", () => {
  it("accepts the frozen success, failure, and handshake streams", async () => {
    for (const name of ["output-success.jsonl", "output-failure.jsonl", "output-handshake.jsonl"]) {
      const text = await fixture("protocol", "valid", name);
      const frames = parseGatewayOutputStream(text);
      expect(frames.at(-1)?.frame, name).toBe("result");
      expect(encodeGatewayFrames(frames), name).toBe(text);
    }
  });

  it("refuses a stream with no result, two results, or a result that is not last", async () => {
    const text = await fixture("protocol", "valid", "output-success.jsonl");
    const lines = text.trimEnd().split("\n");
    const progressOnly = `${lines.slice(0, 3).join("\n")}\n`;
    expect(rejection(() => parseGatewayOutputStream(progressOnly)).code).toBe("DK_GATEWAY_PROTOCOL_INVALID");
    const resultFirst = `${lines.at(-1)!}\n${lines[0]!}\n`;
    expect(rejection(() => parseGatewayOutputStream(resultFirst)).code).toBe("DK_GATEWAY_PROTOCOL_INVALID");
  });
});

// -------------------------------------------------------- runtime manifest --

describe("canonical runtime manifest", () => {
  async function manifestBytes(): Promise<Buffer> {
    const text = await fixture("protocol", "valid", "apply.jsonl");
    const frame = JSON.parse(text.split("\n")[1]!) as { payload: string };
    return Buffer.from(frame.payload, "base64");
  }

  it("accepts exactly the compiled canonical bytes", async () => {
    const manifest = parseCanonicalRuntimeManifest(await manifestBytes());
    expect(manifest.apiVersion).toBe("deploykit/runtime/v1alpha1");
    expect(manifest.secrets.required).toEqual(["CERTBOT_EMAIL", "DATABASE_URL", "POSTGRES_PASSWORD"]);
  });

  it("refuses a semantically equal but noncanonically encoded manifest", async () => {
    const bytes = await manifestBytes();
    const reordered = Buffer.from(
      bytes.toString("utf8").replace(
        '"metadata":\n  "name": "static-compose"\n  "requiredVersion"',
        '"metadata":\n  "requiredVersion"',
      ).replace(`: "${VERSION}"\n`, `: "${VERSION}"\n  "name": "static-compose"\n`),
      "utf8",
    );
    expect(reordered.equals(bytes)).toBe(false);
    expect(rejection(() => parseCanonicalRuntimeManifest(reordered)).code).toBe("DK_GATEWAY_PROTOCOL_INVALID");
  });

  it("refuses an unknown key, a missing resolved default, and unparsable bytes", async () => {
    const text = (await manifestBytes()).toString("utf8");
    const unknownKey = Buffer.from(`${text}"sudo": true\n`, "utf8");
    expect(rejection(() => parseCanonicalRuntimeManifest(unknownKey)).code).toBe("DK_GATEWAY_PROTOCOL_INVALID");
    const missingDefault = Buffer.from(text.replace('  "spaFallback": true\n', ""), "utf8");
    expect(rejection(() => parseCanonicalRuntimeManifest(missingDefault)).code).toBe("DK_GATEWAY_PROTOCOL_INVALID");
    expect(rejection(() => parseCanonicalRuntimeManifest(Buffer.from("\t- [", "utf8"))).code)
      .toBe("DK_GATEWAY_PROTOCOL_INVALID");
    expect(rejection(() => parseCanonicalRuntimeManifest(Buffer.from([0x22, 0x00, 0x22]))).code)
      .toBe("DK_GATEWAY_PROTOCOL_INVALID");
  });
});

// ---------------------------------------------------------- binding reading --

describe("root-owned gateway binding", () => {
  async function bindingDirectory(): Promise<string> {
    return mkdtemp(join(tmpdir(), "deploykit-binding-"));
  }

  it("reads a well-formed private binding", async () => {
    const directory = await bindingDirectory();
    const path = join(directory, "binding.json");
    await writeFile(path, JSON.stringify(binding), { mode: 0o644 });
    expect(await readGatewayBinding({ path, requireRootOwnership: false })).toEqual(binding);
  });

  it("refuses a symlink, a group-writable file, and a foreign shape", async () => {
    const directory = await bindingDirectory();
    const real = join(directory, "real.json");
    await writeFile(real, JSON.stringify(binding), { mode: 0o644 });
    const link = join(directory, "link.json");
    await symlink(real, link);
    await expect(readGatewayBinding({ path: link, requireRootOwnership: false }))
      .rejects.toMatchObject({ code: "DK_GATEWAY_BOOTSTRAP_FAILED" });

    const writable = join(directory, "writable.json");
    await writeFile(writable, JSON.stringify(binding));
    await chmod(writable, 0o666);
    await expect(readGatewayBinding({ path: writable, requireRootOwnership: false }))
      .rejects.toMatchObject({ code: "DK_GATEWAY_BOOTSTRAP_FAILED" });

    const foreign = join(directory, "foreign.json");
    await writeFile(foreign, JSON.stringify({ ...binding, forcedCommand: "bash -lc" }), { mode: 0o600 });
    await expect(readGatewayBinding({ path: foreign, requireRootOwnership: false }))
      .rejects.toMatchObject({ code: "DK_GATEWAY_BOOTSTRAP_FAILED" });

    await expect(readGatewayBinding({ path: join(directory, "missing.json"), requireRootOwnership: false }))
      .rejects.toMatchObject({ code: "DK_GATEWAY_BOOTSTRAP_FAILED" });
  });

  it("lets a caller confirm the binding but never choose it", async () => {
    const substitution = await fixture("protocol", "invalid", "binding-substitution.jsonl");
    const stream = parseGatewayRequestStream(substitution);
    const error = rejection(() => { confirmGatewayBinding(stream, binding); });
    expect(error.code).toBe("DK_GATEWAY_BINDING_MISMATCH");
    expect((error.details as { fields: string[] }).fields).toEqual(["repository", "targetId"]);

    const apply = parseGatewayRequestStream(await fixture("protocol", "valid", "apply.jsonl"));
    const otherTarget = rejection(() => {
      confirmGatewayBinding(apply, { ...binding, targetName: "staging" });
    });
    expect(otherTarget.code).toBe("DK_GATEWAY_BINDING_MISMATCH");
  });
});

// ------------------------------------------------------------- invocation --

describe("restricted invocation", () => {
  const base = { environment: {}, argv: [], stdinIsTty: false, stdoutIsTty: false };

  it("accepts only a non-interactive forced command with no arguments", () => {
    expect(() => { assertRestrictedInvocation(base); }).not.toThrow();
    expect(() => { assertRestrictedInvocation({ ...base, environment: { SSH_ORIGINAL_COMMAND: "" } }); })
      .not.toThrow();
  });

  it("fails closed on a client command, arguments, a PTY, or forwarding", () => {
    const hostile = [
      { ...base, environment: { SSH_ORIGINAL_COMMAND: "/bin/bash" } },
      { ...base, argv: ["--target", "production"] },
      { ...base, environment: { SSH_TTY: "/dev/pts/0" } },
      { ...base, environment: { SSH_AUTH_SOCK: "/tmp/agent" } },
      { ...base, environment: { DISPLAY: "localhost:10.0" } },
      { ...base, environment: { XAUTHORITY: "/home/x/.Xauthority" } },
      { ...base, stdinIsTty: true },
      { ...base, stdoutIsTty: true },
    ];
    for (const invocation of hostile) {
      expect(rejection(() => { assertRestrictedInvocation(invocation); }).code)
        .toBe("DK_GATEWAY_PROTOCOL_INVALID");
    }
  });
});

// ---------------------------------------------------------------- sessions --

const DEPLOYMENT_RESULT: GatewayDeploymentResult = {
  kind: "deployment",
  outcome: "succeeded",
  targetName: "production",
  targetId: "04809ce707a77a199e6b989440139ba0",
  commitSha: "3f0a1b2c4d5e6f708192a3b4c5d6e7f809a1b2c3",
  manifestDigest: null,
  phase: "complete",
  domains: ["static.example.test"],
  ports: [{ service: "api", address: "127.0.0.1", port: 34_071 }],
  health: [{ service: "api", healthy: true, check: "http" }],
  resumed: false,
  failureCode: null,
};

interface FakeOperations extends GatewayOperations {
  readonly applied: GatewayApplyContext[];
  readonly inspected: GatewayInspectContext[];
}

function fakeOperations(
  overrides: {
    capabilities?: readonly GatewayOperations["capabilities"][number][];
    apply?: (context: GatewayApplyContext) => Promise<GatewayDeploymentResult>;
  } = {},
): FakeOperations {
  const applied: GatewayApplyContext[] = [];
  const inspected: GatewayInspectContext[] = [];
  return {
    applied,
    inspected,
    capabilities: overrides.capabilities ?? ["handshake", "apply", "retry", "inspect"],
    async handshake(target): Promise<GatewayHandshakeResult> {
      return {
        kind: "handshake",
        bindingId: target.bindingId,
        targetId: target.targetId,
        runtimeVersion: target.runtimeVersion,
        runtimeBundleSha256: target.runtimeBundleSha256,
        capabilities: ["handshake", "apply", "retry", "inspect"],
      };
    },
    async inspect(context): Promise<GatewayDeploymentResult> {
      inspected.push(context);
      return { ...DEPLOYMENT_RESULT, outcome: "not-deployed", phase: null };
    },
    async apply(context): Promise<GatewayDeploymentResult> {
      applied.push(context);
      if (overrides.apply !== undefined) return overrides.apply(context);
      context.report({
        phase: "resources-reserved",
        code: "DK_GATEWAY_RESOURCES_RESERVED",
        message: "Loopback ports and domains reserved.",
      });
      return DEPLOYMENT_RESULT;
    },
  };
}

async function session(
  streamName: string,
  operations: GatewayOperations = fakeOperations(),
): Promise<Awaited<ReturnType<typeof runGatewaySession>>> {
  return runGatewaySession(await fixture("protocol", "valid", streamName), {
    operations,
    readBinding: async () => binding,
    now: CLOCK,
    invocation: { environment: {}, argv: [], stdinIsTty: false, stdoutIsTty: false },
  });
}

describe("gateway sessions", () => {
  it("answers a handshake with a single result frame", async () => {
    const result = await session("handshake.jsonl");
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    const frames = parseGatewayOutputStream(result.output);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ frame: "result", ok: true, code: "DK_GATEWAY_OK", recovery: "none" });
  });

  it("reports inspect and apply as bounded, strictly ordered output streams", async () => {
    const operations = fakeOperations();
    const inspect = await session("inspect.jsonl", operations);
    expect(parseGatewayOutputStream(inspect.output).map((frame) => frame.frame))
      .toEqual(["progress", "progress", "result"]);
    expect(operations.inspected[0]?.commitSha).toBe("3f0a1b2c4d5e6f708192a3b4c5d6e7f809a1b2c3");

    const apply = await session("apply.jsonl", operations);
    expect(apply.ok).toBe(true);
    const phases = parseGatewayOutputStream(apply.output)
      .filter((frame) => frame.frame === "progress")
      .map((frame) => (frame as { phase: string }).phase);
    expect(phases).toEqual(["request-validated", "binding-verified", "manifest-validated", "resources-reserved"]);
    expect(operations.applied[0]?.operation).toBe("apply");
    expect(operations.applied[0]?.dryRun).toBe(false);
    expect([...(operations.applied[0]?.secrets.keys() ?? [])])
      .toEqual(["CERTBOT_EMAIL", "DATABASE_URL", "POSTGRES_PASSWORD"]);
  });

  it("passes retry and dry-run through to the runtime unchanged", async () => {
    const operations = fakeOperations();
    await session("retry.jsonl", operations);
    await session("apply-dry-run.jsonl", operations);
    expect(operations.applied.map((context) => [context.operation, context.dryRun]))
      .toEqual([["retry", false], ["apply", true]]);
  });

  it("refuses an operation this installation cannot serve", async () => {
    const result = await session("apply.jsonl", fakeOperations({ capabilities: ["handshake", "inspect"] }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe("DK_GATEWAY_BOOTSTRAP_FAILED");
    expect(result.recovery).toBe("repair-vps-and-rerun");
    parseGatewayOutputStream(result.output);
  });

  it("turns every hostile stream into a parsable failure result", async () => {
    const cases = expectations.cases.filter((entry) => entry.fixture.startsWith("protocol/invalid/"))
      .filter((entry) => !entry.fixture.endsWith("progress-sequence-regression.jsonl"));
    for (const entry of cases) {
      const text = await fixture(...entry.fixture.split("/"));
      const result = await runGatewaySession(text, {
        operations: fakeOperations(),
        readBinding: async () => binding,
        now: CLOCK,
        invocation: { environment: {}, argv: [], stdinIsTty: false, stdoutIsTty: false },
      });
      expect(result.ok, entry.fixture).toBe(false);
      expect(result.code, entry.fixture).toBe(entry.code);
      expect(result.recovery, entry.fixture).toBe(entry.recovery);
      expect(result.exitCode, entry.fixture).toBe(exitCodeFor(entry.code));
      expect(Object.hasOwn(RECOVERY_INSTRUCTIONS, result.recovery)).toBe(true);
      expect(containsCanary(result.output), entry.fixture).toBeUndefined();
      // A refusal before the binding is confirmed emits nothing but the result;
      // a binding mismatch is reached only after the request was accepted.
      expect(parseGatewayOutputStream(result.output), entry.fixture).toHaveLength(
        entry.code === "DK_GATEWAY_BINDING_MISMATCH" ? 2 : 1,
      );
    }
  });

  it("keeps a received secret out of stdout even when the runtime leaks it", async () => {
    const leaked = "DK_CANARY_POSTGRES_PASSWORD_c481ad";
    const result = await session("apply.jsonl", fakeOperations({
      apply: (context) => {
        context.report({
          phase: "workloads-ready",
          code: "DK_GATEWAY_WORKLOADS_READY",
          message: `compose up failed with POSTGRES_PASSWORD=${leaked}`,
        });
        throw new Error(`docker compose exited 1: POSTGRES_PASSWORD=${leaked}`);
      },
    }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe("DK_DEPLOYMENT_FAILED");
    expect(containsCanary(result.output)).toBeUndefined();
    expect(containsCanary(result.reason ?? "")).toBeUndefined();
    expect(result.output).toContain("[REDACTED]");
    parseGatewayOutputStream(result.output);
  });

  it("refuses an interactive or command-bearing invocation before reading stdin", async () => {
    let read = false;
    const result = await runGatewaySession(async () => { read = true; return ""; }, {
      operations: fakeOperations(),
      readBinding: async () => binding,
      now: CLOCK,
      invocation: {
        environment: { SSH_ORIGINAL_COMMAND: "cat /etc/shadow" },
        argv: [],
        stdinIsTty: false,
        stdoutIsTty: false,
      },
    });
    expect(read).toBe(false);
    expect(result.code).toBe("DK_GATEWAY_PROTOCOL_INVALID");
    expect(result.frames).toHaveLength(1);
    expect((result.frames[0] as { requestId: string | null }).requestId).toBeNull();
  });
});

// -------------------------------------------------------------- CLI wiring --

describe("gateway command", () => {
  it("writes only frames to stdout and returns the catalog exit code", async () => {
    const chunks: string[] = [];
    const stdout = { write: (value: string) => { chunks.push(value); return true; } } as NodeJS.WritableStream;
    const result = await runGatewayCommand({
      argv: [],
      env: {},
      stdin: inputStreamFrom(await fixture("protocol", "valid", "handshake.jsonl")),
      stdout,
      stdinIsTty: false,
      stdoutIsTty: false,
      now: CLOCK,
      operations: fakeOperations(),
      readBinding: async () => binding,
    });
    expect(result.exitCode).toBe(0);
    expect(chunks.join("")).toBe(result.output);
    parseGatewayOutputStream(chunks.join(""));
  });

  it("advertises only the non-mutating operations without a source provider", async () => {
    const operations = createGatewayOperations({ runtimeVersion: binding.runtimeVersion });
    expect(operations.capabilities).toEqual(["handshake", "inspect"]);
    const handshake = await operations.handshake(binding);
    expect(handshake.capabilities).toEqual(["handshake", "inspect"]);
    await expect(operations.handshake({ ...binding, runtimeVersion: "0.0.1" }))
      .rejects.toMatchObject({ code: "DK_GATEWAY_BOOTSTRAP_FAILED" });
  });

  it("is registered on the standalone server CLI as the forced command", () => {
    const commands = configureServerProgram().commands.map((command) => command.name());
    expect(commands).toContain("gateway");
  });
});

// ------------------------------------------------------- production runtime --

describe("production gateway runtime", () => {
  async function temporaryRoots(): Promise<{ base: string; roots: ServerRoots }> {
    const base = await mkdtemp(join(tmpdir(), "deploykit-gateway-"));
    return {
      base,
      roots: {
        config: join(base, "etc"),
        state: join(base, "state"),
        data: join(base, "data"),
        nginxAvailable: join(base, "nginx", "sites-available"),
        nginxEnabled: join(base, "nginx", "sites-enabled"),
        letsEncryptWebroot: join(base, "acme"),
      },
    };
  }

  async function tree(directory: string): Promise<string[]> {
    const found: string[] = [];
    const walk = async (current: string): Promise<void> => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        found.push(full.slice(directory.length));
        if (entry.isDirectory()) await walk(full);
      }
    };
    await walk(directory);
    return found.sort();
  }

  async function compiledManifest(): Promise<Awaited<ReturnType<typeof compileRuntimeManifest>>> {
    return compileRuntimeManifest(
      parseOperatorConfig(
        parseYaml(await readFile(resolve("test", "fixtures", "static-compose", "deploykit.config.fixture.yaml"), "utf8")),
      ),
    );
  }

  function applyContext(
    compiled: Awaited<ReturnType<typeof compileRuntimeManifest>>,
    overrides: Partial<GatewayApplyContext> = {},
  ): GatewayApplyContext {
    return {
      binding,
      requestId: "9f1c0a2b-3d4e-4f50-8a1b-2c3d4e5f6071",
      operation: "apply",
      applicationRef: "refs/heads/main",
      commitSha: "3f0a1b2c4d5e6f708192a3b4c5d6e7f809a1b2c3",
      manifest: compiled.manifest,
      manifestBytes: compiled.canonicalBytes,
      manifestDigest: compiled.digest,
      secrets: new Map(),
      dryRun: true,
      report: () => undefined,
      ...overrides,
    };
  }

  it("answers a dry run from durable state without touching the host", async () => {
    const { base, roots } = await temporaryRoots();
    const before = await tree(base);
    const operations = createGatewayOperations({ roots, runtimeVersion: binding.runtimeVersion });
    const result = await operations.apply(applyContext(await compiledManifest()));
    expect(result).toMatchObject({
      kind: "deployment",
      outcome: "dry-run",
      targetId: binding.targetId,
      targetName: binding.targetName,
      ports: [],
      domains: [],
    });
    expect(await tree(base)).toEqual(before);
  });

  it("reports a target that has never been deployed", async () => {
    const { roots } = await temporaryRoots();
    const operations = createGatewayOperations({ roots, runtimeVersion: binding.runtimeVersion });
    const inspection = await operations.inspect({
      binding,
      requestId: "9f1c0a2b-3d4e-4f50-8a1b-2c3d4e5f6071",
      commitSha: null,
      manifestDigest: null,
      report: () => undefined,
    });
    expect(inspection).toMatchObject({ outcome: "not-deployed", phase: null, resumed: false });
  });

  it("refuses a manifest that requires a runtime this gateway does not provide", async () => {
    const { roots } = await temporaryRoots();
    const compiled = await compiledManifest();
    const operations = createGatewayOperations({ roots, runtimeVersion: binding.runtimeVersion });
    const future = {
      ...compiled,
      manifest: { ...compiled.manifest, metadata: { ...compiled.manifest.metadata, requiredVersion: "99.0.0" } },
    };
    await expect(operations.apply(applyContext(future, { dryRun: false })))
      .rejects.toMatchObject({ code: "DK_PREFLIGHT_FAILED" });
  });

  it("refuses to apply as a non-root user and without a source provider", async () => {
    const { roots } = await temporaryRoots();
    const compiled = await compiledManifest();
    const asUser = createGatewayOperations({ roots, runtimeVersion: binding.runtimeVersion, currentUid: () => 1_000 });
    await expect(asUser.apply(applyContext(compiled, { dryRun: false })))
      .rejects.toMatchObject({ code: "DK_PREFLIGHT_FAILED" });

    const asRoot = createGatewayOperations({ roots, runtimeVersion: binding.runtimeVersion, currentUid: () => 0 });
    await expect(asRoot.apply(applyContext(compiled, { dryRun: false })))
      .rejects.toMatchObject({ code: "DK_GATEWAY_BOOTSTRAP_FAILED" });
  });

  it("reads root-owned host facts and refuses anything else", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deploykit-host-"));
    const path = join(directory, "host.json");
    await writeFile(path, JSON.stringify({ version: 1, publicAddresses: ["203.0.113.10"] }), { mode: 0o644 });
    expect(await readGatewayHostFacts({ path, requireRootOwnership: false }))
      .toEqual({ publicAddresses: ["203.0.113.10"] });

    const invalid = join(directory, "invalid.json");
    await writeFile(invalid, JSON.stringify({ version: 1, publicAddresses: [] }), { mode: 0o644 });
    await expect(readGatewayHostFacts({ path: invalid, requireRootOwnership: false }))
      .rejects.toMatchObject({ code: "DK_GATEWAY_BOOTSTRAP_FAILED" });
    await expect(readGatewayHostFacts({ path: join(directory, "missing.json"), requireRootOwnership: false }))
      .rejects.toMatchObject({ code: "DK_GATEWAY_BOOTSTRAP_FAILED" });
  });

  it("keeps every deployment command on a minimal environment", () => {
    expect(minimalGatewayEnvironment()).toEqual({
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: "/nonexistent",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TZ: "UTC",
      DEPLOYKIT_SERVER_RUNTIME: "1",
    });
    expect(minimalGatewayEnvironment()).not.toHaveProperty("SSH_ORIGINAL_COMMAND");
  });
});
