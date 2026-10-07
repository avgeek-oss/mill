import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { expect, test } from "@playwright/test";
import {
  authenticateBrowserFixture,
  getBrowserBootstrap,
  type BrowserFixtureSession,
} from "../browser-fixture.js";

let fixture: BrowserFixtureSession;
test.beforeAll(async ({ baseURL }) => {
  const bootstrap = await getBrowserBootstrap(baseURL!);
  fixture = bootstrap;
  await bootstrap.api.dispose();
});

const selected = {
  dateFormat: "short-month-day-year",
  timeFormat: "24-hour-seconds",
  timeZone: "Asia/Kathmandu",
};
for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const)
    test(`native display preferences persist at ${width}px in ${theme}`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        baseURL: fixture.origin,
        viewport: { width, height: 900 },
        isMobile: width === 390,
        hasTouch: width === 390,
      });
      try {
        const page = await context.newPage();
        await authenticateBrowserFixture(page, fixture);
        const reset = await page.request.patch("/api/auth/profile", {
          headers: { Origin: fixture.origin },
          data: {
            dateFormat: "day-short-month-year",
            timeFormat: "24-hour",
            timeZone: "UTC",
          },
        });
        expect(reset.status()).toBe(200);
        await page.goto("/settings/preferences");
        await expect(
          page.getByRole("heading", { name: "Preferences", exact: true }),
        ).toBeVisible();
        if ((await page.locator("html").getAttribute("data-theme")) !== theme)
          await page
            .getByRole("button", {
              name: `Appearance: switch to ${theme} theme`,
              exact: true,
            })
            .click();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        const form = page
          .locator("form")
          .filter({ has: page.getByRole("button", { name: /Date format/ }) });
        const save = form.getByRole("button", { name: "Save", exact: true });
        await expect(save).toBeDisabled();
        await form.getByRole("button", { name: /Date format/ }).click();
        let options = page.getByRole("listbox").getByRole("option");
        await expect(options).toHaveText([
          "16 Sept 2026",
          "Sept 16, 2026",
          "2026-09-16",
          "16/09/2026",
          "09/16/2026",
        ]);
        await options.filter({ hasText: "Sept 16, 2026" }).click();
        await form.getByRole("button", { name: /Time format/ }).click();
        options = page.getByRole("listbox").getByRole("option");
        await expect(options).toHaveText([
          "14:30",
          "2:30 PM",
          "14:30:45",
          "2:30:45 PM",
        ]);
        await page
          .getByRole("listbox")
          .getByRole("option", { name: "14:30:45", exact: true })
          .click();
        await form.getByRole("button", { name: /Time zone/ }).click();
        await page
          .getByRole("searchbox", { name: "Search time zones" })
          .fill("Kathmandu");
        const zone = page
          .getByRole("listbox")
          .getByRole("option", { name: /Asia\/Kathmandu/ });
        await expect(zone).toContainText("+05:45");
        await expect(zone).not.toContainText("UTC");
        await zone.click();
        await expect(
          form.getByRole("button", { name: /Time zone/ }),
        ).toContainText("+05:45");
        await expect(form.getByText("Preview", { exact: true })).toHaveCount(0);
        let acknowledgements = 0;
        page.on("response", (response) => {
          if (
            new URL(response.url()).pathname === "/api/auth/profile" &&
            response.request().method() === "PATCH" &&
            response.status() === 200
          )
            acknowledgements++;
        });
        if (width === 1280 && theme === "light") {
          await page.route("**/api/auth/profile", (route) => route.abort(), {
            times: 1,
          });
          await save.click();
          const error = page
            .locator('[data-slot="toast"]')
            .filter({ hasText: "Mill could not be reached" });
          await expect(error).toHaveCount(1);
          await expect(error).toBeVisible();
          await expect(form.getByRole("alert")).toHaveCount(0);
          await expect(
            form.getByRole("button", { name: /Date format/ }),
          ).toContainText("Sept 16, 2026");
          await error.locator('[data-slot="toast-close"]').click();
          await expect(error).toHaveCount(0);
        }
        await save.click();
        const success = page
          .locator('[data-slot="toast"]')
          .filter({ hasText: "Preferences updated" });
        await expect(success).toHaveCount(1);
        await expect(success).toBeVisible();
        await expect(
          page.getByText("Preferences updated", { exact: true }),
        ).toHaveCount(1);
        await expect(form.getByRole("alert")).toHaveCount(0);
        await expect(save).toBeDisabled();
        expect(acknowledgements).toBe(1);
        const me = await page.request.get("/api/auth/me");
        expect(me.status()).toBe(200);
        expect((await me.json()).user).toMatchObject(selected);
        await page.reload();
        await expect(
          form.getByRole("button", { name: /Date format/ }),
        ).toContainText("Sept 16, 2026");
        await expect(
          form.getByRole("button", { name: /Time format/ }),
        ).toContainText("14:30:45");
        await expect(
          form.getByRole("button", { name: /Time zone/ }),
        ).toContainText("Asia/Kathmandu");
        await expect(form.getByText("Preview", { exact: true })).toHaveCount(0);
        await expect(save).toBeDisabled();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      } finally {
        await context.close();
      }
    });

