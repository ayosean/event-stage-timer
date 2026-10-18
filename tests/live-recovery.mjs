// Ad hoc production redeploy check; mode 'before' starts the live timer.
import { chromium, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
const secrets = JSON.parse(
  readFileSync(process.env.LIVE_CREDENTIALS_FILE, "utf8"),
);
const baseURL = process.env.LIVE_URL;
const stateFile = process.env.LIVE_STATE_FILE;
const browser = await chromium.launch({
  proxy: process.env.HTTPS_PROXY
    ? { server: process.env.HTTPS_PROXY }
    : undefined,
});
try {
  const context = await browser.newContext({
    baseURL,
    ...(process.argv[2] === "after"
      ? { storageState: stateFile + ".auth" }
      : {}),
  });
  const page = await context.newPage();
  await page.goto("/controller");
  if (process.argv[2] === "before") {
    await page
      .getByLabel("Username", { exact: true })
      .fill(secrets.ADMIN_USERNAME ?? "admin");
    await page.getByLabel("Admin password").fill(secrets.ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Open controller" }).click();
  }
  await expect(page.getByText("Connected", { exact: true })).toBeVisible({
    timeout: 20000,
  });
  if (process.argv[2] === "before") {
    await page.getByRole("button", { name: "90 min", exact: true }).click();
    await page
      .getByRole("button", { name: "Start timer", exact: true })
      .click();
    await expect(page.getByText("RUNNING", { exact: true })).toBeVisible();
  }
  const state = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket("wss://" + location.host + "/ws/controller");
        const t = setTimeout(() => {
          ws.close();
          reject(Error("No timer state"));
        }, 10000);
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          if (msg.type === "state") {
            clearTimeout(t);
            ws.close();
            resolve(msg);
          }
        };
        ws.onerror = () => reject(Error("Socket failed"));
      }),
  );
  if (process.argv[2] === "before") {
    writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
    await context.storageState({ path: stateFile + ".auth" });
    console.log(
      "Captured running deadline and rundown for redeployment recovery check.",
    );
  } else {
    const before = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(state.timer.status).toBe("running");
    expect(state.timer.deadline).toBe(before.timer.deadline);
    expect(state.timer.startedAt).toBe(before.timer.startedAt);
    expect(state.sessions).toEqual(before.sessions);
    expect(state.selectedId).toBe(before.selectedId);
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(
      page.getByText("READY TO START", { exact: true }),
    ).toBeVisible();
    console.log(
      "Hosted timer deadline, rundown, selected session and admin login survived redeployment. Restored 90:00 ready.",
    );
  }
} finally {
  await browser.close();
}
