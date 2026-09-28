import { defineConfig, devices } from "@playwright/test";
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
const baseURL = process.env.MILL_BROWSER_BASE_URL ?? "http://localhost:4323";
export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  retries: 0,
  use: { baseURL, trace: "off", screenshot: "off" },
  webServer: {
    command: "node --import tsx tests/browser-server.ts",
    url: `${baseURL}/health/ready`,
    timeout: 60000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], channel: "chromium" },
    },
  ],
  reporter: [["list"], ["html", { open: "never" }]],
});
