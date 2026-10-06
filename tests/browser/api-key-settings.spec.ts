import { readFile, writeFile } from "node:fs/promises";
import postgres from "postgres";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type Locator,
} from "@playwright/test";
import {
  authenticateBrowserFixture,
  getBrowserBootstrap,
  getBrowserRoleFixture,
} from "../browser-fixture.js";

function feedbackToast(page: Page, message: string) {
  return page
    .locator(
      '[data-slot="toast"]:not([data-exiting="true"]):not([data-hidden="true"])',
    )
    .filter({ hasText: message })
    .last();
}

// Credential responses and reveal dialogs must never enter traces or screenshots.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
test.use({ trace: "off", screenshot: "off" });
test.describe.configure({ mode: "serial" });
let origin: string;
let admin: APIRequestContext;
let board: { id: string; name: string };
let scenarioOwner: { id: string; baseline: string[] } | null = null;
async function expectTheme(page: Page, theme: "light" | "dark") {
  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-theme", theme);
  if (theme === "dark") await expect(root).toHaveClass(/\bdark\b/);
  else await expect(root).not.toHaveClass(/\bdark\b/);
}
async function measureRevokeBounds(button: Locator) {
  return button.evaluate((element) => {
    const container = element.closest("table")?.parentElement;
    if (!container) throw new Error("API key table scroll container missing");
    const action = element.getBoundingClientRect();
    const visibleArea = container.getBoundingClientRect();
    return {
      actionLeft: action.left,
      actionRight: action.right,
      containerLeft: visibleArea.left,
      containerRight: visibleArea.right,
      clientWidth: container.clientWidth,
      scrollWidth: container.scrollWidth,
      overflowX: getComputedStyle(container).overflowX,
    };
  });
}
function expectUnclippedRevoke(
  bounds: Awaited<ReturnType<typeof measureRevokeBounds>>,
) {
  expect(bounds.actionLeft).toBeGreaterThanOrEqual(bounds.containerLeft - 1);
  expect(bounds.actionRight).toBeLessThanOrEqual(bounds.containerRight + 1);
  expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth + 1);
}
async function chooseTheme(page: Page, theme: "light" | "dark", touch = false) {
  await expect(
    page.getByRole("button", { name: /^Appearance: switch to / }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    /^(light|dark)$/,
  );
  if ((await page.locator("html").getAttribute("data-theme")) !== theme) {
    const switcher = page.getByRole("button", {
      name: new RegExp(`^Appearance: switch to ${theme}`),
    });
    if (touch) await switcher.tap();
    else await switcher.click();
  }
  await expectTheme(page, theme);
}
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
async function account(page: Page, role: "member" | "viewer" = "member") {
  const fixture = await getBrowserRoleFixture(origin, role);
  try {
    await authenticateBrowserFixture(page, fixture);
    const state = await database();
    try {
      const rows = await state.sql.unsafe(
        `SELECT id FROM "${state.schema}".credentials WHERE user_id=$1`,
        [fixture.identity.user.id],
      );
      scenarioOwner = {
        id: fixture.identity.user.id,
        baseline: rows.map((row) => row.id),
      };
    } finally {
      await state.sql.end();
    }
    await page.goto("/");
    await expect(
      page.getByRole("navigation", { name: "Workspace navigation" }),
    ).toBeVisible();
    return { id: fixture.identity.user.id, email: fixture.identity.user.email };
  } finally {
    await fixture.api.dispose();
  }
}
async function directoryAccount(page: Page) {
  const invitation = await json(admin, "/auth/invitations", {
    email: "browser-key-directory-member@example.test",
    role: "member",
  });
  await json(page.request, "/auth/accept-invitation", {
    token: invitation.token,
    name: "Directory fixture member",
    password: "Browser-directory-fixture-password-42",
  });
  const identity = await json(page.request, "/auth/me");
  expect(identity.user.role).toBe("member");
  expect(identity.workspace.id).toBe(
    (await json(admin, "/auth/me")).workspace.id,
  );
  scenarioOwner = { id: identity.user.id, baseline: [] };
  await page.goto("/");
  await expect(
    page.getByRole("navigation", { name: "Workspace navigation" }),
  ).toBeVisible();
}
async function openKeys(page: Page) {
  await page.goto("/settings/api-keys");
  await expect(
    page.getByRole("heading", { name: "API keys", exact: true }),
  ).toBeVisible();
}
async function createDialog(
  page: Page,
  name: string,
  activation: "pointer" | "touch" | "keyboard" = "pointer",
) {
  const action = page.getByRole("button", {
    name: "Create API key",
    exact: true,
  });
  if (activation === "touch") await action.tap();
  else await action.click();
  const dialog = page.getByRole("dialog", {
    name: "Create API key",
    exact: true,
  });
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await expect(
    dialog.getByRole("button", { name: "Create key", exact: true }),
  ).toBeEnabled();
  return dialog;
}
async function choose(
  page: Page,
  label: string,
  name: string,
  activation: "pointer" | "touch" | "keyboard" = "pointer",
) {
  const trigger = page.getByRole("button", {
    name: new RegExp(`${label}\\*$`),
  });
  await expect(trigger).toBeEnabled();
  if (activation === "touch") await trigger.tap();
  else if (activation === "keyboard") {
    await trigger.focus();
    await trigger.press("Enter");
  } else await trigger.click();
  if (activation === "keyboard") {
    const names = await page.getByRole("option").allTextContents();
    const index = names.findIndex((text) => text.trim() === name);
    expect(index).toBeGreaterThanOrEqual(0);
    await page.keyboard.press("Home");
    for (let option = 0; option < index; option++)
      await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
  } else {
    const option = page.getByRole("option", { name, exact: true });
    if (activation === "touch") await option.tap();
    else await option.click();
  }
  await expect(trigger).toHaveText(name);
  await expect(page.getByRole("option", { name, exact: true })).toHaveCount(0);
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
  admin = (await getBrowserBootstrap(origin)).api;
  board = (
    await json(admin, "/boards", {
      name: "API key release planning",
      prefix: "ARP",
    })
  ).board;
});
test.afterAll(async () => {
  await admin?.dispose();
});
test.beforeEach(() => {
  scenarioOwner = null;
});
test.afterEach(async () => {
  if (!scenarioOwner) return;
  const owner = scenarioOwner;
  scenarioOwner = null;
  const state = await database();
  try {
    await state.sql.unsafe(
      `DELETE FROM "${state.schema}".credentials WHERE user_id=$1 AND id NOT IN (SELECT jsonb_array_elements_text($2::text::jsonb)::uuid)`,
      [owner.id, JSON.stringify(owner.baseline)],
    );
  } finally {
    await state.sql.end();
  }
});

