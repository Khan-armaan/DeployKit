import { basename, join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import prompts from "prompts";
import { discoverComposeFiles, inspectCompose, type ComposeInspection } from "./compose.js";
import { pathExists } from "./fs.js";
import type { DeployKitManifestInput } from "./manifest.js";
import { VERSION } from "./version.js";

export interface InitAnswers {
  projectName: string;
  targetName: string;
  runnerLabel: string;
  primaryDomain: string;
  apiService?: string;
  apiPort?: number;
  healthPath?: string;
  frontendMode: "static" | "service" | "none";
  frontendService?: string;
  staticDirectory?: string;
  nodeVersion: string;
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
  outputDirectory: string;
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z]/.test(normalized) ? normalized.slice(0, 63) : `app-${normalized}`.slice(0, 63);
}

async function detectPackageManager(directory: string): Promise<InitAnswers["packageManager"]> {
  if (await pathExists(join(directory, "pnpm-lock.yaml"))) return "pnpm";
  if (await pathExists(join(directory, "yarn.lock"))) return "yarn";
  if (await pathExists(join(directory, "bun.lockb")) || await pathExists(join(directory, "bun.lock"))) return "bun";
  return "npm";
}

async function detectStaticDirectory(root: string): Promise<string | undefined> {
  for (const candidate of ["frontend", "web", "client", "."]) {
    const packagePath = resolve(root, candidate, "package.json");
    if (!(await pathExists(packagePath))) continue;
    try {
      const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
      if (packageJson.scripts?.build && (dependencies.vite || dependencies["react-scripts"] || dependencies["@angular/cli"])) return candidate;
    } catch {
      // Invalid package.json is surfaced by validate; continue detecting other candidates.
    }
  }
  return undefined;
}

function inferredPort(inspection: ComposeInspection | undefined, serviceName: string | undefined): number {
  const service = inspection?.services.find((candidate) => candidate.name === serviceName);
  return service?.exposedPorts[0] ?? service?.ports[0]?.target ?? 3000;
}

export async function collectInitAnswers(root: string, defaults: Partial<InitAnswers> = {}, nonInteractive = false): Promise<InitAnswers> {
  const composeFiles = await discoverComposeFiles(root);
  const inspection = composeFiles.length > 0 ? await inspectCompose(root, composeFiles) : undefined;
  const staticDirectory = defaults.staticDirectory ?? await detectStaticDirectory(root);
  const serviceNames = inspection?.services.map((service) => service.name) ?? [];
  const likelyApi = defaults.apiService ?? serviceNames.find((name) => /api|backend|server/i.test(name)) ?? serviceNames.find((name) => !/postgres|mysql|redis|mongo|db/i.test(name));
  const likelyFrontendService = serviceNames.find((name) => /front|web|ui/i.test(name));
  const projectDefault = defaults.projectName ?? slug(basename(root));
  const manager = defaults.packageManager ?? await detectPackageManager(resolve(root, staticDirectory ?? "."));

  if (nonInteractive) {
    if (!defaults.primaryDomain || !defaults.runnerLabel) {
      throw new Error("Non-interactive init requires --domain and --runner-label");
    }
    return {
      projectName: projectDefault,
      targetName: defaults.targetName ?? "production",
      runnerLabel: defaults.runnerLabel,
      primaryDomain: defaults.primaryDomain,
      apiService: likelyApi,
      apiPort: defaults.apiPort ?? inferredPort(inspection, likelyApi),
      healthPath: defaults.healthPath ?? "/health",
      frontendMode: defaults.frontendMode ?? (staticDirectory ? "static" : likelyFrontendService ? "service" : "none"),
      frontendService: defaults.frontendService ?? likelyFrontendService,
      staticDirectory,
      nodeVersion: defaults.nodeVersion ?? "22.18.0",
      packageManager: manager,
      outputDirectory: defaults.outputDirectory ?? "dist"
    };
  }

  const response = await prompts([
    { type: "text", name: "projectName", message: "Project slug", initial: projectDefault },
    { type: "text", name: "targetName", message: "Deployment target", initial: defaults.targetName ?? "production" },
    { type: "text", name: "runnerLabel", message: "Enrolled VPS runner label", initial: defaults.runnerLabel ?? "production-vps" },
    { type: "text", name: "primaryDomain", message: "Primary domain", initial: defaults.primaryDomain },
    ...(serviceNames.length > 0 ? [{ type: "select" as const, name: "apiService", message: "Public API Compose service", choices: serviceNames.map((name) => ({ title: name, value: name })), initial: Math.max(0, serviceNames.indexOf(likelyApi ?? "")) }] : []),
    { type: (_previous: unknown, values: Record<string, unknown>) => values.apiService ? "number" : null, name: "apiPort", message: "API container port", initial: inferredPort(inspection, likelyApi) },
    { type: (_previous: unknown, values: Record<string, unknown>) => values.apiService ? "text" : null, name: "healthPath", message: "API health path", initial: defaults.healthPath ?? "/health" },
    {
      type: "select",
      name: "frontendMode",
      message: "Frontend delivery",
      choices: [
        { title: "Static build served by Nginx", value: "static" },
        { title: "Compose/PM2 service proxied by Nginx", value: "service" },
        { title: "No frontend", value: "none" }
      ],
      initial: staticDirectory ? 0 : likelyFrontendService ? 1 : 2
    },
    { type: (_previous: unknown, values: Record<string, unknown>) => values.frontendMode === "static" ? "text" : null, name: "staticDirectory", message: "Static frontend directory", initial: staticDirectory ?? "frontend" },
    { type: (_previous: unknown, values: Record<string, unknown>) => values.frontendMode === "service" ? "select" : null, name: "frontendService", message: "Frontend service", choices: serviceNames.map((name) => ({ title: name, value: name })), initial: Math.max(0, serviceNames.indexOf(likelyFrontendService ?? "")) },
    { type: (_previous: unknown, values: Record<string, unknown>) => values.frontendMode === "static" ? "text" : null, name: "nodeVersion", message: "Exact Node.js version", initial: defaults.nodeVersion ?? "22.18.0" },
    { type: (_previous: unknown, values: Record<string, unknown>) => values.frontendMode === "static" ? "select" : null, name: "packageManager", message: "Package manager", choices: ["npm", "pnpm", "yarn", "bun"].map((value) => ({ title: value, value })), initial: ["npm", "pnpm", "yarn", "bun"].indexOf(manager) },
    { type: (_previous: unknown, values: Record<string, unknown>) => values.frontendMode === "static" ? "text" : null, name: "outputDirectory", message: "Build output directory (relative to frontend)", initial: defaults.outputDirectory ?? "dist" }
  ], { onCancel: () => { throw new Error("Initialization cancelled"); } });

  return response as InitAnswers;
}

