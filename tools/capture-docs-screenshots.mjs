import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  chromium,
  expect as playwrightExpect,
  request,
} from "@playwright/test";
import postgres from "postgres";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifestPath = path.join(root, "tools/docs-screenshots.json");
const expect = playwrightExpect.configure({ timeout: 70000 });
const pause = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const actions = new Set([
  "activity",
  "create-task",
  "board-settings",
  "notifications",
  "server-error",
]);
let lastRequestAt = 0;
let requestQueue = Promise.resolve();

async function paceRequest() {
  const scheduled = requestQueue.then(async () => {
    const remaining = 350 - (Date.now() - lastRequestAt);
    if (remaining > 0) await pause(remaining);
    lastRequestAt = Date.now();
  });
  requestQueue = scheduled;
  await scheduled;
}

export function validateManifest(manifest) {
  if (
    manifest.schemaVersion !== 1 ||
    manifest.output !== "docs/screenshots/release-v1"
  )
    throw new Error(
      "Screenshot manifest must use the release-v1 output directory",
    );
  if (manifest.deviceScaleFactor !== 2)
    throw new Error("Documentation screenshots require 2x pixel density");
  if (JSON.stringify(manifest.themes) !== JSON.stringify(["light", "dark"]))
    throw new Error("Every section must include light and dark screenshots");
  if (
    JSON.stringify(Object.keys(manifest.devices).sort()) !==
    JSON.stringify(["desktop", "mobile"])
  )
    throw new Error(
      "Every section must include desktop and mobile screenshots",
    );
  for (const viewport of Object.values(manifest.devices))
    if (
      !Number.isInteger(viewport.width) ||
      !Number.isInteger(viewport.height) ||
      viewport.width < 320 ||
      viewport.height < 400
    )
      throw new Error("Screenshot viewport dimensions are invalid");
  const names = new Set();
  for (const entry of manifest.screenshots) {
    if (!/^[a-z][a-z0-9-]*$/.test(entry.name) || names.has(entry.name))
      throw new Error("Screenshot names must be unique safe basenames");
    names.add(entry.name);
    if (
      !entry.route?.startsWith("/") ||
      entry.route.startsWith("//") ||
      !entry.heading ||
      !entry.guides?.length
    )
      throw new Error(
        `Screenshot ${entry.name} needs a local route, heading and guide mapping`,
      );
    if (entry.action && !actions.has(entry.action))
      throw new Error(`Unknown screenshot action: ${entry.action}`);
    if (entry.beforeSetup && !entry.anonymous)
      throw new Error("Setup screenshots must be anonymous");
  }
  if (!names.size) throw new Error("The screenshot manifest is empty");
  return manifest;
}

