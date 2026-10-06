import { expect, test, type Page } from "@playwright/test";
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

async function openNavigation(page: Page) {
  const toggle = page.getByRole("banner").getByRole("button", {
    name: /^(Open|Close) navigation$/,
  });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
  await expect(
    page.getByRole("navigation", { name: "Workspace navigation", exact: true }),
  ).toBeVisible();
}

const accountPages = [
  ["profile", "Profile", "Profile"],
  ["preferences", "Preferences", "Preferences"],
  ["email-password", "Email & Password", "Email & Password"],
  ["two-factor", "Two-factor Auth", "Two-factor Auth"],
  ["sessions", "Sessions", "Sessions"],
  ["api-keys", "API Keys", "API keys"],
  ["mcp", "MCP Guide", "MCP Guide"],
] as const;

for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`focused settings navigation at ${width}px in ${theme}`, async ({
      browser,
    }, testInfo) => {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: width === 390,
        hasTouch: width === 390,
        reducedMotion: "reduce",
      });
      try {
        await context.addInitScript(
          (value) => localStorage.setItem("mill:theme", value),
          theme,
        );
        await context.grantPermissions(["clipboard-read", "clipboard-write"], {
          origin: fixture.origin,
        });
        const page = await context.newPage();
        await authenticateBrowserFixture(page, fixture);
        await page.goto("/settings/profile");
        const primary = page.getByRole("navigation", {
          name: "Workspace navigation",
          exact: true,
        });
        const accountNavigation = page.getByRole("navigation", {
          name: "Account settings navigation",
          exact: true,
        });
        for (const [section, label, title] of accountPages) {
          await openNavigation(page);
          await expect(
            primary.getByRole("link", { name: "API keys", exact: true }),
          ).toHaveCount(0);
          await expect(
            primary.getByRole("link", { name: "People", exact: true }),
          ).toHaveCount(0);
          await expect(
            primary.getByRole("heading", { name: "Workspace", exact: true }),
          ).toHaveCount(0);
          await expect(
            primary.getByRole("heading", { name: "Settings", exact: true }),
          ).toBeVisible();
          await expect(
            primary.getByRole("link", {
              name: "Account settings",
              exact: true,
            }),
          ).toHaveAttribute("aria-current", "page");
          await accountNavigation
            .getByRole("link", { name: label, exact: true })
            .click();
          await expect(page).toHaveURL(`/settings/${section}`);
          await expect(
            page.getByRole("heading", { name: title, exact: true, level: 1 }),
          ).toBeVisible();
          await expect(
            page.getByRole("navigation", { name: "Breadcrumb", exact: true }),
          ).toContainText("Account");
          await expect(
            page.getByRole("navigation", { name: "Breadcrumb", exact: true }),
          ).toContainText(title);
          if (section === "mcp") {
            const guide = page.getByRole("region", {
              name: "Connect your MCP client",
              exact: true,
            });
            const picker = guide.getByRole("button", { name: /Client/ });
            const code = guide.getByLabel("MCP configuration", { exact: true });
            const endpoint = `${fixture.origin}/mcp`;
            await expect(picker).toContainText("Cursor");
            for (const [name, filename, expectedCode] of [
              [
                "Codex",
                "~/.codex/config.toml",
                `[mcp_servers.mill]\nurl = ${JSON.stringify(endpoint)}`,
              ],
              [
                "Claude Code",
                "Claude Code",
                `claude mcp add --transport http mill '${endpoint}'`,
              ],
              [
                "VS Code",
                ".vscode/mcp.json",
                JSON.stringify(
                  { servers: { mill: { type: "http", url: endpoint } } },
                  null,
                  2,
                ),
              ],
              [
                "Other clients",
                "Connection details",
                `Transport: Streamable HTTP\nURL: ${endpoint}\nAuthentication: OAuth`,
              ],
              [
                "Cursor",
                ".cursor/mcp.json",
                JSON.stringify(
                  { mcpServers: { mill: { url: endpoint } } },
                  null,
                  2,
                ),
              ],
            ]) {
              await picker.click();
              await page.getByRole("option", { name, exact: true }).click();
              await expect(picker).toContainText(name!);
              await expect(
                guide.locator('[data-slot="code-block-filename"]'),
              ).toHaveText(filename!);
              await expect(code).toHaveText(expectedCode!);
              await guide
                .getByRole("button", { name: "Copy code", exact: true })
                .click();
              await expect(
                page
                  .locator('[data-slot="toast"]:not([data-exiting="true"])')
                  .filter({ hasText: "Copied to clipboard." })
                  .last(),
              ).toBeVisible();
              expect(
                await page.evaluate(() => navigator.clipboard.readText()),
              ).toBe(expectedCode);
              expect(
                await page.evaluate(
                  () =>
                    document.documentElement.scrollWidth <= window.innerWidth,
                ),
              ).toBe(true);
            }
            await code.focus();
            await expect(code).toBeFocused();
            await expect(
              guide.getByRole("link", {
                name: "MCP setup and troubleshooting",
                exact: true,
              }),
            ).toHaveAttribute("href", "https://mill.fyi/clients");
            await expect(
              guide.getByRole("link", { name: "API keys", exact: true }),
            ).toHaveAttribute("href", "/settings/api-keys");
          }
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
          ).toBe(true);
          await page.screenshot({
            path: testInfo.outputPath(`${section}-${width}-${theme}.png`),
            fullPage: true,
            animations: "disabled",
          });
          await openNavigation(page);
          await expect(
            accountNavigation.getByRole("link", { name: label, exact: true }),
          ).toHaveAttribute("aria-current", "page");
        }
        await primary
          .getByRole("link", { name: "Team settings", exact: true })
          .click();
        await expect(page).toHaveURL("/settings/workspace");
        const teamNavigation = page.getByRole("navigation", {
          name: "Team settings navigation",
          exact: true,
        });
        await openNavigation(page);
        await expect(
          teamNavigation.getByRole("link", { name: "General", exact: true }),
        ).toHaveAttribute("aria-current", "page");
        await teamNavigation
          .getByRole("link", { name: "Members", exact: true })
          .click();
        await expect(page).toHaveURL("/settings/members");
        await openNavigation(page);
        await expect(
          primary.getByRole("link", { name: "Team settings", exact: true }),
        ).toHaveAttribute("aria-current", "page");
        await expect(
          teamNavigation.getByRole("link", { name: "Members", exact: true }),
        ).toHaveAttribute("aria-current", "page");
        await page.screenshot({
          path: testInfo.outputPath(`team-navigation-${width}-${theme}.png`),
          fullPage: true,
          animations: "disabled",
        });
        await page.getByRole("button", { name: /^Account menu for / }).click();
        const menu = page.getByRole("menu", {
          name: /^Account menu/,
        });
        await expect(menu.getByText("Account", { exact: true })).toBeVisible();
        await expect(menu.getByText("Mill", { exact: true })).toBeVisible();
        await expect(
          menu.getByRole("group", { name: "Account", exact: true }),
        ).toBeVisible();
        await expect(
          menu.getByRole("group", { name: "Mill", exact: true }),
        ).toBeVisible();
        await page.screenshot({
          path: testInfo.outputPath(`account-menu-${width}-${theme}.png`),
          fullPage: true,
          animations: "disabled",
        });
        await expect(menu.getByRole("menuitem")).toHaveText([
          "Profile",
          "Preferences",
          "Auth & Security",
          "My API Keys",
          "Changelog",
          "Documentation",
          "Feedback",
          "Repo / Contribute",
          "Sign out",
        ]);
        await expect(
          menu.getByRole("menuitem", { name: "Documentation", exact: true }),
        ).toHaveAttribute("href", "https://mill.fyi");
        await menu
          .getByRole("menuitem", { name: "Auth & Security", exact: true })
          .click();
        await expect(page).toHaveURL("/settings/email-password");
        await page.goBack();
        await expect(page).toHaveURL("/settings/members");
        await page
          .getByRole("button", { name: "Navigate team pages", exact: true })
          .click();
        await page
          .getByRole("menu")
          .getByRole("menuitem", { name: "General", exact: true })
          .click();
        await expect(page).toHaveURL("/settings/workspace");
        await page.goto("/settings/security");
        await expect(
          page.getByRole("heading", {
            name: "Email & Password",
            exact: true,
            level: 1,
          }),
        ).toBeVisible();
        await openNavigation(page);
        await expect(
          accountNavigation.getByRole("link", {
            name: "Email & Password",
            exact: true,
          }),
        ).toHaveAttribute("aria-current", "page");
      } finally {
        await context.close();
      }
    });
  }

