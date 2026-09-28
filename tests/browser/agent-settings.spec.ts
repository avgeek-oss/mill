import { readFile, writeFile } from "node:fs/promises";
import postgres from "postgres";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import {
  authenticateBrowserFixture,
  getBrowserBootstrap,
  getBrowserRoleFixture,
} from "../browser-fixture.js";

// Credential responses and reveal dialogs must never enter traces or screenshots.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
test.use({ trace: "off", screenshot: "off" });
test.describe.configure({ mode: "serial" });
let origin: string;
let admin: APIRequestContext;
let board: { id: string; name: string };
let archived: { id: string; name: string };
let scenarioOwner: { id: string; baseline: string[] } | null = null;
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
async function openAgents(page: Page) {
  await page.goto("/settings/agents");
  await expect(
    page.getByRole("heading", { name: "Agent access", exact: true }),
  ).toBeVisible();
}
async function createDialog(page: Page, name: string) {
  await page
    .getByRole("button", { name: "Create credential", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Create credential",
    exact: true,
  });
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await expect(
    dialog.getByRole("button", { name: "Create credential", exact: true }),
  ).toBeEnabled();
  return dialog;
}
async function choose(page: Page, label: string, name: string) {
  await page.getByRole("button", { name: new RegExp(`${label}$`) }).click();
  await page.getByRole("option", { name, exact: true }).click();
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
      name: "Agent release planning",
      prefix: "ARP",
    })
  ).board;
  archived = (
    await json(admin, "/boards", {
      name: "Agent archived plans",
      prefix: "AAP",
    })
  ).board;
  await json(
    admin,
    `/boards/${archived.id}`,
    { version: 1, archived: true },
    "PATCH",
  );
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

