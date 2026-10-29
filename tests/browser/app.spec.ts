import { test, expect, type Page, type Locator } from "@playwright/test";
import { type Snapshot } from "../../shared/timer";
import { formatClockTime } from "../../shared/clock";

async function login(page: Page) {
  await page.goto("/controller");
  // Authentication loads asynchronously. Wait for the login form or an
  // authenticated controller before deciding which path this tab needs.
  await expect(
    page
      .getByLabel("Username", { exact: true })
      .or(page.getByText("Connected", { exact: true })),
  ).toBeVisible();
  if (await page.getByLabel("Username", { exact: true }).isVisible()) {
    await page.getByLabel("Username", { exact: true }).fill("admin");
    await page.getByLabel("Admin password").fill("browser-test-only-password");
    await page.getByRole("button", { name: "Open controller" }).click();
  }
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
}
async function publish(page: Page, button: Locator) {
  await button.click();
  const confirm = page.getByRole("button", {
    name: "Confirm LIVE change",
    exact: true,
  });
  if (await confirm.isVisible()) await confirm.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}
async function tab(page: Page, name: "LIVE Output" | "Staging" | "Legacy") {
  await page.getByRole("tab", { name, exact: true }).click();
}
async function startPrepared(page: Page, minutes: number) {
  await tab(page, "Staging");
  await page.getByRole("button", { name: "Countdown", exact: true }).click();
  await page
    .getByRole("button", { name: `${minutes} min`, exact: true })
    .click();
  await publish(page, page.getByRole("button", { name: "TAKE", exact: true }));
  await tab(page, "LIVE Output");
  await expect(page.getByText("READY TO START", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start timer", exact: true }).click();
  await expect(page.getByText("RUNNING", { exact: true })).toBeVisible();
}
function output(page: Page): Promise<Snapshot> {
  return page.evaluate(
    () =>
      new Promise<Snapshot>((resolve, reject) => {
        const ws = new WebSocket(
          `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/display`,
        );
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error("Snapshot timed out"));
        }, 5000);
        ws.onmessage = (event) => {
          const message = JSON.parse(event.data);
          if (message.type === "state") {
            clearTimeout(timer);
            ws.close();
            resolve(message);
          }
        };
      }),
  );
}
async function addSession(page: Page, name: string) {
  await page
    .locator(".rundown-header")
    .getByRole("button", { name: "Add session", exact: true })
    .click();
  await page.getByLabel("Presenter / session name").fill(name);
  await page.getByLabel("Duration in minutes").fill("25");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Add session", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: `Edit ${name}`, exact: true }),
  ).toBeVisible();
}
async function agendaWork(page: Page, suffix: string) {
  await tab(page, "Staging");
  await page.getByRole("button", { name: "Countdown", exact: true }).click();
  const source = await page
    .locator(".timer-panel .session-heading h2")
    .innerText();
  const selected = await page
    .locator(".current-session .session-select > span")
    .innerText();
  const renamed = `Edited agenda ${suffix}`;
  const added = `New presenter ${suffix}`;
  await page
    .getByRole("button", { name: `Edit ${selected}`, exact: true })
    .click();
  await page.getByLabel("Presenter / session name").fill(renamed);
  await page.getByLabel("Duration in minutes").fill("20");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByRole("button", { name: `Edit ${renamed}`, exact: true }),
  ).toBeVisible();
  await addSession(page, added);
  await page
    .getByRole("button", { name: `Duplicate ${renamed}`, exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: `Edit ${renamed} (copy)`, exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: `Move ${added} up`, exact: true })
    .click();
  await page
    .getByRole("button", { name: `Prepare ${added}`, exact: true })
    .click();
  await expect(page.locator(".prepared-summary > span")).toHaveText(added);
  await page
    .getByRole("button", { name: "Previous presenter", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Next presenter", exact: true })
    .click();
  await page
    .getByRole("button", { name: `Delete ${renamed}`, exact: true })
    .click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(
    page.getByRole("button", { name: `Edit ${renamed}`, exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: `Prepare ${added}`, exact: true })
    .click();
  await page.getByLabel("Custom duration").fill("17.5");
  await page
    .getByRole("button", { name: "Prepare timer", exact: true })
    .click();
  await expect(page.locator(".prepared-summary .digits span")).toHaveText(
    "17:30",
  );
  return source;
}

test("manual LIVE start, precise pause/resume, adjustments and offline landscape display", async ({
  page,
  browser,
}, testInfo) => {
  await login(page);
  await startPrepared(page, 90);
  const context = await browser.newContext({
    viewport: { width: 1194, height: 834 },
    isMobile: true,
    hasTouch: true,
  });
  await context.addInitScript(() => {
    Date.now = () => 42;
  });
  const viewer = await context.newPage();
  await viewer.goto("/display");
  await expect(viewer.locator("main")).toHaveText("89:59", { timeout: 5000 });
  const running = await output(viewer);
  await tab(page, "Staging");
  await page.getByRole("button", { name: "30 min", exact: true }).click();
  await expect(page.locator(".prepared-summary .digits span")).toHaveText(
    "30:00",
  );
  expect((await output(viewer)).timer).toEqual(running.timer);
  await tab(page, "LIVE Output");
  await page
    .getByRole("button", { name: "Add 5 minutes", exact: true })
    .click();
  await expect
    .poll(async () => (await output(viewer)).timer.deadline)
    .toBe(running.timer.deadline! + 300000);
  await page
    .getByRole("button", { name: "Subtract 30 seconds", exact: true })
    .click();
  await expect
    .poll(async () => (await output(viewer)).timer.deadline)
    .toBe(running.timer.deadline! + 270000);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByText("PAUSED", { exact: true })).toBeVisible();
  await viewer.waitForTimeout(100);
  const paused = await viewer.locator("main").innerText();
  await viewer.waitForTimeout(1100);
  await expect(viewer.locator("main")).toHaveText(paused);
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.getByText("RUNNING", { exact: true })).toBeVisible();
  const beforeOffline = await viewer.locator("main").innerText();
  await context.setOffline(true);
  await expect
    .poll(() => viewer.locator("main").innerText(), { timeout: 4000 })
    .not.toBe(beforeOffline);
  await context.setOffline(false);
  await viewer.reload();
  await expect(viewer.locator("main")).toHaveText(/^9\d:\d{2}$/);
  await expect(viewer.locator("main")).toHaveCSS(
    "background-color",
    "rgb(0, 0, 0)",
  );
  await expect(viewer.locator(".digits")).toHaveCSS(
    "color",
    "rgb(255, 255, 255)",
  );
  await expect(viewer.locator("button,input,a,progress")).toHaveCount(0);
  const bounds = await viewer.locator(".digits span").boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(1194);
  expect(bounds!.width).toBeGreaterThan(1050);
  expect(bounds!.height).toBeLessThanOrEqual(834);
  await viewer.screenshot({ path: testInfo.outputPath("live-ipad.png") });
  await context.close();
});

