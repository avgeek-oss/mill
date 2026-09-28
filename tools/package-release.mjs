import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { inspectImageArchive } from "./image-archive.mjs";

const options = new Map();
for (let index = 2; index < process.argv.length; index += 2)
  options.set(process.argv[index], process.argv[index + 1]);
const archive = options.get("--image-archive");
const platform = options.get("--platform");
const output = options.get("--output");
assert.ok(
  archive && output && ["linux/amd64", "linux/arm64"].includes(platform),
  "Usage: node tools/package-release.mjs --image-archive image.tar --platform linux/amd64 --output directory",
);
function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
const revision = git(["rev-parse", "HEAD"]);
assert.equal(
  git(["status", "--porcelain", "--untracked-files=all"]),
  "",
  "Package only a clean reviewed commit",
);
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const imageMetadata = inspectImageArchive(archive, {
  version,
  platform,
  revision,
});
const directory = resolve(output);
await mkdir(directory, { recursive: false });
const imageFile = `mill-${version}-${platform.split("/")[1]}.tar`;
await copyFile(archive, join(directory, imageFile));
const sourceFile = `mill-${version}-source.tar.gz`;
const source = spawnSync(
  "git",
  [
    "archive",
    "--format=tar.gz",
    `--prefix=mill-${version}/`,
    `--output=${join(directory, sourceFile)}`,
    revision,
  ],
  { encoding: "utf8" },
);
assert.equal(source.status, 0, source.stderr);
for (const file of [
  "docker-compose.yml",
  ".env.example",
  "LICENSE",
  "NOTICE",
  "README.md",
])
  await copyFile(file, join(directory, basename(file)));
await writeFile(
  join(directory, "release-manifest.json"),
  JSON.stringify(
    {
      version,
      revision,
      platform,
      imageArchive: imageFile,
      sourceArchive: sourceFile,
      ...imageMetadata,
      privacy:
        "Private review artifact. No registry publication or production deployment performed.",
    },
    null,
    2,
  ),
);
const checksums = [];
for (const name of (await readdir(directory)).sort()) {
  const hash = createHash("sha256");
  for await (const data of createReadStream(join(directory, name)))
    hash.update(data);
  checksums.push(`${hash.digest("hex")}  ${name}`);
}
await writeFile(join(directory, "SHA256SUMS"), `${checksums.join("\n")}\n`);
console.log(
  `Prepared private ${platform} artifacts for ${version} at ${directory}`,
);
