import type { ProjectManifest } from "../manifest.js";
import {
  asRecord,
  assertPort,
  assertSafeName,
  manifestRecord,
  namedEntries,
  optionalBoolean,
  optionalString,
  requiredString,
  stringArray,
  type ManifestRecord,
} from "./model.js";

export interface NginxTlsOptions {
  certificate?: string;
  certificateKey?: string;
  trustedCertificate?: string;
}

export interface NginxGenerationOptions {
  target: string;
  /** Stable loopback ports allocated by the server runtime, keyed by service name. */
  ports: Readonly<Record<string, number>>;
  /** Absolute path containing a copied static frontend build. */
  staticRoot?: string;
  acmeWebroot?: string;
  tls?: false | NginxTlsOptions;
  /** Include the shared http-context map in this output. Normally installed once at bootstrap. */
  includeConnectionUpgradeMap?: boolean;
}

export const NGINX_CONNECTION_UPGRADE_MAP = [
  "map $http_upgrade $connection_upgrade {",
  "    default upgrade;",
  "    '' close;",
  "}",
  "",
].join("\n");

/** Content for `/etc/nginx/conf.d/deploykit-connection-upgrade.conf`. */
export function generateNginxConnectionUpgradeMap(): string {
  return NGINX_CONNECTION_UPGRADE_MAP;
}

interface NormalizedRoute {
  hostname?: string;
  path: string;
  match: "exact" | "prefix";
  target: string;
  preservePrefix: boolean;
  websocket: boolean;
  sse: boolean;
  buffering: boolean;
  requestBuffering: boolean;
  uploadLimit?: string;
  connectTimeout: string;
  sendTimeout: string;
  readTimeout: string;
}

function nginxPath(value: string, label: string): string {
  if (!value.startsWith("/") || /[\s{};$#"'\\]/.test(value)) {
    throw new Error(`${label} must be an absolute URL path without Nginx metacharacters`);
  }
  return value;
}

function filesystemPath(value: string, label: string): string {
  if (!value.startsWith("/") || !/^\/[A-Za-z0-9._/-]+$/.test(value) || value.includes("..")) {
    throw new Error(`${label} must be a safe absolute filesystem path`);
  }
  return value.replace(/\/$/, "") || "/";
}

function domain(value: string, label: string): string {
  const normalized = value.toLowerCase();
  if (
    normalized.length > 253 ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      normalized,
    )
  ) {
    throw new Error(`${label} must be a valid fully-qualified domain name`);
  }
  return normalized;
}

function nginxDuration(value: unknown, fallback: string, label: string): string {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return `${value}s`;
  }
  if (typeof value === "string" && /^[1-9][0-9]*(?:ms|s|m|h|d)$/.test(value)) {
    return value;
  }
  if (value === undefined) return fallback;
  throw new Error(`${label} must be a positive Nginx duration such as '60s'`);
}

function normalizeRoute(value: ManifestRecord, index: number): NormalizedRoute {
  const label = `routes[${index}]`;
  const matchValue = optionalString(value, "match") ?? "prefix";
  if (matchValue !== "exact" && matchValue !== "prefix") {
    throw new Error(`${label}.match must be 'exact' or 'prefix'`);
  }
  const path = nginxPath(requiredString(value, "path", label), `${label}.path`);
  const timeoutsValue = value.timeouts;
  const timeouts =
    timeoutsValue === undefined ? {} : asRecord(timeoutsValue, `${label}.timeouts`);
  return {
    hostname: optionalString(value, "hostname"),
    path,
    match: matchValue,
    target: assertSafeName(requiredString(value, "target", label), `${label}.target`),
    preservePrefix: optionalBoolean(value, "preservePrefix", true),
    websocket: optionalBoolean(value, "websocket", false),
    sse: optionalBoolean(value, "sse", false),
    buffering: optionalBoolean(value, "buffering", true),
    requestBuffering: optionalBoolean(value, "requestBuffering", true),
    uploadLimit: optionalString(value, "uploadLimit"),
    connectTimeout: nginxDuration(
      timeouts.connect ?? timeouts.connectSeconds,
      "60s",
      `${label}.timeouts.connectSeconds`,
    ),
    sendTimeout: nginxDuration(
      timeouts.send ?? timeouts.sendSeconds,
      "60s",
      `${label}.timeouts.sendSeconds`,
    ),
    readTimeout: nginxDuration(
      timeouts.read ?? timeouts.readSeconds,
      "60s",
      `${label}.timeouts.readSeconds`,
    ),
  };
}

