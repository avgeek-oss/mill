import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, dirname, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@mdx-js/mdx";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = resolve(root, "docs");
const site = JSON.parse(await readFile(resolve(dir, "docs.json"), "utf8"));
assert.equal(site.name, "Mill");
assert.equal(site.seo.metatags.canonical, "https://www.mill.fyi");
function pageRoutes(items) {
  return items.flatMap((item) =>
    typeof item === "string"
      ? [item]
      : pageRoutes(item.pages ?? item.groups ?? []),
  );
}
const routes = pageRoutes(
  site.navigation.dropdowns.flatMap((item) => item.groups),
);
assert.equal(new Set(routes).size, routes.length, "Duplicate navigation route");
// Every navigation route is a published page that compiles as MDX and carries
// the title and description Mintlify uses for search and link previews.
for (const route of routes) {
  const body = await readFile(resolve(dir, route + ".mdx"), "utf8");
  await compile(body);
  assert(
    /^---\n[\s\S]*title: .+[\s\S]*description: .+[\s\S]*?\n---/.test(body),
    `${route} needs metadata`,
  );
}
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      [
        "node_modules",
        ".git",
        "dist",
        "tmp",
        "playwright-report",
        "test-results",
      ].includes(entry.name) ||
      entry.name.startsWith("test-results-")
    )
      continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if ([".md", ".mdx"].includes(extname(entry.name))) files.push(path);
  }
}
await walk(root);
// The docs .md files and home.mdx are the sources tools/build-mintlify-docs.mjs
// turns into the published .mdx pages (home.mdx becomes index.mdx), so only
// the published pages must be reachable.
const publishedRoutes = new Set([
  ...routes,
  "index",
  "home",
  ...(site.redirects ?? []).map(({ source }) => source.replace(/^\//, "")),
]);
for (const path of files)
  if (path.startsWith(`${dir}/`) && extname(path) === ".mdx") {
    const route = relative(dir, path).slice(0, -4);
    assert(
      publishedRoutes.has(route),
      `${route} is missing from navigation or redirects`,
    );
  }
const errors = [];
for (const path of files) {
  const source = (await readFile(path, "utf8"))
    .replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*$/gm, "")
    .replace(/`[^`\n]*`/g, "");
  // Documentation pages and their .md sources link to site routes.
  const inDocs = path.startsWith(`${dir}/`);
  const links = [
    ...source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g),
    ...source.matchAll(/(?:href|light|dark|src)="([^"]+)"/g),
    ...source.matchAll(/icon="(\/[^"]+)"/g),
    ...source.matchAll(/^icon: "(\/[^"]+)"/gm),
  ];
  for (const match of links) {
    let destination = match[1].split(" ")[0].replace(/^<|>$/g, "");
    if (/^(https?:|mailto:|#)/.test(destination)) continue;
    destination = destination.split("#")[0];
    if (!destination) continue;
    const target =
      inDocs && destination.startsWith("/")
        ? resolve(dir, decodeURIComponent(destination.slice(1)))
        : resolve(dirname(path), decodeURIComponent(destination));
    let found = false;
    for (const candidate of inDocs ? [target, `${target}.mdx`] : [target])
      try {
        await stat(candidate);
        found = true;
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    if (!found)
      errors.push(`${path.slice(root.length)}: missing ${destination}`);
  }
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `PASS ${routes.length} routes compile with metadata and ${files.length} Markdown files have valid local links`,
  );
