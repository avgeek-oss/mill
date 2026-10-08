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
    (path.startsWith("/guides/") ||
      path.startsWith("/assets/") ||
      [
        "/brand/mill-favicon.png",
        "/brand/mill-mark.png",
        "/brand/mill-touch-icon.png",
        "/startup-recovery.js",
        "/theme-bootstrap.js",
      ].includes(path)) &&
      !path.split("/").some((part) => [".", ".."].includes(part)) &&
      !/[\\\p{Cc}]/u.test(path),
    "Guide resources must resolve to the bundled static tree",
  );
  return { path, fragment: decodeURIComponent(url.hash.slice(1)) };
}

function resourceKind(path) {
  if (path === "/THIRD-PARTY-NOTICES.txt") return "notice";
  if (path === "/startup-recovery.js") return "startup-script";
  if (path === "/theme-bootstrap.js") return "theme-script";
  const extension = extname(path).toLowerCase();
  if (path.startsWith("/assets/") && /-[A-Za-z0-9_-]{8}\.js$/.test(path))
    return "script";
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
    if (path.startsWith("/brand/"))
      assert.ok(
        bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
        `Brand asset is a PNG: ${path}`,
      );
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
      let icons = 0;
      for (const match of text.matchAll(/<link\b([^>]+)>/gi)) {
        const rel = attribute(match[1], "rel");
        const target = localTarget(attribute(match[1], "href"), path);
        assert.ok(target, "Guide linked resources are bundled locally");
        if (rel === "stylesheet") {
          assert.equal(resourceKind(target.path), "style");
          styles++;
        } else {
          assert.equal(
            rel,
            "icon",
            "Guides use only stylesheets and the Mill favicon",
          );
          assert.equal(target.path, "/brand/mill-favicon.png");
          assert.equal(attribute(match[1], "type"), "image/png");
          icons++;
        }
        await add(target.path);
      }
      assert.ok(styles > 0, "Guides use the built local stylesheet");
      assert.equal(icons, 1, "Guides use one local PNG favicon");
      for (const match of text.matchAll(/<img\b([^>]+)>/gi)) {
        const target = localTarget(attribute(match[1], "src"), path);
        assert.equal(target?.path, "/brand/mill-mark.png");
        assert.equal(resourceKind(target.path), "image");
        assert.notEqual(attribute(match[1], "alt"), undefined);
        await add(target.path);
      }
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
  const index = await readFile(resolve(root, "index.html"), "utf8");
  const brandLinks = new Map();
  const appStyles = [];
  for (const match of index.matchAll(/<link\b([^>]+)>/gi)) {
    const rel = attribute(match[1], "rel");
    if (rel === "stylesheet") {
      const target = localTarget(attribute(match[1], "href"), "/");
      assert.equal(resourceKind(target?.path), "style");
      assert.match(target.path, /^\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.css$/);
      appStyles.push(target.path);
      await add(target.path);
      continue;
    }
    if (!["icon", "apple-touch-icon"].includes(rel)) continue;
    assert.equal(brandLinks.has(rel), false, `Only one ${rel} is bundled`);
    const target = localTarget(attribute(match[1], "href"), "/");
    assert.equal(
      target?.path,
      rel === "icon" ? "/brand/mill-favicon.png" : "/brand/mill-touch-icon.png",
    );
    if (rel === "icon") assert.equal(attribute(match[1], "type"), "image/png");
    brandLinks.set(rel, target.path);
    await add(target.path);
  }
  assert.equal(
    brandLinks.size,
    2,
    "The app bundles favicon and touch icon links",
  );
  assert.equal(appStyles.length, 1, "The app loads one hashed stylesheet");
  const scripts = [
    ...index.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi),
  ];
  const startupScripts = scripts.filter(
    (match) => attribute(match[1], "src") === "/startup-recovery.js",
  );
  assert.equal(
    startupScripts.length,
    1,
    "The app loads one external startup recovery script",
  );
  assert.equal(
    startupScripts[0][2].trim(),
    "",
    "Startup recovery has no inline script body",
  );
  await add("/startup-recovery.js");
  const themeScripts = scripts.filter(
    (match) => attribute(match[1], "src") === "/theme-bootstrap.js",
  );
  assert.equal(themeScripts.length, 1, "The app loads one theme bootstrap");
  assert.equal(
    themeScripts[0][2].trim(),
    "",
    "Theme bootstrap has no inline body",
  );
  assert.equal(attribute(themeScripts[0][1], "type"), undefined);
  assert.doesNotMatch(
    themeScripts[0][1],
    /\b(?:async|defer)\b/i,
    "Theme bootstrap runs before the first paint",
  );
  assert.ok(
    themeScripts[0].index < index.indexOf('<link rel="stylesheet"'),
    "Theme bootstrap precedes the stylesheet",
  );
  await add("/theme-bootstrap.js");
  const appScripts = scripts.filter(
    (match) => attribute(match[1], "type") === "module",
  );
  assert.equal(appScripts.length, 1, "The app loads one hashed module script");
  assert.equal(
    scripts.length,
    3,
    "The app loads only the three bundled scripts",
  );
  const appScript = localTarget(attribute(appScripts[0][1], "src"), "/");
  assert.equal(resourceKind(appScript?.path), "script");
  assert.match(appScript.path, /^\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.js$/);
  assert.equal(appScripts[0][2].trim(), "", "The module has no inline body");
  await add(appScript.path);
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