test("changing date and time preserves an older stored offset time zone", async ({
  page,
}) => {
  await authenticateBrowserFixture(page, fixture);
  const metadata: { schema: string; baseURL: string } = JSON.parse(
    await readFile(
      `tmp/browser-${new URL(fixture.origin).port}-schema.json`,
      "utf8",
    ),
  );
  expect(metadata.schema).toMatch(/^browser_[a-f0-9]{16}$/);
  expect(new URL(metadata.baseURL).origin).toBe(fixture.origin);
  if (!process.env.DATABASE_URL) process.loadEnvFile(".env");
  if (!process.env.DATABASE_URL)
    throw new Error("The browser fixture requires DATABASE_URL");
  const database = postgres(process.env.DATABASE_URL, {
    max: 1,
    transform: postgres.camel,
    connection: { options: `-c search_path=${metadata.schema}` },
  });
  let original:
    { dateFormat: string; timeFormat: string; timeZone: string } | undefined;
  try {
    [original] = await database<
      (typeof original)[]
    >`SELECT date_format,time_format,time_zone FROM users WHERE id=${fixture.identity.user.id}`;
    expect(original).toBeDefined();
    await database`UPDATE users SET date_format='day-short-month-year',time_format='24-hour',time_zone='+05:30' WHERE id=${fixture.identity.user.id}`;
    await page.goto("/settings/preferences");
    const form = page
      .locator("form")
      .filter({ has: page.getByRole("button", { name: /Date format/ }) });
    const zone = form.getByRole("button", { name: /Time zone/ });
    await expect(zone).toContainText("+05:30");
    await form.getByRole("button", { name: /Date format/ }).click();
    await page
      .getByRole("listbox")
      .getByRole("option", { name: "Sept 16, 2026", exact: true })
      .click();
    await form.getByRole("button", { name: /Time format/ }).click();
    await page
      .getByRole("listbox")
      .getByRole("option", { name: "14:30:45", exact: true })
      .click();
    await expect(form.getByText("Preview", { exact: true })).toHaveCount(0);
    await expect(zone).toContainText("+05:30");
    const patch = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === "/api/auth/profile" &&
        request.method() === "PATCH",
    );
    await form.getByRole("button", { name: "Save", exact: true }).click();
    expect((await patch).postDataJSON()).toEqual({
      dateFormat: selected.dateFormat,
      timeFormat: selected.timeFormat,
    });
    const success = page
      .locator('[data-slot="toast"]')
      .filter({ hasText: "Preferences updated" });
    await expect(success).toHaveCount(1);
    await expect(success).toBeVisible();
    await expect(form.getByRole("alert")).toHaveCount(0);
    await expect(
      form.getByRole("button", { name: "Save", exact: true }),
    ).toBeDisabled();
    const me = await page.request.get("/api/auth/me");
    expect(me.status()).toBe(200);
    expect((await me.json()).user).toMatchObject({
      dateFormat: selected.dateFormat,
      timeFormat: selected.timeFormat,
      timeZone: "+05:30",
    });
    await page.reload();
    await expect(zone).toContainText("+05:30");
    await expect(
      form.getByRole("button", { name: /Date format/ }),
    ).toContainText("Sept 16, 2026");
    await expect(
      form.getByRole("button", { name: /Time format/ }),
    ).toContainText("14:30:45");
    await expect(form.getByText("Preview", { exact: true })).toHaveCount(0);
  } finally {
    try {
      if (original)
        await database`UPDATE users SET date_format=${original.dateFormat},time_format=${original.timeFormat},time_zone=${original.timeZone} WHERE id=${fixture.identity.user.id}`;
    } finally {
      await database.end();
    }
  }
});
