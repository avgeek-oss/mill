import { cp, mkdir, readFile, rm, writeFile, mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { posix, resolve } from "node:path";
import { tmpdir } from "node:os";
import { format } from "prettier";
const { syncSite } = await import(
  new URL(
    "../bin/mintlify-docs.mjs",
    import.meta.resolve("@avgeek-oss/mintlify-docs"),
  )
);
const root = fileURLToPath(new URL("../", import.meta.url));
const source = resolve(root, "docs");
const output = source;
const check = process.argv.includes("--check");
const { version } = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const screenshots = JSON.parse(
  await readFile(resolve(root, "tools/docs-screenshots.json"), "utf8"),
);
const screenshotTitles = {
  setup: "Team setup",
  boards: "Boards",
  board: "Task list",
  task: "Task details and comments",
  "task-activity": "Task activity",
  "create-task": "Create a task",
  "board-settings": "Board settings",
  "empty-board": "An empty board",
  people: "People",
  "api-keys": "Personal API keys",
  "team-api-keys": "Team API keys",
  "mcp-connections": "MCP connections",
  account: "Profile",
  preferences: "Preferences",
  "email-password": "Email & Password",
  sessions: "Sessions",
  "mcp-guide": "MCP Guide",
  security: "Passkeys",
  team: "Team settings: General",
  notifications: "Notifications",
  "sign-in": "Sign in",
  "not-found": "A missing page",
  "server-error": "A page loading error",
};
function screenshotFrame(entry, device) {
  const dimensions = screenshots.devices[device];
  const scale = entry.deviceScaleFactor ?? screenshots.deviceScaleFactor;
  const suffix = device === "mobile" ? "-mobile" : "";
  return `<Screenshot light="/assets/screenshots/release-v1/${entry.name}${suffix}-light.png" dark="/assets/screenshots/release-v1/${entry.name}${suffix}-dark.png" alt="${screenshotTitles[entry.name]} in Mill with sample data." width={${dimensions.width * scale}} height={${dimensions.height * scale}}${device === "mobile" ? " portrait" : ""} />`;
}
function guideScreenshot(name) {
  const entry = screenshots.screenshots.find((entry) => entry.name === name);
  if (!entry) throw new Error(`Unknown screenshot: ${name}`);
  return `<Tabs>\n<Tab title="Desktop">\n${screenshotFrame(entry, "desktop")}\n</Tab>\n<Tab title="Mobile">\n${screenshotFrame(entry, "mobile")}\n</Tab>\n</Tabs>`;
}
async function emit(name, content, parser = "mdx") {
  const target = resolve(output, name);
  const formatted = await format(content, { parser });
  if (check) {
    if ((await readFile(target, "utf8").catch(() => null)) !== formatted)
      throw new Error(`Generated docs differ: ${name}; run pnpm docs:build`);
  } else {
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, formatted);
  }
}
const pages = [
  ["overview", "About Mill", "Self-hosted task lists for teams.", "book-open"],
  [
    "boards",
    "Boards",
    "Organize work into boards with unique task prefixes.",
    "clipboard-list",
  ],
  [
    "task-lists",
    "Task lists",
    "Search, filter, sort and update tasks in bulk.",
    "list-checks",
  ],
  [
    "task-details",
    "Task details",
    "Edit tasks, discuss work and review changes.",
    "file-text",
  ],
  [
    "task-attachments",
    "Task attachments",
    "Upload, preview and download images and PDFs.",
    "paperclip",
  ],
  [
    "notifications",
    "Notifications",
    "Follow assignments, mentions and task changes.",
    "bell",
  ],
  [
    "authentication",
    "Accounts and team access",
    "Manage invitations, sessions, passkeys and recovery.",
    "users",
  ],
  [
    "api-keys",
    "API keys",
    "Connect REST clients with scoped personal or team keys.",
    "key-round",
  ],
  [
    "mcp-connections",
    "MCP connections",
    "Approve and revoke connections from MCP clients.",
    "plug",
  ],
  [
    "installation",
    "Architecture overview",
    "Understand Mill's services and choose an installation method.",
    "network",
    "Overview",
  ],
  [
    "installation/docker-compose",
    "Docker Compose",
    "Install Mill with Docker Compose and PostgreSQL.",
    "/assets/installation/docker-compose.png",
  ],
  [
    "installation/towbar",
    "Towbar",
    "Deploy Mill through your existing Towbar installation.",
    "/assets/installation/towbar.png",
  ],
  [
    "configuration",
    "Configuration",
    "Configure public origins, private storage and email.",
    "settings",
  ],
  [
    "security",
    "Security",
    "Protect your installation and report vulnerabilities.",
    "shield-check",
  ],
  [
    "backup",
    "Backup and recovery",
    "Back up PostgreSQL and test a full restore.",
    "database-backup",
  ],
  ["upgrades", "Upgrades", "Upgrade Mill with a tested backup.", "package"],
  [
    "troubleshooting",
    "Troubleshooting",
    "Resolve installation, sign-in and client access errors.",
    "wrench",
  ],
];
const aliases = {
  "getting-started": "/boards",
  workflows: "/task-details",
  clients: "/api-keys",
  api: "/api-reference/overview",
  operations: "/troubleshooting",
  "towbar-deployment": "/installation/towbar",
  "package-registry":
    "https://github.com/avgeek-oss/mill/blob/main/CONTRIBUTING.md",
  "release-notes": "https://github.com/avgeek-oss/mill/releases",
};
const included = new Set(pages.map(([name]) => name));
function rewriteLinks(body, name) {
  return body.replace(/\]\(([^)]+)\)/g, (match, href) => {
    if (/^(?:https?:|mailto:|#)/.test(href)) return match;
    const [file, anchor = ""] = href.split("#", 2);
    const route = file.startsWith("/")
      ? file.slice(1).replace(/\.md$/, "")
      : posix
          .normalize(posix.join(posix.dirname(name), file))
          .replace(/\.md$/, "");
    if (route === "../SECURITY") return "](/security)";
    if (route === "operations" && anchor === "account-recovery")
      return "](/authentication#recover-an-account)";
    const destination = included.has(route) ? `/${route}` : aliases[route];
    if (!destination) return match;
    return `](${destination}${anchor && !aliases[route] ? `#${anchor}` : ""})`;
  });
}
const retired = [
  "getting-started",
  "workflows",
  "clients",
  "rest-reference",
  "towbar-deployment",
  "package-registry",
  "operations",
  "release-notes",
];
for (const name of retired) {
  const target = resolve(output, `${name}.mdx`);
  if (check) {
    if (await readFile(target, "utf8").catch(() => null))
      throw new Error(
        `Retired public page still exists: ${name}; run pnpm docs:build`,
      );
  } else await rm(target, { force: true });
}
await emit("index.mdx", await readFile(resolve(source, "home.mdx"), "utf8"));
for (const [name, title, description, icon, sidebarTitle] of pages) {
  let body = rewriteLinks(
    (await readFile(resolve(source, `${name}.md`), "utf8"))
      .replace(/^# .+\n\n/, "")
      .replace(
        /<!-- installed-only:start -->[\s\S]*?<!-- installed-only:end -->\n*/g,
        "",
      ),
    name,
  );
  let hasScreenshots = false;
  body = body.replace(/<!-- screenshot:([\w-]+) -->/g, (_match, capture) => {
    hasScreenshots = true;
    return guideScreenshot(capture);
  });
  const metadata = `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\nicon: ${JSON.stringify(icon)}\n${sidebarTitle ? `sidebarTitle: ${JSON.stringify(sidebarTitle)}\n` : ""}---\n\n`;
  await emit(
    `${name}.mdx`,
    metadata +
      (hasScreenshots
        ? 'import { Screenshot } from "/snippets/oss/screenshot.jsx";\n\n'
        : "") +
      body,
  );
}
for (const name of ["mill-mark.png", "mill-favicon.png", "mill-social.png"]) {
  const input = resolve(root, "apps/web/public/brand", name),
    target = resolve(output, "assets", name);
  if (check) {
    if (!(await readFile(input)).equals(await readFile(target)))
      throw new Error(`Brand asset differs: ${name}`);
  } else {
    await mkdir(resolve(output, "assets"), { recursive: true });
    await cp(input, target);
  }
}
const config = JSON.parse(
  (await readFile(resolve(source, "site.json"), "utf8")).replaceAll(
    "{version}",
    version,
  ),
);
const references = JSON.parse(
  await readFile(resolve(source, "reference-navigation.json"), "utf8"),
);
config.navigation.dropdowns
  .find((item) => item.dropdown === "API & MCP")
  .groups.push(
    {
      group: "MCP reference",
      pages: ["mcp-reference/overview", ...references.mcp],
    },
    {
      group: "API Reference",
      pages: ["api-reference/overview", ...references.api],
    },
  );
function validateNavigation(value) {
  if (typeof value === "string")
    return readFile(resolve(source, `${value}.mdx`));
  return Promise.all(
    value.map((item) =>
      typeof item === "string"
        ? validateNavigation(item)
        : validateNavigation(item.pages),
    ),
  );
}
await Promise.all(
  config.navigation.dropdowns.flatMap((item) =>
    item.groups.map((group) => validateNavigation(group.pages)),
  ),
);
const temp = await mkdtemp(resolve(tmpdir(), "mill-docs-"));
try {
  const path = resolve(temp, "site.json");
  await writeFile(path, JSON.stringify(config));
  await syncSite({ config: path, dir: output, check });
} finally {
  await rm(temp, { recursive: true, force: true });
}
console.log(
  `${check ? "Checked" : "Generated"} ${pages.length + 1} pages with @avgeek-oss/mintlify-docs in docs/`,
);
