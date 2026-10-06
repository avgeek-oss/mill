import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { frontendGuides, renderGuides } from "./frontend-guides.mjs";

test("curated installed guides retain commands, resolve every local link and exclude live environment values", async () => {
  const guides = await renderGuides({
    stylesheets: ["assets/index-guide.css"],
  });
  assert.equal(guides.size, 14);
  assert.ok(guides.get("guides/clients.html").includes("/mcp"));
  assert.ok(guides.get("guides/backup.html").includes("tools/backup.sh"));
  assert.ok(
    guides.get("guides/operations.html").includes('id="account-recovery"'),
  );
  assert.equal(
    guides.get("guides/environment.txt"),
    await readFile(new URL("../.env.example", import.meta.url), "utf8"),
  );
  for (const [file, html] of guides) {
    if (!file.endsWith(".html")) continue;
    assert.ok(html.includes('href="/assets/index-guide.css"'));
    assert.ok(html.includes('name="viewport"'));
    assert.doesNotMatch(html, /<script[\s>]/);
    for (const match of html.matchAll(/href="(\/guides\/[^"#]+)(?:#[^"]*)?"/g))
      assert.ok(guides.has(match[1].slice(1)), `${file}: ${match[1]}`);
    assert.doesNotMatch(html, /href="[^"#]*\.md(?:#|")/);
    assert.doesNotMatch(html, /\/Users\/|node_modules\/|DATABASE_URL=postgres/);
  }
});

test("rendering escapes unsafe content, preserves useful Markdown and fails dead relative links", async () => {
  const root = await mkdtemp(join(tmpdir(), "mill-guide-"));
  try {
    await writeFile(
      join(root, "guide.md"),
      '# A <safe> guide\n\n<script>alert(1)</script>\n\n[Bad](javascript:alert(1)) [Local](second.md#account-recovery)\n\n```sh\ncurl --fail "$MILL_URL/api/boards"\n```\n\n| Field | Value |\n| --- | --- |\n| mode | read |',
    );
    await writeFile(
      join(root, "second.md"),
      "# Second\n\n## Account recovery\n",
    );
    const guides = [
      { source: "guide.md", output: "guide.html" },
      { source: "second.md", output: "second.html" },
    ];
    const rendered = await renderGuides({ root, guides });
    const html = rendered.get("guides/guide.html");
    assert.ok(html.includes("&lt;safe&gt;"));
    assert.ok(html.includes('href="/guides/second.html#account-recovery"'));
    assert.ok(html.includes("<table>"));
    assert.ok(html.includes('class="language-sh"'));
    assert.doesNotMatch(html, /<script[\s>]|href="javascript:/);
    await writeFile(
      join(root, "guide.md"),
      "# Dead link\n\n[Missing](missing.md)",
    );
    await assert.rejects(renderGuides({ root, guides }), /unbundled file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("build plugin emits static guides using actual CSS assets and rejects a stylesheet-free build", async () => {
  const emitted = [];
  const plugin = frontendGuides();
  await plugin.generateBundle.handler.call(
    { emitFile: (asset) => emitted.push(asset) },
    {},
    {
      style: { type: "asset", fileName: "assets/index-built.css" },
      script: { type: "chunk", fileName: "assets/index-built.js" },
    },
  );
  assert.equal(emitted.length, 14);
  assert.ok(emitted.every((asset) => asset.type === "asset"));
  assert.ok(
    emitted
      .find((asset) => asset.fileName === "guides/backup.html")
      .source.includes('href="/assets/index-built.css"'),
  );
  await assert.rejects(
    plugin.generateBundle.handler.call({ emitFile() {} }, {}, {}),
    /stylesheet/,
  );
});