function expectedMime(kind, value, path) {
  const type = value.split(";", 1)[0].trim();
  if (["notice", "text"].includes(kind)) return type === "text/plain";
  if (kind === "guide") return type === "text/html";
  if (["startup-script", "theme-script", "script"].includes(kind))
    return ["text/javascript", "application/javascript"].includes(type);
  if (kind === "style") return type === "text/css";
  if (kind === "font")
    return (
      /^font\//.test(type) ||
      /^application\/(?:font-|x-font-|octet-stream)/.test(type)
    );
  if (kind === "image" && extname(path).toLowerCase() === ".png")
    return type === "image/png";
  return kind === "image" && /^image\//.test(type);
}

export async function verifyStaticContent(origin, manifest, timeoutMs = 8000) {
  const url = new URL(origin);
  assert.ok(
    ["127.0.0.1", "localhost"].includes(url.hostname) &&
      ["http:", "https:"].includes(url.protocol) &&
      url.origin === origin,
    "Static verification targets disposable loopback origins only",
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
          headers: { "Accept-Encoding": "identity" },
        });
        assert.equal(
          response.status,
          200,
          `Anonymous production static resource responds: ${file.path}`,
        );
        assert.ok(
          expectedMime(
            file.kind,
            response.headers.get("content-type") ?? "",
            file.path,
          ),
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
        assert.equal(response.headers.get("content-encoding"), null);
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
  for (const kind of ["script", "style"]) {
    const file = manifest.resources.find(
      (resource) =>
        resource.kind === kind &&
        resource.path.startsWith("/assets/") &&
        resource.bytes >= 1024,
    );
    assert.ok(file, `The built app has a compressible ${kind}`);
    for (const [acceptEncoding, compressed] of [
      ["gzip", true],
      ["gzip;q=0, *;q=1", false],
    ]) {
      const response = await fetch(`${origin}${file.path}`, {
        credentials: "omit",
        redirect: "error",
        signal,
        headers: { "Accept-Encoding": acceptEncoding },
      });
      assert.equal(response.status, 200);
      assert.ok(
        expectedMime(
          kind,
          response.headers.get("content-type") ?? "",
          file.path,
        ),
      );
      assert.match(
        response.headers.get("vary") ?? "",
        /(?:^|,)\s*Accept-Encoding(?:,|$)/i,
      );
      assert.equal(
        response.headers.get("cache-control"),
        "public, max-age=31536000, immutable",
      );
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.match(
        response.headers.get("content-security-policy") ?? "",
        /frame-ancestors/,
      );
      assert.equal(
        response.headers.get("content-encoding"),
        compressed ? "gzip" : null,
      );
      if (compressed)
        assert.equal(response.headers.get("content-length"), null);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(digest(bytes), file.sha256);
    }
  }
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
