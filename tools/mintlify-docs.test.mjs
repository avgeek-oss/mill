import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

test("Mintlify generation preserves maintained sources and produces navigable pages with complete assets", async () => {
  await mkdir(resolve(root, "tmp"), { recursive: true });
  const fixture = await mkdtemp(resolve(root, "tmp/mintlify-generation-"));
  const inputs = [
    "home.mdx",
    "site.json",
    "task-lists.md",
    "task-details.md",
    "notifications.md",
    "api-keys.md",
    "mcp-connections.md",
    "overview.md",
    "installation.md",
    "package-registry.md",
    "getting-started.md",
    "workflows.md",
    "authentication.md",
    "clients.md",
    "api.md",
    "configuration.md",
    "security.md",
    "operations.md",
    "backup.md",
    "upgrades.md",
    "troubleshooting.md",
    "release-notes.md",
  ];
  try {
    await mkdir(resolve(fixture, "tools"), { recursive: true });
    await mkdir(resolve(fixture, "docs"), { recursive: true });
    for (const name of inputs)
      await cp(resolve(root, "docs", name), resolve(fixture, "docs", name));
    await cp(
      resolve(root, "tools/build-mintlify-docs.mjs"),
      resolve(fixture, "tools/build-mintlify-docs.mjs"),
    );
    await cp(
      resolve(root, "tools/docs-screenshots.json"),
      resolve(fixture, "tools/docs-screenshots.json"),
    );
    await cp(
      resolve(root, "apps/web/public/brand"),
      resolve(fixture, "apps/web/public/brand"),
      { recursive: true },
    );
    await cp(
      resolve(root, "docs/assets/screenshots/release-v1"),
      resolve(fixture, "docs/assets/screenshots/release-v1"),
      { recursive: true },
    );
    await writeFile(
      resolve(fixture, "package.json"),
      JSON.stringify({ type: "module", version: "2.3.4" }),
    );
    const sources = await Promise.all(
      inputs.map((name) => readFile(resolve(fixture, "docs", name), "utf8")),
    );
    for (let run = 0; run < 2; run++) {
      const result = spawnSync(
        process.execPath,
        [resolve(fixture, "tools/build-mintlify-docs.mjs")],
        { encoding: "utf8", timeout: 30_000 },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
    assert.deepEqual(
      await Promise.all(
        inputs.map((name) => readFile(resolve(fixture, "docs", name), "utf8")),
      ),
      sources,
    );
    const output = resolve(fixture, "docs");
    assert.equal(
      await readFile(resolve(output, "index.mdx"), "utf8"),
      await readFile(resolve(root, "docs/index.mdx"), "utf8"),
    );
    assert.ok(
      (await readFile(resolve(output, "oss-docs.css"), "utf8")).includes(
        "@avgeek-oss/docs 0.1.5",
      ),
    );
    const config = JSON.parse(
      await readFile(resolve(output, "docs.json"), "utf8"),
    );
    assert.equal(config.navbar.links[0].label, "v2.3.4");
    const routes = config.navigation.dropdowns.flatMap((section) =>
      section.groups.flatMap((group) => group.pages),
    );
    assert.ok(routes.includes("package-registry"));
    assert.ok(
      (await readFile(resolve(output, "installation.mdx"), "utf8")).includes(
        "](/package-registry)",
      ),
    );
    const pages = ["index.mdx", ...routes.map((route) => `${route}.mdx`)];
    const links = [
      config.logo.href,
      config.logo.light,
      config.logo.dark,
      config.favicon,
      config.navbar.primary.href,
      ...config.navbar.links.map((link) => link.href),
      ...config.footer.links.flatMap((group) =>
        group.items.map((item) => item.href),
      ),
    ];
    for (const page of pages) {
      const content = await readFile(resolve(output, page), "utf8");
      links.push(
        ...[...content.matchAll(/(?:href|src)="([^"]+)"|\]\((\/[^)]+)\)/g)].map(
          (match) => match[1] || match[2],
        ),
      );
    }
    for (const link of links) {
      if (!link.startsWith("/")) continue;
      const route = link.split("#")[0].slice(1) || "index";
      const candidates = [route, `${route}.md`, `${route}.mdx`];
      const exists = await Promise.all(
        candidates.map((candidate) =>
          stat(resolve(output, candidate))
            .then((file) => file.isFile())
            .catch(() => false),
        ),
      );
      assert.ok(
        exists.some(Boolean),
        `Missing generated route or image: ${link}`,
      );
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
