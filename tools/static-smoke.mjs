import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const localOrigin = "http://mill-static.invalid";

function unescape(value) {
  return value.replace(/&(amp|quot|apos|lt|gt|#39);/g, (entity) => {
    return {
      "&amp;": "&",
      "&quot;": '"',
      "&apos;": "'",
      "&#39;": "'",
      "&lt;": "<",
      "&gt;": ">",
    }[entity];
  });
}

function attribute(source, name) {
  const value = source.match(
    new RegExp(`\\b${name}=["']([^"']*)["']`, "i"),
  )?.[1];
  return value === undefined ? undefined : unescape(value);
}

function localTarget(value, source, anchor = false) {
  if (!value) return null;
  if (value.startsWith("#"))
    return anchor
      ? { path: source, fragment: decodeURIComponent(value.slice(1)) }
      : null;
  const url = new URL(value, `${localOrigin}${source}`);
  if (url.origin !== localOrigin) {
    assert.ok(
      anchor && ["http:", "https:", "mailto:"].includes(url.protocol),
      "Guides must not depend on external assets or unsafe links",
    );
    return null;
  }
  const path = decodeURIComponent(url.pathname);
  if (anchor && path === "/") return null;
  assert.ok(
    (path.startsWith("/guides/") || path.startsWith("/assets/")) &&
      !path.split("/").some((part) => [".", ".."].includes(part)) &&
      !/[\\\p{Cc}]/u.test(path),
    "Guide resources must resolve to the bundled static tree",
  );
  return { path, fragment: decodeURIComponent(url.hash.slice(1)) };
}

function resourceKind(path) {
  if (path === "/THIRD-PARTY-NOTICES.txt") return "notice";
  const extension = extname(path).toLowerCase();
  if (path.startsWith("/guides/") && extension === ".html") return "guide";
  if (path.startsWith("/guides/") && extension === ".txt") return "text";
  if (extension === ".css") return "style";
  if ([".woff2", ".woff", ".ttf", ".otf"].includes(extension)) return "font";
  if (
    [
      ".svg",
      ".png",
      ".webp",
      ".avif",
      ".jpg",
      ".jpeg",
      ".gif",
      ".ico",
    ].includes(extension)
  )
    return "image";
  throw new Error(
    "Guides must not depend on application scripts or API resources",
  );
}

