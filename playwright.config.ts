import { defineConfig, devices } from "@playwright/test";
const baseURL = process.env.MILL_BROWSER_BASE_URL ?? "http://localhost:4323";
export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  retries: 0,
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: {
    command: "node --import tsx tests/browser-server.ts",
    url: `${baseURL}/health/ready`,
    timeout: 60000,
    reuseExistingServer: false,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  reporter: [["list"], ["html", { open: "never" }]],
});
