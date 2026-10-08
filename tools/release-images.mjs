import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const repository = "ghcr.io/avgeek-oss/mill";
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const commitPattern = /^[0-9a-f]{40}$/;
const tagPattern = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function validateReleaseImages(value, expectedTag, expectedCommit) {
  assert.equal(value?.version, expectedTag);
  assert.equal(value?.commit, expectedCommit);
  assert.match(value.version, tagPattern);
  assert.match(value.commit, commitPattern);
  assert.deepEqual(value.platforms, ["linux/amd64", "linux/arm64"]);
  assert.match(value.image, /^ghcr\.io\/avgeek-oss\/mill@sha256:[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(value).sort(), [
    "commit",
    "image",
    "platforms",
    "version",
  ]);
  return value;
}

export async function readReleaseImages(file, tag, commit) {
  return validateReleaseImages(
    JSON.parse(await readFile(file, "utf8")),
    tag,
    commit,
  );
}

function docker(...args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function verifyRegistryImage(tag, commit) {
  const tagged = `${repository}:${tag}`;
  const description = docker("buildx", "imagetools", "inspect", tagged);
  const digest = /^Digest:\s+(sha256:[0-9a-f]{64})$/m.exec(description)?.[1];
  assert.ok(digest, "The registry must return an immutable index digest");
  const index = JSON.parse(
    docker("buildx", "imagetools", "inspect", "--raw", tagged),
  );
  assert.ok(
    Array.isArray(index.manifests),
    "Expected a multi-platform image index",
  );
  for (const architecture of ["amd64", "arm64"]) {
    const matches = index.manifests.filter(
      (entry) =>
        entry.platform?.os === "linux" &&
        entry.platform?.architecture === architecture,
    );
    assert.equal(
      matches.length,
      1,
      `Expected one linux/${architecture} manifest`,
    );
    const platformDigest = matches[0].digest;
    assert.match(platformDigest, digestPattern);
    const reference = `${repository}@${platformDigest}`;
    docker("pull", "--platform", `linux/${architecture}`, reference);
    const image = JSON.parse(
      docker("image", "inspect", reference, "--format", "{{json .}}"),
    );
    assert.equal(image.Os, "linux");
    assert.equal(image.Architecture, architecture);
    assert.equal(
      image.Config.Labels["org.opencontainers.image.revision"],
      commit,
    );
    assert.equal(
      image.Config.Labels["org.opencontainers.image.version"],
      tag.slice(1),
    );
    assert.equal(
      image.Config.Labels["org.opencontainers.image.source"],
      "https://github.com/avgeek-oss/mill",
    );
  }
  return `${repository}@${digest}`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [tag, commit, output] = process.argv.slice(2);
  assert.ok(
    tag && commit && output,
    "Usage: release-images.mjs <tag> <commit> <output>",
  );
  assert.match(tag, tagPattern);
  assert.match(commit, commitPattern);
  const manifest = validateReleaseImages(
    {
      version: tag,
      commit,
      platforms: ["linux/amd64", "linux/arm64"],
      image: verifyRegistryImage(tag, commit),
    },
    tag,
    commit,
  );
  await writeFile(output, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Verified authenticated registry image ${manifest.image}`);
}
