export type SupportedPackageManagerName = "npm" | "pnpm" | "yarn" | "bun";

const DECLARATION = /^(npm|pnpm|yarn|bun)@((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?)$/;

export interface PackageManagerDeclaration {
  readonly name: SupportedPackageManagerName;
  readonly version: string;
}

/** Parse the deterministic packageManager form accepted by DeployKit. */
export function parsePackageManagerDeclaration(value: unknown): PackageManagerDeclaration | undefined {
  if (typeof value !== "string") return undefined;
  const match = DECLARATION.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { name: match[1] as SupportedPackageManagerName, version: match[2] };
}
