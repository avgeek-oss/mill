import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const repositories = {
  api: "ghcr.io/avgeek-oss/mill-api",
  web: "ghcr.io/avgeek-oss/mill-web",
};
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const commitPattern = /^[0-9a-f]{40}$/;
const tagPattern = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function validateReleaseImages(value, expectedTag, expectedCommit) {
  assert.equal(value?.version, expectedTag);
  assert.equal(value?.commit, expectedCommit);
  assert.match(value.version, tagPattern);
  assert.match(value.commit, commitPattern);
  assert.deepEqual(value.platforms, ["linux/amd64", "linux/arm64"]);
  assert.ok(value.images && typeof value.images === "object");
  assert.deepEqual(Object.keys(value.images).sort(), ["api", "web"]);
  for (const component of ["api", "web"]) {
    assert.match(
      value.images[component],
      new RegExp(
        `^ghcr\\.io/avgeek-oss/mill-${component}@sha256:[0-9a-f]{64}$`,
      ),
    );
  }
  assert.deepEqual(Object.keys(value).sort(), [
    "commit",
    "images",
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

// `run` defaults to the Docker CLI; the tests pass a fake registry.
export function verifyRegistryImage(component, tag, commit, run = docker) {
  const repository = repositories[component];
  const tagged = `${repository}:${tag}`;
  const description = run("buildx", "imagetools", "inspect", tagged);
  const digest = /^Digest:\s+(sha256:[0-9a-f]{64})$/m.exec(description)?.[1];
  assert.ok(digest, "The registry must return an immutable index digest");
  for (const alias of [tag.slice(1), commit]) {
    const aliasDescription = run(
      "buildx",
      "imagetools",
      "inspect",
      `${repository}:${alias}`,
    );
    const aliasDigest = /^Digest:\s+(sha256:[0-9a-f]{64})$/m.exec(
      aliasDescription,
    )?.[1];
    assert.equal(
      aliasDigest,
      digest,
      `Release alias ${alias} must match ${tag}`,
    );
  }
  const index = JSON.parse(
    run("buildx", "imagetools", "inspect", "--raw", tagged),
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
    // Read the platform image configuration from the registry instead of
    // pulling every layer. The arm64 installation smoke test pulls and runs
    // its platform image before the release is published.
    const image = JSON.parse(
      run(
        "buildx",
        "imagetools",
        "inspect",
        `${repository}@${platformDigest}`,
        "--format",
        "{{json .Image}}",
      ),
    );
    assert.equal(image.os, "linux");
    assert.equal(image.architecture, architecture);
    const labels = image.config?.Labels ?? {};
    assert.equal(labels["org.opencontainers.image.revision"], commit);
    assert.equal(labels["org.opencontainers.image.version"], tag.slice(1));
    assert.equal(
      labels["org.opencontainers.image.source"],
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
      images: {
        api: verifyRegistryImage("api", tag, commit),
        web: verifyRegistryImage("web", tag, commit),
      },
    },
    tag,
    commit,
  );
  await writeFile(output, JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    `Verified registry images ${manifest.images.api} and ${manifest.images.web}`,
  );
}
