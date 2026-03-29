import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  globalSetup: "./tests/browser/global-setup.ts",
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:14567",
    headless: true,
  },
  webServer: {
    command: "npx tsx tests/browser/server.ts",
    url: "http://localhost:14567/health",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    // PORT must be set before the process starts so dotenv (loaded inside
    // src/foreman.ts) does not override it with the value from .env.
    env: { PORT: "14567" },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
