import { describe, expect, it } from "vitest";

import { isValidVersionRequirement, versionSatisfiesRequirement } from "../src/version.js";

describe("DeployKit version requirements", () => {
  it("supports exact and standard semantic-version ranges", () => {
    expect(versionSatisfiesRequirement("0.1.0", "0.1.0")).toBe(true);
    expect(versionSatisfiesRequirement("^0.1.0", "0.1.7")).toBe(true);
    expect(versionSatisfiesRequirement("^0.1.0", "0.2.0")).toBe(false);
    expect(isValidVersionRequirement("latest please")).toBe(false);
  });
});
