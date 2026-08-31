import { describe, expect, it } from "vitest";

import { collectComposeEnvironmentReferences } from "../src/compose.js";

describe("Compose environment reference inspection", () => {
  it("distinguishes required, defaulted, escaped, and pass-through variables", () => {
    const references = collectComposeEnvironmentReferences({
      name: "${COMPOSE_PROJECT_NAME}",
      services: {
        api: {
          image: "example:${IMAGE_TAG:-latest}",
          command: ["--dsn", "${DATABASE_URL:?required}", "$$NOT_INTERPOLATED"],
          environment: {
            API_TOKEN: null,
            LOG_LEVEL: "${LOG_LEVEL-default}",
          },
        },
      },
    });

    expect(references).toEqual([
      expect.objectContaining({ name: "API_TOKEN", required: true }),
      expect.objectContaining({ name: "COMPOSE_PROJECT_NAME", required: true }),
      expect.objectContaining({ name: "DATABASE_URL", required: true }),
      expect.objectContaining({ name: "IMAGE_TAG", required: false }),
      expect.objectContaining({ name: "LOG_LEVEL", required: false }),
    ]);
    expect(references.some((entry) => entry.name === "NOT_INTERPOLATED")).toBe(false);
  });
});