test("all agenda work including deleting LIVE source is off air; publishing paused requires confirmation", async ({
  page,
  browser,
}, testInfo) => {
  await login(page);
  await startPrepared(page, 90);
  const context = await browser.newContext();
  const viewer = await context.newPage();
  await viewer.goto("/display");
  const before = await output(viewer);
  const source = await agendaWork(page, `countdown-${testInfo.project.name}`);
  expect((await output(viewer)).timer).toEqual(before.timer);
  await expect(page.locator(".timer-panel .session-heading h2")).toHaveText(
    source,
  );
  await page.reload();
  await expect(page.getByText("RUNNING", { exact: true })).toBeVisible();
  await expect(page.locator(".timer-panel .session-heading h2")).toHaveText(
    source,
  );
  await expect(page.locator(".prepared-summary .digits span")).toHaveText(
    "17:30",
  );
  await tab(page, "Staging");
  await page.getByRole("button", { name: "TAKE", exact: true }).click();
  await page
    .getByRole("button", { name: "Keep LIVE unchanged", exact: true })
    .click();
  expect((await output(viewer)).timer).toEqual(before.timer);
  await publish(page, page.getByRole("button", { name: "TAKE", exact: true }));
  await expect(viewer.locator("main")).toHaveText("17:30");
  await tab(page, "LIVE Output");
  await expect(page.getByText("READY TO START", { exact: true })).toBeVisible();
  await viewer.waitForTimeout(1100);
  await expect(viewer.locator("main")).toHaveText("17:30");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await page.screenshot({
    path: testInfo.outputPath("off-air-preparation-mobile.png"),
    fullPage: true,
  });
  await context.close();
});

