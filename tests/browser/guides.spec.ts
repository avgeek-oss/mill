import { expect, test } from "@playwright/test";

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  test(`bundled guides work without API requests at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const apiRequests: string[] = [];
    const failedAssets: string[] = [];
    page.on("response", (response) => {
      if (/\/assets\//.test(response.url()) && !response.ok())
        failedAssets.push(response.url());
    });
    await page.route("**/api/**", async (route) => {
      apiRequests.push(route.request().url());
      await route.abort("connectionfailed");
    });

    const response = await page.goto("/guides/agents.html");
    expect(response?.status()).toBe(200);
    expect(response?.headers()["content-security-policy"]).toContain(
      "script-src 'self'",
    );
    await expect(
      page.getByRole("heading", { name: "Connect an agent", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("main")).toContainText("Agents");
    await expect(page.getByRole("main")).toContainText("API keys");
    await expect(page.locator("script")).toHaveCount(0);
    expect(
      await page.locator('link[rel="stylesheet"]').count(),
    ).toBeGreaterThan(0);
    await page.evaluate(() => document.fonts.ready);
    expect(
      await page
        .locator("h1")
        .evaluate((element) => getComputedStyle(element).fontSize),
    ).toBe("20px");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expect(page.locator("#use-rest")).toHaveText("Use REST");
    await expect(page.locator("pre").first()).toContainText("MILL_TOKEN");
    await page.getByRole("link", { name: "the REST reference" }).click();
    await expect(page).toHaveURL(/\/guides\/api\.html$/);
    await expect(
      page.getByRole("heading", { name: "REST API", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("main")).toContainText("agentId");
    for (const status of [
      "backlog",
      "todo",
      "in_progress",
      "in_review",
      "done",
      "wont_do",
    ])
      await expect(page.getByRole("main")).toContainText(status);

    await page
      .getByRole("navigation", { name: "Guide navigation" })
      .getByRole("link", { name: "Backup and recovery" })
      .click();
    await expect(page).toHaveURL(/\/guides\/backup\.html$/);
    await expect(
      page.getByRole("heading", { name: "Backup and recovery", exact: true }),
    ).toBeVisible();
    await expect(page.locator("pre").first()).toContainText("tools/backup.sh");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(apiRequests).toEqual([]);
    expect(failedAssets).toEqual([]);
  });
}
