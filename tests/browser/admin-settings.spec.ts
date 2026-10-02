import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

// Invitation links must not enter automatic traces or failure screenshots.
test.use({ trace: "off", screenshot: "off" });
test.describe.configure({ mode: "serial" });
const bootstrap = {
  workspaceName: "Mill browser verification",
  name: "Alex Morgan",
  email: "browser-admin@example.test",
  password: "Browser-only-password-42",
};
let origin: string;
let admin: APIRequestContext;
let userId: string;
let memberId: string;
const longPerson = {
  name: "Avery Alexandria Montgomery Wellington with a long display name for responsive People review",
  email:
    "avery.alexandria.montgomery.wellington.responsive.people.verification@example.test",
};
const teammate = {
  email: "people-jordan@example.test",
  name: "Jordan Rivera",
  password: "People-browser-password-42",
};
async function json(
  api: APIRequestContext,
  path: string,
  data?: unknown,
  method = "POST",
) {
  const requestMethod = data === undefined ? "GET" : method;
  const response = await api.fetch(`/api${path}`, {
    method: requestMethod,
    headers: { Origin: origin },
    data,
  });
  expect(response.ok(), `${requestMethod} ${path}: ${response.status()}`).toBe(
    true,
  );
  return response.json();
}
async function login(page: Page, path = "/settings/members") {
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill(bootstrap.email);
  await page.getByLabel("Password", { exact: true }).fill(bootstrap.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Open notifications", exact: true }),
  ).toBeVisible();
  await page.goto(path);
  await expect(
    page.getByRole("heading", {
      name: path.endsWith("workspace") ? "Team settings" : "People",
      exact: true,
      level: 1,
    }),
  ).toBeVisible();
}
async function openSettings(page: Page, section: "People" | "Team settings") {
  const openNavigation = page.getByRole("button", {
    name: "Open navigation",
    exact: true,
  });
  if ((page.viewportSize()?.width ?? 1280) < 1024) {
    const path =
      section === "People" ? "/settings/members" : "/settings/workspace";
    if (new URL(page.url()).pathname !== path) await page.goto(path);
    return;
  }
  if (await openNavigation.isVisible()) await openNavigation.click();
  await page.getByRole("link", { name: section, exact: true }).click();
}
async function database() {
  if (!process.env.DATABASE_URL) process.loadEnvFile(".env");
  const metadata = JSON.parse(
    await readFile(`tmp/browser-${new URL(origin).port}-schema.json`, "utf8"),
  ) as { schema: string; baseURL: string };
  expect(metadata.schema).toMatch(/^browser_[a-f0-9]{16}$/);
  expect(metadata.baseURL).toBe(origin);
  return {
    sql: postgres(process.env.DATABASE_URL!, { max: 1 }),
    schema: metadata.schema,
  };
}
test.beforeAll(async ({ baseURL }) => {
  origin = baseURL!;
  admin = await request.newContext({ baseURL: origin });
  const status = await json(admin, "/auth/status");
  const identity = status.setupRequired
    ? await json(admin, "/auth/setup", bootstrap)
    : await json(admin, "/auth/login", {
        email: bootstrap.email,
        password: bootstrap.password,
      });
  userId = identity.user.id;
});
test.afterAll(async () => {
  await admin?.dispose();
});