test("Eastern/Pacific clock selection stays off air until TAKE and survives refresh/offline", async ({
  page,
  browser,
}, testInfo) => {
  await login(page);
  await startPrepared(page, 30);
  const running = await output(page);
  await tab(page, "Staging");
  await page.getByRole("button", { name: "Current Time", exact: true }).click();
  await page
    .getByLabel("Clock timezone", { exact: true })
    .selectOption("America/New_York");
  expect((await output(page)).displayMode).toBe("countdown");
  expect((await output(page)).timer).toEqual(running.timer);
  await tab(page, "Staging");
  await page.getByRole("button", { name: "TAKE", exact: true }).click();
  await page
    .getByRole("button", { name: "Keep LIVE unchanged", exact: true })
    .click();
  expect((await output(page)).timer).toEqual(running.timer);
  await publish(page, page.getByRole("button", { name: "TAKE", exact: true }));
  await tab(page, "LIVE Output");
  await expect(page.getByText("EASTERN TIME", { exact: true })).toBeVisible();
  const context = await browser.newContext({
    viewport: { width: 1194, height: 834 },
    timezoneId: "Asia/Tokyo",
  });
  await context.addInitScript(() => {
    Date.now = () => 42;
  });
  const viewer = await context.newPage();
  await viewer.clock.install();
  await viewer.goto("/display");
  await expect
    .poll(async () => {
      const text = await viewer.locator("main").innerText();
      return [-1000, 0, 1000].some(
        (offset) =>
          formatClockTime(Date.now() + offset, "America/New_York") === text,
      );
    })
    .toBe(true);
  const before = await output(viewer);
  const second = await context.newPage();
  await second.goto("/display");
  await expect(second.locator("main")).toHaveText(
    await viewer.locator("main").innerText(),
  );
  await agendaWork(page, `clock-${testInfo.project.name}`);
  expect((await output(viewer)).displayMode).toBe("clock");
  expect((await output(viewer)).timer).toEqual(before.timer);
  await tab(page, "Staging");
  await page.getByRole("button", { name: "Current Time", exact: true }).click();
  await page
    .getByLabel("Clock timezone", { exact: true })
    .selectOption("America/Los_Angeles");
  expect((await output(viewer)).clockTimeZone).toBe("America/New_York");
  await publish(page, page.getByRole("button", { name: "TAKE", exact: true }));
  await tab(page, "LIVE Output");
  await expect(page.getByText("PACIFIC TIME", { exact: true })).toBeVisible();
  await expect
    .poll(async () => {
      const text = await viewer.locator("main").innerText();
      return [-1000, 0, 1000].some(
        (offset) =>
          formatClockTime(Date.now() + offset, "America/Los_Angeles") === text,
      );
    })
    .toBe(true);
  expect((await output(viewer)).timer).toEqual(before.timer);
  await page.reload();
  await expect(page.getByLabel("Clock timezone", { exact: true })).toHaveValue(
    "America/Los_Angeles",
  );
  const previous = await viewer.locator("main").innerText();
  await context.setOffline(true);
  await viewer.clock.fastForward(61000);
  await expect
    .poll(() => viewer.locator("main").innerText())
    .not.toBe(previous);
  await context.setOffline(false);
  await viewer.reload();
  await expect(viewer.locator("main")).toHaveText(/^\d{1,2}:\d{2}$/);
  await expect(viewer.locator(".digits")).toHaveCSS(
    "color",
    "rgb(255, 255, 255)",
  );
  await expect(viewer.locator("button,input,a,select")).toHaveCount(0);
  await viewer.screenshot({ path: testInfo.outputPath("clock-ipad.png") });
  await tab(page, "Staging");
  await page.getByRole("button", { name: "Countdown", exact: true }).click();
  expect((await output(viewer)).displayMode).toBe("clock");
  await publish(page, page.getByRole("button", { name: "TAKE", exact: true }));
  await tab(page, "LIVE Output");
  await expect(page.getByText("READY TO START", { exact: true })).toBeVisible();
  await expect(viewer.locator("main")).toHaveText("17:30");
  await viewer.waitForTimeout(1100);
  await expect(viewer.locator("main")).toHaveText("17:30");
  await context.close();
});

