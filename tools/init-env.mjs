import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!["--file", "--web-url", "--api-url"].includes(key) || !value)
    throw new Error(
      "Usage: node tools/init-env.mjs [--file .env] [--web-url http://localhost:4322] [--api-url http://localhost:4321]",
    );
  options.set(key, value);
}
function origin(raw) {
  const url = new URL(raw);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw new Error(
      "Use an HTTPS origin or a loopback HTTP development origin",
    );
  return url.origin;
}
const webURL = origin(options.get("--web-url") ?? "http://localhost:4322");
const apiURL = origin(options.get("--api-url") ?? "http://localhost:4321");
if (webURL === apiURL) throw new Error("UI and API require separate origins");
const password = randomBytes(32).toString("hex");
const destination = resolve(options.get("--file") ?? ".env");
await writeFile(
  destination,
  [
    `POSTGRES_PASSWORD=${password}`,
    `MILL_SECRET=${randomBytes(48).toString("hex")}`,
    `MILL_WEB_URL=${webURL}`,
    `MILL_API_URL=${apiURL}`,
    `DATABASE_URL=postgres://mill:${password}@127.0.0.1:55432/mill`,
    "",
  ].join("\n"),
  { flag: "wx", mode: 0o600 },
);
console.log(
  `Created ${destination}. Keep it private and include it in your encrypted recovery plan.`,
);
