import { DeployKitError, exitCodeFor, type ErrorCode } from "../errors.js";
import {
  GATEWAY_PROTOCOL_LIMITS,
  GATEWAY_PROTOCOL_VERSION,
  type CompiledRuntimeManifest,
  type GatewayDeploymentResult,
  type GatewayHandshakeResult,
  type GatewayOperation,
  type GatewayOutputFrame,
  type GatewayProgressEvent,
  type GatewayProgressPhase,
  type GatewayResultFrame,
  type ManifestDigest,
  type RecoveryAction,
  type RootOwnedGatewayBinding,
} from "../orchestrator/contracts.js";
import { isServerError } from "../server/errors.js";
import { deployKitCodeForServerError } from "../server/failures.js";
import { SecretRedactor } from "../server/secrets.js";
import { confirmGatewayBinding } from "./binding.js";
import { gatewayError, gatewayRecovery } from "./failures.js";
import { assertRestrictedInvocation, type GatewayInvocation } from "./invocation.js";
import { encodeGatewayFrames, parseGatewayRequestStream, type GatewayRequestStream } from "./protocol.js";

/**
 * One gateway session: read a bounded request stream, prove it against the
 * root-owned binding, run exactly one of the four exposed operations, and emit
 * a bounded, redacted output stream that always ends in a result frame.
 *
 * The session never throws to its caller. Hostile input, a binding it cannot
 * confirm, a runtime refusal, and an unexpected exception all become a failure
 * result frame carrying a frozen `DK_*` code and its recovery action, so the far
 * side always receives an answer it can parse.
 *
 * The result frame has no free-form message field, which is deliberate: a
 * failure is identified by its code and recovery action, and prose is exactly
 * where a secret would escape. The reason is returned to the local caller
 * instead, already redacted.
 */

/** Our own messages are short; clamping keeps a frame far below its bound. */
const MAX_MESSAGE_CHARACTERS = 480;

export interface GatewayProgressInput {
  readonly phase: GatewayProgressPhase;
  readonly code: string;
  readonly message: string;
  readonly level?: "info" | "warning";
}

export type GatewayProgressReporter = (event: GatewayProgressInput) => void;

export interface GatewayInspectContext {
  readonly binding: RootOwnedGatewayBinding;
  readonly requestId: string;
  readonly commitSha: string | null;
  readonly manifestDigest: ManifestDigest | null;
  readonly report: GatewayProgressReporter;
}

export interface GatewayApplyContext {
  readonly binding: RootOwnedGatewayBinding;
  readonly requestId: string;
  readonly operation: "apply" | "retry";
  readonly applicationRef: string;
  readonly commitSha: string;
  readonly manifest: CompiledRuntimeManifest;
  readonly manifestBytes: Buffer;
  readonly manifestDigest: ManifestDigest;
  /** Transient: the runtime writes these to its own store and forgets them. */
  readonly secrets: ReadonlyMap<string, string>;
  readonly dryRun: boolean;
  readonly report: GatewayProgressReporter;
}

/**
 * What this gateway installation can actually do. `capabilities` is not
 * decoration: a request for an operation the installation cannot serve is
 * refused as an incomplete bootstrap rather than attempted.
 */
export interface GatewayOperations {
  readonly capabilities: readonly GatewayOperation[];
  handshake(binding: RootOwnedGatewayBinding): Promise<GatewayHandshakeResult>;
  inspect(context: GatewayInspectContext): Promise<GatewayDeploymentResult>;
  apply(context: GatewayApplyContext): Promise<GatewayDeploymentResult>;
}

export interface GatewaySessionDependencies {
  readonly operations: GatewayOperations;
  readonly readBinding: () => Promise<RootOwnedGatewayBinding>;
  readonly now: () => Date;
  readonly invocation: GatewayInvocation;
}

export interface GatewaySessionResult {
  readonly ok: boolean;
  readonly code: ErrorCode | "DK_GATEWAY_OK";
  readonly recovery: RecoveryAction;
  /** Redacted reason for the local operator; never part of the output stream. */
  readonly reason: string | null;
  readonly frames: readonly GatewayOutputFrame[];
  readonly output: string;
  readonly exitCode: number;
}

