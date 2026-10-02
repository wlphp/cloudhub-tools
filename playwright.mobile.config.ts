import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/mobile-ui",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4174",
    trace: "on-first-retry",
    ...devices["Desktop Chrome"],
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  },
  webServer: {
    command: "npm run preview -- --host 127.0.0.1 --port 4174",
    url: "http://127.0.0.1:4174",
    reuseExistingServer: !process.env.CI,
  },
});
