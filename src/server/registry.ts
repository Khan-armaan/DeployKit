import { createServer } from "node:net";
import { domainToASCII } from "node:url";

import { atomicWriteJson, readJsonFile } from "./atomic.js";
import { ServerError } from "./errors.js";
import type { LockProvider } from "./lock.js";

export const LOOPBACK_ADDRESS = "127.0.0.1" as const;

export interface PortRange {
  readonly start: number;
  readonly end: number;
}

export interface PortRequest {
  readonly serviceKey: string;
  readonly targetId: string;
  readonly service: string;
  readonly requestedPort?: number;
}

export interface PortReservation {
  readonly serviceKey: string;
  readonly targetId: string;
  readonly service: string;
  readonly address: typeof LOOPBACK_ADDRESS;
  readonly port: number;
}

export interface DomainReservation {
  readonly domain: string;
  readonly targetId: string;
}

export interface ServerRegistry {
  readonly version: 1;
  readonly ports: readonly PortReservation[];
  readonly domains: readonly DomainReservation[];
}

export interface PortProbe {
  isAvailable(address: typeof LOOPBACK_ADDRESS, port: number): Promise<boolean>;
}

export class NetworkPortProbe implements PortProbe {
  async isAvailable(address: typeof LOOPBACK_ADDRESS, port: number): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.unref();
      server.once("error", () => resolve(false));
      server.listen({ host: address, port, exclusive: true }, () => {
        server.close(() => resolve(true));
      });
    });
  }
}

export interface RegistryStoreOptions {
  readonly file: string;
  readonly lockFile: string;
  readonly lock: LockProvider;
  readonly portProbe?: PortProbe;
  readonly portRange?: PortRange;
}

export interface ReserveResourcesRequest {
  readonly targetId: string;
  readonly domains: readonly string[];
  readonly ports: readonly PortRequest[];
}

export interface ReservedResources {
  readonly domains: readonly DomainReservation[];
  readonly ports: readonly PortReservation[];
}

const EMPTY_REGISTRY: ServerRegistry = Object.freeze({ version: 1, ports: [], domains: [] });

export function normalizeDomain(domain: string): string {
  const withoutDot = domain.trim().toLowerCase().replace(/\.$/, "");
  const ascii = domainToASCII(withoutDot);
  if (
    ascii === "" ||
    ascii.length > 253 ||
    ascii.includes("..") ||
    !ascii.includes(".") ||
    !ascii.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new ServerError("SERVER_INVALID_DOMAIN", `invalid deployment domain: ${domain}`, { domain });
  }
  return ascii;
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new ServerError(
      "SERVER_PORT_COLLISION",
      `host port ${port} must be an integer between 1024 and 65535`,
      { port },
    );
  }
}

function validateRegistry(value: ServerRegistry): ServerRegistry {
  if (value.version !== 1 || !Array.isArray(value.ports) || !Array.isArray(value.domains)) {
    throw new ServerError("SERVER_STATE_INVALID", "server registry has an unsupported shape");
  }
  const serviceKeys = new Set<string>();
  const portNumbers = new Set<number>();
  for (const reservation of value.ports) {
    if (
      reservation.address !== LOOPBACK_ADDRESS ||
      !Number.isInteger(reservation.port) ||
      reservation.port < 1024 ||
      reservation.port > 65535 ||
      reservation.serviceKey === "" ||
      reservation.targetId === "" ||
      reservation.service === "" ||
      serviceKeys.has(reservation.serviceKey) ||
      portNumbers.has(reservation.port)
    ) {
      throw new ServerError("SERVER_STATE_INVALID", "server registry contains an invalid port reservation", {
        reservation,
      });
    }
    serviceKeys.add(reservation.serviceKey);
    portNumbers.add(reservation.port);
  }
  const domains = new Set<string>();
  for (const reservation of value.domains) {
    if (
      reservation.targetId === "" ||
      normalizeDomain(reservation.domain) !== reservation.domain ||
      domains.has(reservation.domain)
    ) {
      throw new ServerError("SERVER_STATE_INVALID", "server registry contains an invalid domain reservation", {
        reservation,
      });
    }
    domains.add(reservation.domain);
  }
  return value;
}

export class RegistryStore {
  private readonly file: string;
  private readonly lockFile: string;
  private readonly lock: LockProvider;
  private readonly portProbe: PortProbe;
  private readonly range: PortRange;

