import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
export default defineConfig({
  ...base,
  use: { ...base.use, baseURL: "http://127.0.0.1:8787" },
  webServer: {
    command:
      "npm run build:cloudflare && wrangler dev --port 8787 --var ADMIN_USERNAME:admin --var ADMIN_PASSWORD:browser-test-only-password --var SESSION_SECRET:browser-test-only-session-secret-32-characters --persist-to ./data/cloudflare-browser-" +
      crypto.randomUUID(),
    url: "http://127.0.0.1:8787/health",
    reuseExistingServer: false,
    env: { WRANGLER_SEND_METRICS: "false" },
    timeout: 120000,
  },
});