test("initial loading, failed loading, empty list and the personal key form remain distinct", async ({
  page,
}) => {
  await directoryAccount(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let initial = true;
  let boardLookups = 0;
  await page.route("**/api/boards?directory=true*", async (route) => {
    boardLookups++;
    await route.continue();
  });
  await page.route("**/api/credentials", async (route) => {
    if (route.request().method() !== "GET" || !initial) return route.continue();
    initial = false;
    await route.fetch();
    await gate;
    await route.abort("failed");
  });
  await openKeys(page);
  const region = page.getByRole("region", { name: "API keys", exact: true });
  try {
    await expect(region).toHaveAttribute("aria-busy", "true");
    const loading = region
      .getByRole("status")
      .filter({ hasText: "Loading API keys" });
    await expect(loading).toBeAttached();
    await expect(loading).toHaveClass(/sr-only/);
    await expect(loading).toHaveCSS("width", "1px");
    await expect(loading).toHaveCSS("height", "1px");
    await expect(region.getByText("No API keys", { exact: true })).toHaveCount(
      0,
    );
  } finally {
    release();
  }
  await expect(feedbackToast(page, "Mill could not be reached")).toBeVisible();
  await expect(region.getByRole("alert")).toHaveCount(0);
  await region.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(region.getByText("No API keys", { exact: true })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("link", { name: "Boards", exact: true })
    .click();
  await expect(
    page.getByRole("main").getByRole("link", { name: board.name, exact: true }),
  ).toBeVisible();
  await openKeys(page);
  const directoryBaseline = boardLookups;
  const dialog = await createDialog(page, "A personal API key");
  await expect(dialog.getByRole("textbox")).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: /Agent$/ })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /Access$/ })).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: /Board access$/ }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: /Expires after\*$/ }),
  ).toContainText("30 days");
  await dialog.getByRole("button", { name: /Expires after\*$/ }).click();
  await expect(page.getByRole("option")).toHaveText([
    "30 days",
    "60 days",
    "90 days",
    "365 days",
  ]);
  await page.getByRole("option", { name: "365 days", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: /Expires after\*$/ }),
  ).toContainText("365 days");
  expect(boardLookups).toBe(directoryBaseline);
  await dialog.getByRole("button", { name: "Create key", exact: true }).click();
  const reveal = page.getByRole("dialog", {
    name: "Copy your API key",
    exact: true,
  });
  await expect(reveal).toBeVisible();
  await reveal.getByRole("button", { name: "Done", exact: true }).click();
  const key = (await json(page.request, "/credentials")).items[0];
  expect(
    Math.round(
      (Date.parse(key.expiresAt) - Date.parse(key.createdAt)) / 86400000,
    ),
  ).toBe(365);
  expect(key).not.toHaveProperty("agentId");
});

