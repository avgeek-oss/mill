import assert from "node:assert/strict";
import { test } from "node:test";
import { validateReleaseImages } from "./release-images.mjs";

const tag = "v1.0.1";
const commit = "a".repeat(40);
const manifest = {
  version: tag,
  commit,
  platforms: ["linux/amd64", "linux/arm64"],
  image: `ghcr.io/avgeek-oss/mill@sha256:${"b".repeat(64)}`,
};

test("release manifest binds a stable version and source to the Mill digest", () => {
  assert.deepEqual(validateReleaseImages(manifest, tag, commit), manifest);
  assert.throws(() =>
    validateReleaseImages({ ...manifest, commit: "c".repeat(40) }, tag, commit),
  );
  assert.throws(() =>
    validateReleaseImages(
      { ...manifest, image: "ghcr.io/other/mill@sha256:" + "b".repeat(64) },
      tag,
      commit,
    ),
  );
  assert.throws(() =>
    validateReleaseImages(
      { ...manifest, platforms: ["linux/amd64"] },
      tag,
      commit,
    ),
  );
  assert.throws(() =>
    validateReleaseImages({ ...manifest, extra: true }, tag, commit),
  );
});
