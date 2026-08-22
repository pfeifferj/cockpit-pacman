import { defineConfig } from "vitest/config";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  // The build injects this; without it the version check would compile out of
  // every test and never be exercised.
  define: { __BUNDLE_VERSION__: JSON.stringify(pkg.version) },
  test: {
    globals: true,
    environment: "jsdom",
    testTimeout: 20000,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/test/**", "src/**/*.test.{ts,tsx}"],
    },
  },
});
