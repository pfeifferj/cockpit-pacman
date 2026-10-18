import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["line"]] : "html",
  use: {
    baseURL: process.env.COCKPIT_URL || "https://localhost:9090",
    ignoreHTTPSErrors: true,
    trace: "off",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: "chromium",
      testIgnore: /shots\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: ".auth/session.json",
      },
      dependencies: ["setup"],
    },
  ],
  timeout: 60000,
  expect: {
    timeout: 10000,
  },
});
