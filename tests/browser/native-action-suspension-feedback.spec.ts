import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  authenticateBrowserFixture,
  browserBootstrap,
  getBrowserBootstrap,
} from "../browser-fixture.js";

// Credential and invitation responses must not enter traces or screenshots.
test.use({ trace: "off", screenshot: "off" });
test.describe.configure({ mode: "serial" });

function alerts(page: Page) {
  return page.locator('[data-slot="toast"]:not([data-exiting="true"])');
}
async function clearAlerts(page: Page) {
  while (await alerts(page).count()) {
    const count = await alerts(page).count();
    await page
      .locator(
        '[data-slot="toast"][data-frontmost="true"]:not([data-exiting="true"])',
      )
      .locator('[data-slot="toast-close"]')
      .click();
    await expect(alerts(page)).toHaveCount(count - 1);
  }
}

type HeldAction = {
  calls: number;
  reads: number;
  release: () => void;
};
const operations = [
  "create-key",
  "revoke-key",
  "invite",
  "role",
  "remove",
  "revoke-invitation",
] as const;
for (const [index, operation] of operations.entries()) {
  test(`native ${operation} ignores a successful response from the expired overlay`, async ({
    page,
    baseURL,
  }) => {
    const fixture = await getBrowserBootstrap(baseURL!);
    const width = index % 2 ? 390 : 1280;
    const theme = index % 2 ? "dark" : "light";
    await page.setViewportSize({ width, height: 844 });
    const id = randomUUID();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
    const member = {
      id,
      name: "Overlay lifecycle teammate",
      email: "overlay-lifecycle@example.test",
      role: "member",
      createdAt: now,
      timeZone: "UTC",
      passkeyEnabled: false,
    };
    const invitation = {
      id,
      email: "overlay-invitation@example.test",
      role: "member",
      createdAt: now,
      expiresAt,
      acceptedAt: null,
      revokedAt: null,
    };
    const credential = {
      id,
      name: "Overlay lifecycle key",
      scopes: [],
      boardIds: null,
      tokenType: "api-key",
      userId: fixture.identity.user.id,
      createdBy: fixture.identity.user.id,
      accessLevel: "read",
      includeAdmin: false,
      tokenPrefix: "redacted",
      createdAt: now,
      expiresAt,
      lastUsedAt: null,
      revokedAt: null,
    };
    const keyOperation = operation.endsWith("key");
    const path = keyOperation ? "/settings/api-keys" : "/team-settings/members";
    const heading = keyOperation ? "API Keys" : "Members";
    const requestPath =
      operation === "create-key"
        ? "/api/credentials"
        : operation === "revoke-key"
          ? `/api/credentials/${id}`
          : operation === "invite"
            ? "/api/auth/invitations"
            : operation === "revoke-invitation"
              ? `/api/auth/invitations/${id}`
              : `/api/auth/members/${id}`;
    const method =
      operation === "role"
        ? "PATCH"
        : operation === "create-key" || operation === "invite"
          ? "POST"
          : "DELETE";
    const response =
      operation === "create-key"
        ? {
            credential: { ...credential, name: "Retained key draft" },
            token: `mill_${"X".repeat(43)}`,
          }
        : operation === "revoke-key"
          ? { revoked: true }
          : operation === "invite"
            ? {
                inviteUrl: `${baseURL}/invite?token=fixture-private-link`,
                emailDelivery: "unavailable",
              }
            : { ok: true };
    try {
      await page.addInitScript(
        ({ appearance, target, requestMethod, acknowledgement }) => {
          localStorage.setItem("avgeek-oss-ui-theme", appearance);
          const state: HeldAction = { calls: 0, reads: 0, release: () => {} };
          Object.defineProperty(window, "heldNativeAction", { value: state });
          const nativeFetch = window.fetch.bind(window);
          window.fetch = async (...args: Parameters<typeof fetch>) => {
            const [input, options] = args;
            const url =
              typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.href
                  : input.url;
            const pathname = new URL(url, location.origin).pathname;
            if (options?.method === requestMethod && pathname === target) {
              state.calls++;
              if (state.calls > 1) return Response.json(acknowledgement);
              return new Promise<Response>((resolve) => {
                state.release = () => resolve(Response.json(acknowledgement));
              });
            }
            if (
              [
                "/api/credentials",
                "/api/auth/members",
                "/api/auth/invitations",
                "/api/auth/me",
              ].includes(pathname) &&
              (!options?.method || options.method === "GET")
            )
              state.reads++;
            return nativeFetch(...args);
          };
        },
        {
          appearance: theme,
          target: requestPath,
          requestMethod: method,
          acknowledgement: response,
        },
      );
      for (const [endpoint, items] of [
        ["credentials", operation === "create-key" ? [] : [credential]],
        ["auth/members", [fixture.identity.user, member]],
        ["auth/invitations", [invitation]],
      ] as const) {
        await page.route(`**/api/${endpoint}`, (route) =>
          route.request().method() === "GET"
            ? route.fulfill({
                json: { items, hasMore: false, nextCursor: null },
              })
            : route.continue(),
        );
      }
      await authenticateBrowserFixture(page, fixture);
      await page.goto(path);
      await expect(
        page.getByRole("heading", { name: heading, exact: true }),
      ).toBeVisible();
      let dialogTitle: string;
      let submit: string;
      if (operation === "create-key") {
        await page
          .getByRole("button", { name: "Create API key", exact: true })
          .click();
        dialogTitle = "Create API key";
        submit = "Create key";
        await page
          .getByRole("dialog", { name: dialogTitle, exact: true })
          .getByLabel("Name", { exact: true })
          .fill("Retained key draft");
        await page.getByRole("button", { name: /Permissions\*$/ }).click();
        await page
          .getByRole("option", { name: "Read-only", exact: true })
          .click();
        await page.getByRole("button", { name: /Expires after\*$/ }).click();
        await page
          .getByRole("option", { name: "30 days", exact: true })
          .click();
      } else if (operation === "revoke-key") {
        await page
          .getByRole("row")
          .filter({ hasText: credential.name })
          .getByRole("button", { name: "Revoke", exact: true })
          .click();
        dialogTitle = `Revoke ${credential.name}?`;
        submit = "Revoke key";
      } else if (operation === "invite") {
        await page
          .getByRole("button", { name: "Create invitation", exact: true })
          .click();
        dialogTitle = "Create invitation";
        submit = "Create invitation";
        await page
          .getByRole("dialog", { name: dialogTitle, exact: true })
          .getByLabel("Email", { exact: true })
          .fill("retained-invitation@example.test");
      } else if (operation === "role") {
        await page
          .getByRole("button", {
            name: `Edit role for ${member.name}`,
            exact: true,
          })
          .click();
        dialogTitle = `Edit role for ${member.name}`;
        submit = "Update";
        await page
          .getByRole("dialog", { name: dialogTitle, exact: true })
          .getByRole("button", { name: /Role\*$/ })
          .click();
        await page.getByRole("option", { name: /^Viewer\b/ }).click();
      } else if (operation === "remove") {
        await page
          .getByRole("button", { name: `Remove ${member.name}`, exact: true })
          .click();
        dialogTitle = `Remove ${member.name}?`;
        submit = "Remove member";
      } else {
        await page
          .getByRole("button", {
            name: `Revoke invitation for ${invitation.email}`,
            exact: true,
          })
          .click();
        dialogTitle = "Revoke invitation?";
        submit = "Revoke invitation";
      }
      const dialog = page.getByRole("dialog", {
        name: dialogTitle,
        exact: true,
      });
      await dialog.getByRole("button", { name: submit, exact: true }).click();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { heldNativeAction: HeldAction })
                .heldNativeAction.calls,
          ),
        )
        .toBe(1);
      const logout = await page.request.post("/api/auth/logout", {
        headers: { Origin: fixture.origin },
        data: {},
      });
      expect(logout.ok()).toBe(true);
      await page.evaluate(() =>
        window.dispatchEvent(new Event("mill:expired")),
      );
      await expect(
        page.getByRole("heading", { name: "Sign in", exact: true }),
      ).toBeVisible();
      await expect(dialog).toHaveCount(0);
      await expect(alerts(page)).toHaveCount(1);
      await expect(alerts(page)).toContainText(
        "Your session expired. Sign in again to continue.",
      );
      await clearAlerts(page);
      await page
        .getByLabel("Email", { exact: true })
        .fill(browserBootstrap.email);
      await page
        .getByLabel("Password", { exact: true })
        .fill(browserBootstrap.password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: heading, exact: true }),
      ).toBeVisible();
      await expect(dialog).toBeVisible();
      const readsBeforeRelease = await page.evaluate(
        () =>
          (window as unknown as { heldNativeAction: HeldAction })
            .heldNativeAction.reads,
      );
      await page.evaluate(async () => {
        (
          window as unknown as { heldNativeAction: HeldAction }
        ).heldNativeAction.release();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: submit, exact: true }),
      ).toBeEnabled();
      await expect(alerts(page)).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(
        page.getByRole("dialog", { name: "Copy your API key", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("dialog", { name: "Invitation link", exact: true }),
      ).toHaveCount(0);
      if (operation === "create-key")
        await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(
          "Retained key draft",
        );
      if (operation === "invite")
        await expect(dialog.getByLabel("Email", { exact: true })).toHaveValue(
          "retained-invitation@example.test",
        );
      if (operation === "role")
        await expect(
          dialog.getByRole("button", { name: /Role\*$/ }),
        ).toContainText("Viewer");
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { heldNativeAction: HeldAction })
              .heldNativeAction.reads,
        ),
      ).toBe(readsBeforeRelease);
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { heldNativeAction: HeldAction })
              .heldNativeAction.calls,
        ),
      ).toBe(1);
      await dialog.getByRole("button", { name: submit, exact: true }).click();
      const success = {
        "create-key": "API key created.",
        "revoke-key": "Access revoked.",
        invite: "Invitation created.",
        role: "Role updated.",
        remove: "Workspace access removed.",
        "revoke-invitation": "Invitation revoked.",
      }[operation];
      await expect(alerts(page)).toHaveCount(1);
      await expect(alerts(page)).toContainText(success);
      await expect(dialog.getByText(success, { exact: true })).toHaveCount(0);
      if (operation === "create-key")
        await expect(
          page.getByRole("dialog", { name: "Copy your API key", exact: true }),
        ).toBeVisible();
      else if (operation === "invite")
        await expect(
          page.getByRole("dialog", { name: "Invitation link", exact: true }),
        ).toBeVisible();
      else await expect(dialog).toHaveCount(0);
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { heldNativeAction: HeldAction })
              .heldNativeAction.calls,
        ),
      ).toBe(2);
    } finally {
      await fixture.api.dispose();
    }
  });
}
