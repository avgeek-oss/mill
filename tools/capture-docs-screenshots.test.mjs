import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import {
  documentationPages,
  validateManifest,
  verifyPreviewAssets,
} from "./capture-docs-screenshots.mjs";

const manifest = JSON.parse(
  await readFile(new URL("./docs-screenshots.json", import.meta.url), "utf8"),
);

test("documentation preview serves the captured asset bytes at the public root path", async () => {
  const file = "docs/assets/screenshots/release-v1/setup-light.png";
  const bytes = await readFile(new URL(`../${file}`, import.meta.url));
  const image = {
    file,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    await verifyPreviewAssets(origin, [image]);
    assert.deepEqual(requests, [
      "/assets/screenshots/release-v1/setup-light.png",
    ]);
    await assert.rejects(
      verifyPreviewAssets(origin, [{ ...image, file: "../../.env" }]),
      /invalid asset path/,
    );
    await assert.rejects(
      verifyPreviewAssets(origin, [{ ...image, sha256: "0".repeat(64) }]),
      /changed after capture/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

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
