import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export async function githubPackagesToken({
  env = process.env,
  home = homedir(),
} = {}) {
  const validate = (token) => {
    if (/[\r\n\0]/.test(token))
      throw new Error(
        "GitHub Packages credentials must contain a single token.",
      );
    return token;
  };
  if (env.NODE_AUTH_TOKEN?.trim()) return validate(env.NODE_AUTH_TOKEN.trim());
  const configuration =
    env.NPM_CONFIG_USERCONFIG ??
    env.npm_config_userconfig ??
    join(home, ".npmrc");
  let source;
  try {
    source = await readFile(configuration, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const match = source?.match(
    /^\s*\/\/npm\.pkg\.github\.com\/:_authToken\s*=\s*([^\r\n]*)$/m,
  );
  const token = match?.[1]
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2")
    .replace(/\$\{([^}]+)\}/g, (_, name) => env[name] ?? "")
    .trim();
  if (token) return validate(token);
  throw new Error(
    "GitHub Packages authentication is required to build Mill. Run npm login --scope=@avgeek-oss --registry=https://npm.pkg.github.com --auth-type=legacy with a classic token with read:packages, or provide NODE_AUTH_TOKEN through your secret manager.",
  );
}