export async function createStarterManifest(root: string, answers: InitAnswers): Promise<DeployKitManifestInput> {
  const composeFiles = await discoverComposeFiles(root);
  const inspection = composeFiles.length > 0 ? await inspectCompose(root, composeFiles) : undefined;
  const services: DeployKitManifestInput["services"] = {};
  if (answers.apiService) {
    services.api = {
      type: "compose",
      service: answers.apiService,
      internalPort: answers.apiPort ?? inferredPort(inspection, answers.apiService),
      healthCheck: {
        type: "http",
        path: answers.healthPath ?? "/health"
      }
    };
  }
  if (answers.frontendMode === "service" && answers.frontendService) {
    services.web = {
      type: "compose",
      service: answers.frontendService,
      internalPort: inferredPort(inspection, answers.frontendService),
      healthCheck: { type: "http", path: "/" }
    };
  }

  const frontend = answers.frontendMode === "static"
    ? {
        type: "static" as const,
        workingDirectory: answers.staticDirectory ?? "frontend",
        nodeVersion: answers.nodeVersion,
        packageManager: answers.packageManager,
        buildScript: "build",
        outputDirectory: answers.outputDirectory,
        spaFallback: true,
        apiBasePath: "/api",
        publicEnvironment: { VITE_API_BASE_URL: "/api" }
      }
    : answers.frontendMode === "service"
      ? { type: "service" as const, service: "web" }
      : undefined;

  const routes = answers.apiService ? [{ hostname: "@primary" as const, path: "/api/", match: "prefix" as const, target: "api", preservePrefix: true, websocket: false }] : [];

  return {
    apiVersion: "deploykit/v1alpha1",
    metadata: { name: slug(answers.projectName), requiredVersion: `^${VERSION}` },
    ...(composeFiles.length > 0 ? { compose: { files: composeFiles } } : {}),
    services,
    frontend,
    routes,
    secrets: { required: ["CERTBOT_EMAIL"], generated: [] },
    targets: {
      [slug(answers.targetName)]: {
        runnerLabel: answers.runnerLabel,
        primaryDomain: answers.primaryDomain,
        aliases: [],
        environment: "production",
        publicOverrides: {},
        runtimeOverrides: {}
      }
    }
  };
}
