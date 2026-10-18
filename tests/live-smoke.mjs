// Run manually after deployment. Credentials stay outside the repository.
import { chromium, expect } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const baseURL = process.env.LIVE_URL;
const secretFile = process.env.LIVE_CREDENTIALS_FILE;
if (!baseURL || !secretFile)
  throw new Error("Set LIVE_URL and LIVE_CREDENTIALS_FILE.");
const { ADMIN_PASSWORD: password, ADMIN_USERNAME: username = "admin" } =
  JSON.parse(readFileSync(secretFile, "utf8"));
const artifactDir = process.env.LIVE_ARTIFACT_DIR ?? "test-results/live";
mkdirSync(artifactDir, { recursive: true });
const browser = await chromium.launch({
  proxy: process.env.HTTPS_PROXY
    ? { server: process.env.HTTPS_PROXY }
    : undefined,
});
try {
  const controller = await browser.newPage({ baseURL });
  const errors = [];
  controller.on("pageerror", (error) => errors.push(error.message));
  await controller.goto("/controller");
  await controller.getByLabel("Username", { exact: true }).fill(username);
  await controller.getByLabel("Admin password").fill(password);
  await controller.getByRole("button", { name: "Open controller" }).click();
  await expect(controller.getByText("Connected", { exact: true })).toBeVisible({
    timeout: 20000,
  });
  await controller.getByRole("button", { name: "90 min", exact: true }).click();
  await expect(
    controller.getByText("READY TO START", { exact: true }),
  ).toBeVisible();
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1194, height: 834 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  });
  const display = await context.newPage();
  await display.goto("/display");
  await expect(display.locator("main")).toHaveText("90:00");
  await expect(display.locator("button,input,a")).toHaveCount(0);
  await controller
    .getByRole("button", { name: "Start timer", exact: true })
    .click();
  await expect(display.locator("main")).toHaveText("89:59", { timeout: 10000 });
  await display.reload();
  await expect(display.locator("main")).toHaveText(/89:5\d/);
  await controller
    .getByRole("button", { name: "Add 5 minutes", exact: true })
    .click();
  await expect(display.locator("main")).toHaveText(/94:5\d/);
  await controller.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(controller.getByText("PAUSED", { exact: true })).toBeVisible();
  const paused = await display.locator("main").innerText();
  await display.waitForTimeout(1500);
  await expect(display.locator("main")).toHaveText(paused);
  await controller.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(controller.getByText("RUNNING", { exact: true })).toBeVisible();
  await controller.getByRole("button", { name: "30 min", exact: true }).click();
  await expect(display.locator("main")).toHaveText("30:00");
  await expect(
    controller.getByText("READY TO START", { exact: true }),
  ).toBeVisible();
  await controller.getByLabel("Custom duration").fill("0.02");
  await controller
    .getByRole("button", { name: "Load timer", exact: true })
    .click();
  await controller
    .getByRole("button", { name: "Start timer", exact: true })
    .click();
  await expect(display.locator("main")).toHaveText("00:00", { timeout: 10000 });
  await expect(display.locator(".digits")).toHaveCSS("color", "rgb(255, 0, 0)");
  await expect(display.locator("main")).toHaveText("00:01", { timeout: 4000 });
  await expect(controller.getByText("OVERTIME", { exact: true })).toBeVisible();
  await display.reload();
  await expect(display.locator(".digits")).toHaveCSS("color", "rgb(255, 0, 0)");
  await controller.getByRole("button", { name: "15 min", exact: true }).click();
  await expect(display.locator("main")).toHaveText("15:00");
  await expect(
    controller.getByText("READY TO START", { exact: true }),
  ).toBeVisible();
  await controller.getByRole("button", { name: "90 min", exact: true }).click();
  await expect(display.locator("main")).toHaveText("90:00");
  await expect(
    controller.getByText("READY TO START", { exact: true }),
  ).toBeVisible();
  await controller.screenshot({
    path: join(artifactDir, "controller.png"),
    fullPage: true,
  });
  await display.screenshot({ path: join(artifactDir, "display.png") });
  if (errors.length) throw Error(errors.join("\n"));
  console.log(
    "Live HTTPS login, WSS synchronization, 90-minute manual start, refresh, add five minutes, pause/resume, preset paused state, red overtime, 15-minute preset and 90:00 ready restoration passed.",
  );
} finally {
  await browser.close();
}
