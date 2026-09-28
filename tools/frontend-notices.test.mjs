import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  collectFrontendNotices,
  frontendNotices,
} from "./frontend-notices.mjs";

const mit = `MIT License\r\nCopyright (c) Example Authors\r\n\r\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software.\r\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.\r\n`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "mill-frontend-notices-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "LICENSE"), "Mill Apache license\n");
  await writeFile(join(root, "NOTICE"), "Mill adapted code attribution\n");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "mill-notice-fixture",
      version: "0.0.0",
      private: true,
    }),
  );
  return root;
}

async function dependency(root, name, files, license = "MIT") {
  const directory = join(root, "node_modules", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name, version: "1.2.3", license }),
  );
  for (const [file, text] of Object.entries(files))
    await writeFile(join(directory, file), text);
  return directory;
}

test("bundle notices preserve original license bytes and source copyrights deterministically", async (t) => {
  const root = await fixture(t);
  const react = await dependency(root, "react", {
    LICENSE: mit,
    "index.js": "export const react = 1;",
  });
  const adobeNotice =
    "/*\n * Copyright 2022 Adobe. All rights reserved.\n * Licensed under the Apache License, Version 2.0.\n */";
  const adobe = await dependency(
    root,
    "adobe",
    {
      LICENSE:
        "Apache License\nVersion 2.0, January 2004\nEND OF TERMS AND CONDITIONS\n",
      "first.js": `${adobeNotice}\nexport const a = 1;`,
      "second.js": `${adobeNotice}\nexport const b = 2;`,
    },
    "Apache-2.0",
  );
  const ids = [
    join(react, "index.js"),
    join(adobe, "second.js"),
    join(adobe, "first.js"),
  ];
  const notices = collectFrontendNotices({ root, moduleIds: ids });
  assert.ok(
    notices.includes(mit),
    "full license bytes, including CRLF, must remain intact",
  );
  assert.ok(notices.includes(adobeNotice));
  assert.equal(
    notices.split(adobeNotice).length - 1,
    1,
    "identical source notices are deduplicated",
  );
  assert.equal(
    notices,
    collectFrontendNotices({ root, moduleIds: ids.reverse() }),
  );
  assert.ok(notices.includes("Mill adapted code attribution"));
  assert.ok(
    !notices.includes(root),
    "output must not depend on checkout paths",
  );
});

test("complete README licenses are retained, while metadata alone cannot substitute for a license", async (t) => {
  const root = await fixture(t);
  const icons = await dependency(root, "icons", {
    "README.md": `# Icons\n\n## License\n${mit}\n## Development\nDo not include this section.`,
    "index.js": "export const icon = 1;",
  });
  const notices = collectFrontendNotices({
    root,
    moduleIds: [join(icons, "index.js")],
  });
  assert.ok(notices.includes(mit));
  assert.ok(!notices.includes("Do not include this section"));
  const missing = await dependency(root, "missing-license", {
    "README.md": "## License\nMIT. All rights reserved.",
    "index.js": "export const x = 1;",
  });
  assert.throws(
    () =>
      collectFrontendNotices({ root, moduleIds: [join(missing, "index.js")] }),
    /missing-license@1\.2\.3 has no supplied license text/,
  );
});

test("plugin covers rendered modules, lazy chunks, stylesheet dependencies, and font assets without unused packages", async (t) => {
  const root = await fixture(t);
  const used = await dependency(root, "used", {
    LICENSE: mit,
    "index.js": "export const x = 1;",
  });
  const lazy = await dependency(root, "lazy", {
    LICENSE: mit,
    "index.js": "export const x = 1;",
  });
  const styles = await dependency(root, "styles", {
    LICENSE: mit,
    "base.css": "body { color: red; }",
  });
  const font = await dependency(
    root,
    "font",
    { LICENSE: "Font original license and copyright", "font.woff2": "binary" },
    "OFL-1.1",
  );
  const unused = await dependency(root, "unused", {
    "index.js": "export const x = 1;",
  });
  let emitted;
  const plugin = frontendNotices({ root });
  plugin.configResolved({ createResolver: () => async () => undefined });
  plugin.buildStart();
  await plugin.transform("", join(styles, "base.css"));
  plugin.generateBundle.handler.call(
    {
      emitFile: (asset) => {
        emitted = asset;
        return "notice";
      },
    },
    {},
    {
      entry: {
        type: "chunk",
        modules: {
          [join(used, "index.js")]: { renderedLength: 1 },
          [join(unused, "index.js")]: { renderedLength: 0 },
        },
      },
      lazy: {
        type: "chunk",
        modules: { [join(lazy, "index.js")]: { renderedLength: 1 } },
      },
      css: {
        type: "asset",
        fileName: "assets/index.css",
        originalFileNames: [],
      },
      font: {
        type: "asset",
        fileName: "assets/font.woff2",
        originalFileNames: [join(font, "font.woff2")],
      },
    },
  );
  assert.equal(emitted.fileName, "THIRD-PARTY-NOTICES.txt");
  for (const name of ["used", "lazy", "styles", "font"])
    assert.ok(emitted.source.includes(`${name}@1.2.3`));
  assert.ok(!emitted.source.includes("unused@"));
  assert.ok(!emitted.source.includes("build-tool@"));
});