function renderProxyLocation(route: NormalizedRoute, port: number): string[] {
  assertPort(port, `Port for service '${route.target}'`);
  const matcher = route.match === "exact" ? `= ${route.path}` : `^~ ${route.path}`;
  const proxyUri = route.preservePrefix ? "" : "/";
  const lines = [
    `    location ${matcher} {`,
    `        proxy_pass http://127.0.0.1:${port}${proxyUri};`,
    "        proxy_http_version 1.1;",
    "        proxy_set_header Host $host;",
    "        proxy_set_header X-Real-IP $remote_addr;",
    "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    "        proxy_set_header X-Forwarded-Proto $scheme;",
  ];
  if (route.websocket) {
    lines.push(
      "        proxy_set_header Upgrade $http_upgrade;",
      "        proxy_set_header Connection $connection_upgrade;",
    );
  }
  if (route.sse || !route.buffering) {
    lines.push("        proxy_buffering off;", '        add_header X-Accel-Buffering "no";');
  }
  if (route.sse) lines.push("        proxy_cache off;");
  if (!route.requestBuffering) lines.push("        proxy_request_buffering off;");
  if (route.uploadLimit) {
    if (!/^[1-9][0-9]*(?:k|m|g)$/i.test(route.uploadLimit)) {
      throw new Error(`Invalid upload limit '${route.uploadLimit}' for route ${route.path}`);
    }
    lines.push(`        client_max_body_size ${route.uploadLimit};`);
  }
  lines.push(
    `        proxy_connect_timeout ${route.connectTimeout};`,
    `        proxy_send_timeout ${route.sendTimeout};`,
    `        proxy_read_timeout ${route.readTimeout};`,
    "    }",
  );
  return lines;
}

function sortedRoutes(routes: NormalizedRoute[]): NormalizedRoute[] {
  return [...routes].sort((left, right) => {
    if (left.match !== right.match) return left.match === "exact" ? -1 : 1;
    if (left.path.length !== right.path.length) return right.path.length - left.path.length;
    return left.path.localeCompare(right.path);
  });
}

function hostRoutes(
  routes: NormalizedRoute[],
  hostname: string,
  primaryDomain: string,
): NormalizedRoute[] {
  return routes.filter((route) => {
    if (route.hostname === undefined) return true;
    if (route.hostname === "@primary") return hostname === primaryDomain;
    return route.hostname.toLowerCase() === hostname;
  });
}

function renderApplicationLocations(
  manifest: ProjectManifest,
  hostname: string,
  primaryDomain: string,
  routes: NormalizedRoute[],
  options: NginxGenerationOptions,
  staticRoot: string | undefined,
): string[] {
  const root = manifestRecord(manifest);
  const selectedRoutes = sortedRoutes(hostRoutes(routes, hostname, primaryDomain));
  const lines: string[] = [];
  for (const route of selectedRoutes) {
    const port = options.ports[route.target];
    if (port === undefined) {
      throw new Error(`No allocated port was provided for route target '${route.target}'`);
    }
    lines.push(...renderProxyLocation(route, port), "");
  }

  const hasRootRoute = selectedRoutes.some(
    (route) => route.path === "/" && route.match === "prefix",
  );
  const frontend = root.frontend;
  if (!hasRootRoute && frontend !== undefined) {
    const frontendRecord = asRecord(frontend, "frontend");
    const type = requiredString(frontendRecord, "type", "frontend");
    if (type === "static") {
      if (!staticRoot) throw new Error("staticRoot is required for a static frontend");
      lines.push(
        "    location / {",
        `        root ${staticRoot};`,
        "        index index.html;",
        optionalBoolean(frontendRecord, "spaFallback", true)
          ? "        try_files $uri $uri/ /index.html;"
          : "        try_files $uri $uri/ =404;",
        "    }",
        "",
      );
    } else if (type === "service") {
      const serviceName = assertSafeName(
        requiredString(frontendRecord, "service", "frontend"),
        "frontend.service",
      );
      const port = options.ports[serviceName];
      if (port === undefined) {
        throw new Error(`No allocated port was provided for frontend service '${serviceName}'`);
      }
      lines.push(
        ...renderProxyLocation(
          {
            path: "/",
            match: "prefix",
            target: serviceName,
            preservePrefix: true,
            websocket: false,
            sse: false,
            buffering: true,
            requestBuffering: true,
            connectTimeout: "60s",
            sendTimeout: "60s",
            readTimeout: "60s",
          },
          port,
        ),
        "",
      );
    }
  }
  return lines;
}