test("response loss retries the same creation, reveals the original token locally and rotates the next operation", async ({
  page,
  context,
}) => {
  await account(page);
  await openKeys(page);
  let original = "";
  const keys: string[] = [];
  let loseResponse = true;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/credentials", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    keys.push(route.request().headers()["idempotency-key"]);
    const payload = route.request().postDataJSON();
    expect(Object.keys(payload).toSorted()).toEqual(["expiresInDays", "name"]);
    expect(payload.name).toBe("Response recovery assistant");
    if (loseResponse) {
      loseResponse = false;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      original = (await response.json()).token;
      await gate;
      await route.abort("failed");
    } else await route.continue();
  });
  const dialog = await createDialog(page, "Response recovery assistant");
  await expect(
    dialog.getByRole("button", { name: /Expires after\*$/ }),
  ).toContainText("30 days");
  await dialog.getByRole("button", { name: "Create key", exact: true }).click();
  try {
    await expect(
      dialog.getByRole("button", { name: "Creating…", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Close", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
  } finally {
    release();
  }
  await expect(feedbackToast(page, "Mill could not be reached")).toBeVisible();
  await dialog.getByRole("button", { name: "Create key", exact: true }).click();
  const reveal = page.getByRole("dialog", { name: "Copy your API key" });
  await expect(reveal).toBeVisible();
  expect(keys.length).toBe(2);
  expect(keys[0] === keys[1]).toBe(true);
  expect(
    (await reveal.locator('[data-slot="code-block-code"] code').innerText()) ===
      original,
    "The retried creation reveals the original credential",
  ).toBe(true);
  expect(
    (
      await page
        .getByRole("region", { name: "API keys", exact: true })
        .textContent()
    )?.includes(original),
    "The credential is absent from the metadata table",
  ).toBe(false);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin,
  });
  await reveal.getByRole("button", { name: "Copy code", exact: true }).click();
  await expect(feedbackToast(page, "Copied to clipboard.")).toBeVisible();
  expect(
    (await page.evaluate(() => navigator.clipboard.readText())) === original,
    "Copy places the original credential on the clipboard",
  ).toBe(true);
  await reveal.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator('[data-slot="code-block-code"] code')).toHaveCount(
    0,
  );
  const list = await json(page.request, "/credentials");
  const created = list.items.filter(
    (item: { name: string }) => item.name === "Response recovery assistant",
  );
  expect(created).toHaveLength(1);
  expect(created[0].scopes).toEqual([]);
  expect(created[0].boardIds).toBeNull();
  expect(created[0]).not.toHaveProperty("agentId");
  expect(created[0]).not.toHaveProperty("agentName");
  expect(
    Math.round(
      (Date.parse(created[0].expiresAt) - Date.parse(created[0].createdAt)) /
        86400000,
    ),
  ).toBe(30);
  const next = await createDialog(page, "Response recovery assistant");
  await choose(page, "Expires after", "60 days");
  await next.getByRole("button", { name: "Create key", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Copy your API key" }),
  ).toBeVisible();
  expect(keys[2] !== keys[1]).toBe(true);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Done", exact: true })
    .click();
  expect(
    (await json(page.request, "/credentials")).items.filter(
      (item: { name: string }) => item.name === "Response recovery assistant",
    ),
  ).toHaveLength(2);
});

