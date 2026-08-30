import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the operational scripts at this level; each workspace runs its own.
    include: ["scripts/**/*.test.ts"],
  },
  // Deliberately not named vitest.config.ts: vitest resolves config by walking
  // up from the working directory, so a root config is inherited by every
  // workspace that lacks one — which made the signer run with this `include`,
  // find nothing, and exit 1. Referenced explicitly by the test:scripts script.
});
