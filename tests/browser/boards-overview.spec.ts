import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  authenticateBrowserFixture,
  getBrowserBootstrap,
  type BrowserFixtureSession,
} from "../browser-fixture.js";

let fixture: BrowserFixtureSession;
let api: APIRequestContext;
let boardId: string;
let taskId: string;
const seededBoardIds: string[] = [];
const boardName =
  "Alpha release planning across teams and product documentation";
test.beforeAll(async ({ baseURL }) => {
  const bootstrap = await getBrowserBootstrap(baseURL!);
  fixture = bootstrap;
  api = bootstrap.api;
  const profile = await api.patch("/api/auth/profile", {
    data: { name: "Alex Morgan — release coordination across product teams" },
  });
  expect(profile.status()).toBe(200);
  for (const name of ["Zulu empty board", boardName]) {
    const response = await api.post("/api/boards", {
      data: {
        name,
        prefix: `OV${randomBytes(4).toString("hex").toUpperCase()}`,
      },
    });
    expect(response.status()).toBe(201);
    const board = (await response.json()).board;
    seededBoardIds.push(board.id);
    if (name === boardName) boardId = board.id;
  }
  for (const status of [
    ...Array<string>(13).fill("backlog"),
    "todo",
    "in_progress",
    "in_review",
    "done",
    "wont_do",
  ]) {
    const response = await api.post(`/api/boards/${boardId}/tasks`, {
      data: { title: `Release task ${status}`, status },
    });
    expect(response.status()).toBe(201);
    if (status === "todo") taskId = (await response.json()).task.id;
  }
  await mkdir("tmp/boards-layout-evidence", { recursive: true });
});
test.afterAll(async () => {
  try {
    for (const id of seededBoardIds) {
      const response = await api.get(`/api/boards/${id}`);
      expect(response.status()).toBe(200);
      const { board } = await response.json();
      const removed = await api.delete(`/api/boards/${id}`, {
        data: { version: board.version },
      });
      expect(removed.status()).toBe(200);
    }
  } finally {
    await api?.dispose();
  }
});
for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`overview counts and filter panel at ${width}px in ${theme}`, async ({
      browser,
    }, testInfo) => {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: width === 390,
        hasTouch: width === 390,
      });
      try {
        await context.addInitScript(
          (value) => localStorage.setItem("avgeek-oss-ui-theme", value),
          theme,
        );
        const page = await context.newPage();
        await authenticateBrowserFixture(page, fixture);
        await page.goto("/");
        await expect(page).toHaveURL(/\/boards$/);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(
          page.getByRole("heading", { name: "Boards", exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("navigation", {
            name: "Page navigation",
            exact: true,
          }),
        ).toHaveCount(0);
        const wrapperGeometry = [];
        for (const viewportWidth of width === 390 ? [390] : [1920, 768, 1280]) {
          await page.setViewportSize({ width: viewportWidth, height: 844 });
          await expect(
            page.getByRole("navigation", {
              name: "Workspace navigation",
              exact: true,
            }),
          ).toHaveCount(viewportWidth >= 1024 ? 1 : 0);
          const readGeometry = () =>
            page
              .getByRole("main")
              .getByRole("list", { name: "Boards", exact: true })
              .evaluate((list) => {
                const element = list.closest(".max-w-7xl")!;
                const style = getComputedStyle(element);
                const bounds = element.getBoundingClientRect();
                const parent = element.closest("main")!.getBoundingClientRect();
                return {
                  maxWidth: style.maxWidth,
                  paddingTop: style.paddingTop,
                  paddingBottom: style.paddingBottom,
                  paddingLeft: style.paddingLeft,
                  paddingRight: style.paddingRight,
                  width: bounds.width,
                  parentWidth: parent.width,
                  leftMargin: bounds.left - parent.left,
                  rightMargin: parent.right - bounds.right,
                };
              });
          await expect
            .poll(async () => {
              const current = await readGeometry();
              return (
                current.parentWidth > viewportWidth / 2 &&
                Math.abs(current.width - Math.min(1280, current.parentWidth)) <=
                  1 &&
                Math.abs(current.leftMargin - current.rightMargin) <= 1
              );
            })
            .toBe(true);
          const geometry = await readGeometry();
          const paddingX = 16;
          expect(geometry.maxWidth).toBe("1280px");
          expect(geometry.paddingTop).toBe("0px");
          expect(geometry.paddingBottom).toBe("80px");
          expect(geometry.paddingLeft).toBe(`${paddingX}px`);
          expect(geometry.paddingRight).toBe(`${paddingX}px`);
          expect(geometry.width).toBe(Math.min(1280, geometry.parentWidth));
          expect(
            Math.abs(geometry.leftMargin - geometry.rightMargin),
          ).toBeLessThanOrEqual(1);
          if (viewportWidth === 1920)
            expect(geometry.leftMargin).toBeGreaterThan(0);
          wrapperGeometry.push({ viewportWidth, ...geometry });
        }
        await testInfo.attach("overview-wrapper-geometry.json", {
          body: Buffer.from(JSON.stringify(wrapperGeometry)),
          contentType: "application/json",
        });
        const cards = page
          .getByRole("main")
          .getByRole("list", { name: "Boards", exact: true });
        await expect(cards.getByRole("link")).toHaveCount(2);
        expect(await cards.getByRole("link").allTextContents()).toEqual([
          expect.stringContaining(boardName),
          expect.stringContaining("Zulu empty board"),
        ]);
        const card = cards.getByRole("link", { name: boardName, exact: true });
        await expect(card.locator("dl > div").nth(0)).toHaveText("Backlog13");
        await expect(card.locator("dl > div").nth(1)).toHaveText("To Do1");
        await expect(card.locator("dl > div").nth(2)).toHaveText(
          "In Progress1",
        );
        await expect(card.locator("h2 svg")).toHaveCount(0);
        await expect(card.locator("dd svg")).toHaveCount(3);
        await expect(
          cards.getByRole("link", { name: "Zulu empty board" }).locator("dd"),
        ).toHaveText(["0", "0", "0"]);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page.screenshot({
          path: `tmp/boards-layout-evidence/overview-${width}-${theme}.png`,
          fullPage: true,
        });
        await card.click();
        await expect(page).toHaveURL(new RegExp(`/boards/${boardId}$`));
        const heading = page.getByRole("heading", {
          name: boardName,
          exact: true,
        });
        const newTask = page.getByRole("button", {
          name: "New task",
          exact: true,
        });
        await expect(newTask).toBeVisible();
        const headerGeometry = [];
        for (const viewportWidth of width === 390 ? [390] : [390, 1280]) {
          await page.setViewportSize({ width: viewportWidth, height: 844 });
          const readHeaderGeometry = () =>
            heading.evaluate((title) => {
              const header = title.closest("header")!;
              const action = header.querySelector("button")!;
              const name = title.querySelector("[data-slot=tooltip-trigger]")!;
              const titleBounds = title.getBoundingClientRect();
              const actionBounds = action.getBoundingClientRect();
              const nameBounds = name.getBoundingClientRect();
              return {
                sameRow:
                  Math.abs(
                    titleBounds.top +
                      titleBounds.height / 2 -
                      actionBounds.top -
                      actionBounds.height / 2,
                  ) < 1,
                textOverflow: getComputedStyle(name).textOverflow,
                clipped: name.scrollWidth > name.clientWidth,
                nameRight: nameBounds.right,
                actionLeft: actionBounds.left,
                actionRight: actionBounds.right,
              };
            });
          await expect
            .poll(async () => (await readHeaderGeometry()).sameRow)
            .toBe(true);
          const geometry = await readHeaderGeometry();
          expect(geometry.textOverflow).toBe("ellipsis");
          if (viewportWidth === 390) expect(geometry.clipped).toBe(true);
          expect(geometry.nameRight).toBeLessThanOrEqual(geometry.actionLeft);
          expect(geometry.actionRight).toBeLessThanOrEqual(viewportWidth);
          headerGeometry.push({ viewportWidth, ...geometry });
        }
        await testInfo.attach("board-header-geometry.json", {
          body: Buffer.from(JSON.stringify(headerGeometry)),
          contentType: "application/json",
        });
        const search = page.getByRole("searchbox", { name: "Search tasks" });
        await expect(search).toBeVisible();
        await page.keyboard.press("/");
        await expect(search).toBeFocused();
        await expect(
          page.getByRole("dialog", {
            name: "Navigation",
            exact: true,
          }),
        ).toHaveCount(0);
        const searchBounds = (await search.boundingBox())!;
        const titleBounds = (await heading.boundingBox())!;
        const tableBounds = (await page
          .getByRole("grid", { name: "Task list", exact: true })
          .boundingBox())!;
        expect(searchBounds.y).toBeGreaterThan(
          titleBounds.y + titleBounds.height,
        );
        expect(searchBounds.y + searchBounds.height).toBeLessThan(
          tableBounds.y,
        );
        const task = (await (await api.get(`/api/tasks/${taskId}`)).json())
          .task;
        for (const viewportWidth of width === 390 ? [390] : [768, 1280]) {
          await page.setViewportSize({ width: viewportWidth, height: 844 });
          const table = page.getByRole("grid", {
            name: "Task list",
            exact: true,
          });
          await expect(table.getByRole("columnheader")).toHaveText(
            viewportWidth < 640
              ? ["Task", "Status", "Assignee", "Priority"]
              : ["Task ID", "Task", "Status", "Assignee", "Priority"],
          );
          const row = table.locator(`[data-key="${taskId}"]`);
          const title = row.getByRole("link", { name: /^Release task todo/ });
          const id = row.getByRole("link", {
            name: task.identifier,
            exact: true,
          });
          if (viewportWidth < 640) {
            await expect(id).toHaveCount(0);
            await expect(title).toContainText(task.identifier);
          } else {
            await expect(id).toBeVisible();
            await expect(title).toHaveAccessibleName(task.title);
            await expect(id).toHaveAttribute(
              "href",
              (await title.getAttribute("href"))!,
            );
            expect((await id.boundingBox())!.x).toBeLessThan(
              (await title.boundingBox())!.x,
            );
          }
          const identifier =
            viewportWidth < 640
              ? title.getByText(task.identifier, { exact: true })
              : id;
          const identifierGeometry = await identifier.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(element);
            const textBounds = range.getBoundingClientRect();
            return {
              text: element.textContent,
              fits:
                element.scrollWidth <= element.clientWidth &&
                textBounds.left >= bounds.left - 1 &&
                textBounds.right <= bounds.right + 1,
            };
          });
          expect(identifierGeometry.text).toBe(task.identifier);
          expect(identifierGeometry.fits).toBe(true);
        }
        await page.screenshot({
          path: `tmp/boards-layout-evidence/heading-search-${width}-${theme}.png`,
        });
        if (width === 390)
          await page
            .getByRole("button", { name: "Filters", exact: true })
            .click();
        const filters = page.getByRole("navigation", {
          name: "Page navigation",
          exact: true,
        });
        await expect(
          filters.getByRole("searchbox", { name: "Search tasks" }),
        ).toHaveCount(0);
        await expect(
          filters.getByRole("heading", { name: "Filter tasks", exact: true }),
        ).toBeVisible();
        await expect(
          filters.getByRole("heading", { name: "Sort tasks", exact: true }),
        ).toBeVisible();
        const filterGeometry = await filters.evaluate((nav) => {
          const sections = Array.from(
            nav.querySelectorAll("[data-secondary-menu]"),
          );
          const section = sections.find(
            (candidate) =>
              candidate.querySelector("h2")?.textContent === "Filter tasks",
          )!;
          const heading = section.querySelector("h2")!;
          const fields = section.querySelector(":scope > div")!;
          const gutter = nav.closest("aside") ? nav.parentElement! : nav;
          const gutterRect = gutter.getBoundingClientRect();
          const fieldRect = fields.getBoundingClientRect();
          return {
            sections: sections.flatMap((candidate) => {
              const title = candidate.querySelector("h2")?.textContent;
              return title ? [title] : [];
            }),
            gutterPaddingLeft: getComputedStyle(gutter).paddingLeft,
            gutterPaddingRight: getComputedStyle(gutter).paddingRight,
            leftInset: fieldRect.left - gutterRect.left,
            rightInset: gutterRect.right - fieldRect.right,
            fieldGap: getComputedStyle(fields).rowGap,
            labels: Array.from(
              section.querySelectorAll("[data-slot=label]"),
            ).map((label) => ({
              text: label.textContent,
              paddingLeft: getComputedStyle(label).paddingLeft,
              fontSize: getComputedStyle(label).fontSize,
              color: getComputedStyle(label).color,
            })),
            headingFontSize: getComputedStyle(heading).fontSize,
            headingColor: getComputedStyle(heading).color,
          };
        });
        expect(filterGeometry.sections).toEqual(["Sort tasks", "Filter tasks"]);
        await expect(
          filters.getByText("Sort order", { exact: true }),
        ).toBeVisible();
        expect(filterGeometry.gutterPaddingLeft).toBe("12px");
        expect(filterGeometry.gutterPaddingRight).toBe("12px");
        expect(Math.abs(filterGeometry.leftInset - 12)).toBeLessThan(0.01);
        expect(Math.abs(filterGeometry.rightInset - 12)).toBeLessThan(0.01);
        expect(filterGeometry.fieldGap).toBe("16px");
        expect(filterGeometry.labels.map((label) => label.text)).toEqual([
          "Assignee",
          "Priority",
          "Status",
        ]);
        for (const label of filterGeometry.labels) {
          expect(label.paddingLeft).toBe("8px");
          expect(label.fontSize).toBe("12px");
          expect(label.color).toBe(filterGeometry.headingColor);
        }
        for (const label of ["Assignee", "Priority", "Status", "Sort order"]) {
          const value = filters.getByRole("button", {
            name: new RegExp(`${label}$`),
          });
          await expect(
            value.locator("[data-slot=select-value] svg"),
          ).toHaveCount(1);
        }
        await testInfo.attach("filter-panel-geometry.json", {
          body: Buffer.from(JSON.stringify(filterGeometry)),
          contentType: "application/json",
        });
        const assigneeTrigger = filters.getByRole("button", {
          name: /Assignee$/,
        });
        if (width === 390) await assigneeTrigger.tap();
        else await assigneeTrigger.click();
        const assigneeSearch = page.getByRole("searchbox", {
          name: "Search assignee",
        });
        await expect(assigneeSearch).toBeVisible();
        if (width === 1280) await expect(assigneeSearch).toBeFocused();
        else {
          await expect(assigneeSearch).not.toBeFocused();
          await assigneeSearch.tap();
          await expect(assigneeSearch).toBeFocused();
        }
        const popover = page.locator('[data-slot="select-popover"]');
        await expect(popover).not.toHaveAttribute("data-entering", "true");
        const readPopoverGeometry = () =>
          popover.evaluate((menu) => {
            const nav = document.querySelector(
              'nav[aria-label="Page navigation"]',
            )!;
            const bounds = menu.getBoundingClientRect();
            const search = menu.querySelector("input")!.getBoundingClientRect();
            const x = bounds.right - 12;
            const y = search.top + search.height / 2;
            return {
              right: bounds.right,
              left: bounds.left,
              width: bounds.width,
              sampleX: x,
              navRight: nav.getBoundingClientRect().right,
              hitInsideMenu: menu.contains(document.elementFromPoint(x, y)),
              insideDrawer: !!menu.closest(
                '[role="dialog"][aria-label="Navigation"]',
              ),
            };
          });
        await expect
          .poll(async () => (await readPopoverGeometry()).hitInsideMenu)
          .toBe(true);
        const popoverGeometry = await readPopoverGeometry();
        expect(popoverGeometry.width).toBeLessThanOrEqual(
          Math.min(320, width - 32),
        );
        const longName = page.getByRole("option", {
          name: "Alex Morgan — release coordination across product teams",
          exact: true,
        });
        const truncation = await longName
          .locator("span.truncate")
          .evaluate((text) => ({
            clipped: text.scrollWidth > text.clientWidth,
            textOverflow: getComputedStyle(text).textOverflow,
            whiteSpace: getComputedStyle(text).whiteSpace,
          }));
        expect(truncation).toEqual({
          clipped: true,
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        });
        if (width === 1280) {
          expect(popoverGeometry.right).toBeGreaterThan(
            popoverGeometry.navRight,
          );
          expect(popoverGeometry.sampleX).toBeGreaterThan(
            popoverGeometry.navRight,
          );
          expect(popoverGeometry.insideDrawer).toBe(false);
        } else {
          expect(popoverGeometry.left).toBeGreaterThanOrEqual(0);
          expect(popoverGeometry.right).toBeLessThanOrEqual(width);
          expect(popoverGeometry.insideDrawer).toBe(true);
        }
        await testInfo.attach("filter-popover-geometry.json", {
          body: Buffer.from(JSON.stringify(popoverGeometry)),
          contentType: "application/json",
        });
        await page.screenshot({
          path: `tmp/boards-layout-evidence/popover-${width}-${theme}.png`,
        });
        await assigneeSearch.fill("Alex");
        await expect(page.getByRole("option")).toHaveCount(1);
        await assigneeSearch.press("Escape");
        await expect(assigneeSearch).toHaveValue("");
        await assigneeSearch.press("Escape");
        await expect(popover).toBeHidden();
        await expect(
          filters.getByRole("button", { name: /Assignee$/ }),
        ).toBeFocused();
        await filters.getByRole("button", { name: /Status$/ }).click();
        await page
          .getByRole("option", { name: "Backlog", exact: true })
          .click();
        await expect(page).toHaveURL(/status=backlog/);
        await expect(filters).toBeVisible();
        await filters.getByRole("button", { name: /Sort order$/ }).click();
        await page
          .getByRole("option", { name: "Priority", exact: true })
          .click();
        await expect(page).toHaveURL(/sort=priority/);
        if (width === 390)
          await page
            .getByRole("dialog", { name: "Navigation", exact: true })
            .getByRole("button", { name: "Close navigation", exact: true })
            .click();
        await search.fill("Release");
        await expect(page).toHaveURL(/q=Release/);
        if (width === 390)
          await page
            .getByRole("button", { name: "Filters", exact: true })
            .click();
        expect(
          await filters.evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
        ).toBe(true);
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({
          path: `tmp/boards-layout-evidence/filters-${width}-${theme}.png`,
          fullPage: true,
          animations: "disabled",
        });
        if (width === 390)
          await page
            .getByRole("dialog", { name: "Navigation", exact: true })
            .getByRole("button", { name: "Close navigation", exact: true })
            .click();
        const pageSize = page.getByRole("button", { name: /Tasks per page$/ });
        await pageSize.click();
        await page
          .getByRole("option", { name: "10 per page", exact: true })
          .click();
        const nextPage = page.getByRole("button", {
          name: "Next",
          exact: true,
        });
        await expect(nextPage).toBeEnabled();
        await nextPage.click();
        await expect(page).toHaveURL(/page=2/);
        const viewUrl = page.url();
        await page.reload();
        await expect(
          page.getByText("Page 2 of 2", { exact: true }),
        ).toBeVisible();
        await expect(
          page
            .getByRole("main")
            .getByRole("grid")
            .getByRole("row")
            .filter({ has: page.getByRole("link") }),
        ).toHaveCount(3);
        expect(page.url()).toBe(viewUrl);
        await expect(search).toHaveValue("Release");
        const titleLink = page
          .getByRole("main")
          .getByRole("link", { name: /^Release task backlog/ })
          .first();
        const taskLink =
          width === 390
            ? titleLink
            : page
                .getByRole("row")
                .filter({
                  has: page.getByRole("link", {
                    name: /^Release task backlog/,
                  }),
                })
                .first()
                .getByRole("link")
                .first();
        await expect(taskLink).toHaveAttribute(
          "href",
          (await titleLink.getAttribute("href"))!,
        );
        await taskLink.click();
        await expect(
          page.getByRole("navigation", {
            name: "Page navigation",
            exact: true,
          }),
        ).toHaveCount(0);
        await page
          .getByRole("button", { name: "Back to board", exact: true })
          .click();
        await expect(page).toHaveURL(viewUrl);
        if (width === 390) {
          await page
            .getByRole("button", { name: "Toggle navigation", exact: true })
            .click();
          await page
            .getByRole("dialog", { name: "Navigation", exact: true })
            .getByRole("link", { name: "Boards", exact: true })
            .click();
        } else {
          await page
            .getByRole("navigation", { name: "Breadcrumb" })
            .getByRole("link", { name: "Boards", exact: true })
            .click();
        }
        await expect(page).toHaveURL(/\/boards$/);
        await expect(
          page
            .getByRole("main")
            .getByRole("link", { name: boardName })
            .locator("dd"),
        ).toHaveText(["13", "1", "1"]);
      } finally {
        await context.close();
      }
    });
  }
test("returning to the overview refreshes counts after task changes", async ({
  page,
}) => {
  await authenticateBrowserFixture(page, fixture);
  await page.goto(`/boards/${boardId}/tasks/${taskId}`);
  const current = (await (await api.get(`/api/tasks/${taskId}`)).json()).task;
  const changed = await api.patch(`/api/tasks/${taskId}`, {
    data: { version: current.version, status: "done" },
  });
  expect(changed.ok()).toBe(true);
  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: "Boards", exact: true })
    .click();
  await expect(
    page
      .getByRole("main")
      .getByRole("link", { name: boardName, exact: true })
      .locator("dd"),
  ).toHaveText(["13", "0", "1"]);
});