  constructor(options: RegistryStoreOptions) {
    this.file = options.file;
    this.lockFile = options.lockFile;
    this.lock = options.lock;
    this.portProbe = options.portProbe ?? new NetworkPortProbe();
    this.range = options.portRange ?? { start: 20_000, end: 39_999 };
    validatePort(this.range.start);
    validatePort(this.range.end);
    if (this.range.start > this.range.end) {
      throw new ServerError("SERVER_PORT_EXHAUSTED", "port range start must not exceed its end");
    }
  }

  async read(): Promise<ServerRegistry> {
    return validateRegistry(await readJsonFile<ServerRegistry>(this.file, EMPTY_REGISTRY));
  }

  async reserve(request: ReserveResourcesRequest): Promise<ReservedResources> {
    return await this.lock.withLock(this.lockFile, async () => {
      const current = await this.read();
      const domains = [...current.domains];
      const ports = [...current.ports];
      const normalizedDomains = [...new Set(request.domains.map(normalizeDomain))];

      for (const domain of normalizedDomains) {
        const existing = domains.find((item) => item.domain === domain);
        if (existing !== undefined && existing.targetId !== request.targetId) {
          throw new ServerError(
            "SERVER_DOMAIN_COLLISION",
            `${domain} is already reserved by ${existing.targetId}`,
            { domain, existingTargetId: existing.targetId, requestedTargetId: request.targetId },
          );
        }
        if (existing === undefined) domains.push({ domain, targetId: request.targetId });
      }

      const reserved: PortReservation[] = [];
      const seenKeys = new Set<string>();
      for (const portRequest of request.ports) {
        if (
          portRequest.targetId !== request.targetId ||
          portRequest.service.trim() === "" ||
          portRequest.serviceKey !== `${request.targetId}:${portRequest.service}`
        ) {
          throw new ServerError("SERVER_STATE_INVALID", "port request identity does not match its target", {
            request: portRequest,
            targetId: request.targetId,
          });
        }
        if (seenKeys.has(portRequest.serviceKey)) {
          throw new ServerError(
            "SERVER_STATE_INVALID",
            `duplicate port request for ${portRequest.serviceKey}`,
          );
        }
        seenKeys.add(portRequest.serviceKey);

        const existing = ports.find((item) => item.serviceKey === portRequest.serviceKey);
        if (existing !== undefined) {
          if (
            existing.targetId !== request.targetId ||
            (portRequest.requestedPort !== undefined && portRequest.requestedPort !== existing.port)
          ) {
            throw new ServerError(
              "SERVER_PORT_COLLISION",
              `port reservation ${portRequest.serviceKey} conflicts with existing state`,
              { existing, request: portRequest },
            );
          }
          reserved.push(existing);
          continue;
        }

        const port = await this.choosePort(portRequest, ports);
        const reservation: PortReservation = {
          serviceKey: portRequest.serviceKey,
          targetId: request.targetId,
          service: portRequest.service,
          address: LOOPBACK_ADDRESS,
          port,
        };
        ports.push(reservation);
        reserved.push(reservation);
      }

      const next: ServerRegistry = { version: 1, ports, domains };
      await atomicWriteJson(this.file, next, { mode: 0o600 });
      return {
        domains: domains.filter((item) => item.targetId === request.targetId),
        ports: reserved,
      };
    });
  }

  private async choosePort(
    request: PortRequest,
    reservations: readonly PortReservation[],
  ): Promise<number> {
    if (request.requestedPort !== undefined) {
      validatePort(request.requestedPort);
      const owner = reservations.find((item) => item.port === request.requestedPort);
      if (owner !== undefined) {
        throw new ServerError(
          "SERVER_PORT_COLLISION",
          `host port ${request.requestedPort} is reserved by ${owner.serviceKey}`,
          { port: request.requestedPort, owner },
        );
      }
      if (!(await this.portProbe.isAvailable(LOOPBACK_ADDRESS, request.requestedPort))) {
        throw new ServerError(
          "SERVER_PORT_COLLISION",
          `host port ${request.requestedPort} is already in use outside DeployKit`,
          { port: request.requestedPort },
        );
      }
      return request.requestedPort;
    }

    const used = new Set(reservations.map((item) => item.port));
    for (let port = this.range.start; port <= this.range.end; port += 1) {
      if (!used.has(port) && await this.portProbe.isAvailable(LOOPBACK_ADDRESS, port)) return port;
    }
    throw new ServerError(
      "SERVER_PORT_EXHAUSTED",
      `no available loopback ports remain in ${this.range.start}-${this.range.end}`,
      { range: this.range },
    );
  }
}
