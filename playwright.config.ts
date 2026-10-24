import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/ui",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // GitHub Windows 跑动机核数少且慢，应用包体积大：本地 3 分钟的套件在 CI 上需 40 分钟以上，
  // 30 秒单测超时会导致大量交互等待被误判失败（v0.1.80 起连续三个版本）。CI 放宽超时并降低并行度。
  timeout: process.env.CI ? 180_000 : 30_000,
  expect: { timeout: process.env.CI ? 30_000 : 5_000 },
  workers: process.env.CI ? 2 : undefined,
  retries: process.env.CI ? 2 : 0,
  reporter: "line",
  use: { baseURL: "http://127.0.0.1:4173", trace: "on-first-retry", ...devices["Desktop Chrome"] },
  webServer: {
    command: "npm run preview -- --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