function renderCommonServerBody(
  manifest: ProjectManifest,
  hostname: string,
  primaryDomain: string,
  routes: NormalizedRoute[],
  options: NginxGenerationOptions,
  staticRoot: string | undefined,
): string[] {
  return [
    ...renderApplicationLocations(
      manifest,
      hostname,
      primaryDomain,
      routes,
      options,
      staticRoot,
    ),
    "    gzip on;",
    "    gzip_min_length 256;",
    "    gzip_types text/plain text/css application/json application/javascript application/xml text/xml;",
  ];
}

/** Render a complete managed Nginx file for one target. */
export function generateNginxConfig(
  manifest: ProjectManifest,
  options: NginxGenerationOptions,
): string {
  const root = manifestRecord(manifest);
  const metadata = asRecord(root.metadata, "metadata");
  const projectName = assertSafeName(
    requiredString(metadata, "name", "metadata"),
    "metadata.name",
  );
  const target = namedEntries(root.targets, "targets").find(
    (entry) => entry.name === options.target,
  );
  if (!target) throw new Error(`Unknown target '${options.target}'`);

  const primaryDomain = domain(
    requiredString(target.value, "primaryDomain", `targets.${options.target}`),
    `targets.${options.target}.primaryDomain`,
  );
  const aliases =
    target.value.aliases === undefined
      ? []
      : stringArray(target.value.aliases, `targets.${options.target}.aliases`).map((value) =>
          domain(value, `targets.${options.target}.aliases`),
        );
  const hostnames = [...new Set([primaryDomain, ...aliases])];

  const routeValues = root.routes;
  if (!Array.isArray(routeValues)) throw new Error("routes must be an array");
  const routes = routeValues.map((route, index) =>
    normalizeRoute(asRecord(route, `routes[${index}]`), index),
  );
  // Explicit host routes may belong to another manifest target. They are
  // intentionally ignored for this target; semantic validation already
  // guarantees that every explicit hostname belongs to some target.

  const staticRoot = options.staticRoot
    ? filesystemPath(options.staticRoot, "staticRoot")
    : root.frontend !== undefined && asRecord(root.frontend, "frontend").type === "static"
      ? `/srv/deploykit/${projectName}/${assertSafeName(options.target, "target")}/current/static`
      : undefined;
  const acmeWebroot = filesystemPath(
    options.acmeWebroot ?? "/var/lib/deploykit/acme",
    "acmeWebroot",
  );

  const output = [
    "# Managed by DeployKit. Manual changes will be replaced.",
    ...(options.includeConnectionUpgradeMap
      ? NGINX_CONNECTION_UPGRADE_MAP.trimEnd().split("\n")
      : []),
    ...(options.includeConnectionUpgradeMap ? [""] : []),
  ];

  for (const hostname of hostnames) {
    if (options.tls === false || options.tls === undefined) {
      output.push(
        "server {",
        "    listen 80;",
        "    listen [::]:80;",
        `    server_name ${hostname};`,
        "",
        "    location ^~ /.well-known/acme-challenge/ {",
        `        root ${acmeWebroot};`,
        "        default_type text/plain;",
        "    }",
        "",
        ...renderCommonServerBody(
          manifest,
          hostname,
          primaryDomain,
          routes,
          options,
          staticRoot,
        ),
        "}",
        "",
      );
      continue;
    }

    const certificate = filesystemPath(
      options.tls.certificate ?? `/etc/letsencrypt/live/${primaryDomain}/fullchain.pem`,
      "tls.certificate",
    );
    const certificateKey = filesystemPath(
      options.tls.certificateKey ?? `/etc/letsencrypt/live/${primaryDomain}/privkey.pem`,
      "tls.certificateKey",
    );
    const trustedCertificate = filesystemPath(
      options.tls.trustedCertificate ?? `/etc/letsencrypt/live/${primaryDomain}/chain.pem`,
      "tls.trustedCertificate",
    );
    output.push(
      "server {",
      "    listen 80;",
      "    listen [::]:80;",
      `    server_name ${hostname};`,
      "",
      "    location ^~ /.well-known/acme-challenge/ {",
      `        root ${acmeWebroot};`,
      "        default_type text/plain;",
      "    }",
      "    location / { return 301 https://$host$request_uri; }",
      "}",
      "",
      "server {",
      "    listen 443 ssl http2;",
      "    listen [::]:443 ssl http2;",
      `    server_name ${hostname};`,
      `    ssl_certificate ${certificate};`,
      `    ssl_certificate_key ${certificateKey};`,
      `    ssl_trusted_certificate ${trustedCertificate};`,
      "    ssl_protocols TLSv1.2 TLSv1.3;",
      "",
      ...renderCommonServerBody(
        manifest,
        hostname,
        primaryDomain,
        routes,
        options,
        staticRoot,
      ),
      "}",
      "",
    );
  }

  return `${output.join("\n").trimEnd()}\n`;
}
