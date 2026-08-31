import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ProjectManifest } from "../manifest.js";
import { atomicWriteFile } from "./atomic.js";
import { ServerError } from "./errors.js";

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SENSITIVE_KEY = /(?:secret|token|password|passwd|api[_-]?key|private[_-]?key|credential|connection[_-]?(?:string|url)|database[_-]?url)/i;

export type SecretValues = Readonly<Record<string, string>>;

export interface SecretRequirements {
  readonly required: readonly string[];
  readonly generated?: readonly string[];
}

export interface SecretCheck {
  readonly valid: boolean;
  readonly present: readonly string[];
  readonly missing: readonly string[];
  readonly generated: readonly string[];
}

function assertSecretName(name: string): void {
  if (!SECRET_NAME.test(name)) {
    throw new ServerError(
      "SERVER_SECRET_INVALID",
      `invalid secret name ${JSON.stringify(name)}; use environment-variable name syntax`,
      { name },
    );
  }
}

function decodeDoubleQuoted(value: string, line: number): string {
  try {
    return JSON.parse(value) as string;
  } catch (error) {
    throw new ServerError(
      "SERVER_SECRET_INVALID",
      `invalid double-quoted secret value on line ${line}`,
      { line },
      { cause: error },
    );
  }
}

export function parseSecretsEnv(contents: string): Record<string, string> {
  if (contents.includes("\0")) {
    throw new ServerError("SERVER_SECRET_INVALID", "secret input contains a NUL byte");
  }
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [index, original] of contents.replace(/\r\n?/g, "\n").split("\n").entries()) {
    const lineNumber = index + 1;
    const trimmed = original.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const candidate = trimmed.startsWith("export ") ? trimmed.slice(7).trimStart() : trimmed;
    const equals = candidate.indexOf("=");
    if (equals <= 0) {
      throw new ServerError(
        "SERVER_SECRET_INVALID",
        `expected NAME=value on line ${lineNumber}`,
        { line: lineNumber },
      );
    }
    const name = candidate.slice(0, equals).trim();
    assertSecretName(name);
    if (Object.hasOwn(values, name)) {
      throw new ServerError("SERVER_SECRET_INVALID", `duplicate secret ${name} on line ${lineNumber}`, {
        line: lineNumber,
        name,
      });
    }
    const rawValue = candidate.slice(equals + 1).trim();
    let value: string;
    if (rawValue.startsWith("\"")) {
      if (!rawValue.endsWith("\"") || rawValue.length < 2) {
        throw new ServerError("SERVER_SECRET_INVALID", `unterminated value on line ${lineNumber}`);
      }
      value = decodeDoubleQuoted(rawValue, lineNumber);
    } else if (rawValue.startsWith("'")) {
      if (!rawValue.endsWith("'") || rawValue.length < 2) {
        throw new ServerError("SERVER_SECRET_INVALID", `unterminated value on line ${lineNumber}`);
      }
      value = rawValue.slice(1, -1);
    } else {
      const comment = rawValue.search(/\s+#/);
      value = (comment >= 0 ? rawValue.slice(0, comment) : rawValue).trimEnd();
    }
    if (value.includes("\n") || value.includes("\r")) {
      throw new ServerError(
        "SERVER_SECRET_INVALID",
        `${name} contains a newline; encode multiline material before storing it`,
        { name },
      );
    }
    values[name] = value;
  }
  return values;
}

function quoteSecret(value: string): string {
  return JSON.stringify(value);
}

export function serializeSecretsEnv(values: SecretValues): string {
  return `${Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      assertSecretName(name);
      if (value.includes("\n") || value.includes("\r") || value.includes("\0")) {
        throw new ServerError("SERVER_SECRET_INVALID", `${name} contains an unsupported control character`, { name });
      }
      return `${name}=${quoteSecret(value)}`;
    })
    .join("\n")}\n`;
}

