import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export interface AdvisorFile {
  path: string;
  content: string;
}

export interface LoadAdvisorFilesOptions {
  cwd: string;
  requestedPaths: readonly string[];
  /** Exact repository-relative paths the user approved for this request. */
  approvedPaths: readonly string[];
  secretValues?: readonly string[];
  maxBytesPerFile?: number;
}

const SENSITIVE_BASENAMES = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  "credentials",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "secrets.json",
]);

function normalizedRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === "" || part === "..")
  ) {
    throw new Error(`Advisor file path '${value}' must be repository-relative`);
  }
  return normalized;
}

export function isSensitiveAdvisorPath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/").toLowerCase();
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return (
    SENSITIVE_BASENAMES.has(basename) ||
    basename.startsWith(".env.") ||
    /\.(?:key|pem|p12|pfx|jks|keystore)$/.test(basename) ||
    /(?:^|[-_.])(?:credential|credentials|secret|secrets)(?:[-_.]|$)/.test(basename) ||
    normalized.includes("/.ssh/") ||
    normalized.includes("/.aws/") ||
    normalized.includes("/.gnupg/")
  );
}

function replaceLiteral(input: string, value: string, replacement: string): string {
  return value.length === 0 ? input : input.split(value).join(replacement);
}

/** Redact common credential formats and exact values supplied by the caller. */
export function redactSecrets(input: string, secretValues: readonly string[] = []): string {
  let result = input;
  for (const value of [...new Set(secretValues)].sort((left, right) => right.length - left.length)) {
    if (value.length >= 4) result = replaceLiteral(result, value, "[REDACTED]");
  }
  result = result
    .replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, "Bearer [REDACTED]")
    .replace(
      /(^|\n)([ \t]*(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Za-z0-9_]*[ \t]*=[ \t]*)([^\r\n]*)/gi,
      "$1$2[REDACTED]",
    )
    .replace(
      /(["']?(?:password|passwd|token|secret|api[_-]?key|private[_-]?key|access[_-]?key)["']?[ \t]*:[ \t]*)(["']?)([^\s,}\]\r\n]+)(\2)/gi,
      "$1$2[REDACTED]$4",
    )
    .replace(
      /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi,
      "$1[REDACTED]$3",
    );
  return result;
}

export function prepareAdvisorFiles(
  files: readonly AdvisorFile[],
  approvedPaths: readonly string[],
  secretValues: readonly string[] = [],
): AdvisorFile[] {
  const approved = new Set(approvedPaths.map(normalizedRelativePath));
  return files.map((file) => {
    const normalized = normalizedRelativePath(file.path);
    if (!approved.has(normalized)) {
      throw new Error(`Advisor file '${normalized}' was not explicitly approved`);
    }
    if (isSensitiveAdvisorPath(normalized)) {
      throw new Error(`Advisor refuses credential-like file '${normalized}'`);
    }
    if (file.content.includes("\0")) throw new Error(`Advisor file '${normalized}' is not text`);
    return { path: normalized, content: redactSecrets(file.content, secretValues) };
  });
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Read only exact, user-approved files beneath `cwd`; symlinks cannot escape it. */
export async function loadApprovedAdvisorFiles(
  options: LoadAdvisorFilesOptions,
): Promise<AdvisorFile[]> {
  const maxBytes = options.maxBytesPerFile ?? 128 * 1024;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error("maxBytesPerFile must be a positive integer");
  }
  const root = await realpath(options.cwd);
  const approved = new Set(options.approvedPaths.map(normalizedRelativePath));
  const files: AdvisorFile[] = [];

  for (const requested of options.requestedPaths) {
    const normalized = normalizedRelativePath(requested);
    if (!approved.has(normalized)) {
      throw new Error(`Advisor file '${normalized}' was not explicitly approved`);
    }
    if (isSensitiveAdvisorPath(normalized)) {
      throw new Error(`Advisor refuses credential-like file '${normalized}'`);
    }
    const candidate = await realpath(path.resolve(root, normalized));
    if (!isWithin(root, candidate)) {
      throw new Error(`Advisor file '${normalized}' resolves outside the project`);
    }
    const details = await stat(candidate);
    if (!details.isFile()) throw new Error(`Advisor path '${normalized}' is not a file`);
    if (details.size > maxBytes) {
      throw new Error(`Advisor file '${normalized}' exceeds ${maxBytes} bytes`);
    }
    files.push({ path: normalized, content: await readFile(candidate, "utf8") });
  }

  return prepareAdvisorFiles(files, options.approvedPaths, options.secretValues);
}