test("overtime survives planning and stale LIVE confirmations cannot replace output", async ({
  page,
  browser,
}) => {
  await login(page);
  await tab(page, "Staging");
  await page.getByRole("button", { name: "Countdown", exact: true }).click();
  await page.getByLabel("Custom duration").fill("0.016666667");
  await page
    .getByRole("button", { name: "Prepare timer", exact: true })
    .click();
  await publish(page, page.getByRole("button", { name: "TAKE", exact: true }));
  await tab(page, "LIVE Output");
  await page.getByRole("button", { name: "Start timer", exact: true }).click();
  const context = await browser.newContext();
  const viewer = await context.newPage();
  await viewer.goto("/display");
  await expect(viewer.locator(".digits")).toHaveCSS("color", "rgb(255, 0, 0)", {
    timeout: 5000,
  });
  await expect(viewer.locator("main")).toHaveText("00:01", { timeout: 4000 });
  const before = await output(viewer);
  await tab(page, "Staging");
  await page.getByRole("button", { name: "60 min", exact: true }).click();
  expect((await output(viewer)).timer).toEqual(before.timer);
  await tab(page, "Staging");
  await page.getByRole("button", { name: "TAKE", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const other = await page.context().newPage();
  await login(other);
  await tab(other, "Staging");
  await other.getByRole("button", { name: "45 min", exact: true }).click();
  await expect(page.locator(".prepared-summary .digits span")).toHaveText(
    "45:00",
  );
  await page
    .getByRole("button", { name: "Confirm LIVE change", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("State changed");
  expect((await output(viewer)).timer).toEqual(before.timer);
  await publish(page, page.getByRole("button", { name: "TAKE", exact: true }));
  await tab(page, "LIVE Output");
  await page.getByRole("button", { name: "Start timer", exact: true }).click();
  await expect(page.getByText("RUNNING", { exact: true })).toBeVisible();
  await expect(viewer.locator(".digits")).toHaveCSS(
    "color",
    "rgb(255, 255, 255)",
  );
  const next = await output(viewer);
  expect(next.timer.durationMs).toBe(2700000);
  expect(next.timer.deadline).not.toBe(before.timer.deadline);
  await other.close();
  await context.close();
});

test("custom LIVE time sets an exact paused time and adjusts running time without TAKE or changing preparation", async ({
  page,
  context,
}) => {
  await login(page);
  await startPrepared(page, 90);
  const viewer = await context.newPage();
  await viewer.goto("/display");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await tab(page, "Staging");
  await page.getByRole("button", { name: "15 min", exact: true }).click();
  await tab(page, "LIVE Output");
  await page.getByLabel("Custom LIVE time", { exact: true }).fill("12:30");
  await page
    .getByRole("button", { name: "Set LIVE time", exact: true })
    .click();
  await expect(viewer.locator(".display-digits span")).toHaveText("12:30");
  expect((await output(page)).timer.status).toBe("paused");
  await viewer.reload();
  await expect(viewer.locator(".display-digits span")).toHaveText("12:30");
  await page.getByLabel("Custom LIVE time", { exact: true }).fill("1:60");
  await expect(
    page.getByRole("button", { name: "Set LIVE time", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Custom LIVE time", { exact: true }).fill("5");
  await page.getByLabel("Custom LIVE time", { exact: true }).press("Enter");
  await expect(viewer.locator(".display-digits span")).toHaveText("05:00");
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.getByLabel("Custom LIVE time", { exact: true }).fill("2:30");
  await page
    .getByRole("button", { name: "Set LIVE time", exact: true })
    .click();
  await expect
    .poll(async () => {
      const s = await output(page);
      return s.timer.remainingMs;
    })
    .toBe(150000);
  expect((await output(page)).timer.status).toBe("running");
  await tab(page, "Staging");
  await expect(
    page.getByRole("button", { name: "15 min", exact: true }),
  ).toHaveClass(/selected/);
});

test("LIVE and Staging tabs share large previews and never change output when switching", async ({
  page,
}, testInfo) => {
  await login(page);
  await startPrepared(page, 90);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const before = await output(page);
  const liveBounds = await page
    .locator("#panel-live .preview-clock")
    .boundingBox();
  await tab(page, "Staging");
  await expect(page.locator("#panel-live")).toBeHidden();
  await expect(page.locator("#panel-staging")).toBeVisible();
  const stagedBounds = await page
    .locator("#panel-staging .preview-clock")
    .boundingBox();
  expect(stagedBounds!.height).toBe(liveBounds!.height);
  expect(Math.abs(stagedBounds!.width - liveBounds!.width)).toBeLessThan(5);
  const digits = page.locator("#panel-staging .digits span");
  await expect
    .poll(async () =>
      parseFloat(await digits.evaluate((el) => getComputedStyle(el).fontSize)),
    )
    .toBeGreaterThan(100);
  await page
    .getByRole("tab", { name: "Staging", exact: true })
    .press("ArrowLeft");
  await expect(
    page.getByRole("tab", { name: "LIVE Output", exact: true }),
  ).toBeFocused();
  await expect(page.locator("#panel-live")).toBeVisible();
  expect((await output(page)).timer).toEqual(before.timer);
  expect((await output(page)).revision).toBe(before.revision);
  await page.setViewportSize({ width: 390, height: 844 });
  await tab(page, "Staging");
  await expect
    .poll(() => digits.evaluate((el) => el.getBoundingClientRect().width))
    .toBeLessThan(340);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await page.screenshot({
    path: testInfo.outputPath("staging-tabs-mobile.png"),
    fullPage: true,
  });
});

test("Legacy tab restores direct controls while entering/leaving it leaves LIVE untouched", async ({
  page,
  context,
}, testInfo) => {
  const presenter = `Legacy browser presenter ${testInfo.project.name}`;
  await login(page);
  await startPrepared(page, 90);
  await addSession(page, presenter);
  const before = await output(page);
  await tab(page, "Legacy");
  expect((await output(page)).timer).toEqual(before.timer);
  await expect(
    page.getByRole("button", { name: "TAKE", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".legacy-notice")).toBeVisible();
  const viewer = await context.newPage();
  await viewer.goto("/display");
  await page.getByRole("button", { name: "30 min", exact: true }).click();
  await expect(viewer.locator("main")).toHaveText("30:00");
  expect((await output(page)).timer.status).toBe("ready");
  const rows = page.locator(".session-list > li");
  const previousTime = await rows
    .nth((await rows.count()) - 2)
    .locator(".row-duration")
    .innerText();
  await page
    .getByRole("button", { name: `Load ${presenter}`, exact: true })
    .click();
  await expect(viewer.locator("main")).toHaveText("25:00");
  await page
    .locator("#panel-live")
    .getByRole("button", { name: "Previous presenter", exact: true })
    .click();
  await expect(viewer.locator("main")).toHaveText(previousTime);
  await page
    .locator("#panel-live")
    .getByRole("button", { name: "Next presenter", exact: true })
    .click();
  await expect(viewer.locator("main")).toHaveText("25:00");
  expect((await output(page)).timer.status).toBe("ready");
  await expect(
    page.getByRole("tab", { name: "Legacy", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByLabel("Custom duration").fill("12.5");
  await page.getByRole("button", { name: "Load timer", exact: true }).click();
  await expect(viewer.locator("main")).toHaveText("12:30");
  await page.getByRole("button", { name: "Current Time", exact: true }).click();
  await expect.poll(async () => (await output(page)).displayMode).toBe("clock");
  await page
    .getByLabel("Clock timezone", { exact: true })
    .selectOption("America/New_York");
  await expect
    .poll(async () => (await output(page)).clockTimeZone)
    .toBe("America/New_York");
  await tab(page, "Staging");
  const clock = await output(page);
  await page.getByRole("button", { name: "45 min", exact: true }).click();
  expect((await output(page)).timer).toEqual(clock.timer);
  expect((await output(page)).displayMode).toBe("clock");
  await tab(page, "Legacy");
  expect((await output(page)).displayMode).toBe("clock");
  await page.getByRole("button", { name: "Countdown", exact: true }).click();
  await expect(viewer.locator("main")).toHaveText("45:00");
  expect((await output(page)).timer.status).toBe("ready");
});
