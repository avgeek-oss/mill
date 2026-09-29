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
    email: "browser-agent-directory-member@example.test",
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
async function openAgents(page: Page) {
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
    dialog.getByRole("button", { name: "Create API key", exact: true }),
  ).toBeEnabled();
  return dialog;
}
async function choose(
  page: Page,
  label: string,
  name: string,
  activation: "pointer" | "touch" | "keyboard" = "pointer",
) {
  const trigger = page.getByRole("button", { name: new RegExp(`${label}$`) });
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
      name: "Agent release planning",
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

test("personal agents are created, edited with conflict recovery, and deleted without removing task history", async ({
  page,
}) => {
  const owner = await account(page);
  await page.goto("/settings/agents");
  await expect(
    page.getByRole("heading", { name: "Agents", exact: true }),
  ).toBeVisible();
  const create = page.getByRole("button", {
    name: "Create agent",
    exact: true,
  });
  await create.click();
  const dialog = page.getByRole("dialog", {
    name: "Create agent",
    exact: true,
  });
  await dialog
    .getByLabel("Name", { exact: true })
    .fill("Browser personal assistant");
  await dialog.getByRole("button", { name: /Access$/ }).click();
  await expect(
    page.getByRole("option", { name: "Team", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await dialog.getByLabel("Name", { exact: true }).press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Agent created.", { exact: true })).toBeVisible();
  await expect(create).toBeFocused();
  const created = (await json(page.request, "/agents?limit=100")).items.find(
    (item: { name: string }) => item.name === "Browser personal assistant",
  );
  expect(created.scope).toBe("personal");
  expect(created.memberIds).toEqual([]);
  expect(created.allMembers).toBe(false);
  await page
    .getByRole("button", {
      name: "Edit Browser personal assistant",
      exact: true,
    })
    .click();
  const edit = page.getByRole("dialog", { name: "Edit agent", exact: true });
  await edit
    .getByLabel("Name", { exact: true })
    .fill("My preserved local draft");
  await json(
    page.request,
    `/agents/${created.id}`,
    { version: created.version, name: "Changed elsewhere" },
    "PATCH",
  );
  await edit.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(edit.getByRole("alert")).toBeVisible();
  await expect(edit.getByLabel("Name", { exact: true })).toHaveValue(
    "My preserved local draft",
  );
  await expect(
    edit.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeDisabled();
  await edit.getByRole("button", { name: "Reload agent", exact: true }).click();
  await expect(edit.getByLabel("Name", { exact: true })).toHaveValue(
    "Changed elsewhere",
  );
  await edit
    .getByLabel("Name", { exact: true })
    .fill("Browser personal assistant edited");
  await edit.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(edit.getByRole("status")).toHaveText("Agent updated.");
  await edit.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.getByRole("row", { name: /Browser personal assistant edited/ }),
  ).toBeVisible();
  const key = await json(page.request, "/credentials", {
    name: "Independent personal key",
    expiresInDays: 30,
  });
  const taskResponse = await page.request.post(
    `/api/boards/${board.id}/tasks`,
    {
      headers: { Authorization: `Bearer ${key.token}`, Origin: origin },
      data: {
        title: "History survives agent deletion",
        assigneeId: owner.id,
        agentId: created.id,
      },
    },
  );
  expect(taskResponse.ok()).toBe(true);
  const task = (await taskResponse.json()).task;
  const comment = await page.request.post(`/api/tasks/${task.id}/comments`, {
    headers: { Authorization: `Bearer ${key.token}`, Origin: origin },
    data: { body: "Agent discussion remains available" },
  });
  expect(comment.ok()).toBe(true);
  const history = await json(page.request, `/tasks/${task.id}/activity`);
  expect(
    history.items.some(
      (item: { actorKind: string }) => item.actorKind === "human",
    ),
  ).toBe(true);
  const before = await page.request.get(`/api/boards/${board.id}`);
  expect(before.ok()).toBe(true);
  await page
    .getByRole("button", {
      name: "Delete Browser personal assistant edited",
      exact: true,
    })
    .click();
  const removal = page.getByRole("dialog", {
    name: "Delete agent?",
    exact: true,
  });
  await expect(removal).toContainText("Task history stays available");
  await removal
    .getByRole("button", { name: "Keep agent", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Delete Browser personal assistant edited",
      exact: true,
    }),
  ).toBeFocused();
  await page
    .getByRole("button", {
      name: "Delete Browser personal assistant edited",
      exact: true,
    })
    .click();
  await removal
    .getByRole("button", { name: "Delete agent", exact: true })
    .click();
  await expect(removal.getByRole("status")).toHaveText("Agent deleted.");
  await removal.getByRole("button", { name: "Done", exact: true }).click();
  await expect(create).toBeFocused();
  await expect(
    page.getByRole("row", { name: /Browser personal assistant edited/ }),
  ).toHaveCount(0);
  expect((await page.request.get(`/api/boards/${board.id}`)).ok()).toBe(true);
  expect((await json(page.request, `/tasks/${task.id}`)).task.id).toBe(task.id);
  expect(
    (await json(page.request, `/tasks/${task.id}/comments`)).items,
  ).toHaveLength(1);
  const retained = await json(page.request, `/tasks/${task.id}/activity`);
  expect(retained.items).toEqual(expect.arrayContaining(history.items));
  expect(retained.items.length).toBe(history.items.length + 1);
  expect(
    (await json(page.request, `/tasks/${task.id}`)).task.agentId,
  ).toBeNull();
  expect(
    (
      await page.request.get("/api/boards", {
        headers: { Authorization: `Bearer ${key.token}` },
      })
    ).status(),
  ).toBe(200);
});

test("team agents retain the creator grant and explicit named people while viewers cannot manage them", async ({
  page,
}) => {
  const fixture = await getBrowserBootstrap(origin);
  const creator = fixture.identity.user;
  try {
    await authenticateBrowserFixture(page, fixture);
  } finally {
    await fixture.api.dispose();
  }
  const member = await getBrowserRoleFixture(origin, "member");
  const viewer = await getBrowserRoleFixture(origin, "viewer");
  try {
    await page.goto("/settings/agents");
    await page
      .getByRole("button", { name: "Create agent", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Create agent",
      exact: true,
    });
    await dialog
      .getByLabel("Name", { exact: true })
      .fill("Explicit team assistant");
    await choose(page, "Access", "Team");
    const assigned = dialog.getByRole("group", {
      name: "Assigned people",
      exact: true,
    });
    const owner = assigned.getByRole("checkbox", {
      name: `${creator.name} (${creator.email})`,
      exact: true,
    });
    await expect(owner).toBeChecked();
    await expect(owner).toBeDisabled();
    await expect(assigned.getByRole("checkbox", { checked: true })).toHaveCount(
      1,
    );
    const person = assigned.getByRole("checkbox", {
      name: `${viewer.identity.user.name} (${viewer.identity.user.email})`,
      exact: true,
    });
    await assigned
      .getByText(viewer.identity.user.email, { exact: true })
      .click();
    await expect(person).toBeChecked();
    await person.focus();
    await expect(person).toBeFocused();
    await page.keyboard.press("Space");
    await expect(person).not.toBeChecked();
    await page.keyboard.press("Space");
    await expect(person).toBeChecked();
    await dialog
      .getByRole("button", { name: "Create agent", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByText("Agent created.", { exact: true }),
    ).toBeVisible();
    let created = (
      await json(admin, "/agents?manage=true&limit=100")
    ).items.find(
      (item: { name: string }) => item.name === "Explicit team assistant",
    );
    expect(created.memberIds.toSorted()).toEqual(
      [creator.id, viewer.identity.user.id].toSorted(),
    );
    expect(created.allMembers).toBe(false);
    expect(
      (await json(admin, "/agents?limit=100")).items.some(
        (item: { id: string }) => item.id === created.id,
      ),
    ).toBe(true);
    created = (
      await json(
        admin,
        `/agents/${created.id}`,
        { version: created.version, memberIds: [viewer.identity.user.id] },
        "PATCH",
      )
    ).agent;
    expect(created.memberIds.toSorted()).toEqual(
      [creator.id, viewer.identity.user.id].toSorted(),
    );
    await authenticateBrowserFixture(page, viewer);
    await page.goto("/settings/agents");
    await expect(
      page.getByRole("row", { name: /Explicit team assistant/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Create agent", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: "Edit Explicit team assistant",
        exact: true,
      }),
    ).toHaveCount(0);
    await authenticateBrowserFixture(page, member);
    await page.goto("/settings/agents");
    await expect(
      page.getByRole("row", { name: /Explicit team assistant/ }),
    ).toHaveCount(0);
    await json(
      admin,
      `/agents/${created.id}`,
      { version: created.version },
      "DELETE",
    );
  } finally {
    await member.api.dispose();
    await viewer.api.dispose();
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
  let agentLookups = 0;
  await page.route("**/api/boards?directory=true*", async (route) => {
    boardLookups++;
    await route.continue();
  });
  await page.route("**/api/agents?*", async (route) => {
    agentLookups++;
    await route.continue();
  });
  await page.route("**/api/credentials", async (route) => {
    if (route.request().method() !== "GET" || !initial) return route.continue();
    initial = false;
    await route.fetch();
    await gate;
    await route.abort("failed");
  });
  await openAgents(page);
  const region = page.getByRole("region", { name: "API keys", exact: true });
  try {
    await expect(region.getByRole("status")).toHaveText("Loading API keys…");
    await expect(
      region.getByText("No API keys yet", { exact: true }),
    ).toHaveCount(0);
  } finally {
    release();
  }
  await expect(region.getByRole("alert")).toContainText(
    "Mill could not be reached",
  );
  await region.getByRole("button", { name: "Retry loading API keys" }).click();
  await expect(
    region.getByText("No API keys yet", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Workspace navigation" })
      .getByRole("link", { name: board.name, exact: true }),
  ).toBeVisible();
  const directoryBaseline = { boards: boardLookups, agents: agentLookups };
  const dialog = await createDialog(page, "A personal key without an Agent");
  await expect(dialog.getByRole("textbox")).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: /Agent$/ })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /Access$/ })).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: /Board access$/ }),
  ).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /Expiry$/ })).toContainText(
    "30 days",
  );
  await dialog.getByRole("button", { name: /Expiry$/ }).click();
  await expect(page.getByRole("option")).toHaveText([
    "30 days",
    "60 days",
    "90 days",
    "365 days",
  ]);
  await page.getByRole("option", { name: "365 days", exact: true }).click();
  await expect(dialog.getByRole("button", { name: /Expiry$/ })).toContainText(
    "365 days",
  );
  expect(boardLookups).toBe(directoryBaseline.boards);
  expect(agentLookups).toBe(directoryBaseline.agents);
  await dialog
    .getByRole("button", { name: "Create API key", exact: true })
    .click();
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
  expect(key.agentId).toBeNull();
  expect(agentLookups).toBe(directoryBaseline.agents);
  expect((await json(page.request, "/agents?limit=100")).items).toHaveLength(0);
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
  await expect(dialog.getByRole("button", { name: /Expiry$/ })).toContainText(
    "30 days",
  );
  await dialog
    .getByRole("button", { name: "Create API key", exact: true })
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
    .getByRole("button", { name: "Create API key", exact: true })
    .click();
  const reveal = page.getByRole("dialog", { name: "Copy your API key" });
  await expect(reveal).toBeVisible();
  expect(keys.length).toBe(2);
  expect(keys[0] === keys[1]).toBe(true);
  expect(
    (await reveal.getByLabel("API key", { exact: true }).inputValue()) ===
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
  await reveal
    .getByRole("button", { name: "Copy API key", exact: true })
    .click();
  await expect(reveal.getByRole("status")).toHaveText("API key copied.");
  expect(
    (await page.evaluate(() => navigator.clipboard.readText())) === original,
    "Copy places the original credential on the clipboard",
  ).toBe(true);
  await reveal.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByLabel("API key", { exact: true })).toHaveCount(0);
  const list = await json(page.request, "/credentials");
  const created = list.items.filter(
    (item: { name: string }) => item.name === "Response recovery assistant",
  );
  expect(created).toHaveLength(1);
  expect(created[0].scopes).toEqual([]);
  expect(created[0].boardIds).toBeNull();
  expect(created[0].agentId).toBeNull();
  expect(created[0].agentName).toBeNull();
  expect(
    Math.round(
      (Date.parse(created[0].expiresAt) - Date.parse(created[0].createdAt)) /
        86400000,
    ),
  ).toBe(30);
  const next = await createDialog(page, "Response recovery assistant");
  await choose(page, "Expiry", "60 days");
  await next
    .getByRole("button", { name: "Create API key", exact: true })
    .click();
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
      name: "Revocation retry agent",
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
  const dialog = page.getByRole("dialog", { name: "Revoke API key?" });
  await dialog
    .getByRole("button", { name: "Revoke API key", exact: true })
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
    .getByRole("button", { name: "Revoke API key", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "The server response was incomplete",
  );
  await dialog
    .getByRole("button", { name: "Revoke API key", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toHaveText("API key revoked.");
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
      expiresInDays: 30,
    })
  ).credential;
  const { sql, schema } = await database();
  try {
    await sql.unsafe(
      `INSERT INTO "${schema}".credentials(user_id,name,token_hash,token_prefix,scopes,created_at,expires_at,revoked_at) SELECT $1::uuid,'Recent revoked agent '||n,md5($1||n::text),'redacted',ARRAY[]::text[],now()+n*interval '1 second',now()+interval '30 days',now() FROM generate_series(1,205)n`,
      [owner.id],
    );
  } finally {
    await sql.end();
  }
  await openAgents(page);
  await expect(
    page.getByRole("button", { name: "Load more API keys" }),
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
  await page.getByRole("button", { name: "Load more API keys" }).click();
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
      .getByRole("button", { name: "Create API key", exact: true })
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
    .getByRole("button", { name: "Revoke Older active agent", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Revoke API key", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("status")).toHaveText(
    "API key revoked.",
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

test("personal keys follow the viewer's current role and metadata fit desktop and phone in both themes", async ({
  page,
  browser,
}, testInfo) => {
  const viewer = await account(page, "viewer");
  const visibleAgent = (
    await json(admin, "/agents", {
      name: "Viewer visible team assistant",
      scope: "team",
      memberIds: [viewer.id],
    })
  ).agent;
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
  expect(
    (
      await page.request.post("/api/agents", {
        headers: keyHeaders,
        data: { name: "Forbidden bearer Agent", scope: "personal" },
      })
    ).status(),
  ).toBe(403);
  await openAgents(page);
  const dialog = await createDialog(page, "Viewer personal key", "keyboard");
  await choose(page, "Expiry", "60 days", "keyboard");
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
      "API key",
      "Status",
      "Expires",
      "Last used",
      "Action",
    ]);
    expect(columns.every((column) => column.right <= 1280)).toBe(true);
    await writeFile(
      testInfo.outputPath(`api-keys-desktop-${theme}-columns.json`),
      JSON.stringify(columns, null, 2),
    );
    await expectTheme(page, theme);
    await page.screenshot({
      path: testInfo.outputPath(`api-keys-desktop-${theme}.png`),
      fullPage: true,
      animations: "disabled",
    });
    await page.goto("/settings/agents");
    await expect(
      page.getByRole("row", { name: new RegExp(visibleAgent.name) }),
    ).toBeVisible();
    await expectTheme(page, theme);
    await page.screenshot({
      path: testInfo.outputPath(`agent-directory-desktop-${theme}.png`),
      fullPage: true,
      animations: "disabled",
    });
    await openAgents(page);
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
    const action = mobile.getByRole("button", {
      name: "Revoke Release planning reader",
      exact: true,
    });
    const longAction = mobile.getByRole("button", {
      name: `Revoke ${longCredentialName}`,
      exact: true,
    });
    for (const target of [action, longAction]) {
      const bounds = await target.boundingBox();
      expect(
        Boolean(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390),
      ).toBe(true);
      await target.tap();
      await expect(
        mobile.getByRole("dialog", { name: "Revoke API key?" }),
      ).toBeVisible();
      await mobile
        .getByRole("dialog")
        .getByRole("button", { name: "Cancel", exact: true })
        .tap();
    }
    expect(longCredential.credential.agentId).toBeNull();
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
      expect(cells).toHaveLength(1);
      expect(cells.every((cell) => cell.right <= 390)).toBe(true);
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
        fullPage: true,
        animations: "disabled",
      });
      await mobile.goto("/settings/agents");
      await expect(
        mobile.getByRole("row", { name: new RegExp(visibleAgent.name) }),
      ).toBeVisible();
      await expectTheme(mobile, theme);
      await mobile.screenshot({
        path: testInfo.outputPath(`agent-directory-phone-${theme}.png`),
        fullPage: true,
        animations: "disabled",
      });
      await openAgents(mobile);
      const form = await createDialog(
        mobile,
        "Phone viewer personal key",
        "touch",
      );
      await choose(mobile, "Expiry", "90 days", "touch");
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

test("125 active people keep selections across pages and search with bounded wheel, keyboard and touch controls", async ({
  page,
  browser,
}, testInfo) => {
  const fixture = await getBrowserBootstrap(origin);
  const creator = fixture.identity.user;
  try {
    await authenticateBrowserFixture(page, fixture);
  } finally {
    await fixture.api.dispose();
  }
  const state = await database();
  type Person = { id: string; name: string; email: string };
  let people: Person[];
  try {
    people = await state.sql.unsafe<Person[]>(
      `INSERT INTO "${state.schema}".users(id,workspace_id,name,email,password_hash,role) SELECT gen_random_uuid(),(SELECT id FROM "${state.schema}".workspace),'Stress person '||lpad(n::text,3,'0')||' for international planning, accessibility and long member directory verification','stress-members-'||lpad(n::text,3,'0')||'@example.test','picker-fixture-has-no-login','member' FROM generate_series(1,125)n RETURNING id,name,email`,
    );
  } finally {
    await state.sql.end();
  }
  const first = people.find(
    (person) => person.email === "stress-members-002@example.test",
  )!;
  const late = people.find(
    (person) => person.email === "stress-members-125@example.test",
  )!;
  let created: { id: string; version: number } | null = null;
  const phone = await browser.newContext({
    baseURL: origin,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    storageState: await page.context().storageState(),
  });
  async function selection(
    target: Page,
    dialog: Locator,
    person: Person,
    touch = false,
  ) {
    const search = dialog.getByRole("searchbox", {
      name: "Search people",
      exact: true,
    });
    const group = dialog.getByRole("group", {
      name: "Assigned people",
      exact: true,
    });
    await search.fill(person.email);
    const checkbox = group.getByRole("checkbox", {
      name: `${person.name} (${person.email})`,
      exact: true,
    });
    if (touch) await group.getByText(person.email, { exact: true }).tap();
    else await group.getByText(person.email, { exact: true }).click();
    await expect(checkbox).toBeChecked();
    await checkbox.focus();
    await target.keyboard.press("Space");
    await expect(checkbox).not.toBeChecked();
    await target.keyboard.press("Space");
    await expect(checkbox).toBeChecked();
    await search.fill("a search with no matching people");
    await expect(
      group.getByRole("checkbox", {
        name: `${creator.name} (${creator.email})`,
        exact: true,
      }),
    ).toBeVisible();
    await search.fill(person.email);
    await expect(checkbox).toBeChecked();
    await search.clear();
  }
  async function bounded(target: Page, dialog: Locator, touch: boolean) {
    const group = dialog.getByRole("group", {
      name: "Assigned people",
      exact: true,
    });
    const list = group.getByRole("region", {
      name: "People choices",
      exact: true,
    });
    const more = dialog.getByRole("button", {
      name: "Load more people",
      exact: true,
    });
    await expect(list.getByRole("checkbox")).toHaveCount(25);
    let pages = 0;
    while (await more.count()) {
      const before = await list.getByRole("checkbox").count();
      if (touch) await more.tap();
      else await more.click();
      await expect
        .poll(() => list.getByRole("checkbox").count())
        .toBeGreaterThan(before);
      pages++;
      expect(pages).toBeLessThan(8);
    }
    expect(pages).toBeGreaterThanOrEqual(4);
    await expect(
      group.getByRole("checkbox", {
        name: `${late.name} (${late.email})`,
        exact: true,
      }),
    ).toHaveCount(1);
    const owner = group.getByRole("checkbox", {
      name: `${creator.name} (${creator.email})`,
      exact: true,
    });
    await expect(owner).toBeChecked();
    await expect(owner).toBeDisabled();
    await list.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect
      .poll(() => list.evaluate((element) => element.scrollTop))
      .toBe(0);
    const ownerBefore = await owner.boundingBox();
    const submit = dialog.getByRole("button", {
      name: /^(Create agent|Save changes)$/,
    });
    const footerBefore = await submit.boundingBox();
    const bounds = await list.boundingBox();
    const viewport = target.viewportSize()!;
    expect(
      Boolean(
        bounds &&
        bounds.x >= 0 &&
        bounds.y >= 0 &&
        bounds.x + bounds.width <= viewport.width &&
        bounds.height <= viewport.height * 0.45,
      ),
    ).toBe(true);
    expect(
      Boolean(
        footerBefore && footerBefore.y + footerBefore.height <= viewport.height,
      ),
    ).toBe(true);
    expect(
      await list.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    ).toBe(true);
    if (!bounds) throw new Error("People choices must be visible");
    if (touch) {
      const session = await target.context().newCDPSession(target);
      try {
        const x = bounds.x + bounds.width / 2;
        const y = bounds.y + bounds.height * 0.8;
        await session.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x, y }],
        });
        for (const distance of [40, 80, 120])
          await session.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x, y: y - distance }],
          });
        await session.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
      } finally {
        await session.detach();
      }
    } else {
      await target.mouse.move(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
      );
      await target.mouse.wheel(0, 350);
    }
    await expect
      .poll(() => list.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    if (!touch) {
      const beforeKeyboard = await list.evaluate(
        (element) => element.scrollTop,
      );
      await list.focus();
      await target.keyboard.press("End");
      await expect
        .poll(() => list.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(beforeKeyboard);
      await target.keyboard.press("Home");
      await expect
        .poll(() => list.evaluate((element) => element.scrollTop))
        .toBe(0);
    }
    expect((await owner.boundingBox())?.y).toBe(ownerBefore?.y);
    expect((await submit.boundingBox())?.y).toBe(footerBefore?.y);
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    expect(
      await target.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  try {
    const directory = await json(admin, "/auth/members");
    expect(
      directory.items.filter((person: Person) =>
        person.email.startsWith("stress-members-"),
      ).length,
    ).toBe(125);
    await page.goto("/settings/agents");
    await chooseTheme(page, "light");
    await page
      .getByRole("button", { name: "Create agent", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Create agent",
      exact: true,
    });
    await dialog
      .getByLabel("Name", { exact: true })
      .fill("Many people team assistant");
    await choose(page, "Access", "Team");
    for (const theme of ["light", "dark"] as const) {
      if (theme === "dark") {
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        await chooseTheme(page, theme);
        await page
          .getByRole("button", { name: "Create agent", exact: true })
          .click();
        await dialog
          .getByLabel("Name", { exact: true })
          .fill("Many people team assistant");
        await choose(page, "Access", "Team");
      }
      await expectTheme(page, theme);
      await selection(page, dialog, first);
      await bounded(page, dialog, false);
      await expect(
        dialog.getByRole("checkbox", {
          name: `${first.name} (${first.email})`,
          exact: true,
        }),
      ).toBeChecked();
      await selection(page, dialog, late);
      await dialog
        .getByRole("searchbox", { name: "Search people", exact: true })
        .fill(late.email);
      await expect(
        dialog.getByRole("checkbox", {
          name: `${late.name} (${late.email})`,
          exact: true,
        }),
      ).toBeChecked();
      await expectTheme(page, theme);
      await page.screenshot({
        path: testInfo.outputPath(`agent-people-desktop-${theme}.png`),
        animations: "disabled",
      });
    }
    await dialog
      .getByRole("button", { name: "Create agent", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    const saved = (
      await json(admin, "/agents?manage=true&limit=100")
    ).items.find(
      (item: { name: string }) => item.name === "Many people team assistant",
    );
    created = saved;
    expect(saved.memberIds.toSorted()).toEqual(
      [creator.id, first.id, late.id].toSorted(),
    );
    const mobile = await phone.newPage();
    await mobile.goto("/settings/agents");
    for (const theme of ["dark", "light"] as const) {
      await chooseTheme(mobile, theme, true);
      await mobile
        .getByRole("button", {
          name: "Edit Many people team assistant",
          exact: true,
        })
        .tap();
      const edit = mobile.getByRole("dialog", {
        name: "Edit agent",
        exact: true,
      });
      await bounded(mobile, edit, true);
      for (const person of [first, late]) {
        await edit
          .getByRole("searchbox", { name: "Search people", exact: true })
          .fill(person.email);
        const checkbox = edit.getByRole("checkbox", {
          name: `${person.name} (${person.email})`,
          exact: true,
        });
        await expect(checkbox).toBeChecked();
        await edit.getByText(person.email, { exact: true }).tap();
        await expect(checkbox).not.toBeChecked();
        await edit.getByText(person.email, { exact: true }).tap();
        await expect(checkbox).toBeChecked();
      }
      await expectTheme(mobile, theme);
      await mobile.screenshot({
        path: testInfo.outputPath(`agent-people-phone-${theme}.png`),
        animations: "disabled",
      });
      await edit.getByRole("button", { name: "Cancel", exact: true }).tap();
    }
  } finally {
    await phone.close();
    if (created)
      await json(
        admin,
        `/agents/${created.id}`,
        { version: created.version },
        "DELETE",
      );
    const cleanup = await database();
    try {
      await cleanup.sql.unsafe(
        `DELETE FROM "${cleanup.schema}".users WHERE email LIKE 'stress-members-%@example.test'`,
      );
    } finally {
      await cleanup.sql.end();
    }
  }
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
    await choose(page, "Expiry", name === names[0] ? "30 days" : "90 days");
    await dialog
      .getByRole("button", { name: "Create API key", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText(
      "The server response was incomplete",
    );
    await expect(page.getByLabel("API key", { exact: true })).toHaveCount(0);
  }
  await dialog.getByLabel("Name", { exact: true }).fill(names[0]);
  await choose(page, "Expiry", "30 days");
  await dialog
    .getByRole("button", { name: "Create API key", exact: true })
    .click();
  const reveal = page.getByRole("dialog", { name: "Copy your API key" });
  await expect(reveal).toBeVisible();
  expect(keys[0] !== keys[1]).toBe(true);
  expect(keys[0] === keys[2]).toBe(true);
  expect(
    (await reveal.getByLabel("API key", { exact: true }).inputValue()) ===
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

test("all team members includes future people and switching back preserves named grants through conflict recovery", async ({
  page,
  browser,
}) => {
  const fixture = await getBrowserBootstrap(origin);
  const creator = fixture.identity.user;
  try {
    await authenticateBrowserFixture(page, fixture);
  } finally {
    await fixture.api.dispose();
  }
  const member = await getBrowserRoleFixture(origin, "member");
  const viewer = await getBrowserRoleFixture(origin, "viewer");
  const future = await browser.newContext({ baseURL: origin });
  let created: { id: string; version: number } | null = null;
  try {
    await page.goto("/settings/agents");
    await page
      .getByRole("button", { name: "Create agent", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Create agent",
      exact: true,
    });
    await dialog
      .getByLabel("Name", { exact: true })
      .fill("Whole team assistant");
    await expect(
      dialog.getByRole("checkbox", { name: "All team members", exact: true }),
    ).toHaveCount(0);
    await choose(page, "Access", "Team");
    const group = dialog.getByRole("group", {
      name: "Assigned people",
      exact: true,
    });
    await group.getByText(viewer.identity.user.email, { exact: true }).click();
    await expect(
      group.getByRole("checkbox", {
        name: `${viewer.identity.user.name} (${viewer.identity.user.email})`,
        exact: true,
      }),
    ).toBeChecked();
    await dialog.getByText("All team members", { exact: true }).click();
    await expect(
      dialog.getByRole("checkbox", { name: "All team members", exact: true }),
    ).toBeChecked();
    await expect(
      dialog.getByRole("searchbox", { name: "Search people", exact: true }),
    ).toBeDisabled();
    await expect(
      group.getByRole("checkbox", {
        name: `${creator.name} (${creator.email})`,
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      group.getByRole("checkbox", {
        name: `${member.identity.user.name} (${member.identity.user.email})`,
        exact: true,
      }),
    ).toBeDisabled();
    await dialog
      .getByRole("button", { name: "Create agent", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    created = (await json(admin, "/agents?manage=true&limit=100")).items.find(
      (item: { name: string }) => item.name === "Whole team assistant",
    );
    if (!created) throw new Error("Whole team Agent must be persisted");
    const id = created.id;
    const current = (await json(admin, `/agents/${id}?manage=true`)).agent;
    expect(current.allMembers).toBe(true);
    expect(current.memberIds.toSorted()).toEqual(
      [creator.id, viewer.identity.user.id].toSorted(),
    );
    expect(
      (await json(member.api, "/agents?limit=100")).items.some(
        (item: { id: string }) => item.id === id,
      ),
    ).toBe(true);
    const invitation = await json(admin, "/auth/invitations", {
      email: "browser-agent-future-member@example.test",
      role: "member",
    });
    await json(future.request, "/auth/accept-invitation", {
      token: invitation.token,
      name: "Future team member",
      password: "Browser-future-member-password-42",
    });
    expect(
      (await json(future.request, "/agents?limit=100")).items.some(
        (item: { id: string }) => item.id === id,
      ),
    ).toBe(true);
    await page
      .getByRole("button", { name: "Edit Whole team assistant", exact: true })
      .click();
    const edit = page.getByRole("dialog", { name: "Edit agent", exact: true });
    await edit.getByText("All team members", { exact: true }).click();
    await expect(
      edit.getByRole("searchbox", { name: "Search people", exact: true }),
    ).toBeEnabled();
    await expect(
      edit.getByRole("checkbox", {
        name: `${creator.name} (${creator.email})`,
        exact: true,
      }),
    ).toBeChecked();
    await expect(
      edit.getByRole("checkbox", {
        name: `${viewer.identity.user.name} (${viewer.identity.user.email})`,
        exact: true,
      }),
    ).toBeChecked();
    const changed = (
      await json(
        admin,
        `/agents/${id}`,
        { version: current.version, name: "Whole team changed elsewhere" },
        "PATCH",
      )
    ).agent;
    created = changed;
    await edit
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(edit.getByRole("alert")).toBeVisible();
    await expect(
      edit.getByRole("checkbox", { name: "All team members", exact: true }),
    ).not.toBeChecked();
    await expect(
      edit.getByRole("button", { name: "Save changes", exact: true }),
    ).toBeDisabled();
    await edit
      .getByRole("button", { name: "Reload agent", exact: true })
      .click();
    await expect(
      edit.getByRole("checkbox", { name: "All team members", exact: true }),
    ).toBeChecked();
    await edit.getByText("All team members", { exact: true }).click();
    await edit
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(edit.getByRole("status")).toHaveText("Agent updated.");
    await edit.getByRole("button", { name: "Done", exact: true }).click();
    const saved = (await json(admin, `/agents/${id}?manage=true`)).agent;
    created = saved;
    expect(saved.allMembers).toBe(false);
    expect(saved.memberIds.toSorted()).toEqual(
      [creator.id, viewer.identity.user.id].toSorted(),
    );
    expect(
      (await json(future.request, "/agents?limit=100")).items.some(
        (item: { id: string }) => item.id === id,
      ),
    ).toBe(false);
    expect(
      (await json(member.api, "/agents?limit=100")).items.some(
        (item: { id: string }) => item.id === id,
      ),
    ).toBe(false);
    expect(
      (await json(viewer.api, "/agents?limit=100")).items.some(
        (item: { id: string }) => item.id === id,
      ),
    ).toBe(true);
    expect(
      (await json(admin, "/agents?limit=100")).items.some(
        (item: { id: string }) => item.id === id,
      ),
    ).toBe(true);
  } finally {
    if (created)
      await json(
        admin,
        `/agents/${created.id}`,
        { version: created.version },
        "DELETE",
      );
    await future.close();
    await member.api.dispose();
    await viewer.api.dispose();
  }
});
