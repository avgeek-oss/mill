import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { format } from "prettier";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = resolve(root, "docs");
const output = resolve(source, "mintlify");

const pages = [
  [
    "overview",
    "Mill",
    "A self-hosted task list for people and external agents.",
  ],
  [
    "installation",
    "Installation",
    "Install Mill with Docker Compose and PostgreSQL.",
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
    "agents",
    "REST clients and MCP Agents",
    "Connect external clients with personal API keys or Agent OAuth.",
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
    "Resolve common installation, sign-in, and agent access errors.",
  ],
  [
    "release-notes",
    "Beta release notes",
    "Changes and upgrade notes for the proposed first beta.",
  ],
];

const slug = (name) => (name === "api" ? "rest-reference" : name);
const included = new Set(pages.map(([name]) => name));
await mkdir(resolve(output, "assets"), { recursive: true });

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
  await writeFile(resolve(output, `${slug(name)}.md`), metadata + body);
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
  description: "Self-hosted task lists for people and external agents.",
  logo: {
    light: "/assets/mill-lockup-light.svg",
    dark: "/assets/mill-lockup-dark.svg",
    href: "/",
  },
  favicon: "/assets/mill-favicon.png",
  colors: { primary: "#704628", light: "#704628", dark: "#c89b6d" },
  appearance: { default: "system" },
  navigation: {
    groups: [
      {
        group: "Start",
        pages: ["overview", "installation", "getting-started"],
      },
      { group: "Use Mill", pages: ["workflows", "authentication", "agents"] },
      {
        group: "Reference",
        pages: ["rest-reference", "configuration", "security"],
      },
      {
        group: "Operate",
        pages: ["operations", "backup", "upgrades", "troubleshooting"],
      },
      { group: "Release", pages: ["release-notes"] },
    ],
  },
};
await writeFile(
  resolve(output, "docs.json"),
  await format(JSON.stringify(config), { parser: "json", tabWidth: 2 }),
);
console.log(`Prepared ${pages.length} Mintlify pages in docs/mintlify`);