export function documentationPages(navigation) {
  const pages = new Set();
  function visit(value) {
    if (Array.isArray(value)) for (const item of value) visit(item);
    else if (value && typeof value === "object") {
      if (Array.isArray(value.pages))
        for (const page of value.pages) {
          if (typeof page === "string") {
            if (!/^[a-z0-9][a-z0-9/-]*$/.test(page))
              throw new Error("Documentation page routes must be local slugs");
            pages.add(page);
          } else visit(page);
        }
      for (const [key, item] of Object.entries(value))
        if (key !== "pages") visit(item);
    }
  }
  visit(navigation);
  if (!pages.size)
    throw new Error("Documentation navigation contains no pages");
  pages.add("index");
  return [...pages].sort();
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function json(api, route, data, method = "POST") {
  await paceRequest();
  const response = await api.fetch(`/api${route}`, {
    method: data === undefined ? "GET" : method,
    data,
  });
  if (!response.ok())
    throw new Error(
      `Fixture ${method} ${route} failed (HTTP ${response.status()})`,
    );
  return response.json();
}

async function seed(origin) {
  const password = `Screenshot-${randomBytes(24).toString("base64url")}`;
  const api = await request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin },
  });
  try {
    const setup = await json(api, "/auth/setup", {
      workspaceName: "Mill",
      name: "Maya Chen",
      email: "maya@example.test",
      password,
    });
    const people = [];
    for (const [name, email, role] of [
      ["Alex Morgan", "alex@example.test", "member"],
      ["Sam Rivera", "sam@example.test", "viewer"],
    ]) {
      const invitation = await json(api, "/auth/invitations", { email, role });
      const person = await request.newContext({
        baseURL: origin,
        extraHTTPHeaders: { Origin: origin },
      });
      try {
        const accepted = await json(person, "/auth/accept-invitation", {
          token: invitation.token,
          name,
          password,
        });
        people.push(accepted.user.id);
      } finally {
        await person.dispose();
      }
    }
    await json(api, "/auth/invitations", {
      email: "jordan@example.test",
      role: "member",
    });
    for (const name of ["Local development", "Release automation"])
      await json(api, "/credentials", { name, expiresInDays: 90 });
    const board = (
      await json(api, "/boards", { name: "Release planning", prefix: "REL" })
    ).board;
    const emptyBoard = (
      await json(api, "/boards", { name: "Ideas", prefix: "IDEA" })
    ).board;
    await json(api, "/boards", { name: "Product", prefix: "PRD" });
    const titles = [
      "Prepare the release notes",
      "Review mobile navigation",
      "Check task permissions",
      "Update installation instructions",
      "Verify backup recovery",
      "Review the documentation homepage",
      "Test connected client permissions",
      "Check keyboard navigation",
      "Review table filters",
      "Prepare the first beta",
      "Check dark theme surfaces",
      "Test comment mentions",
    ];
    let taskId;
    for (let index = 0; index < titles.length; index++) {
      const task = (
        await json(api, `/boards/${board.id}/tasks`, {
          title: titles[index],
          type: [3, 9, 11].includes(index) ? "bug" : "task",
          startDate: index === 0 ? "2026-10-05" : null,
          dueDate: index === 0 ? "2026-10-12" : null,
          description:
            index === 0
              ? "Prepare the notes for the next release.\n\n- Summarize task and client improvements\n- Review installation and upgrade instructions\n- Include the documentation links\n\nKeep the notes clear and concise for people trying Mill for the first time."
              : "Review this item before the first beta.",
          status: [
            "in_progress",
            "todo",
            "backlog",
            "in_review",
            "done",
            "wont_do",
          ][index % 6],
          priority: ["high", "medium", "low", "urgent", "none"][index % 5],
          assigneeId:
            index % 3 === 0
              ? setup.user.id
              : index % 3 === 1
                ? people[0]
                : null,
        })
      ).task;
      if (index === 0) taskId = task.id;
    }
    await json(api, `/tasks/${taskId}/comments`, {
      body: "The installation instructions are ready. I checked the local setup and added the recovery steps.",
    });
    const peer = await request.newContext({
      baseURL: origin,
      extraHTTPHeaders: { Origin: origin },
    });
    try {
      await json(peer, "/auth/login", { email: "alex@example.test", password });
      await json(peer, `/tasks/${taskId}/comments`, {
        body: "The mobile review is complete. @Maya Chen, please check the final notes before we publish.",
        mentionIds: [setup.user.id],
      });
    } finally {
      await peer.dispose();
    }
    return {
      api,
      storageState: await api.storageState(),
      boardId: board.id,
      emptyBoardId: emptyBoard.id,
      taskId,
    };
  } catch (error) {
    await api.dispose();
    throw error;
  }
}

