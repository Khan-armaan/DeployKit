import { createHash } from "node:crypto";
import { join } from "node:path";

import { DEFAULT_SERVER_ROOTS, type ServerRoots } from "../server/paths.js";
import { gatewayError } from "./failures.js";

/**
 * The host keys DeployKit trusts when a VPS fetches application source.
 *
 * Source retrieval runs unattended behind a forced command, so there is nobody
 * to answer a host-key prompt and nothing to accept a key on first use. The
 * gateway therefore never consults a system, user, or previously written
 * `known_hosts`: it materializes exactly these lines into its own root-owned
 * source area and runs SSH with `StrictHostKeyChecking=yes` against them.
 *
 * The same bytes ship as the `assets/github-known-hosts` package asset so the
 * bootstrap installer and the generated workflow pin the identical keys.
 * Published by GitHub at https://api.github.com/meta (`ssh_keys`); the
 * fingerprints below are the ones that endpoint reports.
 */

export const GITHUB_SSH_HOST = "github.com" as const;

export const GITHUB_KNOWN_HOSTS_ASSET = "assets/github-known-hosts" as const;

export const GITHUB_HOST_KEY_FINGERPRINTS: Readonly<Record<string, string>> = Object.freeze({
  ed25519: "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU",
  ecdsa: "SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM",
  rsa: "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s",
});

/** Key types offered to the server, most preferred first. */
export const GITHUB_HOST_KEY_ALGORITHMS = "ssh-ed25519,ecdsa-sha2-nistp256,ssh-rsa" as const;

const KNOWN_HOSTS_LINES: readonly string[] = Object.freeze([
  "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
  "github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=",
  "github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=",
]);

/** Exactly what the gateway writes: the key lines, one per line, LF-terminated. */
export const GITHUB_KNOWN_HOSTS = `${KNOWN_HOSTS_LINES.join("\n")}\n`;

export function githubKnownHostsSha256(): string {
  return createHash("sha256").update(GITHUB_KNOWN_HOSTS, "utf8").digest("hex");
}

/** Where the bootstrap installer places the packaged asset on a VPS. */
export function githubKnownHostsFile(roots: ServerRoots = DEFAULT_SERVER_ROOTS): string {
  return join(roots.config, "gateway", "github-known-hosts");
}

/**
 * Comment and blank lines are ignored so the packaged asset may document its
 * provenance; every remaining line must be one of the pinned keys, and every
 * pinned key must be present.
 */
export function pinnedKnownHostsKeyLines(contents: string): readonly string[] {
  return contents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** Refuses an installed or supplied `known_hosts` that is not the pinned set. */
export function assertPinnedGitHubKnownHosts(contents: string, source: string): void {
  const lines = pinnedKnownHostsKeyLines(contents);
  const expected = [...KNOWN_HOSTS_LINES];
  const unexpected = lines.filter((line) => !expected.includes(line));
  const missing = expected.filter((line) => !lines.includes(line));
  if (unexpected.length > 0 || missing.length > 0) {
    throw gatewayError(
      "DK_GATEWAY_BOOTSTRAP_FAILED",
      `${source} does not contain exactly the pinned GitHub host keys`,
      { details: { source, unexpectedLines: unexpected.length, missingLines: missing.length } },
    );
  }
}
