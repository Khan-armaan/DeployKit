import { isIP } from "node:net";

import type { CommandRunner } from "./command.js";
import { ServerError } from "./errors.js";
import { normalizeDomain } from "./registry.js";

export type DnsRecordType = "A" | "AAAA" | "CNAME";

export interface DnsResolver {
  resolve(domain: string, type: DnsRecordType): Promise<readonly string[]>;
}

export class DigDnsResolver implements DnsResolver {
  constructor(private readonly runner: CommandRunner) {}

  async resolve(domain: string, type: DnsRecordType): Promise<readonly string[]> {
    const normalized = normalizeDomain(domain);
    const result = await this.runner.run({
      command: "dig",
      args: ["+short", type, normalized],
      timeoutMs: 15_000,
    });
    if (type === "CNAME") {
      return result.stdout
        .split(/\r?\n/)
        .map((value) => value.trim().toLowerCase().replace(/\.$/, ""))
        .filter(Boolean);
    }
    const family = type === "A" ? 4 : 6;
    return result.stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter((value) => isIP(value) === family);
  }
}

function canonicalIp(address: string): string {
  const family = isIP(address);
  if (family === 4) return address;
  if (family === 6) {
    return new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
  }
  throw new ServerError("SERVER_DNS_MISMATCH", `invalid server address ${address}`, { address });
}

export interface DnsVerificationResult {
  readonly domain: string;
  readonly addresses: readonly string[];
}

/**
 * Validates direct DNS only: every published A/AAAA answer must point at one of
 * the configured server addresses, and every hostname must publish an answer.
 */
export async function verifyDirectDns(
  domains: readonly string[],
  serverAddresses: readonly string[],
  resolver: DnsResolver,
): Promise<readonly DnsVerificationResult[]> {
  if (serverAddresses.length === 0) {
    throw new ServerError("SERVER_DNS_MISMATCH", "at least one server IP address is required");
  }
  const expected = new Set(serverAddresses.map(canonicalIp));
  const results: DnsVerificationResult[] = [];
  for (const domain of [...new Set(domains.map(normalizeDomain))]) {
    const [ipv4, ipv6, cnames] = await Promise.all([
      resolver.resolve(domain, "A"),
      resolver.resolve(domain, "AAAA"),
      resolver.resolve(domain, "CNAME"),
    ]);
    if (cnames.length > 0) {
      throw new ServerError(
        "SERVER_DNS_MISMATCH",
        `${domain} is a CNAME (${cnames.join(", ")}); v0.1 requires direct A/AAAA records`,
        { domain, cnames },
      );
    }
    const addresses = [...new Set([...ipv4, ...ipv6].map(canonicalIp))];
    if (addresses.length === 0) {
      throw new ServerError(
        "SERVER_DNS_EMPTY",
        `${domain} does not have a direct A or AAAA record`,
        { domain },
      );
    }
    const mismatched = addresses.filter((address) => !expected.has(address));
    if (mismatched.length > 0) {
      throw new ServerError(
        "SERVER_DNS_MISMATCH",
        `${domain} resolves to ${mismatched.join(", ")} instead of this server`,
        { domain, actual: addresses, expected: [...expected] },
      );
    }
    results.push({ domain, addresses });
  }
  return results;
}