test("MCP configuration remains available when clipboard access fails", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async () => {
            throw new DOMException("Clipboard denied", "NotAllowedError");
          },
        },
        configurable: true,
      });
    });
    const page = await context.newPage();
    await authenticateBrowserFixture(page, fixture);
    await page.goto("/settings/mcp");
    const guide = page.getByRole("region", {
      name: "Connect your MCP client",
      exact: true,
    });
    await guide.getByRole("button", { name: "Copy code", exact: true }).click();
    await expect(
      page.locator('[data-slot="toast"]').filter({
        hasText:
          "Could not copy the configuration. Select it and copy it manually.",
      }),
    ).toBeVisible();
    await expect(
      guide.getByRole("button", { name: "Copy code", exact: true }),
    ).toBeVisible();
    await expect(
      guide.getByLabel("MCP configuration", { exact: true }),
    ).toContainText(`${fixture.origin}/mcp`);
    const picker = guide.getByRole("button", { name: /Client/ });
    await picker.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("listbox", { name: "Client", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    await expect(picker).toContainText("Codex");
    await expect(picker).toBeFocused();
    await guide.getByRole("link", { name: "API keys", exact: true }).click();
    await expect(page).toHaveURL("/settings/api-keys");
  } finally {
    await context.close();
  }
});
