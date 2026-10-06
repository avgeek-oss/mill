import { randomBytes } from "node:crypto";
import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Locator,
} from "@playwright/test";
import {
  authenticateBrowserFixture,
  getBrowserBootstrap,
  getBrowserRoleFixture,
  type BrowserFixtureSession,
} from "../browser-fixture.js";

let fixture: BrowserFixtureSession;
let api: APIRequestContext;
let boardId: string;
let taskId: string;
let taskIdentifier: string;
let memberName: string;
const assigneeName =
  "Release coordinator responsible for the complete product launch and documentation review";

async function expectNativeButton(
  button: Locator,
  height: number,
  {
    iconOnly = false,
    iconSize = 16,
  }: { iconOnly?: boolean; iconSize?: number } = {},
) {
  const metrics = await button.evaluate((element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    const icon = element.querySelector("svg");
    const iconBounds = icon?.getBoundingClientRect();
    return {
      height: bounds.height,
      width: bounds.width,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      iconWidth: iconBounds?.width,
      iconHeight: iconBounds?.height,
    };
  });
  expect(metrics.height).toBe(height);
  if (iconOnly) expect(metrics.width).toBe(height);
  expect(metrics.fontSize).toBe("14px");
  expect(metrics.lineHeight).toBe("20px");
  if (metrics.iconWidth !== undefined) {
    expect(metrics.iconWidth).toBe(iconSize);
    expect(metrics.iconHeight).toBe(iconSize);
  }
}

test.beforeAll(async ({ baseURL }) => {
  const bootstrap = await getBrowserBootstrap(baseURL!);
  fixture = bootstrap;
  api = bootstrap.api;
  const member = await getBrowserRoleFixture(baseURL!, "member");
  memberName = member.identity.user.name;
  await member.api.dispose();
  const invitation = await api.post("/api/auth/invitations", {
    data: {
      email: `polish-${randomBytes(6).toString("hex")}@example.test`,
      role: "member",
    },
  });
  expect(invitation.status()).toBe(201);
  const person = await request.newContext({ baseURL });
  let assigneeId: string;
  try {
    const accepted = await person.post("/api/auth/accept-invitation", {
      headers: { Origin: baseURL! },
      data: {
        token: (await invitation.json()).token,
        name: assigneeName,
        password: "Polish-browser-password-42",
      },
    });
    expect(accepted.ok()).toBe(true);
    assigneeId = (await accepted.json()).user.id;
  } finally {
    await person.dispose();
  }
  const boardResponse = await api.post("/api/boards", {
    data: {
      name: "Interface polish",
      prefix: `UIP${randomBytes(3).toString("hex").toUpperCase()}`,
    },
  });
  expect(boardResponse.status()).toBe(201);
  boardId = (await boardResponse.json()).board.id;
  const taskResponse = await api.post(`/api/boards/${boardId}/tasks`, {
    data: {
      title: "Review compact controls and long assignee names",
      description:
        "- First bullet\n  - Nested bullet\n- Second bullet\n\n1. First step\n2. Second step",
      assigneeId,
    },
  });
  expect(taskResponse.status()).toBe(201);
  const createdTask = (await taskResponse.json()).task;
  taskId = createdTask.id;
  taskIdentifier = createdTask.identifier;
  expect(
    (
      await api.post(`/api/tasks/${taskId}/comments`, {
        data: { body: "Review the controls on desktop and mobile." },
      })
    ).status(),
  ).toBe(201);
});
test.afterAll(async () => {
  await api?.dispose();
});