async function prepare(page, entry) {
  if (entry.action === "activity")
    await page.getByRole("tab", { name: "Activity", exact: true }).click();
  if (entry.action === "create-task") {
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "New task", exact: true }),
    ).toBeVisible();
  }
  if (entry.action === "board-settings") {
    await page
      .getByRole("button", { name: "Board actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Board settings", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Board settings", exact: true }),
    ).toBeVisible();
  }
  if (entry.action === "notifications") {
    await page
      .getByRole("button", { name: "Open notifications", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Notifications", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("dialog", { name: "Notifications", exact: true })
        .getByRole("listitem")
        .first(),
    ).toBeVisible();
  }
}

async function readyContent(page, entry) {
  if (["boards", "board", "people", "api-keys"].includes(entry.name)) {
    const name = {
      boards: "Release planning",
      board: "Test comment mentions",
      people: "maya@example.test",
      "api-keys": "Local development",
    }[entry.name];
    const element =
      entry.name === "boards"
        ? page.getByRole("link", { name, exact: true })
        : page.locator("tbody").getByText(name, { exact: true }).first();
    await expect(element).toBeVisible();
  }
  const rows =
    {
      people: ["maya@example.test", "Alex Morgan", "Sam Rivera"],
      "api-keys": ["Local development", "Release automation"],
    }[entry.name] ?? [];
  for (const name of rows)
    await expect(
      page.locator("tbody").getByText(name, { exact: true }).first(),
    ).toBeVisible();
  if (entry.name === "empty-board") {
    await expect(page.getByText("No tasks yet", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Create task", exact: true }),
    ).toBeVisible();
  }
  if (entry.name === "sessions")
    await expect(page.getByText("This browser", { exact: true })).toBeVisible();
  if (entry.name === "security") {
    await expect(
      page.getByRole("button", { name: "Add passkey", exact: true }),
    ).toBeVisible();
  }
  if (entry.name === "account")
    await expect(page.getByLabel("Your Name", { exact: true })).toHaveValue(
      "Maya Chen",
    );
  if (entry.name === "team")
    await expect(page.getByLabel("Team name", { exact: true })).toHaveValue(
      "Mill",
    );
  if (entry.name === "task")
    await expect(
      page.getByText(
        "The installation instructions are ready. I checked the local setup and added the recovery steps.",
        { exact: true },
      ),
    ).toBeVisible();
  if (entry.name === "task-activity")
    await expect
      .poll(() => page.locator("tbody tr").count())
      .toBeGreaterThanOrEqual(3);
}

async function capture(browser, origin, manifest, entry, fixture, receipt) {
  for (const [device, viewport] of Object.entries(manifest.devices))
    for (const theme of manifest.themes) {
      const context = await browser.newContext({
        viewport,
        deviceScaleFactor: manifest.deviceScaleFactor,
        colorScheme: theme,
        reducedMotion: "reduce",
        isMobile: device === "mobile",
        hasTouch: device === "mobile",
        ...(entry.anonymous ? {} : { storageState: fixture.storageState }),
      });
      let page;
      const failedResponses = [];
      const pendingApi = new Set();
      try {
        await context.addInitScript(
          (value) => localStorage.setItem("mill:theme", value),
          theme,
        );
        await context.route("**/api/**", async (route) => {
          await paceRequest();
          await route.continue();
        });
        await context.route("https://*.gravatar.com/**", (route) =>
          route.abort(),
        );
        page = await context.newPage();
        page.on("request", (request) => {
          if (new URL(request.url()).pathname.startsWith("/api/"))
            pendingApi.add(request);
        });
        page.on("requestfinished", (request) => pendingApi.delete(request));
        page.on("requestfailed", (request) => pendingApi.delete(request));
        page.on("response", (response) => {
          const url = new URL(response.url());
          if (response.status() >= 400 && url.pathname.startsWith("/api/"))
            failedResponses.push({
              status: response.status(),
              path: url.pathname,
            });
        });
        if (entry.action === "server-error")
          await page.route("**/api/tasks/*?*", (route) =>
            route.fulfill({
              status: 500,
              contentType: "application/json",
              body: JSON.stringify({
                error: "This request could not be completed",
              }),
            }),
          );
        const route = entry.route.replace(
          /\{(boardId|emptyBoardId|taskId)\}/g,
          (_, key) => fixture[key],
        );
        await page.goto(new URL(route, origin).href);
        await expect(
          page.getByRole("heading", {
            name: entry.heading,
            exact: true,
            level: 1,
          }),
        ).toBeVisible();
        await page.waitForLoadState("networkidle", { timeout: 70000 });
        await prepare(page, entry);
        await expect.poll(() => pendingApi.size).toBe(0);
        await readyContent(page, entry);
        await page.evaluate(() => document.fonts.ready);
        await expect(
          page
            .locator('[aria-label^="Loading"]:visible')
            .filter({ hasNot: page.locator('[data-slot="spinner"]') }),
        ).toHaveCount(0);
        await pause(200);
        const file = `${manifest.output}/${entry.name}${device === "mobile" ? "-mobile" : ""}-${theme}.png`;
        const destination = path.join(root, file);
        const temporary = `${destination}.tmp`;
        await page.screenshot({
          path: temporary,
          type: "png",
          fullPage: false,
          animations: "disabled",
        });
        const image = await readFile(temporary);
        const pixelWidth = viewport.width * manifest.deviceScaleFactor;
        const pixelHeight = viewport.height * manifest.deviceScaleFactor;
        if (
          image.readUInt32BE(16) !== pixelWidth ||
          image.readUInt32BE(20) !== pixelHeight
        )
          throw new Error(`Unexpected screenshot dimensions: ${file}`);
        await rename(temporary, destination);
        receipt.images.push({
          name: entry.name,
          file,
          device,
          theme,
          ...viewport,
          pixelWidth,
          pixelHeight,
          deviceScaleFactor: manifest.deviceScaleFactor,
          route: entry.route,
          state: entry.action ?? "page",
          readiness: {
            apiRequestsDrained: true,
            populatedContentVerified: true,
          },
          guides: entry.guides,
          bytes: image.length,
          sha256: createHash("sha256").update(image).digest("hex"),
        });
        console.log(`Captured ${file}`);
      } catch (error) {
        await mkdir(path.join(root, "tmp/docs-screenshot-failures"), {
          recursive: true,
        });
        if (page)
          await page
            .screenshot({
              path: path.join(
                root,
                `tmp/docs-screenshot-failures/${entry.name}-${device}-${theme}.png`,
              ),
              animations: "disabled",
            })
            .catch(() => {});
        receipt.failedResponses = failedResponses;
        throw new Error(
          `${entry.name} ${device} ${theme}: ${error.message}; API failures: ${JSON.stringify(failedResponses)}`,
        );
      } finally {
        await context.close();
      }
    }
}

async function captureDocumentation(browser, origin, manifest, receipt) {
  const url = new URL(origin);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw new Error("Docs screenshots require a loopback preview URL");
  const configuration = JSON.parse(
    await readFile(path.join(root, "docs/mintlify/docs.json"), "utf8"),
  );
  const directory = "tmp/docs-page-screenshots";
  await mkdir(path.join(root, directory), { recursive: true });
  for (const slug of documentationPages(configuration.navigation))
    for (const [device, viewport] of Object.entries(manifest.devices))
      for (const theme of manifest.themes) {
        const context = await browser.newContext({
          viewport,
          deviceScaleFactor: manifest.deviceScaleFactor,
          colorScheme: theme,
          reducedMotion: "reduce",
          isMobile: device === "mobile",
          hasTouch: device === "mobile",
        });
        let page;
        try {
          page = await context.newPage();
          const response = await page.goto(
            new URL(`/${slug === "index" ? "" : slug}`, url).href,
          );
          if (!response?.ok())
            throw new Error(
              `Documentation page ${slug} failed (HTTP ${response?.status()})`,
            );
          await expect(page.locator("h1").first()).toBeVisible();
          await expect
            .poll(() =>
              page.evaluate(
                () =>
                  document.documentElement.classList.contains("dark") ||
                  document.documentElement.dataset.theme === "dark",
              ),
            )
            .toBe(theme === "dark");
          await page.evaluate(() => document.fonts.ready);
          if (device === "mobile") {
            const tabs = page.getByRole("tab", { name: "Mobile", exact: true });
            for (let index = 0; index < (await tabs.count()); index++)
              await tabs.nth(index).click();
          }
          await page.evaluate(() => {
            for (const image of document.images) image.loading = "eager";
          });
          let position = 0;
          while (
            position <
            (await page.evaluate(() => document.documentElement.scrollHeight))
          ) {
            await page.evaluate((top) => window.scrollTo(0, top), position);
            await pause(50);
            position += viewport.height;
          }
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.evaluate(async () => {
            await Promise.all(
              [...document.images].map(async (image) => {
                await image.decode();
                if (!image.naturalWidth)
                  throw new Error("A documentation image failed to load");
              }),
            );
          });
          if (
            await page.evaluate(
              () =>
                document.documentElement.scrollWidth > window.innerWidth + 1,
            )
          )
            throw new Error(
              `Documentation page ${slug} overflows the ${device} viewport`,
            );
          const file = `${directory}/${slug.replaceAll("/", "-")}-${device}-${theme}.png`;
          await page.screenshot({
            path: path.join(root, file),
            fullPage: true,
            animations: "disabled",
          });
          const bytes = await readFile(path.join(root, file));
          receipt.documentation.push({
            page: slug,
            file,
            device,
            theme,
            viewport,
            pixelWidth: bytes.readUInt32BE(16),
            pixelHeight: bytes.readUInt32BE(20),
            deviceScaleFactor: manifest.deviceScaleFactor,
            fullPage: true,
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          });
          console.log(`Captured ${file}`);
        } catch (error) {
          if (page) {
            const diagnostic = `${directory}/failed-${slug.replaceAll("/", "-")}-${device}-${theme}.png`;
            await page
              .screenshot({ path: path.join(root, diagnostic) })
              .catch(() => {});
            receipt.documentationErrorCapture = diagnostic;
          }
          throw error;
        } finally {
          await context.close();
        }
      }
}

async function verifyPreviewAssets(origin, images) {
  const url = new URL(origin);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw new Error("Docs screenshots require a loopback preview URL");
  for (const image of images) {
    if (!/^docs\/screenshots\/release-v1\/[a-z0-9-]+\.png$/.test(image.file))
      throw new Error("Screenshot receipt contains an invalid asset path");
    const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
    if (hash(await readFile(path.join(root, image.file))) !== image.sha256)
      throw new Error(
        `Application screenshot changed after capture: ${image.file}`,
      );
    const route = image.file.replace(
      /^docs\/screenshots\//,
      "/assets/screenshots/",
    );
    if (
      hash(await readFile(path.join(root, "docs/mintlify", route))) !==
      image.sha256
    )
      throw new Error(
        "Regenerate the Mintlify site after refreshing application screenshots",
      );
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const response = await fetch(new URL(route, url), {
        signal: AbortSignal.timeout(5000),
      });
      if (
        response.ok &&
        hash(Buffer.from(await response.arrayBuffer())) === image.sha256
      ) {
        ready = true;
        break;
      }
      await pause(500);
    }
    if (!ready)
      throw new Error(
        `Docs preview does not serve the current screenshot: ${image.file}`,
      );
  }
}

async function buildState() {
  const hash = createHash("sha256");
  let modifiedAt = 0;
  const builtFiles = await readdir(path.join(root, "apps/web/dist"), {
    recursive: true,
  });
  for (const file of builtFiles.sort()) {
    const absolute = path.join(root, "apps/web/dist", file);
    const state = await stat(absolute);
    if (!state.isFile()) continue;
    hash.update(file);
    hash.update(await readFile(absolute));
    modifiedAt = Math.max(modifiedAt, state.mtimeMs);
  }
  return { sha256: hash.digest("hex"), modifiedAt };
}

async function resumeImages(manifest, receipt, version, build) {
  if (!receipt.cleanupVerified || receipt.version !== version)
    throw new Error(
      "Resume requires a cleaned-up capture of the current version",
    );
  if (
    build.modifiedAt > Date.parse(receipt.startedAt) ||
    (receipt.buildSha256 && receipt.buildSha256 !== build.sha256)
  )
    throw new Error("The application build changed since the previous capture");
  const images = [];
  for (const entry of manifest.screenshots) {
    const frames = receipt.images.filter((image) => image.name === entry.name);
    if (
      frames.length !==
      Object.keys(manifest.devices).length * manifest.themes.length
    )
      continue;
    const keys = new Set();
    for (const frame of frames) {
      const viewport = manifest.devices[frame.device];
      const suffix = frame.device === "mobile" ? "-mobile" : "";
      const expected = `${manifest.output}/${entry.name}${suffix}-${frame.theme}.png`;
      const key = `${frame.device}:${frame.theme}`;
      if (
        !viewport ||
        !manifest.themes.includes(frame.theme) ||
        keys.has(key) ||
        frame.file !== expected ||
        !frame.readiness?.apiRequestsDrained ||
        !frame.readiness?.populatedContentVerified
      )
        throw new Error("Previous capture has invalid or unverified frames");
      keys.add(key);
      const bytes = await readFile(path.join(root, expected));
      if (
        createHash("sha256").update(bytes).digest("hex") !== frame.sha256 ||
        bytes.readUInt32BE(16) !==
          viewport.width * manifest.deviceScaleFactor ||
        bytes.readUInt32BE(20) !== viewport.height * manifest.deviceScaleFactor
      )
        throw new Error(`Previous capture asset changed: ${expected}`);
      images.push(frame);
    }
  }
  return images;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "Usage: node tools/capture-docs-screenshots.mjs [--check] [--docs-url http://localhost:4174] [--docs-only] [--section name] [--resume]\nBuild first. Refreshes every application section in both themes and desktop/mobile using an isolated installation. Docs-only mode captures a regenerated preview after checking its application image hashes. Section mode is a diagnostic with a separate receipt. Resume retains verified sections only if the build has not changed. No production URL or existing login is accepted.",
    );
    return;
  }
  let docsOrigin;
  let section;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--docs-url" && args[index + 1])
      docsOrigin = args[++index];
    else if (args[index] === "--section" && args[index + 1])
      section = args[++index];
    else if (!["--check", "--docs-only", "--resume"].includes(args[index]))
      throw new Error(`Unknown screenshot argument: ${args[index]}`);
  }
  const manifest = validateManifest(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  if (section && !manifest.screenshots.some((entry) => entry.name === section))
    throw new Error(`Unknown screenshot section: ${section}`);
  let entries = section
    ? manifest.screenshots.filter((entry) => entry.name === section)
    : manifest.screenshots;
  if (section && docsOrigin)
    throw new Error(
      "Diagnostic section capture cannot be combined with documentation capture",
    );
  if (args.includes("--resume") && (section || args.includes("--docs-only")))
    throw new Error("Resume cannot be combined with section or docs-only mode");
  const navigation = JSON.parse(
    await readFile(path.join(root, "docs/mintlify/docs.json"), "utf8"),
  );
  const pages = new Set(documentationPages(navigation.navigation));
  for (const entry of manifest.screenshots)
    for (const guide of entry.guides)
      if (!pages.has(guide))
        throw new Error(
          `Screenshot ${entry.name} references an unknown guide: ${guide}`,
        );
  if (args.includes("--check")) {
    console.log(
      `Validated ${manifest.screenshots.length} sections, ${manifest.screenshots.length * 4} application images and ${pages.size} documentation pages.`,
    );
    return;
  }
  if (args.includes("--docs-only")) {
    if (!docsOrigin) throw new Error("--docs-only requires --docs-url");
    const receiptPath = path.join(root, "tmp/docs-screenshots-receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    if (
      !receipt.passed ||
      !receipt.cleanupVerified ||
      receipt.images.length !== manifest.screenshots.length * 4 ||
      receipt.images.some(
        (image) =>
          !image.readiness?.apiRequestsDrained ||
          !image.readiness?.populatedContentVerified,
      )
    )
      throw new Error(
        "Refresh every application screenshot successfully before capturing the documentation preview",
      );
    await verifyPreviewAssets(docsOrigin, receipt.images);
    const browser = await chromium.launch();
    try {
      receipt.documentation = [];
      receipt.documentationPassed = false;
      delete receipt.documentationError;
      delete receipt.documentationErrorCapture;
      await captureDocumentation(browser, docsOrigin, manifest, receipt);
      receipt.documentationPassed = true;
      receipt.documentationCapturedAt = new Date().toISOString();
    } catch (error) {
      receipt.documentationError = error.message;
      throw error;
    } finally {
      await browser.close();
      await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    }
    console.log(
      `Captured ${receipt.documentation.length} documentation screenshots. Receipt: tmp/docs-screenshots-receipt.json`,
    );
    return;
  }
  await stat(path.join(root, "apps/web/dist/index.html"));
  const build = await buildState();
  if (!process.env.DATABASE_URL) process.loadEnvFile(path.join(root, ".env"));
  if (!process.env.DATABASE_URL)
    throw new Error(
      "Set DATABASE_URL or provide .env for the isolated screenshot installation",
    );
  const port = await availablePort();
  const origin = `http://localhost:${port}`;
  const metadataPath = path.join(root, "tmp", `browser-${port}-schema.json`);
  const receiptPath = path.join(
    root,
    section
      ? `tmp/docs-screenshots-${section}-receipt.json`
      : "tmp/docs-screenshots-receipt.json",
  );
  await mkdir(path.join(root, manifest.output), { recursive: true });
  const receipt = {
    startedAt: new Date().toISOString(),
    environment: "Isolated local example workspace; not production data",
    viewportCapture: true,
    buildSha256: build.sha256,
    sections: entries.map((entry) => entry.name),
    version: JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
      .version,
    images: [],
    documentation: [],
    cleanupVerified: false,
    passed: false,
  };
  if (args.includes("--resume")) {
    const previous = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.images = await resumeImages(
      manifest,
      previous,
      receipt.version,
      build,
    );
    receipt.resumedFrom = {
      startedAt: previous.startedAt,
      finishedAt: previous.finishedAt,
      cleanupVerified: previous.cleanupVerified,
      retainedImages: receipt.images.length,
    };
    entries = entries.filter(
      (entry) => !receipt.images.some((image) => image.name === entry.name),
    );
    console.log(
      `Retained ${receipt.images.length} verified screenshots; capturing ${entries.length} remaining sections.`,
    );
  }
  let fixture, browser, schema, completion;
  const server = spawn(
    process.execPath,
    ["--import", "tsx", "tests/browser-server.ts"],
    {
      cwd: root,
      stdio: "ignore",
      env: {
        ...process.env,
        MILL_BROWSER_PORT: String(port),
        MILL_BROWSER_BASE_URL: origin,
      },
    },
  );
  let serverExited = false;
  const exited = new Promise((resolve) =>
    server.once("close", (code, signal) => {
      serverExited = true;
      resolve({ code, signal });
    }),
  );
  server.once("error", (error) => {
    completion = error;
  });
  const stop = () => server.kill("SIGTERM");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 300; attempt++) {
      if (serverExited || completion)
        throw new Error(
          "Isolated screenshot server exited before becoming ready",
        );
      try {
        ready = (await fetch(`${origin}/health/ready`)).ok;
      } catch {
        ready = false;
      }
      if (ready) break;
      await pause(100);
    }
    if (!ready)
      throw new Error("Isolated screenshot server did not become ready");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    if (
      !/^browser_[a-f0-9]{16}$/.test(metadata.schema) ||
      metadata.baseURL !== origin
    )
      throw new Error(
        "Screenshot installation isolation could not be confirmed",
      );
    schema = metadata.schema;
    browser = await chromium.launch();
    for (const entry of entries.filter((entry) => entry.beforeSetup))
      await capture(browser, origin, manifest, entry, {}, receipt);
    fixture = await seed(origin);
    for (const entry of entries.filter((entry) => !entry.beforeSetup))
      await capture(browser, origin, manifest, entry, fixture, receipt);
    if (docsOrigin) {
      await new Promise((resolve, reject) => {
        const generator = spawn(
          process.execPath,
          ["tools/build-mintlify-docs.mjs"],
          { cwd: root, stdio: "inherit" },
        );
        generator.once("error", reject);
        generator.once("close", (code) =>
          code === 0
            ? resolve()
            : reject(new Error("Mintlify regeneration failed")),
        );
      });
      await verifyPreviewAssets(docsOrigin, receipt.images);
      await captureDocumentation(browser, docsOrigin, manifest, receipt);
      receipt.documentationPassed = true;
    }
    if (
      receipt.images.length !==
      (section ? entries.length : manifest.screenshots.length) * 4
    )
      throw new Error("The screenshot set is incomplete");
    if ((await buildState()).sha256 !== build.sha256)
      throw new Error("The application build changed during capture");
    receipt.passed = true;
  } catch (error) {
    receipt.error = error.message;
    throw error;
  } finally {
    const resources = await Promise.allSettled([
      fixture?.api.dispose(),
      browser?.close(),
    ]);
    if (resources.some((result) => result.status === "rejected")) {
      receipt.passed = false;
      receipt.error ??= "Screenshot browser resources did not close cleanly";
    }
    stop();
    const shutdown = await Promise.race([
      exited,
      pause(10000).then(() => null),
    ]);
    if (!shutdown) server.kill("SIGKILL");
    if (schema && shutdown) {
      const database = postgres(process.env.DATABASE_URL, {
        max: 1,
        connect_timeout: 5,
        connection: { statement_timeout: 3000 },
        onnotice: () => {},
      });
      try {
        const [state] =
          await database`SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=${schema}) AS present`;
        receipt.cleanupVerified = state.present === false;
      } catch {
        receipt.error ??=
          "PostgreSQL did not confirm screenshot schema removal";
      } finally {
        await database.end({ timeout: 5 }).catch(() => {
          receipt.cleanupVerified = false;
        });
      }
    }
    receipt.passed &&= receipt.cleanupVerified;
    receipt.finishedAt = new Date().toISOString();
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (!receipt.passed) {
      process.exitCode = 1;
      console.error(
        "Screenshot refresh or installation cleanup failed; see receipt.",
      );
    }
  }
  if (receipt.passed)
    console.log(
      `Refreshed ${receipt.images.length} application screenshots. Receipt: ${path.relative(root, receiptPath)}`,
    );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main().catch((error) => {
    console.error(`Screenshot refresh failed: ${error.message}`);
    process.exitCode = 1;
  });
