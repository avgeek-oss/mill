import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";

function member(archive, name) {
  const result = spawnSync(
    "tar",
    ["--extract", "--to-stdout", "--file", resolve(archive), name],
    { maxBuffer: 4 * 1024 * 1024, timeout: 60_000 },
  );
  assert.equal(
    result.status,
    0,
    `Cannot read image metadata ${name}: ${result.stderr?.toString()}`,
  );
  return result.stdout;
}
export function inspectImageArchive(
  archive,
  { version, platform, revision, component },
) {
  assert.ok(
    ["api", "web"].includes(component),
    "Release image component must be api or web",
  );
  const manifest = JSON.parse(
    member(archive, "manifest.json").toString("utf8"),
  );
  assert.equal(
    manifest.length,
    1,
    "A release archive must contain exactly one image",
  );
  const [image] = manifest;
  const architecture = platform.split("/")[1];
  const tag = `mill-${component}:${version}-${architecture}`;
  assert.deepEqual(
    image.RepoTags,
    [tag],
    "The image archive must contain the expected release tag",
  );
  assert.match(
    image.Config,
    /^(?:blobs\/sha256\/)?[a-f0-9]{64}(?:\.json)?$/,
    "Image config path must be a content hash",
  );
  const configBytes = member(archive, image.Config);
  const configHash = createHash("sha256").update(configBytes).digest("hex");
  assert.equal(
    configHash,
    basename(image.Config).replace(/\.json$/, ""),
    "Image config content must match its digest",
  );
  const config = JSON.parse(configBytes.toString("utf8"));
  assert.equal(config.os, "linux", "Release image must use Linux");
  assert.equal(
    config.architecture,
    architecture,
    "Image architecture must match the release platform",
  );
  assert.equal(
    config.config?.User,
    "node",
    "Release image must run as the non-root node user",
  );
  assert.equal(
    config.config?.Labels?.["org.opencontainers.image.revision"],
    revision,
    "Image revision must match the clean source commit",
  );
  return { imageId: `sha256:${configHash}`, imageTag: tag };
}
