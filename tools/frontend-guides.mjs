import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const webRequire = createRequire(join(repository, "apps/web/package.json"));
const entries = [
  ...[
    "clients",
    "api",
    "authentication",
    "backup",
    "configuration",
    "getting-started",
    "installation",
    "operations",
    "troubleshooting",
    "upgrades",
    "workflows",
  ].map((name) => ({ source: `docs/${name}.md`, output: `${name}.html` })),
  { source: "SECURITY.md", output: "security.html" },
  { source: "MAINTAINERS.md", output: "maintainers.html" },
  { source: ".env.example", output: "environment.txt" },
];

function escape(value) {
  return value.replace(/[&<>"']/g, (character) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[character];
  });
}

function linkTarget(url, source, outputs) {
  if (/^(https?:\/\/|mailto:|#)/i.test(url)) return url;
  const [path, fragment] = url.split("#", 2);
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith("//")) return "";
  const target = outputs.get(
    posix.normalize(posix.join(posix.dirname(source), path)),
  );
  if (!target)
    throw new Error(`Guide ${source} links to an unbundled file: ${url}`);
  return `/guides/${target}${fragment ? `#${fragment}` : ""}`;
}

export async function renderGuides({
  root = repository,
  stylesheets = [],
  guides = entries,
} = {}) {
  const React = webRequire("react");
  const { renderToStaticMarkup } = webRequire("react-dom/server");
  const [{ default: ReactMarkdown }, { default: remarkGfm }] =
    await Promise.all([
      import(pathToFileURL(webRequire.resolve("react-markdown")).href),
      import(pathToFileURL(webRequire.resolve("remark-gfm")).href),
    ]);
  const outputs = new Map(guides.map((entry) => [entry.source, entry.output]));
  const result = new Map();
  function text(children) {
    return React.Children.toArray(children)
      .map((child) => {
        if (typeof child === "string" || typeof child === "number")
          return String(child);
        return React.isValidElement(child) ? text(child.props.children) : "";
      })
      .join("");
  }
  function heading(level, className) {
    return ({ children }) =>
      React.createElement(
        `h${level}`,
        {
          className,
          id: text(children)
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, "-")
            .replace(/^-|-$/g, ""),
        },
        children,
      );
  }
  for (const entry of guides) {
    const markdown = await readFile(resolve(root, entry.source), "utf8");
    if (entry.output.endsWith(".txt")) {
      result.set(`guides/${entry.output}`, markdown);
      continue;
    }
    const title = markdown.match(/^# (.+)$/m)?.[1] ?? "Mill guide";
    const body = renderToStaticMarkup(
      React.createElement(ReactMarkdown, {
        children: markdown,
        remarkPlugins: [remarkGfm],
        skipHtml: true,
        urlTransform: (url) => linkTarget(url, entry.source, outputs),
        components: {
          h1: heading(1, "text-xl font-medium"),
          h2: heading(2, "text-lg font-medium"),
          h3: heading(3, "text-base font-medium"),
          img: () => null,
        },
      }),
    );
    const styles = stylesheets
      .map((file) => `<link rel="stylesheet" href="/${escape(file)}">`)
      .join("");
    result.set(
      `guides/${entry.output}`,
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" type="image/png" href="/brand/mill-favicon.png"><title>${escape(title)} · Mill</title>${styles}</head><body><main class="mx-auto min-w-0 max-w-5xl px-4 py-8 sm:px-6"><nav aria-label="Guide navigation" class="mb-6 flex flex-wrap items-center gap-4 text-sm"><a href="/" class="inline-flex items-center gap-2.5 font-medium"><img src="/brand/mill-mark.png" alt="" width="32" height="32" class="size-8 object-contain">Open Mill</a><a href="/guides/clients.html">Connect a client</a><a href="/guides/backup.html">Backup and recovery</a></nav><article class="markdown min-w-0">${body}</article></main></body></html>`,
    );
  }
  return result;
}

export function frontendGuides() {
  return {
    name: "mill-user-guides",
    apply: "build",
    generateBundle: {
      order: "post",
      async handler(_options, bundle) {
        const stylesheets = Object.values(bundle)
          .filter(
            (output) =>
              output.type === "asset" && output.fileName.endsWith(".css"),
          )
          .map((output) => output.fileName)
          .sort();
        if (!stylesheets.length)
          throw new Error(
            "User guides require the built application stylesheet",
          );
        const guides = await renderGuides({ stylesheets });
        for (const [fileName, source] of guides)
          this.emitFile({ type: "asset", fileName, source });
      },
    },
  };
}