test("revocation locks dismissal in flight, retains a failed confirmation and safely retries", async ({
  page,
}) => {
  await account(page);
  const credential = (
    await json(page.request, "/credentials", {
      name: "Revocation retry key",
      expiresInDays: 30,
    })
  ).credential;
  await openKeys(page);
  await page
    .getByRole("row")
    .filter({ hasText: "Revocation retry key" })
    .getByRole("button", { name: "Revoke", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const keys: string[] = [];
  await page.route(`**/api/credentials/${credential.id}`, async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    keys.push(route.request().headers()["idempotency-key"]);
    if (first) {
      first = false;
      await route.fetch();
      await gate;
      await route.abort("failed");
    } else if (keys.length === 2) {
      const response = await route.fetch();
      await route.fulfill({ response, body: "{}" });
    } else await route.continue();
  });
  await page
    .getByRole("row")
    .filter({ hasText: "Revocation retry key" })
    .getByRole("button", { name: "Revoke", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: /^Revoke .*\?$/ });
  await dialog.getByRole("button", { name: "Revoke key", exact: true }).click();
  try {
    await expect(
      dialog.getByRole("button", { name: "Please wait…", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Close", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.mouse.click(4, 4);
    await expect(dialog).toBeVisible();
  } finally {
    release();
  }
  await expect(feedbackToast(page, "Mill could not be reached")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "Revoke key", exact: true }).click();
  await expect(
    feedbackToast(page, "The server response was incomplete"),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Revoke key", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(feedbackToast(page, "Access revoked.")).toBeVisible();
  expect(keys[0] === keys[1]).toBe(true);
  expect(keys[1] === keys[2]).toBe(true);
  await expect(
    page.getByRole("row", { name: /Revocation retry key/ }),
  ).toHaveCount(0);
  const record = (await json(page.request, "/credentials")).items.find(
    (item: { id: string }) => item.id === credential.id,
  );
  expect(record).toBeUndefined();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "API keys", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("row", { name: /Revocation retry key/ }),
  ).toHaveCount(0);
});

test("a list response started before revocation cannot restore the removed key", async ({
  page,
}) => {
  await account(page);
  await json(page.request, "/credentials", {
    name: "Revoke while a list is pending",
    expiresInDays: 30,
  });
  await openKeys(page);
  let release!: () => void;
  let captured!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const snapshot = new Promise<void>((resolve) => {
    captured = resolve;
  });
  await page.route("**/api/credentials", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    captured();
    await gate;
    await route.fulfill({ response });
  });
  try {
    const create = await createDialog(page, "Created during pending list");
    await create
      .getByRole("button", { name: "Create key", exact: true })
      .click();
    await snapshot;
    await page
      .getByRole("dialog", { name: "Copy your API key" })
      .getByRole("button", { name: "Done", exact: true })
      .click();
    await page
      .getByRole("row")
      .filter({ hasText: "Revoke while a list is pending" })
      .getByRole("button", { name: "Revoke", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Revoke key", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("row", { name: /Revoke while a list is pending/ }),
    ).toHaveCount(0);
  } finally {
    release();
  }
  await page.waitForLoadState("networkidle");
  await expect(
    page.getByRole("row", { name: /Created during pending list/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("row", { name: /Revoke while a list is pending/ }),
  ).toHaveCount(0);
});

test("older active credentials remain reachable and revocable after the default page", async ({
  page,
}) => {
  const owner = await account(page);
  const older = (
    await json(page.request, "/credentials", {
      name: "Older active key",
      expiresInDays: 30,
    })
  ).credential;
  const { sql, schema } = await database();
  try {
    await sql.unsafe(
      `INSERT INTO "${schema}".credentials(user_id,name,token_hash,token_prefix,scopes,created_at,expires_at,revoked_at) SELECT $1::uuid,'Recent revoked key '||n,md5($1||n::text),'redacted',ARRAY[]::text[],now()+n*interval '1 second',now()+interval '30 days',now() FROM generate_series(1,205)n`,
      [owner.id],
    );
    await sql.unsafe(
      `INSERT INTO "${schema}".credentials(user_id,name,token_hash,token_prefix,scopes,created_at,expires_at) SELECT $1::uuid,'Recent active key '||n,gen_random_uuid()::text,'redacted',ARRAY[]::text[],now()+n*interval '1 second',now()+interval '30 days' FROM generate_series(1,205)n`,
      [owner.id],
    );
  } finally {
    await sql.end();
  }
  await openKeys(page);
  await expect(
    page.getByRole("row", { name: /Recent revoked key/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Load more credentials" }),
  ).toBeVisible();
  await expect(page.getByText("Older active key", { exact: true })).toHaveCount(
    0,
  );
  let fail = true;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/credentials?cursor=*", async (route) => {
    if (fail) {
      fail = false;
      await route.fetch();
      await route.abort("failed");
    } else {
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    }
  });
  await page.getByRole("button", { name: "Load more credentials" }).click();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(
    page.getByRole("row", { name: /Recent active key 205/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  try {
    await expect(
      page.getByRole("button", { name: "Loading…", exact: true }),
    ).toBeDisabled();
    const creation = await createDialog(page, "Created during continuation");
    await creation
      .getByRole("button", { name: "Create key", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Copy your API key" }),
    ).toBeVisible();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Done", exact: true })
      .click();
  } finally {
    release();
  }
  await expect(
    page.getByRole("row", { name: /Created during continuation/ }),
  ).toBeVisible();
  await page
    .getByRole("row")
    .filter({ hasText: "Older active key" })
    .getByRole("button", { name: "Revoke", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Revoke key", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(feedbackToast(page, "Access revoked.")).toBeVisible();
  await expect(page.getByRole("row", { name: /Older active key/ })).toHaveCount(
    0,
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "API keys", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("row", { name: /Older active key|Recent revoked key/ }),
  ).toHaveCount(0);
  const check = await database();
  try {
    const rows = await check.sql.unsafe(
      `SELECT revoked_at FROM "${check.schema}".credentials WHERE id=$1`,
      [older.id],
    );
    expect(Boolean(rows[0].revoked_at)).toBe(true);
  } finally {
    await check.sql.end();
  }
});

test("personal keys follow the viewer's current role and metadata fit desktop and phone in both themes", async ({
  page,
  browser,
}, testInfo) => {
  const viewer = await account(page, "viewer");
  const credential = await json(page.request, "/credentials", {
    name: "Release planning reader",
    expiresInDays: 30,
  });
  const longCredentialName =
    "Personal key for release coordination, international operations, and workspace integration verification";
  const longCredential = await json(page.request, "/credentials", {
    name: longCredentialName,
    expiresInDays: 365,
  });
  const keyHeaders = {
    Authorization: `Bearer ${credential.token}`,
    Origin: origin,
  };
  expect(
    (await page.request.get("/api/boards", { headers: keyHeaders })).ok(),
  ).toBe(true);
  const mutation = () =>
    page.request.post(`/api/boards/${board.id}/tasks`, {
      headers: keyHeaders,
      data: { title: "Current role authority" },
    });
  expect((await mutation()).status()).toBe(403);
  await json(admin, `/auth/members/${viewer.id}`, { role: "member" }, "PATCH");
  try {
    const promoted = await mutation();
    expect(promoted.ok()).toBe(true);
    const task = (await promoted.json()).task;
    const activity = await json(admin, `/tasks/${task.id}/activity`);
    expect(
      activity.items.some(
        (item: { actorId: string; actorKind: string }) =>
          item.actorId === viewer.id && item.actorKind === "human",
      ),
    ).toBe(true);
  } finally {
    await json(
      admin,
      `/auth/members/${viewer.id}`,
      { role: "viewer" },
      "PATCH",
    );
  }
  expect((await mutation()).status()).toBe(403);
  await openKeys(page);
  const dialog = await createDialog(page, "Viewer personal key", "keyboard");
  await choose(page, "Expires after", "60 days", "keyboard");
  await expect(dialog.getByRole("button", { name: /Access$/ })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Remote MCP", exact: true }),
  ).toHaveCount(0);
  for (const theme of ["light", "dark"] as const) {
    await chooseTheme(page, theme);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const columns = await page
      .getByRole("region", { name: "API keys", exact: true })
      .locator("thead th")
      .evaluateAll((elements) =>
        elements
          .map((element) => {
            const bounds = element.getBoundingClientRect();
            return {
              name: element.textContent?.trim(),
              x: bounds.x,
              width: bounds.width,
              right: bounds.right,
            };
          })
          .filter((column) => column.width > 0),
      );
    expect(columns.map((column) => column.name)).toEqual([
      "Name",
      "Permissions",
      "Added",
      "Expires",
      "Last used",
      "Actions",
    ]);
    expect(columns.every((column) => column.right <= 1280)).toBe(true);
    const revokeGeometry = [];
    for (const width of [1280, 768]) {
      await page.setViewportSize({ width, height: 800 });
      await page
        .getByRole("row")
        .filter({ hasText: "Release planning reader" })
        .getByRole("button", { name: "Revoke", exact: true })
        .scrollIntoViewIfNeeded();
      const bounds = await measureRevokeBounds(
        page
          .getByRole("row")
          .filter({ hasText: "Release planning reader" })
          .getByRole("button", { name: "Revoke", exact: true }),
      );
      expect(bounds.overflowX).toMatch(/auto|scroll/);
      expect(bounds.containerRight).toBeLessThanOrEqual(width + 1);
      revokeGeometry.push({ width, ...bounds });
      if (width === 768)
        await page.screenshot({
          path: testInfo.outputPath(`api-keys-tablet-${theme}.png`),
          fullPage: true,
          animations: "disabled",
        });
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    const unusedRow = page.getByRole("row", {
      name: new RegExp(longCredentialName),
    });
    await expect(unusedRow.getByText("API key", { exact: true })).toHaveCount(
      0,
    );
    await expect(unusedRow.locator("td").nth(2)).not.toBeEmpty();
    const lastUsed = unusedRow.getByRole("gridcell", {
      name: "Never",
      exact: true,
    });
    await expect(lastUsed).toBeVisible();
    await expect(lastUsed).toContainText("Never");
    await expect(lastUsed.locator("time")).toHaveCount(0);
    await expect(lastUsed).toHaveCSS(
      "color",
      await unusedRow
        .getByRole("gridcell", {
          name: "Your current REST permissions",
          exact: true,
        })
        .evaluate((element) => getComputedStyle(element).color),
    );
    await expect
      .poll(() =>
        page
          .getByRole("button", { name: /^Account menu for / })
          .locator('[role="img"]')
          .evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return bounds.width >= 32 && bounds.width === bounds.height;
          }),
      )
      .toBe(true);
    await writeFile(
      testInfo.outputPath(`api-keys-desktop-${theme}-columns.json`),
      JSON.stringify({ columns, revokeGeometry }, null, 2),
    );
    await expectTheme(page, theme);
    await page.screenshot({
      path: testInfo.outputPath(`api-keys-desktop-${theme}.png`),
      fullPage: true,
      animations: "disabled",
    });
    await openKeys(page);
    await expect(
      page.getByRole("row", { name: /Release planning reader/ }),
    ).toBeVisible();
  }
  const phone = await browser.newContext({
    baseURL: origin,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    storageState: await page.context().storageState(),
  });
  try {
    const mobile = await phone.newPage();
    await mobile.goto("/settings/api-keys");
    const touchMedia = await mobile.evaluate(() => ({
      coarse: matchMedia("(pointer: coarse)").matches,
      noHover: matchMedia("(hover: none)").matches,
      touchPoints: navigator.maxTouchPoints,
    }));
    expect(touchMedia.coarse).toBe(true);
    expect(touchMedia.noHover).toBe(true);
    expect(touchMedia.touchPoints).toBeGreaterThan(0);
    const action = mobile
      .getByRole("row")
      .filter({ hasText: "Release planning reader" })
      .getByRole("button", { name: "Revoke", exact: true });
    const longAction = mobile
      .getByRole("row")
      .filter({ hasText: longCredentialName })
      .getByRole("button", { name: "Revoke", exact: true });
    for (const target of [action, longAction]) {
      await target.scrollIntoViewIfNeeded();
      expectUnclippedRevoke(await measureRevokeBounds(target));
      const bounds = await target.boundingBox();
      expect(
        Boolean(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390),
      ).toBe(true);
      await target.tap();
      await expect(
        mobile.getByRole("dialog", { name: /^Revoke .*\?$/ }),
      ).toBeVisible();
      await mobile
        .getByRole("dialog")
        .getByRole("button", { name: "Cancel", exact: true })
        .tap();
    }
    expect(longCredential.credential).not.toHaveProperty("agentId");
    for (const theme of ["dark", "light"] as const) {
      await chooseTheme(mobile, theme, true);
      await mobile.evaluate(() => window.scrollTo(0, 0));
      const cells = await mobile
        .getByRole("region", { name: "API keys", exact: true })
        .locator("tbody tr")
        .first()
        .locator("td")
        .evaluateAll((elements) =>
          elements
            .map((element) => {
              const bounds = element.getBoundingClientRect();
              return { x: bounds.x, width: bounds.width, right: bounds.right };
            })
            .filter((cell) => cell.width > 0),
        );
      expect(cells).toHaveLength(6);
      const scroll = mobile
        .getByRole("grid", { name: "API keys", exact: true })
        .locator("..");
      const container = await scroll.boundingBox();
      expect(
        container && container.x >= 0 && container.x + container.width <= 391,
      ).toBeTruthy();
      await expect(
        mobile
          .getByRole("row", { name: new RegExp(longCredentialName) })
          .getByRole("gridcell", {
            name: "Your current REST permissions",
            exact: true,
          }),
      ).toBeVisible();
      await writeFile(
        testInfo.outputPath(`api-keys-phone-${theme}-cells.json`),
        JSON.stringify(cells, null, 2),
      );
      expect(
        await mobile.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await expectTheme(mobile, theme);
      await mobile.screenshot({
        path: testInfo.outputPath(`api-keys-phone-${theme}.png`),
        animations: "disabled",
      });
      expect(
        await mobile.evaluate(() => matchMedia("(pointer: coarse)").matches),
      ).toBe(true);
      await openKeys(mobile);
      const form = await createDialog(
        mobile,
        "Phone viewer personal key",
        "touch",
      );
      await choose(mobile, "Expires after", "90 days", "touch");
      expect(
        await form
          .getByLabel("Name", { exact: true })
          .evaluate(
            (element) => parseFloat(getComputedStyle(element).fontSize) >= 16,
          ),
      ).toBe(true);
      await form.getByRole("button", { name: "Cancel", exact: true }).tap();
    }
  } finally {
    await phone.close();
  }
});

test("incomplete creation responses preserve unresolved keys when a draft is changed and reverted", async ({
  page,
}) => {
  await account(page);
  await openKeys(page);
  const names = ["Unresolved draft A", "Unresolved draft B"];
  const keys: string[] = [];
  let original = "";
  await page.route("**/api/credentials", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    keys.push(route.request().headers()["idempotency-key"]);
    if (keys.length <= 2) {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      if (keys.length === 1) original = (await response.json()).token;
      await route.fulfill({ response, body: "{}" });
    } else await route.continue();
  });
  const dialog = await createDialog(page, names[0]);
  for (const name of names) {
    await dialog.getByLabel("Name", { exact: true }).fill(name);
    await choose(
      page,
      "Expires after",
      name === names[0] ? "30 days" : "90 days",
    );
    await dialog
      .getByRole("button", { name: "Create key", exact: true })
      .click();
    await expect(
      feedbackToast(page, "The server response was incomplete"),
    ).toBeVisible();
    await expect(
      page.locator('[data-slot="code-block-code"] code'),
    ).toHaveCount(0);
  }
  await dialog.getByLabel("Name", { exact: true }).fill(names[0]);
  await choose(page, "Expires after", "30 days");
  await dialog.getByRole("button", { name: "Create key", exact: true }).click();
  const reveal = page.getByRole("dialog", { name: "Copy your API key" });
  await expect(reveal).toBeVisible();
  expect(keys[0] !== keys[1]).toBe(true);
  expect(keys[0] === keys[2]).toBe(true);
  expect(
    (await reveal.locator('[data-slot="code-block-code"] code').innerText()) ===
      original,
    "Reverting an unresolved draft reveals its original credential",
  ).toBe(true);
  await reveal.getByRole("button", { name: "Done", exact: true }).click();
  const records = (await json(page.request, "/credentials")).items;
  for (const name of names) {
    expect(
      records.filter((item: { name: string }) => item.name === name),
    ).toHaveLength(1);
    await expect(
      page.getByRole("row", { name: new RegExp(name) }),
    ).toBeVisible();
  }
});

test("Agent navigation, settings and API routes are absent for every workspace role", async ({
  page,
}) => {
  for (const role of ["admin", "member", "viewer"] as const) {
    const fixture =
      role === "admin"
        ? await getBrowserBootstrap(origin)
        : await getBrowserRoleFixture(origin, role);
    try {
      await authenticateBrowserFixture(page, fixture);
      await page.goto("/settings/api-keys");
      await expect(
        page
          .getByRole("navigation", { name: "Workspace navigation" })
          .getByRole("link", { name: "Agents", exact: true }),
      ).toHaveCount(0);
      await page.goto("/settings/agents");
      await expect(
        page.getByRole("heading", {
          name: "This page could not be found",
          exact: true,
        }),
      ).toBeVisible();
      expect((await fixture.api.get("/api/agents")).status()).toBe(404);
      expect(
        (
          await fixture.api.post("/api/agents", {
            data: { name: "Removed identity" },
          })
        ).status(),
      ).toBe(404);
    } finally {
      await fixture.api.dispose();
    }
  }
});
