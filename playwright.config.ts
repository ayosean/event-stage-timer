import { defineConfig } from "@playwright/test";
export default defineConfig({
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  testDir: "tests/browser",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3000",
    viewport: { width: 1366, height: 1024 },
  },
  webServer: {
    command: "NODE_ENV=production npm run build && node dist/server.js",
    url: "http://127.0.0.1:3000/health",
    reuseExistingServer: false,
    env: {
      ADMIN_PASSWORD: "browser-test-only-password",
      SESSION_SECRET: "browser-test-only-session-secret-32-characters",
      DATA_DIR: "./data/browser-test-" + crypto.randomUUID(),
      PORT: "3000",
      NODE_ENV: "test",
    },
    timeout: 120000,
  },
});
