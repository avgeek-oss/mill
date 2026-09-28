import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
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
    else if (extname(entry.name) === ".md") files.push(path);
  }
}
await walk(root);
const errors = [];
for (const path of files) {
  const source = (await readFile(path, "utf8"))
    .replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*$/gm, "")
    .replace(/`[^`\n]*`/g, "");
  for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    let destination = match[1].split(" ")[0].replace(/^<|>$/g, "");
    if (/^(https?:|mailto:|#)/.test(destination)) continue;
    destination = destination.split("#")[0];
    if (!destination) continue;
    const target = resolve(dirname(path), decodeURIComponent(destination));
    try {
      await stat(target);
    } catch {
      errors.push(`${path.slice(root.length)}: missing ${destination}`);
    }
  }
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else
  console.log(`PASS ${files.length} Markdown files have valid local links`);