/**
 * Control characters are replaced rather than escaped: a message reaches a
 * terminal, and a frame must never carry an escape sequence a caller chose.
 */
function clamp(message: string): string {
  const printable = [...message]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? " " : character;
    })
    .join("");
  const single = printable.replace(/\s+/gu, " ").trim();
  return single.length > MAX_MESSAGE_CHARACTERS
    ? `${single.slice(0, MAX_MESSAGE_CHARACTERS - 1)}…`
    : single;
}

/**
 * Redacts every received secret value in both its raw form and the form it
 * takes once JSON-escaped, so a value cannot survive by being quoted.
 */
function secretRedactor(secrets: ReadonlyMap<string, string> | undefined): SecretRedactor {
  const values: string[] = [];
  for (const value of secrets?.values() ?? []) {
    if (value === "") continue;
    values.push(value);
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) values.push(escaped);
  }
  return new SecretRedactor(values);
}

interface NormalizedFailure {
  readonly code: ErrorCode;
  readonly message: string;
}

/**
 * Maps anything thrown during a session onto the frozen catalog. A runtime
 * `SERVER_*` failure travels through the one existing translation, so an
 * operator sees the same code and recovery here as through the local CLI.
 */
function normalizeFailure(error: unknown, mutating: boolean): NormalizedFailure {
  if (error instanceof DeployKitError) {
    return { code: error.code, message: error.message };
  }
  if (isServerError(error)) {
    return { code: deployKitCodeForServerError(error.code), message: error.message };
  }
  // An unexpected exception during a mutating operation is reported as a
  // deployment failure: the VPS may already have been touched.
  return {
    code: mutating ? "DK_DEPLOYMENT_FAILED" : "DK_PREFLIGHT_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

class GatewayOutput {
  private sequence = 0;
  private progressEvents = 0;
  private readonly emitted: GatewayOutputFrame[] = [];
  private requestId: string | null = null;
  private redactor = new SecretRedactor([]);

  constructor(private readonly now: () => Date) {}

  bindRequest(requestId: string, redactor: SecretRedactor): void {
    this.requestId = requestId;
    this.redactor = redactor;
  }

  progress(event: GatewayProgressInput): void {
    if (this.requestId === null) return;
    if (this.progressEvents >= GATEWAY_PROTOCOL_LIMITS.maxProgressEvents) return;
    const frame: GatewayProgressEvent = {
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      frame: "progress",
      requestId: this.requestId,
      sequence: this.sequence + 1,
      time: this.now().toISOString(),
      level: event.level ?? "info",
      phase: event.phase,
      code: event.code,
      message: clamp(this.redactor.redactText(event.message)),
    };
    if (Buffer.byteLength(encodeGatewayFrames([frame]), "utf8") > GATEWAY_PROTOCOL_LIMITS.maxProgressEventBytes) {
      return;
    }
    this.sequence += 1;
    this.progressEvents += 1;
    this.emitted.push(frame);
  }

  success(result: GatewayHandshakeResult | GatewayDeploymentResult): GatewaySessionResult {
    return this.finish({
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      frame: "result",
      requestId: this.requestId ?? "",
      sequence: (this.sequence += 1),
      time: this.now().toISOString(),
      ok: true,
      code: "DK_GATEWAY_OK",
      recovery: "none",
      result,
    }, null);
  }

  failure(
    code: ErrorCode,
    reason: string,
    result: GatewayDeploymentResult | null,
  ): GatewaySessionResult {
    const recovery = gatewayRecovery(code);
    return this.finish({
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      frame: "result",
      requestId: this.requestId,
      sequence: (this.sequence += 1),
      time: this.now().toISOString(),
      ok: false,
      code,
      recovery: recovery === "none" ? "not-resumable" : recovery,
      result,
    }, clamp(this.redactor.redactText(reason)));
  }

  /** A result that will not fit its frozen bound is refused, never truncated. */
  private finish(frame: GatewayResultFrame, reason: string | null): GatewaySessionResult {
    const redacted = this.redactor.redact(frame);
    if (Buffer.byteLength(encodeGatewayFrames([redacted]), "utf8") > GATEWAY_PROTOCOL_LIMITS.maxResultBytes) {
      return this.failure("DK_GATEWAY_PROTOCOL_INVALID", "the gateway result exceeds its frozen bound", null);
    }
    const frames = [...this.emitted, redacted];
    return {
      ok: redacted.ok,
      code: redacted.ok ? "DK_GATEWAY_OK" : redacted.code,
      recovery: redacted.recovery,
      reason,
      frames,
      output: this.redactor.redactText(encodeGatewayFrames(frames)),
      exitCode: redacted.ok ? 0 : exitCodeFor(redacted.code),
    };
  }
}

/**
 * Runs one gateway session.
 *
 * `input` may be a reader rather than a string so the invocation guard runs
 * *before* a byte of stdin is consumed: a caller who asked for a shell, a PTY,
 * or a forwarded channel is refused without the gateway ever waiting on them.
 *
 * The input is hostile. Nothing in it is trusted until the parser has
 * re-derived every claim and the root-owned binding has confirmed the identity.
 */
export async function runGatewaySession(
  input: string | (() => Promise<string>),
  dependencies: GatewaySessionDependencies,
): Promise<GatewaySessionResult> {
  const output = new GatewayOutput(dependencies.now);
  let stream: GatewayRequestStream | undefined;
  let lastResult: GatewayDeploymentResult | null = null;

  try {
    assertRestrictedInvocation(dependencies.invocation);
    stream = parseGatewayRequestStream(typeof input === "string" ? input : await input());
    output.bindRequest(stream.requestId, secretRedactor(stream.secrets));

    const observable = stream.operation !== "handshake";
    if (observable) {
      output.progress({
        phase: "request-validated",
        code: "DK_GATEWAY_REQUEST_VALIDATED",
        message: `Request accepted for target ${stream.request.targetName}.`,
      });
    }

    const binding = await dependencies.readBinding();
    confirmGatewayBinding(stream, binding);
    if (observable) {
      output.progress({
        phase: "binding-verified",
        code: "DK_GATEWAY_BINDING_VERIFIED",
        message: "Root-owned binding matched the request.",
      });
    }

    if (!dependencies.operations.capabilities.includes(stream.operation)) {
      throw gatewayError(
        "DK_GATEWAY_BOOTSTRAP_FAILED",
        `this gateway installation cannot serve the ${stream.operation} operation`,
        { details: { capabilities: [...dependencies.operations.capabilities] } },
      );
    }

    const report: GatewayProgressReporter = (event) => { output.progress(event); };

    if (stream.operation === "handshake") {
      return output.success(await dependencies.operations.handshake(binding));
    }

    if (stream.operation === "inspect") {
      lastResult = await dependencies.operations.inspect({
        binding,
        requestId: stream.requestId,
        commitSha: stream.request.commitSha,
        manifestDigest: stream.request.manifestDigest,
        report,
      });
      return output.success(lastResult);
    }

    // Only `apply` and `retry` remain. The parser guarantees each carries a
    // manifest whose digest was recomputed from the bytes that arrived.
    const { manifest, manifestBytes, manifestDigest } = stream;
    const applicationRef = stream.request.applicationRef;
    const commitSha = stream.request.commitSha;
    if (manifest === null || manifestBytes === null || manifestDigest === null ||
        applicationRef === null || commitSha === null) {
      throw gatewayError(
        "DK_GATEWAY_PROTOCOL_INVALID",
        `a ${stream.operation} request must carry a ref, a commit SHA, and a runtime manifest`,
      );
    }
    output.progress({
      phase: "manifest-validated",
      code: "DK_GATEWAY_MANIFEST_VALIDATED",
      message: "Recomputed manifest digest matched the request.",
    });

    lastResult = await dependencies.operations.apply({
      binding,
      requestId: stream.requestId,
      operation: stream.operation,
      applicationRef,
      commitSha,
      manifest,
      manifestBytes,
      manifestDigest,
      secrets: stream.secrets,
      dryRun: stream.dryRun,
      report,
    });
    return output.success(lastResult);
  } catch (error) {
    const mutating = stream?.operation === "apply" || stream?.operation === "retry";
    const failure = normalizeFailure(error, mutating);
    return output.failure(failure.code, failure.message, lastResult);
  }
}
