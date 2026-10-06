import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  authenticateBrowserFixture,
  getBrowserBootstrap,
  type BrowserFixtureSession,
} from "../browser-fixture.js";

// Private invitation links must not enter automatic failure artifacts.
test.use({ trace: "off", screenshot: "off" });
let fixture: BrowserFixtureSession;
test.beforeAll(async ({ baseURL }) => {
  const bootstrap = await getBrowserBootstrap(baseURL!);
  fixture = bootstrap;
  await bootstrap.api.dispose();
});

function alerts(page: Page) {
  return page.locator(
    '[data-slot="toast"]:not([data-exiting="true"]):not([data-hidden="true"])',
  );
}

async function openInvitation(page: Page) {
  await authenticateBrowserFixture(page, fixture);
  await page.goto("/settings/members");
  await page
    .getByRole("button", { name: "Invite a person", exact: true })
    .click();
  const form = page.getByRole("dialog", {
    name: "Create invitation",
    exact: true,
  });
  await form
    .getByLabel("Email", { exact: true })
    .fill("invitation-delivery@example.test");
  return form;
}

for (const [width, theme, emailDelivery] of [
  [1280, "light", "queued"],
  [1280, "dark", "unavailable"],
  [390, "light", "unavailable"],
  [390, "dark", "queued"],
] as const) {
  test(`invitation ${emailDelivery} acknowledgement keeps truthful copy at ${width}px in ${theme}`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(
      (value) => localStorage.setItem("avgeek-oss-ui-theme", value),
      theme,
    );
    const inviteUrl = `${baseURL}/invite?token=${randomBytes(32).toString("base64url")}`;
    let posts = 0;
    // Exercise the UI acknowledgement states independently of runner SMTP configuration.
    await page.route("**/api/auth/invitations", (route) => {
      if (route.request().method() !== "POST") return route.continue();
      posts++;
      expect(route.request().postDataJSON()).toEqual({
        email: "invitation-delivery@example.test",
        role: "member",
      });
      return route.fulfill({ status: 201, json: { inviteUrl, emailDelivery } });
    });
    const form = await openInvitation(page);
    await form
      .getByRole("button", { name: "Create invitation", exact: true })
      .click();
    const result = page.getByRole("dialog", {
      name: "Invitation link",
      exact: true,
    });
    await expect(result).toBeVisible();
    await expect(
      result.locator('[data-slot="code-block-code"] code'),
    ).toHaveText(inviteUrl);
    const message =
      emailDelivery === "queued"
        ? "Invitation created and email queued."
        : "Invitation created.";
    await expect(alerts(page)).toHaveCount(1);
    await expect(alerts(page)).toContainText(message);
    await expect(result.getByText(message, { exact: true })).toHaveCount(0);
    await expect(result.getByRole("alert")).toHaveCount(0);
    await expect(
      result.getByText(
        emailDelivery === "queued"
          ? "The invitation email is queued. You can also copy the link to share it directly. The invitation expires after seven days."
          : "Email delivery is not configured. Copy the link to share it directly. The invitation expires after seven days.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(result.getByText(/email sent|email delivered/i)).toHaveCount(
      0,
    );
    if (emailDelivery === "queued")
      await expect(
        result.getByText(/Email delivery is not configured/),
      ).toHaveCount(0);
    await expect(
      result.getByRole("button", {
        name: "Copy invitation link",
        exact: true,
      }),
    ).toBeEnabled();
    await expect(
      result.getByRole("button", { name: "Done", exact: true }),
    ).toBeFocused();
    expect(posts).toBe(1);
    await result.getByRole("button", { name: "Done", exact: true }).click();
    await expect(result).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Invite a person", exact: true }),
    ).toBeFocused();
  });
}

test("incomplete invitation acknowledgements retain the draft and never claim creation", async ({
  page,
  baseURL,
}) => {
  const inviteUrl = `${baseURL}/invite?token=${randomBytes(32).toString("base64url")}`;
  const invalid = [
    { inviteUrl, emailDelivery: "sent" },
    { inviteUrl: "", emailDelivery: "queued" },
    { emailDelivery: "unavailable" },
    { inviteUrl, emailDelivery: "queued", error: "Invitation unavailable" },
  ];
  let posts = 0;
  await page.route("**/api/auth/invitations", (route) => {
    if (route.request().method() !== "POST") return route.continue();
    return route.fulfill({ status: 201, json: invalid[posts++] });
  });
  const form = await openInvitation(page);
  for (let attempt = 0; attempt < invalid.length; attempt++) {
    await form
      .getByRole("button", { name: "Create invitation", exact: true })
      .click();
    await expect(alerts(page)).toHaveCount(1);
    await expect(alerts(page)).toContainText(
      "The server response was incomplete. Try again.",
    );
    await expect(alerts(page)).not.toContainText("Invitation created");
    await expect(form).toBeVisible();
    await expect(form.getByLabel("Email", { exact: true })).toHaveValue(
      "invitation-delivery@example.test",
    );
    await expect(form.getByRole("alert")).toHaveCount(0);
    await expect(
      page.getByRole("dialog", { name: "Invitation link", exact: true }),
    ).toHaveCount(0);
    expect(posts).toBe(attempt + 1);
    await alerts(page).locator('[data-slot="toast-close"]').click();
    await expect(alerts(page)).toHaveCount(0);
  }
});