export async function staticManifest(directory) {
  const root = resolve(directory);
  const resources = new Map();
  const fragments = [];
  const texts = new Map();
  async function add(path) {
    if (resources.has(path)) return;
    const kind = resourceKind(path);
    const bytes = await readFile(resolve(root, `.${path}`));
    assert.ok(bytes.length > 0, `Bundled static resource is nonempty: ${path}`);
    resources.set(path, {
      path,
      kind,
      bytes: bytes.length,
      sha256: digest(bytes),
    });
    if (!["guide", "style", "notice"].includes(kind)) return;
    const text = bytes.toString("utf8");
    texts.set(path, text);
    if (kind === "notice") {
      assert.match(text, /Mill frontend distribution notices/);
      assert.match(text, /--- Mill LICENSE ---/);
      assert.match(text, /--- Mill NOTICE ---/);
      assert.match(text, /react@\d/);
      assert.match(text, /Package metadata license:/);
      assert.match(text, /copyright/i);
      assert.match(text, /MIT License/);
      assert.match(text, /SIL OPEN FONT LICENSE/);
    } else if (kind === "guide") {
      assert.match(text, /<!doctype html>/i);
      assert.match(text, /<nav\b[^>]*aria-label=["']Guide navigation["']/i);
      assert.match(text, /<article\b[^>]*class=["'][^"']*markdown/);
      assert.doesNotMatch(text, /<(?:script|iframe|form|object|embed)\b/i);
      assert.doesNotMatch(text, /\son[a-z]+\s*=/i);
      let styles = 0;
      for (const match of text.matchAll(/<link\b([^>]+)>/gi)) {
        assert.equal(
          attribute(match[1], "rel"),
          "stylesheet",
          "Guides require only static stylesheets",
        );
        const target = localTarget(attribute(match[1], "href"), path);
        assert.ok(target, "Guide stylesheets are bundled locally");
        assert.equal(resourceKind(target.path), "style");
        styles++;
        await add(target.path);
      }
      assert.ok(styles > 0, "Guides use the built local stylesheet");
      for (const match of text.matchAll(/<a\b([^>]+)>/gi)) {
        const target = localTarget(attribute(match[1], "href"), path, true);
        if (!target) continue;
        await add(target.path);
        if (target.fragment) fragments.push(target);
      }
    } else {
      const css = text.replace(/\/\*[\s\S]*?\*\//g, "");
      const links = new Set();
      for (const match of css.matchAll(
        /url\(\s*(?:["']([^"']+)["']|([^\s)]+))\s*\)/g,
      ))
        links.add(match[1] ?? match[2]);
      for (const match of css.matchAll(/@import\s+["']([^"']+)["']/g))
        links.add(match[1]);
      for (const value of links) {
        if (value.startsWith("data:") || value.startsWith("#")) continue;
        const target = localTarget(value, path);
        assert.ok(target, "CSS resources are bundled locally");
        await add(target.path);
      }
    }
  }
  await add("/THIRD-PARTY-NOTICES.txt");
  async function guideTree(path = "/guides") {
    for (const entry of await readdir(resolve(root, `.${path}`), {
      withFileTypes: true,
    })) {
      const target = `${path}/${entry.name}`;
      if (entry.isDirectory()) await guideTree(target);
      else {
        assert.ok(
          entry.isFile(),
          "The bundled guide tree contains regular files",
        );
        await add(target);
      }
    }
  }
  await guideTree();
  assert.ok(resources.has("/guides/backup.html"), "Backup guide is bundled");
  assert.match(
    texts.get("/guides/backup.html"),
    /<h1\b[^>]*>Backup and recovery<\/h1>/,
  );
  for (const { path, fragment } of fragments)
    assert.ok(
      texts.get(path)?.includes(`id="${fragment}"`),
      "Linked guide anchors resolve in the build",
    );
  const files = [...resources.values()].sort((a, b) =>
    a.path.localeCompare(b.path, "en"),
  );
  assert.ok(
    files.some((file) => file.kind === "font"),
    "Guide stylesheet includes bundled fonts",
  );
  return { format: "mill-static-content-v1", resources: files };
}

function expectedMime(kind, value) {
  const type = value.split(";", 1)[0].trim();
  if (["notice", "text"].includes(kind)) return type === "text/plain";
  if (kind === "guide") return type === "text/html";
  if (kind === "style") return type === "text/css";
  if (kind === "font")
    return (
      /^font\//.test(type) ||
      /^application\/(?:font-|x-font-|octet-stream)/.test(type)
    );
  return kind === "image" && /^image\//.test(type);
}

export async function verifyStaticContent(origin, manifest, timeoutMs = 8000) {
  const url = new URL(origin);
  assert.ok(
    ["127.0.0.1", "localhost"].includes(url.hostname) &&
      url.protocol === "http:" &&
      url.origin === origin,
    "Static verification targets disposable loopback HTTP only",
  );
  assert.equal(manifest?.format, "mill-static-content-v1");
  assert.ok(Array.isArray(manifest.resources) && manifest.resources.length > 0);
  assert.ok(
    manifest.resources.some((file) => file.path === "/THIRD-PARTY-NOTICES.txt"),
  );
  assert.ok(
    manifest.resources.some((file) => file.path === "/guides/backup.html"),
  );
  const signal = AbortSignal.timeout(timeoutMs);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, manifest.resources.length) }, async () => {
      while (next < manifest.resources.length) {
        const file = manifest.resources[next++];
        assert.equal(resourceKind(file.path), file.kind);
        if (file.kind !== "notice") {
          const target = localTarget(file.path, "/");
          assert.equal(target?.path, file.path);
        }
        assert.ok(Number.isInteger(file.bytes) && file.bytes > 0);
        assert.match(file.sha256, /^[a-f0-9]{64}$/);
        const response = await fetch(`${origin}${file.path}`, {
          credentials: "omit",
          redirect: "error",
          signal,
        });
        assert.equal(
          response.status,
          200,
          `Anonymous production static resource responds: ${file.path}`,
        );
        assert.ok(
          expectedMime(file.kind, response.headers.get("content-type") ?? ""),
          `Static MIME type matches ${file.path}`,
        );
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
        assert.ok(response.headers.get("referrer-policy"));
        assert.match(
          response.headers.get("content-security-policy") ?? "",
          /frame-ancestors/,
        );
        assert.equal(
          response.headers.get("set-cookie"),
          null,
          "Public static resources do not create authentication sessions",
        );
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.equal(
          bytes.length,
          file.bytes,
          `Production static length matches built file: ${file.path}`,
        );
        assert.equal(
          digest(bytes),
          file.sha256,
          `Production static bytes match built file: ${file.path}`,
        );
      }
    }),
  );
  return {
    resources: manifest.resources.length,
    guides: manifest.resources.filter((file) => file.kind === "guide").length,
    stylesheets: manifest.resources.filter((file) => file.kind === "style")
      .length,
    fonts: manifest.resources.filter((file) => file.kind === "font").length,
  };
}

export async function verifyConfiguredStaticContent(timeoutMs = 8000) {
  if (!process.env.MILL_VERIFY_STATIC_MANIFEST) return;
  const manifest = JSON.parse(
    await readFile(process.env.MILL_VERIFY_STATIC_MANIFEST, "utf8"),
  );
  const counts = await verifyStaticContent(
    process.env.MILL_VERIFY_URL,
    manifest,
    timeoutMs,
  );
  console.log(
    `PASS Attributed production notices and ${counts.guides} guides with ${counts.stylesheets} local stylesheets/${counts.fonts} fonts (${counts.resources} exact built resources), anonymously served`,
  );
}

if (process.env.MILL_STATIC_MODE === "manifest") {
  console.log(
    JSON.stringify(
      await staticManifest(
        process.env.MILL_STATIC_ROOT ?? resolve("apps/web/dist"),
      ),
    ),
  );
} else if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  assert.ok(
    process.env.MILL_VERIFY_STATIC_MANIFEST,
    "Supply the built production static manifest",
  );
  await verifyConfiguredStaticContent();
}
