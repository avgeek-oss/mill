import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  documentationPages,
  validateManifest,
} from "./capture-docs-screenshots.mjs";

const manifest = JSON.parse(
  await readFile(new URL("./docs-screenshots.json", import.meta.url), "utf8"),
);

test("screenshot refresh rejects destinations outside the documentation asset directory", () => {
  assert.throws(
    () => validateManifest({ ...manifest, output: "../screenshots" }),
    /output directory/,
  );
});
test("screenshot sections cannot silently omit a theme or repeat a destination", () => {
  assert.throws(
    () => validateManifest({ ...manifest, themes: ["light"] }),
    /light and dark/,
  );
  assert.throws(
    () =>
      validateManifest({
        ...manifest,
        screenshots: [...manifest.screenshots, manifest.screenshots[0]],
      }),
    /unique/,
  );
});
test("documentation capture finds pages in grouped, tabbed and nested navigation", () => {
  assert.deepEqual(
    documentationPages({
      tabs: [
        {
          tab: "Start",
          groups: [
            {
              pages: [
                "index",
                "installation",
                { group: "Guides", pages: ["workflows", "clients"] },
              ],
            },
          ],
        },
        { tab: "Reference", pages: ["clients", "rest-reference"] },
      ],
    }),
    ["clients", "index", "installation", "rest-reference", "workflows"],
  );
  assert.deepEqual(documentationPages({ groups: [{ pages: ["overview"] }] }), [
    "index",
    "overview",
  ]);
  assert.throws(
    () => documentationPages({ pages: ["https://example.com/private"] }),
    /local slugs/,
  );
  assert.throws(() => documentationPages({ pages: [] }), /no pages/);
});
