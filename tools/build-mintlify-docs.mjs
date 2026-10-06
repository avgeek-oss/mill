import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { format } from "prettier";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = resolve(root, "docs");
const output = resolve(source, "mintlify");
const { version } = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const screenshots = JSON.parse(
  await readFile(resolve(root, "tools/docs-screenshots.json"), "utf8"),
);
const screenshotTitles = {
  setup: "Workspace setup",
  boards: "Boards",
  board: "Task list",
  task: "Task details and comments",
  "task-activity": "Task activity",
  "create-task": "Create a task",
  "board-settings": "Board settings",
  "empty-board": "An empty board",
  people: "People",
  "api-keys": "Personal API keys",
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
  const suffix = device === "mobile" ? "-mobile" : "";
  const images = screenshots.themes.map(
    (theme) =>
      `<div className="mill-product-${theme}"><img src="/assets/screenshots/release-v1/${entry.name}${suffix}-${theme}.png" alt="${screenshotTitles[entry.name]} in Mill." width="${dimensions.width}" height="${dimensions.height}" loading="lazy" /></div>`,
  );
  return `<Frame><div className="mill-guide-screenshot${device === "mobile" ? " mill-guide-screenshot-mobile" : ""}">${images.join("\n")}</div></Frame>`;
}

function guideScreenshots(route) {
  const entries = screenshots.screenshots.filter((entry) =>
    entry.guides.includes(route),
  );
  if (!entries.length) return "";
  return `\n\n## In the app\n\n${entries.map((entry) => `### ${screenshotTitles[entry.name]}\n\n<Tabs>\n<Tab title="Desktop">\n${screenshotFrame(entry, "desktop")}\n</Tab>\n<Tab title="Mobile">\n${screenshotFrame(entry, "mobile")}\n</Tab>\n</Tabs>`).join("\n\n")}\n`;
}

const pages = [
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
await mkdir(resolve(output, "assets"), { recursive: true });
await rm(resolve(output, "agents.md"), { force: true });
await cp(resolve(source, "home.mdx"), resolve(output, "index.mdx"));
await cp(resolve(source, "home.css"), resolve(output, "style.css"));
await cp(
  resolve(source, "screenshots/release-v1"),
  resolve(output, "assets/screenshots/release-v1"),
  { recursive: true },
);

for (const [name, title, description] of pages) {
  let body = await readFile(resolve(source, `${name}.md`), "utf8");
  body = body.replace(/^# .+\n\n/, "");
  body = body.replaceAll("(../SECURITY.md)", "(/security)");
  body = body.replace(
    /\]\(([^)]+\.md)(#[^)]+)?\)/g,
    (match, file, anchor = "") => {
      const target = file.replace(/^\.\//, "").replace(/\.md$/, "");
      return included.has(target) ? `](/${slug(target)}${anchor})` : match;
    },
  );
  const metadata = `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n\n`;
  await writeFile(
    resolve(output, `${slug(name)}.md`),
    await format(metadata + body + guideScreenshots(slug(name)), {
      parser: "mdx",
    }),
  );
}

await cp(
  resolve(root, "apps/web/public/brand/mill-mark.png"),
  resolve(output, "assets/mill-mark.png"),
);
await cp(
  resolve(root, "apps/web/public/brand/mill-favicon.png"),
  resolve(output, "assets/mill-favicon.png"),
);
await cp(
  resolve(root, "apps/web/public/brand/mill-lockup-light.svg"),
  resolve(output, "assets/mill-lockup-light.svg"),
);
await cp(
  resolve(root, "apps/web/public/brand/mill-lockup-dark.svg"),
  resolve(output, "assets/mill-lockup-dark.svg"),
);

const config = {
  $schema: "https://mintlify.com/docs.json",
  theme: "mint",
  name: "Mill",
  description: "Self-hosted task lists for teams.",
  logo: {
    light: "/assets/mill-lockup-light.svg",
    dark: "/assets/mill-lockup-dark.svg",
    href: "/",
  },
  favicon: "/assets/mill-favicon.png",
  colors: { primary: "#704628", light: "#704628", dark: "#c89b6d" },
  appearance: { default: "system" },
  icons: { library: "lucide" },
  styling: { eyebrows: "breadcrumbs", codeblocks: "system" },
  interaction: { drilldown: false },
  navigation: {
    dropdowns: [
      {
        dropdown: "Introduction",
        icon: "book-open",
        groups: [
          { group: "Get started", pages: ["overview", "getting-started"] },
        ],
      },
      {
        dropdown: "Using Mill",
        icon: "clipboard-list",
        groups: [
          { group: "Tasks and people", pages: ["workflows", "authentication"] },
        ],
      },
      {
        dropdown: "Self-hosting",
        icon: "server",
        groups: [
          {
            group: "Install and configure",
            pages: [
              "installation",
              "package-registry",
              "configuration",
              "security",
            ],
          },
          {
            group: "Operate Mill",
            pages: [
              "operations",
              "backup",
              "upgrades",
              "troubleshooting",
              "release-notes",
            ],
          },
        ],
      },
      {
        dropdown: "API and MCP",
        icon: "plug",
        groups: [
          { group: "Connect a client", pages: ["clients", "rest-reference"] },
        ],
      },
    ],
  },
  navbar: {
    links: [
      { label: `v${version}`, href: "/release-notes" },
      { type: "github", href: "https://github.com/avgeek-inc/mill" },
    ],
    primary: { type: "button", label: "Docs", href: "/overview" },
  },
  footer: {
    socials: { github: "https://github.com/avgeek-inc/mill" },
    links: [
      {
        header: "Documentation",
        items: [
          { label: "Your first board", href: "/getting-started" },
          { label: "Install Mill", href: "/installation" },
          { label: "REST and MCP", href: "/clients" },
        ],
      },
      {
        header: "Project",
        items: [
          { label: "GitHub", href: "https://github.com/avgeek-inc/mill" },
          { label: "Release notes", href: "/release-notes" },
          { label: "Security", href: "/security" },
        ],
      },
    ],
  },
  contextual: { options: ["copy", "view", "chatgpt", "claude"] },
  seo: {
    organization: {
      name: "Mill",
      url: "https://mill.fyi",
      logo: "https://mill.fyi/assets/mill-mark.png",
      sameAs: ["https://github.com/avgeek-inc/mill"],
    },
  },
};
await writeFile(
  resolve(output, "docs.json"),
  await format(JSON.stringify(config), { parser: "json", tabWidth: 2 }),
);
console.log(
  `Prepared homepage and ${pages.length} Mintlify guides in docs/mintlify`,
);
