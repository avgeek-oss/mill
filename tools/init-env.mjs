import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!["--file", "--base-url", "--port"].includes(key) || !value) {
    throw new Error(
      "Usage: node tools/init-env.mjs [--file .env] [--base-url http://localhost:4321] [--port 4321]",
    );
  }
  options.set(key, value);
}
const port = options.get("--port") ?? "4321";
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  throw new Error("Port must be between 1 and 65535");
}
const baseUrl = new URL(
  options.get("--base-url") ?? `http://localhost:${port}`,
);
if (
  !["http:", "https:"].includes(baseUrl.protocol) ||
  baseUrl.username ||
  baseUrl.password ||
  baseUrl.pathname !== "/" ||
  baseUrl.search ||
  baseUrl.hash
) {
  throw new Error(
    "Base URL must be an HTTP(S) origin without a path or credentials",
  );
}
const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname);
if (baseUrl.protocol !== "https:" && !loopback) {
  throw new Error("Remote installations require an HTTPS base URL");
}
const password = randomBytes(32).toString("hex");
const destination = resolve(options.get("--file") ?? ".env");
await writeFile(
  destination,
  [
    `POSTGRES_PASSWORD=${password}`,
    `MILL_SECRET=${randomBytes(48).toString("hex")}`,
    `MILL_BASE_URL=${baseUrl.origin}`,
    `MILL_PORT=${port}`,
    "MILL_BIND_ADDRESS=127.0.0.1",
    `ALLOW_INSECURE_LOCALHOST=${baseUrl.protocol === "http:" && loopback}`,
    "MILL_TRUSTED_PROXY_IPS=",
    `DATABASE_URL=postgres://mill:${password}@127.0.0.1:55432/mill`,
    "MILL_IMAGE=mill:local",
    "",
  ].join("\n"),
  { flag: "wx", mode: 0o600 },
);
console.log(
  `Created ${destination}. Keep it private and include it in your encrypted recovery plan.`,
);