for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`native controls, bounded selects and caret mentions at ${width}px in ${theme}`, async ({
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
        const page = await context.newPage();
        await authenticateBrowserFixture(page, fixture);
        await page.goto(`/boards/${boardId}/tasks/${taskId}`);
        const edit = page.getByRole("button", {
          name: "Edit task details",
          exact: true,
        });
        await expect(edit).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        const compactHeight = width === 390 ? 34 : 32;
        const buttonHeight = width === 390 ? 40 : 36;
        const buttonIconSize = width === 390 ? 20 : 16;
        await expectNativeButton(edit, buttonHeight, {
          iconOnly: true,
          iconSize: buttonIconSize,
        });
        await expectNativeButton(
          page.getByRole("button", {
            name: `Delete comment by ${fixture.identity.user.name}`,
            exact: true,
          }),
          compactHeight,
          { iconOnly: true, iconSize: buttonIconSize },
        );
        for (const headerButton of [
          page.locator(".navigation-toggle"),
          page.getByRole("button", {
            name: /^Notifications(?:, \d+ unread)?$/,
          }),
        ]) {
          await expect(headerButton).toHaveCount(1);
          const dimensions = await headerButton.boundingBox();
          expect(dimensions!.height).toBe(buttonHeight);
          expect(dimensions!.width).toBe(buttonHeight);
        }
        const appearance = page.getByRole("button", { name: /^Appearance:/ });
        await expect(appearance).toHaveCount(1);
        const appearanceDimensions = await appearance.boundingBox();
        expect(appearanceDimensions!.height).toBe(buttonHeight);
        expect(appearanceDimensions!.width).toBe(buttonHeight);
        await edit.click();
        const editModal = page.getByRole("dialog", {
          name: "Edit task",
          exact: true,
        });
        await expect(editModal).toBeVisible();
        const close = editModal.getByRole("button", {
          name: "Close dialog",
          exact: true,
        });
        const closeDimensions = await close.boundingBox();
        expect(closeDimensions!.width).toBe(24);
        expect(closeDimensions!.height).toBe(24);
        await close.click();
        const assignee = page.getByRole("button", { name: /Assignee$/ });
        await expect(assignee).toContainText(assigneeName);
        const bounds = await assignee.evaluate((e) => {
          const parent = e.closest(".select")!;
          const r = e.getBoundingClientRect(),
            p = parent.getBoundingClientRect();
          const text = e.querySelector(".select__value > span:last-child")!;
          return {
            left: r.left,
            right: r.right,
            parentLeft: p.left,
            parentRight: p.right,
            width: innerWidth,
            scrollWidth: text.scrollWidth,
            clientWidth: text.clientWidth,
            overflow: getComputedStyle(text).textOverflow,
          };
        });
        expect(bounds.left).toBeGreaterThanOrEqual(bounds.parentLeft - 1);
        expect(bounds.right).toBeLessThanOrEqual(bounds.parentRight + 1);
        expect(bounds.right).toBeLessThanOrEqual(bounds.width);
        if (width === 390) {
          expect(bounds.scrollWidth).toBeGreaterThan(bounds.clientWidth);
          expect(bounds.overflow).toBe("ellipsis");
        }
        const markers = await page
          .locator(".task-page-content .markdown")
          .evaluate((e) => ({
            ul: getComputedStyle(e.querySelector("ul")!).listStyleType,
            nested: getComputedStyle(e.querySelector("ul ul")!).listStyleType,
            ol: getComputedStyle(e.querySelector("ol")!).listStyleType,
          }));
        expect(markers).toEqual({
          ul: "disc",
          nested: "circle",
          ol: "decimal",
        });
        const composer = page.getByPlaceholder("Add a comment…", {
          exact: true,
        });
        const send = page.getByRole("button", {
          name: "Send comment",
          exact: true,
        });
        const composerMetrics = await composer.evaluate((element) => ({
          height: element.getBoundingClientRect().height,
          fontSize: parseFloat(getComputedStyle(element).fontSize),
        }));
        expect(composerMetrics.height).toBeGreaterThanOrEqual(64);
        if (width === 390)
          expect(composerMetrics.fontSize).toBeGreaterThanOrEqual(16);
        await expect(send).toBeDisabled();
        await expect(send).toHaveClass(/button--secondary/);
        await expectNativeButton(send, buttonHeight, {
          iconOnly: true,
          iconSize: buttonIconSize,
        });
        await composer.fill(
          "Hello @al\n\nAnother line\nAnother line\nAnother line",
        );
        await composer.evaluate((e) => {
          const input = e as HTMLTextAreaElement;
          input.setSelectionRange(9, 9);
        });
        await composer.press("ArrowLeft");
        await composer.press("ArrowRight");
        const mentions = page.getByRole("listbox", {
          name: "Mention a person",
        });
        await expect(mentions).toBeVisible();
        const activeMention = await composer.evaluate((element) => {
          const id = element.getAttribute("aria-activedescendant");
          const option = id ? document.getElementById(id) : null;
          return {
            id,
            role: option?.getAttribute("role"),
            insideList:
              option?.closest('[role="listbox"]')?.id ===
              element.getAttribute("aria-controls"),
          };
        });
        expect(activeMention.id).toBeTruthy();
        expect(activeMention.role).toBe("option");
        expect(activeMention.insideList).toBe(true);
        const caretDropdown = await mentions.boundingBox();
        const textarea = await composer.boundingBox();
        expect(caretDropdown!.x).toBeGreaterThanOrEqual(0);
        expect(caretDropdown!.x + caretDropdown!.width).toBeLessThanOrEqual(
          width,
        );
        expect(caretDropdown!.y).toBeLessThan(
          textarea!.y + textarea!.height - 15,
        );
        await composer.press("ArrowDown");
        await composer.press("Enter");
        await expect(composer).toHaveValue(/Hello @Alex Morgan/);
        await expect(send).toBeEnabled();
        await expect(send).toHaveClass(/button--primary/);
        await expectNativeButton(send, buttonHeight, {
          iconOnly: true,
          iconSize: buttonIconSize,
        });
        await expect(mentions).toBeHidden();
        await expect
          .poll(() =>
            composer.evaluate((element) => {
              const input = element as HTMLTextAreaElement;
              return { start: input.selectionStart, end: input.selectionEnd };
            }),
          )
          .toEqual({
            start: "Hello @Alex Morgan".length,
            end: "Hello @Alex Morgan".length,
          });
        await composer.fill("Hello @al");
        await expect(mentions).toBeVisible();
        await composer.press("ArrowDown");
        await composer.press("Enter");
        await expect(composer).toHaveValue("Hello @Alex Morgan ");
        await expect
          .poll(() =>
            composer.evaluate((element) => {
              const input = element as HTMLTextAreaElement;
              return { start: input.selectionStart, end: input.selectionEnd };
            }),
          )
          .toEqual({
            start: "Hello @Alex Morgan ".length,
            end: "Hello @Alex Morgan ".length,
          });
        await composer.press("ControlOrMeta+A");
        await expect
          .poll(() =>
            composer.evaluate((element) => {
              const input = element as HTMLTextAreaElement;
              return (
                input.selectionStart === 0 &&
                input.selectionEnd === input.value.length
              );
            }),
          )
          .toBe(true);
        await composer.press("Backspace");
        await expect(composer).toHaveValue("");
        await expect(
          page.getByRole("button", { name: "Send comment", exact: true }),
        ).toBeDisabled();
        const back = page.getByRole("button", {
          name: "Back to board",
          exact: true,
        });
        const backMetrics = await back.evaluate((element) => {
          const style = getComputedStyle(element);
          const icon = element.querySelector("svg");
          return {
            height: element.getBoundingClientRect().height,
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
            icons: icon ? 1 : 0,
            decoration: style.textDecorationLine,
            decorationStyle: style.textDecorationStyle,
          };
        });
        expect(backMetrics).toEqual({
          height: compactHeight,
          fontSize: "14px",
          lineHeight: "20px",
          icons: 0,
          decoration: "underline",
          decorationStyle: "dashed",
        });
        const headerBounds = await page
          .locator(".task-page-header")
          .boundingBox();
        const layoutBounds = await page
          .getByRole("region", { name: "Task details", exact: true })
          .boundingBox();
        const propertiesBounds = await page
          .getByRole("complementary", { name: "Task properties" })
          .boundingBox();
        const actionsBounds = await page
          .getByRole("button", { name: "Task actions", exact: true })
          .boundingBox();
        expect(headerBounds!.width).toBeCloseTo(layoutBounds!.width, 0);
        expect(propertiesBounds!.y).toBeGreaterThanOrEqual(
          headerBounds!.y + headerBounds!.height,
        );
        expect(actionsBounds!.x + actionsBounds!.width).toBeCloseTo(
          headerBounds!.x + headerBounds!.width,
          0,
        );
        await page.screenshot({
          path: testInfo.outputPath(`task-header-${width}-${theme}.png`),
          animations: "disabled",
        });
        await back.click();
        const taskList = page.getByRole("grid", {
          name: "Task list",
          exact: true,
        });
        await expect(taskList).toBeVisible();
        const taskRow = taskList.getByRole("row").filter({
          has: page.getByRole("link", {
            name: /^Review compact controls and long assignee names/,
          }),
        });
        await expect(taskRow).toHaveCount(1);
        const identifier = taskRow
          .getByText(taskIdentifier, { exact: true })
          .filter({ visible: true });
        await expect(identifier).toHaveCount(1);
        const identifierMetrics = await identifier.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const text = range.getBoundingClientRect();
          const bounds = element.getBoundingClientRect();
          const icon = element
            .parentElement!.querySelector('[role="img"]')!
            .getBoundingClientRect();
          return {
            clipped: element.scrollWidth > element.clientWidth,
            overflow: getComputedStyle(element).textOverflow,
            glyphLeft: text.left,
            glyphRight: text.right,
            left: bounds.left,
            right: bounds.right,
            iconRight: icon.right,
          };
        });
        expect(identifierMetrics.clipped).toBe(false);
        expect(identifierMetrics.overflow).not.toBe("ellipsis");
        expect(identifierMetrics.glyphLeft).toBeGreaterThanOrEqual(
          identifierMetrics.left - 1,
        );
        expect(identifierMetrics.glyphRight).toBeLessThanOrEqual(
          identifierMetrics.right + 1,
        );
        expect(
          identifierMetrics.left - identifierMetrics.iconRight,
        ).toBeCloseTo(8, 0);
        const identities = taskRow.getByRole("img", {
          name: assigneeName,
          exact: true,
        });
        await expect(identities).toHaveCount(1);
        const avatarShape = await identities.first().evaluate((e) => ({
          radius: parseFloat(getComputedStyle(e).borderTopLeftRadius),
          width: e.getBoundingClientRect().width,
          height: e.getBoundingClientRect().height,
        }));
        expect(avatarShape.width).toBe(avatarShape.height);
        expect(avatarShape.radius).toBeGreaterThanOrEqual(
          avatarShape.width / 2,
        );
        const newTask = page.getByRole("button", {
          name: "New task",
          exact: true,
        });
        await expectNativeButton(newTask, buttonHeight, {
          iconSize: buttonIconSize,
        });
        const pagination = page.getByRole("group", {
          name: "Task list pagination",
        });
        for (const name of ["Previous", "Next"]) {
          await expectNativeButton(
            pagination.getByRole("button", { name, exact: true }),
            width === 390 ? 36 : 32,
          );
        }
        await newTask.click();
        const modal = page.getByRole("dialog", {
          name: "New task",
          exact: true,
        });
        await expect(
          modal.getByRole("button", { name: /Assignee$/ }),
        ).toBeVisible();
        const modalSpacing = await modal.evaluate((element) => {
          const style = getComputedStyle(element);
          const bounds = element.getBoundingClientRect();
          const footer = element
            .querySelector('[data-slot="modal-footer"]')!
            .getBoundingClientRect();
          return {
            padding: [
              style.paddingTop,
              style.paddingRight,
              style.paddingBottom,
              style.paddingLeft,
            ],
            footerBottomGap: bounds.bottom - footer.bottom,
          };
        });
        expect(modalSpacing.padding).toEqual(["20px", "20px", "20px", "20px"]);
        expect(modalSpacing.footerBottomGap).toBeCloseTo(20, 0);
        if (width === 390) {
          for (const name of ["Title", "Description"]) {
            const fieldFontSize = await modal
              .getByLabel(name, { exact: true })
              .evaluate((element) =>
                parseFloat(getComputedStyle(element).fontSize),
              );
            expect(fieldFontSize).toBeGreaterThanOrEqual(16);
          }
        }
        for (const name of ["Cancel", "Create task"]) {
          await expectNativeButton(
            modal.getByRole("button", { name, exact: true }),
            buttonHeight,
            { iconSize: buttonIconSize },
          );
        }
        await expect(modal.getByRole("button", { name: /Agent$/ })).toHaveCount(
          0,
        );
        await modal.getByRole("button", { name: /Assignee$/ }).click();
        const popover = page.locator('[data-slot="select-popover"]');
        await expect(popover).toBeVisible();
        const menuBounds = await popover.boundingBox();
        expect(menuBounds!.width).toBeLessThanOrEqual(
          Math.min(320, width - 32),
        );
        const option = page.getByRole("option", {
          name: assigneeName,
          exact: true,
        });
        const optionLabel = option
          .locator(":scope > span.grid > span.truncate")
          .filter({ visible: true });
        await expect(optionLabel).toHaveCount(1);
        await expect(optionLabel).toHaveText(assigneeName);
        const optionText = await optionLabel.evaluate((text) => ({
          clipped: text.scrollWidth > text.clientWidth,
          overflow: getComputedStyle(text).textOverflow,
        }));
        expect(optionText).toEqual({ clipped: true, overflow: "ellipsis" });
        await option.click();
        const dimensions = await modal
          .getByRole("button", { name: /Assignee$/ })
          .boundingBox();
        expect(dimensions!.x + dimensions!.width).toBeLessThanOrEqual(width);
        await modal.getByRole("button", { name: /Assignee$/ }).click();
        await page
          .getByRole("option", { name: memberName, exact: true })
          .click();
        await expect(
          modal.getByRole("button", { name: /Assignee$/ }),
        ).toContainText(memberName);
        await modal.getByRole("button", { name: /Assignee$/ }).click();
        await page
          .getByRole("option", { name: "Unassigned", exact: true })
          .click();
        await modal
          .getByLabel("Title", { exact: true })
          .fill(`Unassigned creation at ${width}px in ${theme}`);
        await modal
          .getByRole("button", { name: "Create task", exact: true })
          .click();
        await expect(page).toHaveURL(
          new RegExp(`/boards/${boardId}/tasks/[0-9a-f-]+$`),
        );
        const createdId = new URL(page.url()).pathname.split("/tasks/")[1];
        const created = (
          await (await page.request.get(`/api/tasks/${createdId}`)).json()
        ).task;
        expect(created).not.toHaveProperty("agentId");
        expect(created.assigneeId).toBeNull();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      } finally {
        await context.close();
      }
    });
  }