test("initial loading, failed loading, empty list and board lookup retry remain distinct", async ({
  page,
}) => {
  await account(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let initial = true;
  await page.route("**/api/credentials", async (route) => {
    if (route.request().method() !== "GET" || !initial) return route.continue();
    initial = false;
    await route.fetch();
    await gate;
    await route.abort("failed");
  });
  await openAgents(page);
  const region = page.getByRole("region", { name: "Credentials", exact: true });
  try {
    await expect(region.getByRole("status")).toHaveText("Loading credentials…");
    await expect(
      region.getByText("No credentials yet", { exact: true }),
    ).toHaveCount(0);
  } finally {
    release();
  }
  await expect(region.getByRole("alert")).toContainText(
    "Mill could not be reached",
  );
  await region
    .getByRole("button", { name: "Retry loading credentials" })
    .click();
  await expect(
    region.getByText("No credentials yet", { exact: true }),
  ).toBeVisible();
  let boardFailure = true;
  await page.route("**/api/boards?directory=true", async (route) => {
    if (boardFailure) {
      boardFailure = false;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await openAgents(page);
  await page
    .getByRole("button", { name: "Create credential", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Create credential",
    exact: true,
  });
  await expect(dialog.getByRole("alert")).toContainText(
    "Mill could not be reached",
  );
  await expect(
    dialog.getByRole("button", { name: "Create credential", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Retry loading boards" }).click();
  await expect(
    dialog.getByRole("button", { name: "Create credential", exact: true }),
  ).toBeEnabled();
  await choose(page, "Board access", `${archived.name} (archived)`);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("response loss retries the same creation, reveals the original token locally and rotates the next operation", async ({
  page,
  context,
}) => {
  await account(page);
  await openAgents(page);
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
  await expect(dialog.getByRole("button", { name: /Access$/ })).toContainText(
    "Read only",
  );
  await expect(dialog.getByLabel("Expires in days")).toHaveValue("30");
  await choose(page, "Board access", board.name);
  await dialog
    .getByRole("button", { name: "Create credential", exact: true })
    .click();
  try {
    await expect(
      dialog.getByRole("button", { name: "Creating…", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Close dialog", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
  } finally {
    release();
  }
  await expect(dialog.getByRole("alert")).toContainText(
    "Mill could not be reached",
  );
  await dialog
    .getByRole("button", { name: "Create credential", exact: true })
    .click();
  const reveal = page.getByRole("dialog", { name: "Copy your credential" });
  await expect(reveal).toBeVisible();
  expect(keys.length).toBe(2);
  expect(keys[0] === keys[1]).toBe(true);
  expect(
    (await reveal.getByLabel("Credential", { exact: true }).inputValue()) ===
      original,
    "The retried creation reveals the original credential",
  ).toBe(true);
  expect(
    (
      await page
        .getByRole("region", { name: "Credentials", exact: true })
        .textContent()
    )?.includes(original),
    "The credential is absent from the metadata table",
  ).toBe(false);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin,
  });
  await reveal
    .getByRole("button", { name: "Copy credential", exact: true })
    .click();
  await expect(reveal.getByRole("status")).toHaveText("Credential copied.");
  expect(
    (await page.evaluate(() => navigator.clipboard.readText())) === original,
    "Copy places the original credential on the clipboard",
  ).toBe(true);
  await reveal.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByLabel("Credential", { exact: true })).toHaveCount(0);
  const list = await json(page.request, "/credentials");
  const created = list.items.filter(
    (item: { name: string }) => item.name === "Response recovery assistant",
  );
  expect(created).toHaveLength(1);
  expect(created[0].scopes).toEqual(["read"]);
  expect(created[0].boardIds).toEqual([board.id]);
  await expect(
    page.getByRole("row", { name: /Response recovery assistant/ }),
  ).toContainText(board.name);
  const next = await createDialog(page, "Response recovery assistant");
  await choose(page, "Board access", board.name);
  await next
    .getByRole("button", { name: "Create credential", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Copy your credential" }),
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
      name: "Revocation retry agent",
      scopes: ["read"],
      expiresInDays: 30,
    })
  ).credential;
  await openAgents(page);
  await page
    .getByRole("button", { name: "Revoke Revocation retry agent", exact: true })
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
    .getByRole("button", { name: "Revoke Revocation retry agent", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Revoke credential?" });
  await dialog
    .getByRole("button", { name: "Revoke credential", exact: true })
    .click();
  try {
    await expect(
      dialog.getByRole("button", { name: "Revoking…", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Close dialog", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.mouse.click(4, 4);
    await expect(dialog).toBeVisible();
  } finally {
    release();
  }
  await expect(dialog.getByRole("alert")).toContainText(
    "Mill could not be reached",
  );
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeEnabled();
  await dialog
    .getByRole("button", { name: "Revoke credential", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "The server response was incomplete",
  );
  await dialog
    .getByRole("button", { name: "Revoke credential", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toHaveText("Credential revoked.");
  expect(keys[0] === keys[1]).toBe(true);
  expect(keys[1] === keys[2]).toBe(true);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.getByRole("row", { name: /Revocation retry agent/ }),
  ).toContainText("Revoked");
  const record = (await json(page.request, "/credentials")).items.find(
    (item: { id: string }) => item.id === credential.id,
  );
  expect(Boolean(record.revokedAt)).toBe(true);
});

test("older active credentials remain reachable and revocable after the default page", async ({
  page,
}) => {
  const owner = await account(page);
  const older = (
    await json(page.request, "/credentials", {
      name: "Older active agent",
      scopes: ["read"],
      expiresInDays: 30,
    })
  ).credential;
  const { sql, schema } = await database();
  try {
    await sql.unsafe(
      `INSERT INTO "${schema}".credentials(user_id,name,token_hash,token_prefix,scopes,created_at,expires_at,revoked_at) SELECT $1::uuid,'Recent revoked agent '||n,md5($1||n::text),'redacted',ARRAY['read'],now()+n*interval '1 second',now()+interval '30 days',now() FROM generate_series(1,205)n`,
      [owner.id],
    );
  } finally {
    await sql.end();
  }
  await openAgents(page);
  await expect(
    page.getByRole("button", { name: "Load more credentials" }),
  ).toBeVisible();
  await expect(
    page.getByText("Older active agent", { exact: true }),
  ).toHaveCount(0);
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
  await expect(
    page.getByRole("button", { name: "Retry loading more" }),
  ).toBeVisible();
  await expect(
    page.getByRole("row", { name: /Recent revoked agent 205/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry loading more" }).click();
  try {
    await expect(
      page.getByRole("button", { name: "Loading more…" }),
    ).toBeDisabled();
    const creation = await createDialog(page, "Created during continuation");
    await creation
      .getByRole("button", { name: "Create credential", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Copy your credential" }),
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
    .getByRole("button", { name: "Revoke Older active agent", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Revoke credential", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("status")).toHaveText(
    "Credential revoked.",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Done", exact: true })
    .click();
  await expect(
    page.getByRole("row", { name: /Older active agent/ }),
  ).toContainText("Revoked");
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

test("viewer access and metadata fit desktop and phone in both themes", async ({
  page,
  browser,
}, testInfo) => {
  await account(page, "viewer");
  const forbidden = await page.request.post("/api/credentials", {
    headers: { Origin: origin },
    data: {
      name: "Forbidden writer",
      scopes: ["read", "write"],
      expiresInDays: 30,
    },
  });
  expect(forbidden.status()).toBe(403);
  await json(page.request, "/credentials", {
    name: "Release planning reader",
    scopes: ["read"],
    boardIds: [board.id],
    expiresInDays: 30,
  });
  const longBoardName =
    "Release planning for international operations and the next generation of workspace integrations";
  const longBoard = (
    await json(admin, "/boards", { name: longBoardName, prefix: "ALC" })
  ).board;
  const longCredentialName =
    "Automation reader for release coordination, international operations, and workspace integration verification";
  const longCredential = await json(page.request, "/credentials", {
    name: longCredentialName,
    scopes: ["read"],
    boardIds: [longBoard.id],
    expiresInDays: 30,
  });
  const read = await page.request.get("/api/boards", {
    headers: { Authorization: `Bearer ${longCredential.token}` },
  });
  expect(read.ok()).toBe(true);
  await openAgents(page);
  await expect(
    page.getByRole("row", { name: /Release planning reader/ }),
  ).toContainText(board.name);
  const dialog = await createDialog(page, "Viewer assistant");
  await page.getByRole("button", { name: /Access$/ }).click();
  await expect(
    page.getByRole("option", { name: "Read and write", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const guideTab = page.context().waitForEvent("page");
  await page
    .getByRole("link", { name: "Agent setup guide", exact: true })
    .click();
  const guide = await guideTab;
  await expect(guide).toHaveURL(`${origin}/guides/agents.html`);
  await expect(
    guide.getByRole("heading", { name: "Connect an agent", exact: true }),
  ).toBeVisible();
  await guide.close();
  for (const theme of ["light", "dark"]) {
    if (theme === "dark")
      await page
        .getByRole("button", { name: /Appearance: switch to dark/ })
        .click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const columns = await page
      .getByRole("region", { name: "Credentials", exact: true })
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
    expect(columns).toHaveLength(5);
    expect(columns.every((column) => column.right <= 1280)).toBe(true);
    await writeFile(
      testInfo.outputPath(`agents-desktop-${theme}-columns.json`),
      JSON.stringify(columns, null, 2),
    );
    await page.screenshot({
      path: testInfo.outputPath(`agents-desktop-${theme}.png`),
      fullPage: true,
      animations: "disabled",
    });
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
    await mobile.goto("/settings/agents");
    await expect(
      mobile.getByRole("row", { name: /Release planning reader/ }),
    ).toBeVisible();
    const action = mobile.getByRole("button", {
      name: "Revoke Release planning reader",
      exact: true,
    });
    const bounds = await action.boundingBox();
    expect(
      Boolean(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390),
    ).toBe(true);
    await action.click();
    await expect(
      mobile.getByRole("dialog", { name: "Revoke credential?" }),
    ).toBeVisible();
    await mobile
      .getByRole("dialog")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    const longAction = mobile.getByRole("button", {
      name: `Revoke ${longCredentialName}`,
      exact: true,
    });
    const longBounds = await longAction.boundingBox();
    expect(
      Boolean(
        longBounds &&
        longBounds.x >= 0 &&
        longBounds.x + longBounds.width <= 390,
      ),
    ).toBe(true);
    await expect(
      mobile.getByRole("row", { name: new RegExp(longCredentialName) }),
    ).toContainText(longBoardName);
    await longAction.click();
    await mobile
      .getByRole("dialog")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    for (const theme of ["dark", "light"]) {
      if (theme === "light")
        await mobile
          .getByRole("button", { name: /Appearance: switch to light/ })
          .click();
      await mobile.evaluate(() => window.scrollTo(0, 0));
      const cells = await mobile
        .getByRole("region", { name: "Credentials", exact: true })
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
      expect(cells).toHaveLength(1);
      expect(cells.every((cell) => cell.right <= 390)).toBe(true);
      await writeFile(
        testInfo.outputPath(`agents-phone-${theme}-cells.json`),
        JSON.stringify(cells, null, 2),
      );
      expect(
        await mobile.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await mobile.screenshot({
        path: testInfo.outputPath(`agents-phone-${theme}.png`),
        fullPage: true,
        animations: "disabled",
      });
      const form = await createDialog(mobile, "Phone viewer assistant");
      expect(
        await form
          .getByLabel("Name", { exact: true })
          .evaluate(
            (element) => parseFloat(getComputedStyle(element).fontSize) >= 16,
          ),
      ).toBe(true);
      await form.getByRole("button", { name: "Cancel", exact: true }).click();
    }
  } finally {
    await phone.close();
  }
});

test("board choices and scope names include later pages independently of the sidebar", async ({
  page,
}) => {
  await account(page);
  const fixture = await database();
  let laterId = "";
  try {
    const rows = await fixture.sql.unsafe(
      `INSERT INTO "${fixture.schema}".boards(workspace_id,name,prefix,position) SELECT (SELECT id FROM "${fixture.schema}".workspace),'Continued agent board '||n,'CAB'||n,1000+n FROM generate_series(1,105)n RETURNING id,name`,
    );
    laterId = rows.find((row) => row.name === "Continued agent board 105")!.id;
  } finally {
    await fixture.sql.end();
  }
  let changed = false;
  await page.route("**/api/boards?directory=true&cursor=*", async (route) => {
    if (changed) return route.continue();
    changed = true;
    await json(
      admin,
      `/boards/${laterId}`,
      { version: 1, beforeId: board.id },
      "PATCH",
    );
    const response = await route.fetch();
    expect(response.status()).toBe(409);
    await route.fulfill({ response });
  });
  await openAgents(page);
  const dialog = await createDialog(page, "Later board assistant");
  await page.getByRole("button", { name: /Board access$/ }).click();
  await page
    .getByRole("searchbox", { name: "Search board access" })
    .fill("Continued agent board 105");
  await page
    .getByRole("option", { name: "Continued agent board 105", exact: true })
    .click();
  expect(changed).toBe(true);
  await dialog
    .getByRole("button", { name: "Create credential", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Copy your credential" }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Done", exact: true })
    .click();
  await expect(
    page.getByRole("row", { name: /Later board assistant/ }),
  ).toContainText("Continued agent board 105");
  const list = await json(page.request, "/credentials");
  expect(
    list.items.find(
      (item: { name: string }) => item.name === "Later board assistant",
    ).boardIds,
  ).toEqual([laterId]);
});

test("incomplete creation responses preserve unresolved keys when a draft is changed and reverted", async ({
  page,
}) => {
  await account(page);
  await openAgents(page);
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
    await dialog
      .getByRole("button", { name: "Create credential", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText(
      "The server response was incomplete",
    );
    await expect(page.getByLabel("Credential", { exact: true })).toHaveCount(0);
  }
  await dialog.getByLabel("Name", { exact: true }).fill(names[0]);
  await dialog
    .getByRole("button", { name: "Create credential", exact: true })
    .click();
  const reveal = page.getByRole("dialog", { name: "Copy your credential" });
  await expect(reveal).toBeVisible();
  expect(keys[0] !== keys[1]).toBe(true);
  expect(keys[0] === keys[2]).toBe(true);
  expect(
    (await reveal.getByLabel("Credential", { exact: true }).inputValue()) ===
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

test("one complete directory survives state transitions and retains deleted labels without granting them", async ({
  page,
}) => {
  await account(page);
  const fixture = await database();
  try {
    await fixture.sql.unsafe(
      `INSERT INTO "${fixture.schema}".boards(workspace_id,name,prefix,position) SELECT (SELECT id FROM "${fixture.schema}".workspace),'Transition directory fixture '||n,'TDF'||n,2000+n FROM generate_series(1,105)n`,
    );
  } finally {
    await fixture.sql.end();
  }
  const restoredArchived = (
    await json(admin, "/boards", {
      name: "Restored archived grant board",
      prefix: "RAG",
    })
  ).board;
  const restoredDeleted = (
    await json(admin, "/boards", {
      name: "Restored deleted grant board",
      prefix: "RDG",
    })
  ).board;
  const historical = (
    await json(admin, "/boards", {
      name: "Historical deleted scope",
      prefix: "HDS",
    })
  ).board;
  await json(
    admin,
    `/boards/${restoredArchived.id}`,
    { version: 1, archived: true },
    "PATCH",
  );
  await json(
    admin,
    `/boards/${restoredDeleted.id}`,
    { version: 1, deleted: true },
    "PATCH",
  );
  await json(page.request, "/credentials", {
    name: "Historical scope reader",
    scopes: ["read"],
    boardIds: [historical.id],
    expiresInDays: 30,
  });
  await json(
    admin,
    `/boards/${historical.id}`,
    { version: 1, deleted: true },
    "PATCH",
  );
  let transitioned = false;
  await page.route("**/api/boards?directory=true&cursor=*", async (route) => {
    if (transitioned) return route.continue();
    transitioned = true;
    await json(
      admin,
      `/boards/${restoredArchived.id}`,
      { version: 2, archived: false },
      "PATCH",
    );
    await json(admin, `/boards/${restoredDeleted.id}/restore`, { version: 2 });
    const response = await route.fetch();
    expect(response.status()).toBe(409);
    expect((await response.json()).code).toBe("board_list_changed");
    await route.fulfill({ response });
  });
  await openAgents(page);
  const dialog = await createDialog(page, "Restored board assistant");
  expect(transitioned).toBe(true);
  await expect(
    page.getByRole("row", { name: /Historical scope reader/ }),
  ).toContainText(historical.name);
  await page.getByRole("button", { name: /Board access$/ }).click();
  await expect(
    page.getByRole("option", { name: restoredArchived.name, exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("option", { name: restoredDeleted.name, exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("option", {
      name: `${restoredArchived.name} (archived)`,
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("option", { name: historical.name, exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("option", { name: restoredArchived.name, exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Create credential", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Copy your credential" }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Done", exact: true })
    .click();
  const records = (await json(page.request, "/credentials")).items;
  expect(
    records.find(
      (item: { name: string }) => item.name === "Restored board assistant",
    ).boardIds,
  ).toEqual([restoredArchived.id]);
});
