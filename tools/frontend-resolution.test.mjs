import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

test("app and workspace adapter share the published toast, theme, and React Aria modules", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const web = createRequire(
    new URL("../apps/web/package.json", import.meta.url),
  );
  const { resolveConfig } = await import(
    pathToFileURL(web.resolve("vite")).href
  );
  const config = await resolveConfig(
    {
      root: resolve(root, "apps/web"),
      configFile: resolve(root, "apps/web/vite.config.ts"),
    },
    "build",
    "production",
  );
  const resolveModule = config.createResolver();
  const app = resolve(root, "apps/web/src/main.tsx");
  const adapter = resolve(root, "packages/web-design-system/src/index.tsx");
  const publicToast = await resolveModule(
    "@avgeek-oss/design-system/overlays/toast",
    app,
  );
  assert.ok(publicToast);
  for (const id of [
    "@avgeek-oss/design-system",
    "@avgeek-oss/design-system/overlays/toast",
    "@avgeek-oss/design-system/utilities/providers",
    "@heroui/react",
    "react-aria",
    "react-aria-components",
    "@react-aria/utils",
    "@react-aria/ssr",
    "react",
    "react-dom",
  ]) {
    const paths = await Promise.all(
      [app, adapter, publicToast].map((importer) =>
        resolveModule(id, importer),
      ),
    );
    assert.ok(paths.every(Boolean), `${id} must resolve for every consumer`);
    assert.equal(
      new Set(paths).size,
      1,
      `${id} must have one runtime instance`,
    );
  }
});
