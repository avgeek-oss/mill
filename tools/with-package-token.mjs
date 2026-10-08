import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubPackagesToken } from "./package-registry.mjs";

let directory;
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => controller.abort());
try {
  const [command, ...args] = process.argv.slice(2);
  if (!command)
    throw new Error(
      "Usage: node tools/with-package-token.mjs COMMAND [ARGUMENTS]",
    );
  const token = await githubPackagesToken();
  directory = await mkdtemp(join(tmpdir(), "mill-package-auth-"));
  const configuration = join(directory, "npmrc");
  await writeFile(
    configuration,
    `@avgeek-oss:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${token}\n`,
    { mode: 0o600 },
  );
  const child = spawn(command, args, {
    stdio: "inherit",
    signal: controller.signal,
    env: {
      ...process.env,
      NODE_AUTH_TOKEN: token,
      NPM_CONFIG_USERCONFIG: configuration,
    },
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (directory) await rm(directory, { recursive: true, force: true });
}
