import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const toolDirectory = fileURLToPath(new URL("./", import.meta.url));

const noticeName =
  /^(licen[cs]e|copying|notice|copyright|third[-_]party[-_]licen[cs]e)/i;
const stylesheet = /\.(css|scss|sass|less|styl)$/i;
const textSource = /\.(?:[cm]?[jt]sx?|css|scss|sass|less|styl)$/i;

function sourcePath(id, root) {
  if (id.includes("\0")) return undefined;
  const clean = id.replace(/[?#].*$/, "");
  const path = clean.startsWith("file:") ? fileURLToPath(clean) : clean;
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  return existsSync(absolute) ? realpathSync(absolute) : undefined;
}

function owningPackage(path) {
  let directory = dirname(path);
  while (directory !== dirname(directory)) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      const metadata = JSON.parse(readFileSync(manifest, "utf8"));
      if (metadata.name && metadata.version) return { directory, metadata };
    }
    directory = dirname(directory);
  }
  throw new Error(`Cannot identify the package owning ${path}`);
}

function noticeFiles(directory, prefix = "") {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!noticeName.test(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isFile()) {
      files.push({
        name: prefix + entry.name,
        text: readFileSync(path, "utf8"),
      });
    } else if (entry.isDirectory()) {
      for (const nested of readdirSync(path, { withFileTypes: true })) {
        if (nested.isFile()) {
          files.push({
            name: prefix + entry.name + "/" + nested.name,
            text: readFileSync(join(path, nested.name), "utf8"),
          });
        }
      }
    }
  }
  return files.sort((a, b) => a.name.localeCompare(b.name, "en"));
}

function completeLicense(text) {
  return (
    (/Permission (?:is hereby granted|to use, copy, modify)/i.test(text) &&
      /(?:THE SOFTWARE IS PROVIDED|AUTHOR DISCLAIMS ALL WARRANTIES)/i.test(
        text,
      )) ||
    (/Apache License/.test(text) && /END OF TERMS AND CONDITIONS/.test(text)) ||
    (/SIL OPEN FONT LICENSE/.test(text) && /TERMINATION/.test(text))
  );
}

function readmeLicense(directory, requireComplete = true) {
  for (const name of readdirSync(directory).sort()) {
    if (!/^readme(?:\.|$)/i.test(name)) continue;
    const text = readFileSync(join(directory, name), "utf8");
    const heading = /^#{1,6}\s+licen[cs]e[^\n]*\n/im.exec(text);
    if (!heading) continue;
    const start = heading.index + heading[0].length;
    const next = /^#{1,6}\s+/m.exec(text.slice(start));
    const section = text.slice(start, next ? start + next.index : undefined);
    if (!requireComplete || completeLicense(section))
      return { name: name + " (License section)", text: section };
  }
  return undefined;
}

function reviewedSupplement(metadata) {
  const supplements = JSON.parse(
    readFileSync(
      join(toolDirectory, "frontend-license-supplements.json"),
      "utf8",
    ),
  );
  const supplement = supplements.find(
    (entry) =>
      entry.package === metadata.name && entry.version === metadata.version,
  );
  if (!supplement) return undefined;
  const bytes = readFileSync(join(toolDirectory, supplement.file));
  if (
    metadata.license !== supplement.license ||
    createHash("sha256").update(bytes).digest("hex") !== supplement.sha256 ||
    !completeLicense(bytes.toString("utf8"))
  ) {
    throw new Error(
      `Reviewed license supplement for ${metadata.name}@${metadata.version} no longer matches its metadata or verified source bytes`,
    );
  }
  return {
    name: `Upstream license supplement\nSource: ${supplement.source}\nApplicability: ${supplement.scopeSource}\nSHA-256: ${supplement.sha256}`,
    text: bytes.toString("utf8"),
  };
}

function legalComments(path) {
  if (!textSource.test(path)) return [];
  const source = readFileSync(path, "utf8");
  const comments =
    source.match(
      /\/\*[\s\S]*?\*\/|(?:^|\n)[ \t]*\/\/[^\n]*(?:\n[ \t]*\/\/[^\n]*)*/g,
    ) ?? [];
  return comments.filter((comment) =>
    /copyright|@license|SPDX-License-Identifier/i.test(comment),
  );
}

const normalized = (text) => text.replace(/\s+/g, " ").trim();