test("upstream metadata discrepancies and compound ISC license attribution are preserved", async (t) => {
  const root = await fixture(t);
  const text =
    "Apache License\nVersion 2.0, January 2004\nEND OF TERMS AND CONDITIONS\n";
  const heroui = await dependency(
    root,
    "heroui",
    { LICENSE: text, "index.js": "export const x = 1;" },
    "MIT",
  );
  const isc =
    "ISC License\nCopyright Icon Authors\nPermission to use, copy, modify, and/or distribute this software.\nTHE AUTHOR DISCLAIMS ALL WARRANTIES.\n\nDerived icons: Copyright Feather Authors\n";
  const icons = await dependency(
    root,
    "lucide",
    { LICENSE: isc, "index.js": "export const x = 1;" },
    "ISC",
  );
  const notices = collectFrontendNotices({
    root,
    moduleIds: [join(heroui, "index.js"), join(icons, "index.js")],
  });
  assert.ok(notices.includes("heroui@1.2.3\nPackage metadata license: MIT"));
  assert.ok(notices.includes(text));
  assert.ok(notices.includes(isc));
});

test("real Vite/Rolldown fixture retains CSS import and inline font notices in its isolated output", async (t) => {
  const root = await fixture(t);
  const used = await dependency(root, "used", {
    LICENSE: mit,
    "index.js": "export const value = 'license test';",
  });
  const styles = await dependency(root, "styles", {
    LICENSE: mit,
    "index.css": '@import "./nested.css";\nbody { color: red; }',
    "nested.css":
      '@import "nested-styles";\n@font-face { font-family: test; src: url("../font/font.woff2"); }',
  });
  const nestedStyles = await dependency(root, "nested-styles", {
    LICENSE: mit,
    "index.css": ":root { --fixture-color: red; }",
  });
  await writeFile(
    join(nestedStyles, "package.json"),
    JSON.stringify({
      name: "nested-styles",
      version: "1.2.3",
      license: "MIT",
      exports: { ".": { style: "./index.css", default: "./index.js" } },
    }),
  );
  await dependency(
    root,
    "font",
    {
      LICENSE: "Original font copyright and license",
      "font.woff2": "inline font fixture",
    },
    "OFL-1.1",
  );
  await dependency(root, "unused", {
    "index.js": "export const absent = true;",
  });
  await writeFile(
    join(root, "index.html"),
    '<html><body><script type="module" src="/main.js"></script></body></html>',
  );
  await writeFile(
    join(root, "main.js"),
    `import { value } from ${JSON.stringify(join(used, "index.js"))};\nimport ${JSON.stringify(join(styles, "index.css"))};\ndocument.body.append(value);`,
  );
  const require = createRequire(
    new URL("../apps/web/package.json", import.meta.url),
  );
  const { build } = await import(pathToFileURL(require.resolve("vite")).href);
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [frontendNotices({ root })],
  });
  const notices = await readFile(
    join(root, "dist", "THIRD-PARTY-NOTICES.txt"),
    "utf8",
  );
  for (const name of ["used", "styles", "nested-styles", "font"])
    assert.ok(notices.includes(`${name}@1.2.3`), name);
  assert.ok(notices.includes(mit));
  assert.ok(!notices.includes("unused@"));
  assert.ok(!notices.includes(fileURLToPath(new URL("../", import.meta.url))));
});

test("installed frontend licenses, Adobe source copyright, and reviewed Hugeicons supplement are retained", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const web = createRequire(
    new URL("../apps/web/package.json", import.meta.url),
  );
  const designSystem = createRequire(
    new URL("../packages/web-design-system/package.json", import.meta.url),
  );
  const names = [
    "react",
    "react-dom",
    "lucide-react",
    "@hugeicons/core-free-icons",
    "@hugeicons/react",
    "@simplewebauthn/browser",
  ];
  const ids = names.map((name) => web.resolve(name));
  ids.push(
    designSystem.resolve("react-aria-components"),
    designSystem.resolve("@heroui/react"),
  );
  const aria = join(
    root,
    "packages/web-design-system/node_modules/react-aria-components",
  );
  ids.push(join(aria, "dist/private/Button.mjs"));
  for (const name of [
    "@heroui/styles",
    "@fontsource-variable/inter",
    "@fontsource-variable/geist-mono",
  ]) {
    const directory = join(
      root,
      "packages/web-design-system/node_modules",
      name,
    );
    ids.push(
      join(
        directory,
        name === "@heroui/styles" ? "dist/index.css" : "wght.css",
      ),
    );
  }
  const notices = collectFrontendNotices({ root, moduleIds: ids });
  for (const name of [
    "react",
    "react-dom",
    "lucide-react",
    "@hugeicons/react",
    "@simplewebauthn/browser",
    "react-aria-components",
    "@heroui/react",
    "@heroui/styles",
    "@fontsource-variable/inter",
    "@fontsource-variable/geist-mono",
  ]) {
    const workspace = [
      "react-aria-components",
      "@heroui/react",
      "@heroui/styles",
      "@fontsource-variable/inter",
      "@fontsource-variable/geist-mono",
    ].includes(name)
      ? "packages/web-design-system"
      : "apps/web";
    const license = ["@hugeicons/react", "@simplewebauthn/browser"].includes(
      name,
    )
      ? "LICENSE.md"
      : "LICENSE";
    assert.ok(
      notices.includes(
        await readFile(
          join(root, workspace, "node_modules", name, license),
          "utf8",
        ),
      ),
      `${name} complete license bytes`,
    );
  }
  assert.ok(notices.includes("Copyright 2022 Adobe. All rights reserved."));
  assert.ok(notices.includes("@hugeicons/core-free-icons@4.3.0"));
  assert.ok(
    notices.includes("9c48f3723dfb243909fa83501aa7c6423ab972c0/LICENSE.md"),
  );
  assert.ok(notices.includes("Copyright (c) 2025 Hugeicons"));
  assert.ok(
    notices.includes("@heroui/react@3.2.6\nPackage metadata license: MIT"),
  );
  assert.ok(notices.includes("Apache License"));
});
