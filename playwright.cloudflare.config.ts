import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
export default defineConfig({
  ...base,
  use: {
    ...base.use,
    baseURL: "https://127.0.0.1:8787",
    ignoreHTTPSErrors: true,
  },
  webServer: {
    command:
      "npm run build:cloudflare && wrangler dev --port 8787 --local-protocol https --var ADMIN_USERNAME:admin --var ADMIN_PASSWORD:browser-test-only-password --var SESSION_SECRET:browser-test-only-session-secret-32-characters --persist-to ./data/cloudflare-browser-" +
      crypto.randomUUID(),
    url: "https://127.0.0.1:8787/health",
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    env: { WRANGLER_SEND_METRICS: "false" },
    timeout: 120000,
  },
});