test("long task details scroll with the page instead of separate task panes", async ({
  browser,
}, testInfo) => {
  const taskResponse = await api.post(`/api/boards/${boardId}/tasks`, {
    data: {
      title: "Review the complete task in one page",
      description: Array.from(
        { length: 30 },
        (_, index) =>
          `Review section ${index + 1}: Confirm that the title, description, task properties and discussion remain in document flow while reviewing the complete task.`,
      ).join("\n\n"),
    },
  });
  expect(taskResponse.status()).toBe(201);
  const longTaskId = (await taskResponse.json()).task.id;
  const comment = await api.post(`/api/tasks/${longTaskId}/comments`, {
    data: { body: "The end of this long task is reachable by page scrolling." },
  });
  expect(comment.status()).toBe(201);
  for (const width of [1280, 768, 390]) {
    for (const theme of ["light", "dark"] as const) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        reducedMotion: "reduce",
      });
      try {
        await context.addInitScript(
          (value) => localStorage.setItem("avgeek-oss-ui-theme", value),
          theme,
        );
        const page = await context.newPage();
        await authenticateBrowserFixture(page, fixture);
        await page.goto(`/boards/${boardId}/tasks/${longTaskId}`);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        const properties = page.getByRole("complementary", {
          name: "Task properties",
        });
        await expect(properties).toBeVisible();
        await expect(
          page.getByRole("heading", {
            name: "Review the complete task in one page",
            exact: true,
          }),
        ).toBeVisible();
        const scrolling = await page
          .locator(".task-page")
          .evaluate((element) => ({
            nested: Array.from(element.querySelectorAll("*"))
              .filter(
                (child) =>
                  ["auto", "scroll"].includes(
                    getComputedStyle(child).overflowY,
                  ) && child.scrollHeight > child.clientHeight,
              )
              .map((child) => child.className),
            overflowing: document.documentElement.scrollHeight > innerHeight,
            fitsWidth: document.documentElement.scrollWidth <= innerWidth,
          }));
        expect(scrolling).toEqual({
          nested: [],
          overflowing: true,
          fitsWidth: true,
        });
        const description = page.getByRole("region", {
          name: "Description",
          exact: true,
        });
        const before = (await description.boundingBox())!.y;
        const mouseTarget =
          width === 1280
            ? await properties.boundingBox()
            : await description.boundingBox();
        await page.mouse.move(
          mouseTarget!.x + 20,
          Math.min(mouseTarget!.y + 20, 700),
        );
        await page.mouse.wheel(0, 500);
        await expect
          .poll(() => page.evaluate(() => scrollY))
          .toBeGreaterThan(100);
        expect((await description.boundingBox())!.y).toBeLessThan(before - 100);
        const lastComment = page.getByText(
          "The end of this long task is reachable by page scrolling.",
          { exact: true },
        );
        await lastComment.scrollIntoViewIfNeeded();
        await expect(lastComment).toBeInViewport();
        await page.evaluate(() => scrollTo(0, 0));
        await page
          .getByRole("button", { name: "Edit task details", exact: true })
          .click();
        const dialog = page.getByRole("dialog", {
          name: "Edit task",
          exact: true,
        });
        await expect(
          dialog.getByLabel("Description", { exact: true }),
        ).toHaveValue(/Review section 30/);
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await page.screenshot({
          path: testInfo.outputPath(`whole-page-${width}-${theme}.png`),
          animations: "disabled",
        });
      } finally {
        await context.close();
      }
    }
  }
});