test("People lists load independently, show separate recovery and protect the last administrator", async ({
  page,
}) => {
  const avatarRequests = new Set<string>();
  await page.route("https://www.gravatar.com/avatar/**", async (route) => {
    avatarRequests.add(route.request().url());
    await route.fulfill({ status: 404, body: "" });
  });
  await login(page, "/settings/workspace");
  let failMembers = true;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/auth/members", async (route) => {
    if (failMembers)
      return route.fulfill({
        status: 503,
        json: { error: "People are temporarily unavailable." },
      });
    await route.continue();
  });
  await page.route("**/api/auth/invitations", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  await page.getByRole("link", { name: "People", exact: true }).click();
  const members = page.getByRole("region", {
    name: "Workspace members",
    exact: true,
  });
  const invitations = page.getByRole("region", {
    name: "Invitations",
    exact: true,
  });
  try {
    await expect(members.getByRole("alert")).toContainText(
      "People are temporarily unavailable",
    );
    await expect(invitations).toHaveAttribute("aria-busy", "true");
    await expect(invitations.getByText(/Loading invitations/)).toHaveCount(0);
    await expect(
      invitations.getByText("No invitations yet", { exact: true }),
    ).toHaveCount(0);
    await expect(invitations.getByRole("alert")).toHaveCount(0);
    failMembers = false;
    await members.getByRole("button", { name: "Retry people" }).click();
    await expect(
      members.getByRole("grid", { name: "Workspace members", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Workspace members", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Invitations", exact: true }),
    ).toHaveCount(0);
    const avatar = members.getByRole("img", {
      name: bootstrap.name,
      exact: true,
    });
    await expect(avatar).toBeVisible();
    await expect(avatar.getByText("AM", { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        avatar.evaluate((element) => {
          const style = getComputedStyle(element);
          return [style.width, style.height, style.borderRadius];
        }),
      )
      .toEqual(["32px", "32px", "8px"]);
    const gravatar = `https://www.gravatar.com/avatar/${createHash("sha256").update(bootstrap.email.trim().toLowerCase()).digest("hex")}?s=160&d=404&r=g`;
    await expect.poll(() => avatarRequests.has(gravatar)).toBe(true);
    const ownRow = members
      .getByRole("row")
      .filter({ hasText: bootstrap.email });
    await expect(ownRow).toHaveCount(1);
    const adminChip = ownRow
      .locator(".chip")
      .filter({ hasText: /^\s*Admin\s*$/ })
      .filter({ visible: true });
    await expect(adminChip).toHaveCount(1);
    await expect(adminChip.locator("svg")).toHaveCount(1);
    await expect(
      members.getByRole("button", { name: `Edit role for ${bootstrap.name}` }),
    ).toBeDisabled();
    await expect(
      members.getByRole("button", {
        name: `Remove ${bootstrap.name}`,
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      members.getByText("Last administrator", { exact: true }),
    ).toHaveCount(0);
    const protectedRemoval = members.getByRole("group", {
      name: `Removal unavailable for ${bootstrap.name}`,
      exact: true,
    });
    await protectedRemoval.focus();
    await expect(protectedRemoval).toBeFocused();
    await expect(page.getByRole("tooltip")).toContainText(
      "Make another person an administrator before removing access",
    );
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await expect(protectedRemoval).toBeFocused();
    release();
    await expect(
      invitations.getByText("No invitations yet", { exact: true }),
    ).toBeVisible();
  } finally {
    release();
  }
});

test("invitation creation keeps pending, failure, copy and reveal inside its modal, then role changes persist", async ({
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page);
  await page
    .getByRole("button", { name: "Invite a person", exact: true })
    .click();
  let posts = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/auth/invitations", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts++;
    if (posts === 1)
      return route.fulfill({
        status: 503,
        json: { error: "Try creating the invitation again." },
      });
    await gate;
    await route.continue();
  });
  const dialog = page.getByRole("dialog", {
    name: "Invite a person",
    exact: true,
  });
  await dialog.getByLabel("Email", { exact: true }).fill(teammate.email);
  await dialog
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Try creating the invitation again",
  );
  await page.screenshot({
    path: testInfo.outputPath("invite-error.png"),
    animations: "disabled",
  });
  await expect(
    page.getByRole("region", { name: "Workspace members" }).getByRole("alert"),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  try {
    await expect(
      dialog.getByRole("button", { name: "Creating invitation…", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Close dialog", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    expect(posts).toBe(2);
    await page.screenshot({
      path: testInfo.outputPath("invite-pending.png"),
      animations: "disabled",
    });
    release();
    const reveal = page.getByRole("dialog", {
      name: "Invitation created",
      exact: true,
    });
    const inviteUrl = await reveal
      .getByLabel("Invitation link", { exact: true })
      .inputValue();
    await reveal
      .getByRole("button", { name: "Copy invitation link", exact: true })
      .click();
    await expect(
      page.getByText("Invitation link copied.", { exact: true }),
    ).toBeVisible();
    expect(
      (await page.evaluate(() => navigator.clipboard.readText())) === inviteUrl,
      "Clipboard contains the exact invitation link",
    ).toBe(true);
    await reveal.getByRole("button", { name: "Done", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Invite a person", exact: true }),
    ).toBeFocused();
    await expect(
      page.getByLabel("Invitation link", { exact: true }),
    ).toHaveCount(0);
    const temporary = await request.newContext({ baseURL: origin });
    try {
      memberId = (
        await json(temporary, "/auth/accept-invitation", {
          token: new URL(inviteUrl).searchParams.get("token"),
          name: teammate.name,
          password: teammate.password,
        })
      ).user.id;
    } finally {
      await temporary.dispose();
    }
    await page.reload();
    await page
      .getByRole("button", {
        name: `Edit role for ${teammate.name}`,
        exact: true,
      })
      .click();
    const roleDialog = page.getByRole("dialog", {
      name: `Edit role for ${teammate.name}`,
      exact: true,
    });
    await roleDialog
      .getByRole("button", { name: new RegExp(`Role for ${teammate.name}$`) })
      .click();
    await page.getByRole("option", { name: "Viewer", exact: true }).click();
    await roleDialog
      .getByRole("button", { name: "Update role", exact: true })
      .click();
    await expect(roleDialog).toHaveCount(0);
    await expect(
      page.getByText("Role updated.", { exact: true }),
    ).toBeVisible();
    expect(
      (await json(admin, "/auth/members")).items.find(
        (person: { id: string }) => person.id === memberId,
      ).role,
    ).toBe("viewer");
    await expect(
      page
        .getByRole("row")
        .filter({ hasText: teammate.email })
        .getByRole("gridcell", { name: "Viewer", exact: true }),
    ).toBeVisible();
  } finally {
    release();
  }
});

test("team settings persist without backup or portable data surfaces", async ({
  page,
}) => {
  await login(page, "/settings/workspace");
  await expect(
    page.getByRole("link", { name: "Export and import", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Download export", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Choose Mill export", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("textbox", { name: /^Name/ })
    .fill("Admin workspace verification");
  await page.getByRole("button", { name: "Update", exact: true }).click();
  await expect(
    page.getByText("Team settings updated.", { exact: true }),
  ).toBeVisible();
  expect((await json(admin, "/auth/me")).workspace.name).toBe(
    "Admin workspace verification",
  );
  await page.reload();
  await expect(page.getByRole("textbox", { name: /^Name/ })).toHaveValue(
    "Admin workspace verification",
  );
  await page.goto("/settings/data");
  await expect(
    page.getByRole("heading", {
      name: "This page could not be found",
      exact: true,
      level: 1,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Download export", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Choose Mill export", { exact: true }),
  ).toHaveCount(0);
  expect((await admin.get("/api/export")).status()).toBe(404);
  expect(
    (
      await admin.post("/api/import", { headers: { Origin: origin }, data: {} })
    ).status(),
  ).toBe(404);
  await page.goto("/settings/workspace");
  await expect(
    page.getByRole("heading", { name: "Team settings", exact: true, level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("Backups", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "backup and recovery guide", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("main").locator('[data-slot="widget-header"]'),
  ).toHaveCount(0);
});

test("People and team settings layouts remain usable in both themes at desktop and phone widths", async ({
  page,
}, testInfo) => {
  const invite = await json(admin, "/auth/invitations", {
    email: longPerson.email,
    role: "member",
  });
  const temporary = await request.newContext({ baseURL: origin });
  try {
    await json(temporary, "/auth/accept-invitation", {
      token: invite.token,
      name: longPerson.name,
      password: "Responsive-people-password-42",
    });
  } finally {
    await temporary.dispose();
  }
  await json(admin, "/auth/invitations", {
    email:
      "pending.invitation.with.a.long.recipient.address.for.responsive.review@example.test",
    role: "viewer",
  });
  await login(page);
  for (const [width, height, theme] of [
    [1440, 1000, "light"],
    [1440, 1000, "dark"],
    [390, 844, "light"],
    [390, 844, "dark"],
    [429, 926, "light"],
    [429, 926, "dark"],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate(
      (value) => localStorage.setItem("mill:theme", value),
      theme,
    );
    for (const [section, name] of [
      ["People", "people"],
      ["Team settings", "workspace"],
    ] as const) {
      await openSettings(page, section);
      const switcher = page.getByRole("button", {
        name: `Appearance: switch to ${theme} theme`,
      });
      if (await switcher.isVisible()) await switcher.click();
      await expect(
        page.getByRole("heading", {
          name: name === "people" ? "People" : "Team settings",
          exact: true,
          level: 1,
        }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      if (name === "people") {
        expect(
          await page.getByRole("grid").evaluateAll((tables) =>
            tables.every((table) =>
              [
                ...table.querySelectorAll(
                  '[role="rowheader"] span, [role="gridcell"] span, [role="gridcell"] button',
                ),
              ].every((span) => {
                const cell = span.closest(
                  '[role="rowheader"], [role="gridcell"]',
                )!;
                const child = span.getBoundingClientRect();
                const parent = cell.getBoundingClientRect();
                if (child.width === 0 && child.height === 0) return true;
                return (
                  child.right <= parent.right + 1 &&
                  child.left >= parent.left - 1
                );
              }),
            ),
          ),
        ).toBe(true);
        await expect(
          page.getByRole("button", {
            name: `Edit role for ${teammate.name}`,
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", {
            name: `Remove ${teammate.name}`,
            exact: true,
          }),
        ).toBeVisible();
      } else {
        await expect(
          page.getByRole("textbox", { name: /^Name/ }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Update", exact: true }),
        ).toBeVisible();
        await expect(page.getByText("Backups", { exact: true })).toHaveCount(0);
        await expect(
          page.getByRole("link", { name: "Export and import", exact: true }),
        ).toHaveCount(0);
      }
      await page.screenshot({
        path: testInfo.outputPath(`${name}-${width}-${theme}.png`),
        fullPage: false,
        animations: "disabled",
      });
      if (name === "people") {
        await page
          .getByRole("button", { name: "Invite a person", exact: true })
          .click();
        const dialog = page.getByRole("dialog", {
          name: "Invite a person",
          exact: true,
        });
        await expect(dialog.getByLabel("Email", { exact: true })).toBeFocused();
        await dialog
          .getByLabel("Email", { exact: true })
          .fill("review-only@example.test");
        await page.screenshot({
          path: testInfo.outputPath(`invite-${width}-${theme}.png`),
          animations: "disabled",
        });
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
      }
    }
  }
  const touchContext = await page
    .context()
    .browser()!
    .newContext({
      baseURL: origin,
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
  try {
    const touch = await touchContext.newPage();
    await login(touch);
    const touchMedia = await touch.evaluate(() => ({
      coarse: matchMedia("(pointer: coarse)").matches,
      noHover: matchMedia("(hover: none)").matches,
      touchPoints: navigator.maxTouchPoints,
    }));
    expect(touchMedia.coarse).toBe(true);
    expect(touchMedia.noHover).toBe(true);
    expect(touchMedia.touchPoints).toBeGreaterThan(0);
    for (const width of [390, 429]) {
      await touch.setViewportSize({ width, height: 926 });
      for (const theme of ["light", "dark"]) {
        await touch.evaluate(
          (value) => localStorage.setItem("mill:theme", value),
          theme,
        );
        await openSettings(touch, "People");
        const switcher = touch.getByRole("button", {
          name: `Appearance: switch to ${theme} theme`,
          exact: true,
        });
        if (await switcher.isVisible()) await switcher.click();
        expect(
          await touch.evaluate(() => matchMedia("(pointer: coarse)").matches),
        ).toBe(true);
        const members = touch.getByRole("grid", {
          name: "Workspace members",
          exact: true,
        });
        const invitations = touch.getByRole("grid", {
          name: "Workspace invitations",
          exact: true,
        });
        await expect(members.getByRole("columnheader")).toHaveCount(2);
        await expect(invitations.getByRole("columnheader")).toHaveCount(2);
        for (const table of [members, invitations]) {
          const primary = await table
            .getByRole("rowheader")
            .first()
            .boundingBox();
          const actions = await table
            .getByRole("row")
            .nth(1)
            .getByRole("gridcell")
            .last()
            .boundingBox();
          expect(primary!.width).toBeGreaterThanOrEqual(width - 140);
          expect(Math.abs(actions!.width - 80)).toBeLessThanOrEqual(1);
        }
        const protectedRemoval = members.getByRole("group", {
          name: `Removal unavailable for ${bootstrap.name}`,
          exact: true,
        });
        const hintBounds = await protectedRemoval.boundingBox();
        expect(hintBounds!.width).toBeGreaterThanOrEqual(44);
        expect(hintBounds!.height).toBeGreaterThanOrEqual(44);
        await protectedRemoval.click();
        await expect(touch.getByRole("tooltip")).toContainText(
          "Make another person an administrator before removing access",
        );
        await touch.keyboard.press("Escape");
        await expect(touch.getByRole("tooltip")).toHaveCount(0);
        const edit = members.getByRole("button", {
          name: `Edit role for ${longPerson.name}`,
          exact: true,
        });
        await expect(edit).toBeVisible();
        for (const button of await touch
          .getByRole("grid")
          .getByRole("button")
          .all()) {
          const bounds = await button.boundingBox();
          expect(bounds!.width).toBeGreaterThanOrEqual(44);
          expect(bounds!.height).toBeGreaterThanOrEqual(44);
        }
        await edit.focus();
        await expect(edit).toBeFocused();
        await edit.press("Enter");
        const dialog = touch.getByRole("dialog", {
          name: `Edit role for ${longPerson.name}`,
          exact: true,
        });
        await expect(dialog).toBeVisible();
        await touch.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(edit).toBeFocused();
        await edit.press("Enter");
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        await expect(dialog).toHaveCount(0);
        await expect(edit).toBeFocused();
        await edit.press("Space");
        await expect(dialog).toBeVisible();
        await dialog
          .getByRole("button", {
            name: new RegExp(`Role for ${longPerson.name}$`),
          })
          .click();
        await touch
          .getByRole("option", { name: "Viewer", exact: true })
          .click();
        const cancel = dialog.getByRole("button", {
          name: "Cancel",
          exact: true,
        });
        const update = dialog.getByRole("button", {
          name: "Update role",
          exact: true,
        });
        await cancel.focus();
        await cancel.press("Tab");
        await expect(update).toBeFocused();
        await update.press("Shift+Tab");
        await expect(cancel).toBeFocused();
        await cancel.press("Space");
        await expect(dialog).toHaveCount(0);
        await expect(edit).toBeFocused();
        expect(
          await touch.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await touch.screenshot({
          path: testInfo.outputPath(`people-touch-${width}-${theme}.png`),
          fullPage: false,
          animations: "disabled",
        });
      }
    }
    await openSettings(touch, "Team settings");
    await expect(
      touch.getByRole("heading", {
        name: "Team settings",
        exact: true,
        level: 1,
      }),
    ).toBeVisible();
    await expect(
      touch.getByRole("button", { name: "Update", exact: true }),
    ).toBeVisible();
    await expect(
      touch.getByRole("link", {
        name: "backup and recovery guide",
        exact: true,
      }),
    ).toHaveCount(0);
  } finally {
    await touchContext.close();
  }
});

test("invitation pagination reaches and revokes an older active invitation beyond the default page", async ({
  page,
}) => {
  const { sql, schema } = await database();
  const oldId = randomUUID();
  const oldEmail = "older-active@example.test";
  let releaseRemoval: (() => void) | undefined;
  try {
    await sql.unsafe(`SET search_path TO "${schema}",public`);
    await sql`INSERT INTO invitations(id,email,role,token_hash,invited_by,created_at,expires_at) VALUES(${oldId},${oldEmail},'member',${randomUUID()},${userId},now()-interval '1 day',now()+interval '7 days')`;
    const histories = Array.from({ length: 105 }, (_, index) => ({
      id: randomUUID(),
      email: `newer-history-${index}@example.test`,
      role: "viewer",
      token_hash: randomUUID(),
      invited_by: userId,
      created_at: new Date(Date.now() - index * 1000).toISOString(),
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      revoked_at: new Date().toISOString(),
    }));
    await sql`INSERT INTO invitations ${sql(histories)}`;
    await login(page);
    const invitations = page.getByRole("region", {
      name: "Invitations",
      exact: true,
    });
    await expect(invitations.getByText(oldEmail, { exact: true })).toHaveCount(
      0,
    );
    let failedPage = false;
    await page.route("**/api/auth/invitations?cursor=*", async (route) => {
      if (!failedPage) {
        failedPage = true;
        return route.fulfill({
          status: 503,
          json: {
            error: "The next invitation page is temporarily unavailable.",
          },
        });
      }
      await route.continue();
    });
    await invitations
      .getByRole("button", { name: "Load more invitations", exact: true })
      .click();
    await expect(invitations.getByRole("alert")).toContainText(
      "The next invitation page is temporarily unavailable",
    );
    await expect(
      page
        .getByRole("region", { name: "Workspace members", exact: true })
        .getByRole("alert"),
    ).toHaveCount(0);
    await invitations
      .getByRole("button", { name: "Retry invitations", exact: true })
      .click();
    await expect(
      invitations.getByText(oldEmail, { exact: true }),
    ).toBeVisible();
    await invitations
      .getByRole("button", {
        name: `Revoke invitation for ${oldEmail}`,
        exact: true,
      })
      .click();
    const dialog = page.getByRole("dialog", {
      name: `Revoke invitation for ${oldEmail}?`,
      exact: true,
    });
    await dialog
      .getByRole("button", { name: "Revoke invitation", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByText("Invitation revoked.", { exact: true }),
    ).toBeVisible();
    expect(
      (await sql`SELECT revoked_at FROM invitations WHERE id=${oldId}`)[0]
        .revoked_at,
    ).not.toBeNull();
    await expect(
      page.getByRole("button", {
        name: `Account menu for ${bootstrap.name}`,
        exact: true,
      }),
    ).toBeVisible();
    expect(
      memberId === userId,
      "Removal targets a different accepted member",
    ).toBe(false);
    await page
      .getByRole("button", { name: `Remove ${teammate.name}`, exact: true })
      .click();
    const removal = page.getByRole("dialog", {
      name: `Remove ${teammate.name}?`,
      exact: true,
    });
    const removalGate = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    let removalAttempts = 0;
    await page.route(`**/api/auth/members/${memberId}`, async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      removalAttempts++;
      if (removalAttempts === 1) {
        await removalGate;
        return route.fulfill({
          status: 429,
          json: { error: "Too many requests. Try again in a minute." },
        });
      }
      await route.continue();
    });
    await removal
      .getByRole("button", { name: "Remove access", exact: true })
      .click();
    await expect(removal.getByRole("status")).toContainText("Removing access");
    await expect(
      removal.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await expect(
      removal.getByRole("button", { name: "Close dialog", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(removal).toBeVisible();
    releaseRemoval!();
    await expect(removal.getByRole("alert")).toContainText("Too many requests");
    await expect(
      removal.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeEnabled();
    await expect(
      removal.getByRole("button", { name: "Remove access", exact: true }),
    ).toBeEnabled();
    await expect(
      removal.getByRole("button", { name: "Done", exact: true }),
    ).toHaveCount(0);
    const removedResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/auth/members/${memberId}` &&
        response.request().method() === "DELETE",
    );
    await removal
      .getByRole("button", { name: "Remove access", exact: true })
      .click();
    const removed = await removedResponse;
    const acknowledgement = await removed.json();
    expect(
      removed.status(),
      `Member removal: ${acknowledgement.error ?? "response received"}`,
    ).toBe(200);
    expect(acknowledgement.ok).toBe(true);
    expect(removalAttempts).toBe(2);
    await expect(removal).toHaveCount(0);
    await expect(
      page.getByText("Workspace access removed.", { exact: true }),
    ).toBeVisible();
    const inviteAction = page.getByRole("button", {
      name: "Invite a person",
      exact: true,
    });
    const focusState = await inviteAction.evaluate((element) => ({
      active: document.activeElement?.outerHTML.slice(0, 500),
      connected: element.isConnected,
      disabled: element.hasAttribute("disabled"),
      ariaDisabled: element.getAttribute("aria-disabled"),
      visibility: getComputedStyle(element).visibility,
      inertAncestor: Boolean(element.closest("[inert]")),
    }));
    await expect(inviteAction, JSON.stringify(focusState)).toBeFocused();
    expect(
      (await json(admin, "/auth/members")).items.some(
        (person: { id: string }) => person.id === memberId,
      ),
    ).toBe(false);
  } finally {
    releaseRemoval?.();
    await sql.end();
  }
});
