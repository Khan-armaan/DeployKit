import { inspect } from "node:util";

import { createExactValueRedactor, type ExactValueRedactor } from "./orchestrator/redaction.js";

const SECRET_PATTERN = /(token|secret|password|passwd|private[_-]?key|api[_-]?key|authorization|cookie)/i;
const VALUE_PATTERN = /((?:token|secret|password|passwd|private[_-]?key|api[_-]?key|authorization)\s*[=:]\s*)([^\s,;]+)/gi;

export type OutputMode = "human" | "json";

export interface LogEvent {
  level: "debug" | "info" | "warn" | "error";
  code: string;
  message: string;
  phase?: string;
  data?: unknown;
  time: string;
}

/**
 * Exact operator secret values, registered once the single secret-bearing
 * `deploykit.config.yaml` has been partitioned. Key- and pair-shaped redaction
 * below cannot know these literals, so they are replaced separately.
 */
let registeredRedactedValues: ReadonlySet<string> = new Set<string>();
let exactValueRedactor: ExactValueRedactor = createExactValueRedactor([]);

export function registerRedactedValues(values: Iterable<string>): void {
  const merged = new Set<string>(registeredRedactedValues);
  for (const value of values) merged.add(value);
  registeredRedactedValues = merged;
  exactValueRedactor = createExactValueRedactor(merged);
}

/** Test-only reset so one suite's canaries never leak into another's output. */
export function clearRedactedValues(): void {
  registeredRedactedValues = new Set<string>();
  exactValueRedactor = createExactValueRedactor([]);
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        SECRET_PATTERN.test(key) ? "[REDACTED]" : redact(child)
      ])
    );
  }
  if (typeof value === "string") {
    return exactValueRedactor.redactText(value).replace(VALUE_PATTERN, "$1[REDACTED]");
  }
  return value;
}

export class Reporter {
  constructor(
    readonly mode: OutputMode = "human",
    readonly verbose = false,
    private readonly stdout: NodeJS.WritableStream = process.stdout,
    private readonly stderr: NodeJS.WritableStream = process.stderr
  ) {}

  event(level: LogEvent["level"], code: string, message: string, options?: { phase?: string; data?: unknown }): void {
    if (level === "debug" && !this.verbose) return;
    const event: LogEvent = {
      level,
      code,
      message: String(redact(message)),
      phase: options?.phase,
      data: redact(options?.data),
      time: new Date().toISOString()
    };
    const stream = level === "error" ? this.stderr : this.stdout;
    if (this.mode === "json") {
      stream.write(`${JSON.stringify(event)}\n`);
      return;
    }
    const phase = event.phase ? ` [${event.phase}]` : "";
    const prefix = level === "info" ? "" : `${level.toUpperCase()} `;
    stream.write(`${prefix}${event.code}${phase}: ${event.message}\n`);
    if (event.data !== undefined && (this.verbose || level === "error")) {
      stream.write(`${inspect(event.data, { depth: 6, colors: Boolean((this.stdout as NodeJS.WriteStream).isTTY) })}\n`);
    }
  }

  info(code: string, message: string, data?: unknown): void {
    this.event("info", code, message, { data });
  }

  warn(code: string, message: string, data?: unknown): void {
    this.event("warn", code, message, { data });
  }

  error(code: string, message: string, data?: unknown): void {
    this.event("error", code, message, { data });
  }

  /**
   * `ok` describes the reported outcome, not whether the report was produced.
   * A deployment that failed still returns a useful result — the partial
   * identity, the run URL, the recovery action — and a consumer that keys off
   * `ok` must not read that as a success.
   */
  result(code: string, data: unknown, options: { ok?: boolean } = {}): void {
    if (this.mode === "json") {
      this.stdout.write(`${JSON.stringify({ ok: options.ok ?? true, code, data: redact(data) })}\n`);
    } else if (typeof data === "string") {
      this.stdout.write(`${data.endsWith("\n") ? data : `${data}\n`}`);
    } else {
      this.stdout.write(`${inspect(redact(data), { depth: 8, colors: Boolean((this.stdout as NodeJS.WriteStream).isTTY) })}\n`);
    }
  }
}
