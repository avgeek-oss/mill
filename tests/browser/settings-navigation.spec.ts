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
  const toggle = page.getByRole("button", {
    name: "Toggle navigation",
    exact: true,
    includeHidden: true,
  });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await expect(toggle).toBeVisible();
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveAttribute(
    "aria-controls",
    "application-navigation",
  );
  if ((page.viewportSize()?.width ?? 0) < 1024)
    await expect(
      page.getByRole("dialog", { name: "Navigation", exact: true }),
    ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Workspace navigation", exact: true }),
  ).toBeVisible();
}

const accountPages = [
  ["profile", "Profile", "Profile"],
  ["preferences", "Preferences", "Preferences"],
  ["email-password", "Email & Password", "Email & Password"],
  ["passkeys", "Passkeys", "Passkeys"],
  ["sessions", "Sessions", "Sessions"],
  ["api-keys", "API Keys", "API Keys"],
  ["mcp-connections", "MCP Connections", "MCP Connections"],
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
          (value) => localStorage.setItem("avgeek-oss-ui-theme", value),
          theme,
        );
        await context.grantPermissions(["clipboard-read", "clipboard-write"], {
          origin: fixture.origin,
        });
        const page = await context.newPage();
        await authenticateBrowserFixture(page, fixture);
        await page.goto("/settings/two-factor");
        await expect(
          page.getByRole("heading", {
            name: "Passkeys",
            exact: true,
            level: 1,
          }),
        ).toHaveCount(1);
        await expect(
          page.getByRole("region", { name: "Authenticator", exact: true }),
        ).toHaveCount(0);
        await page.goto("/settings/profile");
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        const primary = page.getByRole("navigation", {
          name: "Workspace navigation",
          exact: true,
        });
        const accountNavigation = page.getByRole("navigation", {
          name: "Page navigation",
          exact: true,
        });
        for (const [section, label, title] of accountPages) {
          await openNavigation(page);
          await expect(
            primary.getByRole("link", { name: "API Keys", exact: true }),
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
              name: "Account Settings",
              exact: true,
            }),
          ).toHaveClass(/\bbg-default\b/);
          await expect(
            primary.getByRole("link", { name: "Team Settings", exact: true }),
          ).not.toHaveClass(/\bbg-default\b/);
          await expect(accountNavigation.getByRole("button")).toHaveText(
            accountPages.map(([, pageLabel]) => pageLabel),
          );
          await accountNavigation
            .getByRole("button", { name: label, exact: true })
            .click();
          await expect(page).toHaveURL(`/settings/${section}`);
          await expect(
            page.getByRole("heading", { name: title, exact: true, level: 1 }),
          ).toBeVisible();
          await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
          await expect
            .poll(() =>
              page.getByRole("heading", { level: 1 }).evaluate((heading) => {
                const icon = heading.querySelector("svg");
                if (!icon) throw new Error("Settings heading icon missing");
                const bounds = icon.getBoundingClientRect();
                return {
                  fontSize: getComputedStyle(heading).fontSize,
                  iconWidth: bounds.width,
                  iconHeight: bounds.height,
                };
              }),
            )
            .toEqual({ fontSize: "18px", iconWidth: 24, iconHeight: 24 });
          if (section === "passkeys") {
            await expect(
              page.getByRole("button", { name: "Add passkey", exact: true }),
            ).toBeVisible();
            const empty = page.getByRole("heading", {
              name: "No passkeys added",
              exact: true,
            });
            await expect(empty).toBeVisible();
            const gap = await empty.evaluate((title) => {
              const panel = title.closest('[data-slot="widget"]');
              const heading = document.querySelector(
                'h1[data-slot="application-page-heading"]',
              );
              if (!panel || !heading)
                throw new Error("Passkeys layout is incomplete");
              return (
                panel.getBoundingClientRect().top -
                heading.getBoundingClientRect().bottom
              );
            });
            expect(gap).toBeGreaterThanOrEqual(20);
            expect(gap).toBeLessThanOrEqual(28);
          }
          if (section === "profile") {
            await expect(page.locator('main [data-slot="widget"]')).toHaveCount(
              1,
            );
            const profile = page
              .locator('[data-slot="widget"]')
              .filter({ has: page.getByLabel("Your Name", { exact: true }) });
            await expect(
              profile.getByRole("link", {
                name: "Edit Gravatar image (opens in a new tab)",
                exact: true,
              }),
            ).toHaveCount(0);
            if (width >= 1024) {
              const bounds = await profile.boundingBox();
              const mainBounds = await page.locator("main").boundingBox();
              expect(bounds!.width).toBeLessThan(mainBounds!.width * 0.55);
            }
          }
          const breadcrumb = page.getByRole("navigation", {
            name: "Breadcrumb",
            exact: true,
            includeHidden: true,
          });
          if (width >= 1024) {
            await expect(breadcrumb).toContainText("Account Settings");
            await expect(breadcrumb).toContainText(title);
          } else await expect(breadcrumb).toBeHidden();
          if (section === "mcp") {
            const guide = page.getByRole("region", {
              name: "Connect your MCP client",
              exact: true,
            });
            const picker = guide.getByRole("button", { name: /App/ });
            const code = guide.getByLabel("MCP configuration", { exact: true });
            const endpoint = `${fixture.origin}/mcp`;
            await expect(picker).toContainText("Codex");
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
                .getByRole("button", {
                  name: "Copy MCP configuration",
                  exact: true,
                })
                .click();
              await expect(
                page
                  .locator('[data-slot="toast"]:not([data-exiting="true"])')
                  .filter({ hasText: "Copied to clipboard." })
                  .last(),
              ).toBeVisible();
              await expect(
                guide.getByText("Copied to clipboard.", { exact: true }),
              ).toHaveCount(0);
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
            await expect(guide.getByRole("link")).toHaveCount(1);
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
            accountNavigation.getByRole("button", { name: label, exact: true }),
          ).toHaveAttribute("aria-current", "page");
        }
        await primary
          .getByRole("link", { name: "Team Settings", exact: true })
          .click();
        await expect(page).toHaveURL("/team-settings/general");
        const teamNavigation = page.getByRole("navigation", {
          name: "Page navigation",
          exact: true,
        });
        await openNavigation(page);
        await expect(
          teamNavigation.getByRole("button", { name: "General", exact: true }),
        ).toHaveAttribute("aria-current", "page");
        await teamNavigation
          .getByRole("button", { name: "Members", exact: true })
          .click();
        await expect(page).toHaveURL("/team-settings/members");
        await openNavigation(page);
        await expect(
          primary.getByRole("link", { name: "Team Settings", exact: true }),
        ).toHaveClass(/\bbg-default\b/);
        await expect(
          primary.getByRole("link", { name: "Account Settings", exact: true }),
        ).not.toHaveClass(/\bbg-default\b/);
        await expect(teamNavigation.getByRole("button")).toHaveText([
          "General",
          "Members",
        ]);
        await expect(
          teamNavigation.getByRole("button", { name: "Members", exact: true }),
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
          "Email & Password",
          "API Keys",
          "Changelog",
          "Documentation",
          "Leave Feedback",
          "Sign out",
        ]);
        await context.route("https://mill.fyi/", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: "<title>Mill documentation</title>",
          }),
        );
        const documentationOpened = context.waitForEvent("page");
        await menu
          .getByRole("menuitem", { name: "Documentation", exact: true })
          .click();
        const documentation = await documentationOpened;
        await expect(documentation).toHaveURL("https://mill.fyi/");
        await documentation.close();
        await openNavigation(page);
        await page.getByRole("button", { name: /^Account menu for / }).click();
        await menu
          .getByRole("menuitem", { name: "Email & Password", exact: true })
          .click();
        await expect(page).toHaveURL("/settings/email-password");
        await page.goBack();
        await expect(page).toHaveURL("/team-settings/members");
        if (width >= 1024) {
          await page
            .getByRole("navigation", { name: "Breadcrumb", exact: true })
            .getByRole("link", { name: "Team Settings", exact: true })
            .click();
        } else {
          await openNavigation(page);
          await teamNavigation
            .getByRole("button", { name: "General", exact: true })
            .click();
        }
        await expect(page).toHaveURL("/team-settings/general");
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
          accountNavigation.getByRole("button", {
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
    await guide
      .getByRole("button", { name: "Copy MCP configuration", exact: true })
      .click();
    await expect(
      page.locator('[data-slot="toast"]').filter({
        hasText:
          "Could not copy to the clipboard. Select and copy the text instead.",
      }),
    ).toBeVisible();
    await expect(
      guide.getByText(
        "Could not copy to the clipboard. Select and copy the text instead.",
        {
          exact: true,
        },
      ),
    ).toHaveCount(0);
    await expect(
      guide.getByRole("button", {
        name: "Copy MCP configuration",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      guide.getByLabel("MCP configuration", { exact: true }),
    ).toContainText(`${fixture.origin}/mcp`);
    const picker = guide.getByRole("button", { name: /App/ });
    await picker.focus();
    await page.keyboard.press("Enter");
    await expect(picker).toHaveAttribute("aria-expanded", "true");
    const clients = page.getByRole("listbox").filter({
      has: page.getByRole("option", { name: "Codex", exact: true }),
    });
    await expect(clients).toBeVisible();
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    await expect(picker).toContainText("Codex");
    await expect(picker).toHaveAttribute("aria-expanded", "false");
    await expect(clients).toBeHidden();
    await expect(picker).toBeFocused();
    await expect(guide.locator('[data-slot="code-block-filename"]')).toHaveText(
      "~/.codex/config.toml",
    );
    await expect(
      guide.getByLabel("MCP configuration", { exact: true }),
    ).toHaveText(
      `[mcp_servers.mill]\nurl = ${JSON.stringify(`${fixture.origin}/mcp`)}`,
    );
    await page.goto("/settings/mcp-connections");
    await expect(
      page.getByRole("heading", { name: "MCP Connections", exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("settings aliases preserve query and fragment while selecting canonical account and team pages", async ({
  page,
}) => {
  await authenticateBrowserFixture(page, fixture);
  for (const [alias, canonical, title, category] of [
    ["/settings", "/settings/profile", "Profile", "Account Settings"],
    ["/team-settings", "/team-settings/general", "General", "Team Settings"],
    [
      "/settings/workspace",
      "/team-settings/general",
      "General",
      "Team Settings",
    ],
    ["/settings/members", "/team-settings/members", "Members", "Team Settings"],
    [
      "/settings/security",
      "/settings/email-password",
      "Email & Password",
      "Account Settings",
    ],
    [
      "/settings/two-factor",
      "/settings/passkeys",
      "Passkeys",
      "Account Settings",
    ],
  ]) {
    await page.goto(`${alias}?review=canonical#section`);
    await expect(page).toHaveURL(`${canonical}?review=canonical#section`);
    await expect(
      page.getByRole("heading", { name: title!, exact: true, level: 1 }),
    ).toBeVisible();
    const breadcrumb = page.getByRole("navigation", {
      name: "Breadcrumb",
      exact: true,
    });
    await expect(breadcrumb).toContainText(category!);
    await expect(
      page
        .locator('[data-slot="toast"]')
        .filter({ hasText: "The link may be outdated" }),
    ).toHaveCount(0);
    await page.reload();
    await expect(page).toHaveURL(`${canonical}?review=canonical#section`);
    await expect(
      page.getByRole("heading", { name: title!, exact: true, level: 1 }),
    ).toBeVisible();
  }
});
