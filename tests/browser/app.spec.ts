import { test, expect } from "@playwright/test";
test("controller, landscape iPad, offline countdown, refresh, and manual presenter starts", async ({
  browser,
  page,
}, testInfo) => {
  const sessionName = `Closing keynote · ${testInfo.project.name}`;
  await page.goto("/controller");
  await page.getByLabel("Username", { exact: true }).fill("admin");
  await page.getByLabel("Admin password").fill("browser-test-only-password");
  await page.getByRole("button", { name: "Open controller" }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "90 min", exact: true }).click();
  await expect(page.getByText("READY TO START", { exact: true })).toBeVisible();
  const context = await browser.newContext({
    viewport: { width: 1194, height: 834 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  // A display with a wildly wrong wall clock still uses the server clock.
  await context.addInitScript(() => {
    Date.now = () => 42;
  });
  const viewer = await context.newPage();
  await viewer.goto("/display");
  await expect(viewer.locator("main")).toHaveText("90:00");
  await expect(viewer.locator("button,input,a,progress")).toHaveCount(0);
  await expect(viewer.locator("main")).toHaveCSS(
    "background-color",
    "rgb(0, 0, 0)",
  );
  await expect(viewer.locator(".digits")).toHaveCSS(
    "color",
    "rgb(255, 255, 255)",
  );
  const bounds = await viewer.locator(".digits span").boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(1194);
  expect(bounds!.height).toBeLessThanOrEqual(834);
  expect(bounds!.width).toBeGreaterThan(1050);
  await expect(
    page.getByText("1 connected viewer", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start timer", exact: true }).click();
  await expect(viewer.locator("main")).toHaveText("89:59", { timeout: 5000 });
  await viewer.reload();
  await expect(viewer.locator("main")).toHaveText(/89:5\d/);
  await context.setOffline(true);
  const before = await viewer.locator("main").innerText();
  await expect
    .poll(async () => viewer.locator("main").innerText(), { timeout: 5000 })
    .not.toBe(before);
  await page
    .getByRole("button", { name: "Add 5 minutes", exact: true })
    .click();
  await context.setOffline(false);
  await expect(viewer.locator("main")).toHaveText(/94:5\d/, { timeout: 15000 });
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByText("PAUSED", { exact: true })).toBeVisible();
  const paused = await viewer.locator("main").innerText();
  await viewer.waitForTimeout(1200);
  await expect(viewer.locator("main")).toHaveText(paused);
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.getByRole("button", { name: "30 min", exact: true }).click();
  await expect(viewer.locator("main")).toHaveText("30:00");
  await expect(page.getByText("READY TO START", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Add session", exact: true })
    .first()
    .click();
  await page.getByLabel("Presenter / session name").fill(sessionName);
  await page.getByLabel("Duration in minutes").fill("45");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Add session", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: sessionName, exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start timer", exact: true }).click();
  await page
    .getByRole("button", { name: "Next presenter", exact: true })
    .click();
  await expect(viewer.locator("main")).toHaveText("45:00");
  await expect(page.getByText("READY TO START", { exact: true })).toBeVisible();
  await page.getByLabel("Custom duration").fill("0.02");
  await page.getByRole("button", { name: "Load timer", exact: true }).click();
  await expect(page.getByText("READY TO START", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start timer", exact: true }).click();
  await expect(viewer.locator("main")).toHaveText("00:00", { timeout: 5000 });
  await expect(viewer.locator(".digits")).toHaveCSS("color", "rgb(255, 0, 0)");
  await viewer.waitForTimeout(1100);
  await expect(viewer.locator("main")).toHaveText("00:00");
  await page.getByRole("button", { name: "90 min", exact: true }).click();
  await page.screenshot({
    path: testInfo.outputPath("controller-desktop.png"),
    fullPage: true,
  });
  await viewer.screenshot({ path: testInfo.outputPath("display-ipad.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath("controller-mobile.png"),
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await context.close();
});
