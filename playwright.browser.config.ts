import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Use a separate server/output directory so concurrent desktop tasks cannot
// accidentally run these checks against another worktree's preview.
export default defineConfig({
  ...base,
  testMatch: "browser-environments.spec.ts",
  outputDir: "test-results/browser-environments-run",
  use: { ...base.use, baseURL: "http://127.0.0.1:4187" },
  webServer: {
    command: "npm run preview -- --host 127.0.0.1 --port 4187 --strictPort",
    url: "http://127.0.0.1:4187",
    reuseExistingServer: false,
  },
});
