/**
 * Exact-value redaction for the single secret-bearing operator config.
 *
 * `src/output.ts` redacts secret-*shaped* keys and `key=value` pairs. That is
 * pattern based and cannot know the literal strings an operator typed into
 * `deploykit.config.yaml`. Phase 2 initializes this redactor immediately after
 * the config is partitioned, so every later diagnostic — JSON envelopes, error
 * details, progress events, captured logs — replaces those exact values even if
 * an unrelated code path stringifies them by accident.
 */

/** Values shorter than this are too collision-prone to blanket-replace. */
const MINIMUM_REDACTED_LENGTH = 4;

export const REDACTED = "[REDACTED]" as const;

export interface ExactValueRedactor {
  /** Number of distinct values this redactor replaces. */
  readonly size: number;
  redactText(value: string): string;
  redact(value: unknown): unknown;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Longest values first so a value that contains another value is replaced as a
 * whole rather than leaving a redacted fragment behind.
 */
function orderedValues(values: Iterable<string>): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    if (typeof value === "string" && value.length >= MINIMUM_REDACTED_LENGTH) unique.add(value);
  }
  return [...unique].sort((left, right) => right.length - left.length || (left < right ? -1 : left > right ? 1 : 0));
}

export function createExactValueRedactor(values: Iterable<string>): ExactValueRedactor {
  const ordered = orderedValues(values);
  const pattern = ordered.length === 0
    ? undefined
    : new RegExp(ordered.map(escapeRegExp).join("|"), "gu");

  const redactText = (value: string): string => (pattern ? value.replace(pattern, REDACTED) : value);

  const redact = (value: unknown): unknown => {
    if (typeof value === "string") return redactText(value);
    if (Array.isArray(value)) return value.map(redact);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, redact(child)]),
      );
    }
    return value;
  };

  return { size: ordered.length, redactText, redact };
}

/** Redactor used before any config has been loaded. */
export const NULL_REDACTOR: ExactValueRedactor = createExactValueRedactor([]);
