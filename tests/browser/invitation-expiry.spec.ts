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
  workspaceName: "Mill invitation expiry verification",
  name: "Alex Morgan",
  email: "browser-expiry-admin@example.test",
  password: "Browser-only-password-42",
};
let origin: string;
let admin: APIRequestContext;
let userId: string;
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
    page.getByRole("button", { name: /^Notifications(?:, \d+ unread)?$/ }),
  ).toBeVisible();
  await page.goto(path);
  await expect(
    page.getByRole("heading", {
      name: path.endsWith("workspace") ? "General" : "People",
      exact: true,
      level: 1,
    }),
  ).toBeVisible();
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

for (const width of [1280, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`invitation expiry is relative only and expired rows disappear at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      const { sql, schema } = await database();
      const suffix = `${width}-${theme}`;
      const activeEmail = `active-expiry-${suffix}@example.test`;
      const expiringEmail = `soon-expired-${suffix}@example.test`;
      const expiredEmail = `already-expired-${suffix}@example.test`;
      const emails = [activeEmail, expiringEmail, expiredEmail];
      try {
        await sql.unsafe(`SET search_path TO "${schema}",public`);
        const now = Date.now();
        for (const [index, email] of emails.entries()) {
          await sql`INSERT INTO invitations(id,email,role,token_hash,invited_by,expires_at)
            VALUES(${randomUUID()},${email},'viewer',${randomUUID()},${userId},${new Date(now + [86400000, 60000, -60000][index]!).toISOString()})`;
        }
        await page.setViewportSize({ width, height: 844 });
        await page.addInitScript(
          (theme) => localStorage.setItem("avgeek-oss-ui-theme", theme),
          theme,
        );
        await page.clock.install({ time: now });
        const invitationResponse = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/auth/invitations" &&
            response.request().method() === "GET",
        );
        await login(page);
        expect((await invitationResponse).status()).toBe(200);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        const invitations = page.getByRole("region", {
          name: "Invitations",
          exact: true,
        });
        const active = invitations
          .getByRole("row")
          .filter({ hasText: activeEmail });
        await expect(active).toBeVisible();
        await expect(active.locator("time")).toHaveText(/^Expires in .+$/);
        await expect(active.locator("time > span")).toHaveCount(1);
        await expect(
          invitations.getByText(expiringEmail, { exact: true }),
        ).toBeVisible();
        await expect(
          invitations.getByText(expiredEmail, { exact: true }),
        ).toHaveCount(0);
        await testInfo.attach(`invitation-${suffix}`, {
          body: await active.screenshot(),
          contentType: "image/png",
        });
        await page.clock.fastForward(61000);
        await expect(
          invitations.getByText(expiringEmail, { exact: true }),
        ).toHaveCount(0);
        await expect(active).toBeVisible();
        expect(
          (await sql`SELECT id FROM invitations WHERE email=${expiringEmail}`)
            .length,
        ).toBe(1);
      } finally {
        await sql`DELETE FROM invitations WHERE email IN ${sql(emails)}`;
        await sql.end();
      }
    });
  }
}