export function checkSecrets(
  values: SecretValues,
  requirements: SecretRequirements,
): SecretCheck {
  const generated = requirements.generated ?? [];
  const names = [...new Set([...requirements.required, ...generated])];
  for (const name of names) assertSecretName(name);
  const missing = names.filter((name) => !Object.hasOwn(values, name) || values[name] === "");
  return {
    valid: missing.length === 0,
    present: names.filter((name) => !missing.includes(name)),
    missing,
    generated,
  };
}

export function secretRequirementsFromManifest(manifest: ProjectManifest): SecretRequirements {
  const required = [...manifest.secrets.required];
  const generated = [...manifest.secrets.generated];
  if (manifest.database?.type === "external") {
    required.push(manifest.database.connectionStringSecret);
    if (manifest.database.tlsCaSecret !== undefined) required.push(manifest.database.tlsCaSecret);
  }
  if (manifest.database?.type === "compose") {
    generated.push(manifest.database.credentials.passwordSecret);
  }
  return {
    required: [...new Set(required)],
    generated: [...new Set(generated)],
  };
}

export function fillGeneratedSecrets(
  values: SecretValues,
  names: readonly string[],
  bytes = 32,
): Record<string, string> {
  const result = { ...values };
  for (const name of names) {
    assertSecretName(name);
    if (!Object.hasOwn(result, name) || result[name] === "") {
      result[name] = randomBytes(bytes).toString("base64url");
    }
  }
  return result;
}

export class SecretRedactor {
  private readonly values: readonly string[];

  constructor(values: Iterable<string>) {
    this.values = [...new Set(values)]
      .filter((value) => value.length > 0)
      .sort((left, right) => right.length - left.length);
  }

  redactText(text: string): string {
    let output = text;
    for (const value of this.values) output = output.split(value).join("[REDACTED]");
    return output;
  }

  redact<T>(input: T): T {
    return this.redactValue(input, new WeakSet<object>()) as T;
  }

  private redactValue(input: unknown, seen: WeakSet<object>): unknown {
    if (typeof input === "string") return this.redactText(input);
    if (input === null || typeof input !== "object") return input;
    if (seen.has(input)) return "[CIRCULAR]";
    seen.add(input);
    if (Array.isArray(input)) return input.map((value) => this.redactValue(value, seen));
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : this.redactValue(value, seen);
    }
    return output;
  }
}

export interface SecretsStoreOptions {
  readonly file: string;
  readonly requirements: SecretRequirements;
}

export class SecretsStore {
  private readonly file: string;
  private readonly requirements: SecretRequirements;

  constructor(options: SecretsStoreOptions) {
    this.file = options.file;
    this.requirements = options.requirements;
  }

  async read(): Promise<Record<string, string>> {
    try {
      return parseSecretsEnv(await readFile(this.file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  async writeFromStdin(contents: string, generateMissing = true): Promise<SecretCheck> {
    const supplied = parseSecretsEnv(contents);
    const allowed = new Set([...this.requirements.required, ...(this.requirements.generated ?? [])]);
    const unexpected = Object.keys(supplied).filter((name) => !allowed.has(name)).sort();
    if (unexpected.length > 0) {
      throw new ServerError(
        "SERVER_SECRET_INVALID",
        `undeclared secret names: ${unexpected.join(", ")}`,
        { unexpected },
      );
    }
    const existing = await this.read();
    const merged = { ...existing, ...supplied };
    const values = generateMissing
      ? fillGeneratedSecrets(merged, this.requirements.generated ?? [])
      : merged;
    const check = checkSecrets(values, this.requirements);
    if (!check.valid) {
      throw new ServerError(
        "SERVER_SECRET_MISSING",
        `missing required secrets: ${check.missing.join(", ")}`,
        { missing: check.missing },
      );
    }
    const directory = dirname(this.file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await atomicWriteFile(this.file, serializeSecretsEnv(values), { mode: 0o600 });
    await chmod(this.file, 0o600);
    return check;
  }

  async check(): Promise<SecretCheck> {
    return checkSecrets(await this.read(), this.requirements);
  }

  async redactor(): Promise<SecretRedactor> {
    return new SecretRedactor(Object.values(await this.read()));
  }
}
