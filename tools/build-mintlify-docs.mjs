import { cp, mkdir, readFile, rm, writeFile, mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { format } from "prettier";
const { syncSite } = await import(
  new URL("../bin/oss-docs.mjs", import.meta.resolve("@avgeek-oss/docs"))
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
function guideScreenshots(route) {
  const entries = screenshots.screenshots.filter((entry) =>
    entry.guides.includes(route),
  );
  if (!entries.length) return "";
  return `\n\n## In the app\n\n${entries.map((entry) => `### ${screenshotTitles[entry.name]}\n\n<Tabs>\n<Tab title="Desktop">\n${screenshotFrame(entry, "desktop")}\n</Tab>\n<Tab title="Mobile">\n${screenshotFrame(entry, "mobile")}\n</Tab>\n</Tabs>`).join("\n\n")}\n`;
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
  [
    "task-lists",
    "Task lists",
    "Search, filter and sort the work on your boards.",
  ],
  [
    "task-details",
    "Task details",
    "Edit tasks, set dates, discuss work and inspect its history.",
  ],
  [
    "notifications",
    "Notifications",
    "Review assignments, mentions and changes that need your attention.",
  ],
  [
    "api-keys",
    "API keys",
    "Create personal and team keys with explicit permissions and expiry.",
  ],
  [
    "mcp-connections",
    "MCP connections",
    "Approve and revoke scoped connections from MCP clients.",
  ],
  ["overview", "Mill", "A self-hosted task list for teams."],
  [
    "installation",
    "Installation",
    "Install Mill with Docker Compose and PostgreSQL.",
  ],
  [
    "package-registry",
    "Package registry setup",
    "Authenticate source builds to GitHub Packages.",
  ],
  [
    "getting-started",
    "Your first board",
    "Set up a workspace and make your first task.",
  ],
  [
    "workflows",
    "Everyday work",
    "Boards, tasks, roles, comments, and notifications.",
  ],
  [
    "authentication",
    "Accounts and team access",
    "Invitations, sessions, passkeys, recovery, and access boundaries.",
  ],
  [
    "clients",
    "REST and MCP clients",
    "Connect external clients with personal API keys or OAuth.",
  ],
  [
    "api",
    "REST API",
    "Fields, permissions, pagination, errors, and OAuth/MCP endpoints.",
  ],
  [
    "configuration",
    "Configuration",
    "Required and optional environment settings.",
  ],
  [
    "security",
    "Security",
    "Protect an installation and report a vulnerability privately.",
  ],
  [
    "operations",
    "Operations",
    "Health checks, migrations, recovery, and routine care.",
  ],
  [
    "backup",
    "Backup and recovery",
    "Back up PostgreSQL and test a full restore.",
  ],
  [
    "upgrades",
    "Upgrades",
    "Migrate an existing installation with a tested backup.",
  ],
  [
    "troubleshooting",
    "Troubleshooting",
    "Resolve common installation, sign-in, and client access errors.",
  ],
  [
    "release-notes",
    "Release notes",
    "Changes and upgrade notes for the proposed first release.",
  ],
];

const slug = (name) => (name === "api" ? "rest-reference" : name);
const included = new Set(pages.map(([name]) => name));
await emit("index.mdx", await readFile(resolve(source, "home.mdx"), "utf8"));
for (const [name, title, description] of pages) {
  let body = await readFile(resolve(source, `${name}.md`), "utf8");
  body = body
    .replace(/^# .+\n\n/, "")
    .replaceAll("(../SECURITY.md)", "(/security)");
  body = body.replace(
    /\]\(([^)]+\.md)(#[^)]+)?\)/g,
    (match, file, anchor = "") => {
      const target = file.replace(/^\.\//, "").replace(/\.md$/, "");
      return included.has(target) ? `](/${slug(target)}${anchor})` : match;
    },
  );
  const images = guideScreenshots(slug(name));
  const metadata = `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n\n`;
  await emit(
    `${slug(name)}.mdx`,
    metadata +
      (images
        ? 'import { Screenshot } from "/snippets/oss/screenshot.jsx";\n\n'
        : "") +
      body +
      images,
  );
}
for (const name of [
  "mill-mark.png",
  "mill-favicon.png",
  "mill-social.png",
  "mill-lockup-light.svg",
  "mill-lockup-dark.svg",
]) {
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
const temp = await mkdtemp(resolve(tmpdir(), "mill-docs-"));
try {
  const path = resolve(temp, "site.json");
  await writeFile(path, JSON.stringify(config));
  await syncSite({ config: path, dir: output, check });
} finally {
  await rm(temp, { recursive: true, force: true });
}
console.log(
  `${check ? "Checked" : "Generated"} ${pages.length + 1} pages with @avgeek-oss/docs in docs/`,
);