export function collectFrontendNotices({ root, moduleIds }) {
  const repository = realpathSync(root);
  const packages = new Map();
  for (const id of [...new Set(moduleIds)].sort()) {
    const path = sourcePath(id, repository);
    if (!path) continue;
    const owner = owningPackage(path);
    const key = `${owner.metadata.name}@${owner.metadata.version}`;
    let record = packages.get(key);
    if (!record) {
      const thirdParty = owner.directory
        .split(/[\\/]/)
        .includes("node_modules");
      const files = noticeFiles(owner.directory);
      if (
        thirdParty &&
        !files.some((file) => /licen[cs]e|copying/i.test(file.name))
      ) {
        const fallback = readmeLicense(owner.directory);
        if (fallback) files.push(fallback);
        else {
          const supplement = reviewedSupplement(owner.metadata);
          if (supplement) {
            const suppliedReadme = readmeLicense(owner.directory, false);
            if (suppliedReadme) files.push(suppliedReadme);
            files.push(supplement);
          }
        }
      }
      record = { ...owner, key, thirdParty, files, comments: new Set() };
      packages.set(key, record);
    }
    for (const comment of legalComments(path)) record.comments.add(comment);
  }

  const sections = [];
  for (const record of [...packages.values()].sort((a, b) =>
    a.key.localeCompare(b.key, "en"),
  )) {
    const supplied = record.files.map((file) => file.text).join("\n");
    if (
      record.thirdParty &&
      !record.files.some((file) => /licen[cs]e|copying/i.test(file.name)) &&
      ![...record.comments].some(completeLicense)
    ) {
      throw new Error(
        `Bundled package ${record.key} has no supplied license text; retain its upstream license before distributing`,
      );
    }
    const sourceNotices = [...record.comments]
      .filter((comment) => {
        const copyright = comment.match(/[^\n]*copyright[^\n]*/gi) ?? [];
        if (!copyright.length && record.files.length) return false;
        return (
          !copyright.length ||
          copyright.some(
            (line) =>
              !normalized(supplied).includes(
                normalized(line.replace(/^\s*(?:\/\*|\*|\/\/)\s?/, "")),
              ),
          )
        );
      })
      .sort();
    const content = record.files
      .map((file) => `--- ${file.name} ---\n${file.text}`)
      .concat(
        sourceNotices.map(
          (comment) => `--- Source copyright/license notice ---\n${comment}`,
        ),
      );
    if (content.length) {
      sections.push(
        `${record.key}\nPackage metadata license: ${record.metadata.license ?? "unspecified"}\n\n${content.join("\n\n")}`,
      );
    }
  }

  const ownNotices = ["LICENSE", "NOTICE"].map((name) => {
    const path = join(repository, name);
    return `--- Mill ${name} ---\n${readFileSync(path, "utf8")}`;
  });
  return [
    "Mill frontend distribution notices\n\nThe following notices are retained from packages contributing to this build.\nPackage metadata and supplied license files are reproduced as provided, including any differences.\n",
    ...ownNotices,
    ...sections,
    "",
  ].join("\n\n");
}

export function frontendNotices({
  root = fileURLToPath(new URL("../", import.meta.url)),
} = {}) {
  const cssSources = new Set();
  const cssAssets = new Set();
  let resolveCss;
  async function trackCss(id) {
    const path = sourcePath(id, root);
    if (!path || cssSources.has(path)) return;
    cssSources.add(path);
    const source = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const imports = source.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/g);
    for (const match of imports) {
      if (/^(?:[a-z]+:|\/\/|#)/i.test(match[1])) continue;
      const resolved = await resolveCss(match[1], path);
      if (!resolved)
        throw new Error(
          `Cannot resolve stylesheet notice source ${match[1]} imported by ${path}`,
        );
      await trackCss(resolved);
    }
    const urls = source.matchAll(
      /url\(\s*(?:["']([^"']+)["']|([^\s)]+))\s*\)/g,
    );
    for (const match of urls) {
      const url = match[1] ?? match[2];
      if (/^(?:[a-z]+:|\/\/|#)/i.test(url)) continue;
      const resolved = await resolveCss(url, path);
      if (resolved && !stylesheet.test(resolved)) cssAssets.add(resolved);
    }
  }
  return {
    name: "mill-frontend-notices",
    apply: "build",
    enforce: "pre",
    configResolved(config) {
      resolveCss = config.createResolver({
        extensions: [".css"],
        mainFields: ["style"],
        conditions: ["style", "production"],
        preferRelative: true,
        tryIndex: false,
      });
    },
    buildStart() {
      cssSources.clear();
      cssAssets.clear();
    },
    async transform(_code, id) {
      if (stylesheet.test(id.replace(/[?#].*$/, ""))) await trackCss(id);
    },
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const moduleIds = [];
        let hasCss = false;
        for (const output of Object.values(bundle)) {
          if (output.type === "chunk") {
            for (const [id, module] of Object.entries(output.modules)) {
              if (module.renderedLength > 0) moduleIds.push(id);
            }
          } else {
            hasCss ||= extname(output.fileName) === ".css";
            moduleIds.push(...output.originalFileNames);
          }
        }
        if (hasCss) moduleIds.push(...cssSources, ...cssAssets);
        this.emitFile({
          type: "asset",
          fileName: "THIRD-PARTY-NOTICES.txt",
          source: collectFrontendNotices({ root, moduleIds }),
        });
      },
    },
  };
}
