import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: process.env.COCKPIT_URL || "https://localhost:9090",
    ignoreHTTPSErrors: true,
    viewport: { width: 1970, height: 1400 },
  },
  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: "shots",
      testMatch: /shots\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1970, height: 1400 },
        storageState: ".auth/session.json",
      },
      dependencies: ["setup"],
    },
  ],
  timeout: 180000,
  expect: {
    timeout: 15000,
  },
});
