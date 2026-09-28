import { randomUUID } from "node:crypto";
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
let portable: Record<string, unknown>;
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
  const response = await api.fetch(`/api${path}`, {
    method: data === undefined ? "GET" : method,
    headers: { Origin: origin },
    data,
  });
  expect(response.ok(), `${method} ${path}: ${response.status()}`).toBe(true);
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
      name: path.endsWith("data") ? "Export and import" : "People",
      exact: true,
    }),
  ).toBeVisible();
}
function file(payload: unknown, name = "mill-portable.json") {
  return {
    name,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(payload)),
  };
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
  const board = (
    await json(admin, "/boards", {
      name: "People and data verification",
      prefix: "PDV",
    })
  ).board;
  const detail = await json(admin, `/boards/${board.id}`);
  const task = (
    await json(admin, `/boards/${board.id}/tasks`, {
      title: "Keep portable relationships",
      columnId: detail.columns[0].id,
      dueDate: "2027-01-02",
      checklist: [
        { id: randomUUID(), text: "Verify import counts", done: false },
      ],
    })
  ).task;
  await json(admin, `/tasks/${task.id}/comments`, {
    body: "A portable comment",
  });
  portable = await json(admin, "/export");
});
test.afterAll(async () => {
  await admin?.dispose();
});

test("People lists load independently, show separate recovery and protect the last administrator", async ({
  page,
}) => {
  await login(page, "/settings/data");
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
    await expect(
      invitations
        .getByRole("status")
        .filter({ hasText: "Loading invitations" }),
    ).toContainText("Loading invitations");
    await expect(invitations.getByRole("alert")).toHaveCount(0);
    failMembers = false;
    await members.getByRole("button", { name: "Retry people" }).click();
    await expect(
      members.getByRole("grid", { name: "Workspace members", exact: true }),
    ).toBeVisible();
    await expect(
      members.getByRole("button", { name: `Edit role for ${bootstrap.name}` }),
    ).toBeDisabled();
    await expect(
      members.getByRole("button", {
        name: `Remove ${bootstrap.name}`,
        exact: true,
      }),
    ).toBeDisabled();
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
    await expect(reveal.getByRole("status")).toContainText(
      "Invitation link copied",
    );
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      inviteUrl,
    );
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
    await expect(roleDialog.getByRole("status")).toContainText("Role updated");
    await roleDialog.getByRole("button", { name: "Done", exact: true }).click();
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

test("export downloads real portable data and import validates the file before confirmation with local retry and persisted counts", async ({
  page,
}, testInfo) => {
  await login(page, "/settings/data");
  const exported = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download export", exact: true })
    .click();
  const download = await exported;
  const payload = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(payload.format).toBe("mill-portable");
  expect(payload.version).toBe(2);
  expect(JSON.stringify(payload)).not.toMatch(
    /password_hash|token_hash|encrypted_secret/,
  );
  expect(
    payload.tasks.some(
      (task: { dueDate: string }) => task.dueDate === "2027-01-02",
    ),
  ).toBe(true);
  await expect(
    page.getByRole("region", { name: "Workspace export" }).getByRole("status"),
  ).toContainText("Workspace export downloaded");
  const input = page.getByLabel("Choose Mill export", { exact: true });
  await input.setInputFiles({
    name: "broken.json",
    mimeType: "application/json",
    buffer: Buffer.from("{broken"),
  });
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByText("This file is not valid JSON. Choose a Mill export file.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Import", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await input.setInputFiles(file({ format: "other" }, "wrong-format.json"));
  await expect(
    page.getByText("Choose a Mill export file in version 1 or 2 format.", {
      exact: true,
    }),
  ).toBeVisible();
  await input.setInputFiles(file(portable, "same-file.json"));
  await expect(
    page.getByRole("button", { name: "Import", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Import", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Import workspace data?",
    exact: true,
  });
  await expect(
    dialog.getByText("same-file.json", { exact: true }),
  ).toBeVisible();
  let attempts = 0;
  const keys: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/import", async (route) => {
    attempts++;
    keys.push(route.request().headers()["idempotency-key"]);
    if (attempts === 1)
      return route.fulfill({
        status: 503,
        json: { error: "Import is temporarily unavailable." },
      });
    if (attempts === 2) {
      await gate;
      const committed = await route.fetch();
      expect(committed.ok()).toBe(true);
      return route.fulfill({ status: 200, json: {} });
    }
    await route.continue();
  });
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Import is temporarily unavailable",
  );
  await page.screenshot({
    path: testInfo.outputPath("import-error.png"),
    animations: "disabled",
  });
  await expect(
    page
      .getByRole("region", { name: "Import workspace data" })
      .getByRole("alert"),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Retry import", exact: true })
    .click();
  try {
    await expect(
      dialog.getByRole("button", { name: "Importing…", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Close dialog", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    expect(attempts).toBe(2);
    await page.screenshot({
      path: testInfo.outputPath("import-pending.png"),
      animations: "disabled",
    });
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    release();
    await expect(dialog.getByRole("alert")).toContainText(
      "The server response",
    );
    await page.screenshot({
      path: testInfo.outputPath("import-malformed-response.png"),
      animations: "disabled",
    });
    await expect(
      dialog.getByText("same-file.json", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "Import completed", exact: true }),
    ).toHaveCount(0);
    await dialog
      .getByRole("button", { name: "Retry import", exact: true })
      .click();
    const completed = page.getByRole("dialog", {
      name: "Import completed",
      exact: true,
    });
    await expect(completed.getByRole("status")).toContainText(
      "Import completed",
    );
    for (const label of ["Boards", "Tasks", "Comments", "Member records"])
      await expect(completed.getByText(label, { exact: true })).toBeVisible();
    await expect(
      completed.getByText("same-file.json", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("import-success.png"),
      animations: "disabled",
    });
    expect(attempts).toBe(3);
    expect(keys).toEqual([keys[0], keys[0], keys[0]]);
    const after = await json(admin, "/export");
    expect(after.boards).toHaveLength(
      (portable.boards as unknown[]).length * 2,
    );
    expect(after.tasks).toHaveLength((portable.tasks as unknown[]).length * 2);
    expect(after.comments).toHaveLength(
      (portable.comments as unknown[]).length * 2,
    );
    await completed.getByRole("button", { name: "Done", exact: true }).click();
    await input.setInputFiles(file(portable, "same-file.json"));
    await expect(
      page.getByRole("button", { name: "Import", exact: true }),
    ).toBeEnabled();
  } finally {
    release();
  }
});

test("People and data layouts remain usable in both themes at desktop and phone widths", async ({
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
    for (const [path, name] of [
      ["/settings/members", "people"],
      ["/settings/data", "data"],
    ] as const) {
      await page.goto(path);
      const switcher = page.getByRole("button", {
        name: `Appearance: switch to ${theme} theme`,
      });
      if (await switcher.isVisible()) await switcher.click();
      await expect(
        page.getByRole("heading", {
          name: name === "people" ? "People" : "Export and import",
          exact: true,
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
        await page
          .getByLabel("Choose Mill export", { exact: true })
          .setInputFiles(file(portable, "review.json"));
        await expect(
          page.getByText("review.json", { exact: true }),
        ).toBeVisible();
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
      } else {
        await page.getByRole("button", { name: "Import", exact: true }).click();
        const dialog = page.getByRole("dialog", {
          name: "Import workspace data?",
          exact: true,
        });
        await expect(
          dialog.getByRole("button", { name: "Import", exact: true }),
        ).toBeVisible();
        await page.screenshot({
          path: testInfo.outputPath(`import-${width}-${theme}.png`),
          animations: "disabled",
        });
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
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
    expect(
      await touch.evaluate(() => matchMedia("(pointer: coarse)").matches),
    ).toBe(true);
    for (const width of [390, 429]) {
      await touch.setViewportSize({ width, height: 926 });
      for (const theme of ["light", "dark"]) {
        await touch.evaluate(
          (value) => localStorage.setItem("mill:theme", value),
          theme,
        );
        await touch.goto("/settings/members");
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
    await touch.goto("/settings/data");
    const opened = touch.waitForEvent("popup");
    await touch
      .getByRole("link", { name: "backup and recovery guide", exact: true })
      .click();
    const guide = await opened;
    await guide.waitForLoadState("domcontentloaded");
    expect(new URL(guide.url()).pathname).toBe("/guides/backup.html");
    await expect(
      guide.getByRole("heading", { name: "Backup and recovery", exact: true }),
    ).toBeVisible();
    await guide.close();
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
    await expect(dialog.getByRole("status")).toContainText(
      "Invitation revoked",
    );
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    expect(
      (await sql`SELECT revoked_at FROM invitations WHERE id=${oldId}`)[0]
        .revoked_at,
    ).not.toBeNull();
    await page
      .getByRole("button", { name: `Remove ${teammate.name}`, exact: true })
      .click();
    const removal = page.getByRole("dialog", {
      name: `Remove ${teammate.name}?`,
      exact: true,
    });
    await removal
      .getByRole("button", { name: "Remove access", exact: true })
      .click();
    await expect(removal.getByRole("status")).toContainText(
      "Workspace access removed",
    );
    await removal.getByRole("button", { name: "Done", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Invite a person", exact: true }),
    ).toBeFocused();
    expect(
      (await json(admin, "/auth/members")).items.some(
        (person: { id: string }) => person.id === memberId,
      ),
    ).toBe(false);
  } finally {
    await sql.end();
  }
});
