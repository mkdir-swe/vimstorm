import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Each test file migrates its own schema, so files can run side by side.
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
