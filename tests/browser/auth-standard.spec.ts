import { expect, test } from "@playwright/test";
import { browserBootstrap } from "../browser-fixture.js";

test.describe.configure({ mode: "serial" });

test("team setup retains both steps, validates before one final mutation, and persists preferences", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Set up your team" }),
  ).toBeVisible();
  const submissions: unknown[] = [];
  await page.route("**/api/auth/setup", async (route) => {
    submissions.push(route.request().postDataJSON());
    if (submissions.length === 1)
      await route.fulfill({
        status: 503,
        json: { error: "Setup could not finish. Try again." },
      });
    else await route.continue();
  });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.locator('[data-slot="toast"]:not([data-exiting="true"])'),
  ).toHaveCount(1);
  expect(submissions).toHaveLength(0);
  await page
    .getByLabel("Team name", { exact: true })
    .fill(browserBootstrap.workspaceName);
  await page
    .getByLabel("Your Name", { exact: true })
    .fill(browserBootstrap.name);
  await page.getByLabel("Email", { exact: true }).fill(browserBootstrap.email);
  await page
    .getByLabel("Password", { exact: true })
    .fill(browserBootstrap.password);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Set your preferences" }),
  ).toBeVisible();
  expect(submissions).toHaveLength(0);
  await page.getByRole("button", { name: "← Back", exact: true }).click();
  await expect(page.getByLabel("Team name", { exact: true })).toHaveValue(
    browserBootstrap.workspaceName,
  );
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue(
    browserBootstrap.password,
  );
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByRole("button", { name: "Complete Setup", exact: true })
    .click();
  await expect(
    page
      .locator('[data-slot="toast"]')
      .filter({ hasText: "Setup could not finish. Try again." }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Set your preferences" }),
  ).toBeVisible();
  expect(submissions).toHaveLength(1);
  await page
    .getByRole("button", { name: "Complete Setup", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Boards", exact: true }),
  ).toBeVisible();
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toEqual(submissions[0]);
  const session = await (await page.request.get("/api/auth/me")).json();
  expect(session.user.dateFormat).toBe("day-short-month-year");
  expect(session.user.timeFormat).toBe("24-hour");
  expect(session.user.timeZone).toBeTruthy();
});

for (const [width, theme] of [
  [1280, "light"],
  [390, "dark"],
] as const) {
  test(`sign-in retains pending credentials, clears completed passwords, and reports each failure once at ${width} ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(
      (value) => localStorage.setItem("avgeek-oss-ui-theme", value),
      theme,
    );
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(
      page.getByRole("heading", { name: "Sign in", exact: true }),
    ).toBeVisible();
    let loginAttempts = 0;
    let releaseLogin = () => {};
    let loginEntered = () => {};
    const loginPending = new Promise<void>((resolve) => {
      releaseLogin = resolve;
    });
    const loginStarted = new Promise<void>((resolve) => {
      loginEntered = resolve;
    });
    await page.route("**/api/auth/login", async (route) => {
      loginAttempts++;
      if (loginAttempts === 1) {
        loginEntered();
        await loginPending;
      }
      await route.continue();
    });
    await page
      .getByLabel("Email", { exact: true })
      .fill(browserBootstrap.email);
    await page
      .getByLabel("Password", { exact: true })
      .fill("Incorrect password");
    const failure = page.locator(
      '[data-slot="toast"]:not([data-exiting="true"])',
    );
    try {
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await loginStarted;
      await expect(page.getByLabel("Email", { exact: true })).toHaveValue(
        browserBootstrap.email,
      );
      await expect(page.getByLabel("Password", { exact: true })).toHaveValue(
        "Incorrect password",
      );
      await expect(page.getByLabel("Password", { exact: true })).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Signing in…", exact: true }),
      ).toBeDisabled();
      await expect(failure).toHaveCount(0);
      expect(loginAttempts).toBe(1);
    } finally {
      releaseLogin();
    }
    await expect(failure).toHaveCount(1);
    await expect(failure).toContainText("incorrect");
    await expect(page.getByLabel("Email", { exact: true })).toHaveValue(
      browserBootstrap.email,
    );
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
    await failure.getByRole("button").click();
    await page
      .getByLabel("Password", { exact: true })
      .fill("Incorrect password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(failure).toHaveCount(1);
    await expect(failure).toContainText("incorrect");
    await expect(page.getByLabel("Email", { exact: true })).toHaveValue(
      browserBootstrap.email,
    );
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
    expect(loginAttempts).toBe(2);
    await expect(page.locator('form [role="alert"]')).toHaveCount(0);
    await failure.getByRole("button").click();
    await expect(failure).toHaveCount(0);
    await page
      .getByRole("button", { name: "Forgot password?", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Reset your password" }),
    ).toBeVisible();
    await expect(page.getByLabel("Email", { exact: true })).toHaveValue(
      browserBootstrap.email,
    );
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(failure).toHaveCount(1);
    await expect(failure).toContainText("Email delivery is not configured");
    await expect(page.getByLabel("Email", { exact: true })).toHaveValue(
      browserBootstrap.email,
    );
    await expect(
      page.getByRole("heading", { name: "Reset your password" }),
    ).toBeVisible();
    await failure.getByRole("button").click();
    await page
      .getByRole("button", { name: "← Back to Sign In", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Email", { exact: true })).toHaveValue(
      browserBootstrap.email,
    );
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  });
}

for (const path of ["/login", "/login?source=preview#sign-in"]) {
  test(`successful password sign-in leaves ${path} for boards`, async ({
    page,
  }) => {
    await page.goto(path);
    await page
      .getByLabel("Email", { exact: true })
      .fill(browserBootstrap.email);
    await page
      .getByLabel("Password", { exact: true })
      .fill(browserBootstrap.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Boards", exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(
      new URL(
        "/boards",
        process.env.MILL_BROWSER_BASE_URL ?? "http://localhost:4323",
      ).href,
    );
    await expect(
      page.getByRole("heading", { name: "Page not found", exact: true }),
    ).toHaveCount(0);
    await page.goto(path);
    await expect(
      page.getByRole("heading", { name: "Boards", exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(
      new URL(
        "/boards",
        process.env.MILL_BROWSER_BASE_URL ?? "http://localhost:4323",
      ).href,
    );
    await page.evaluate(
      (loginPath) =>
        window.history.replaceState(window.history.state, "", loginPath),
      path,
    );
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Boards", exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(
      new URL(
        "/boards",
        process.env.MILL_BROWSER_BASE_URL ?? "http://localhost:4323",
      ).href,
    );
  });
}

test("sign-in retains a protected deep link through session expiry", async ({
  page,
}) => {
  const origin = process.env.MILL_BROWSER_BASE_URL ?? "http://localhost:4323";
  const path = "/settings/profile?source=preview#details";
  const signIn = async () => {
    await page
      .getByLabel("Email", { exact: true })
      .fill(browserBootstrap.email);
    await page
      .getByLabel("Password", { exact: true })
      .fill(browserBootstrap.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Profile", exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(new URL(path, origin).href);
  };
  await page.goto(path);
  await signIn();
  await page
    .getByLabel("Your Name", { exact: true })
    .fill("Retained profile draft");
  const logout = await page.request.post("/api/auth/logout", {
    headers: { Origin: origin },
    data: {},
  });
  expect(logout.ok()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("mill:expired")));
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(new URL(path, origin).href);
  await signIn();
  await expect(page.getByLabel("Your Name", { exact: true })).toHaveValue(
    "Retained profile draft",
  );
});
