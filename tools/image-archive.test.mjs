import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectImageArchive } from "./image-archive.mjs";

test("release archives bind platform, non-root user, tag, and image revision to the reviewed source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mill-image-metadata-"));
  const revision = "a".repeat(40);
  const version = "1.0.0";
  const expected = { version, revision, platform: "linux/arm64" };
  try {
    const config = Buffer.from(
      JSON.stringify({
        os: "linux",
        architecture: "arm64",
        config: {
          User: "node",
          Labels: { "org.opencontainers.image.revision": revision },
        },
      }),
    );
    const hash = createHash("sha256").update(config).digest("hex");
    const name = `${hash}.json`;
    await writeFile(join(directory, name), config);
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify([
        { Config: name, RepoTags: [`mill:${version}-arm64`], Layers: [] },
      ]),
    );
    const archive = join(directory, "image.tar");
    const result = spawnSync(
      "tar",
      [
        "--create",
        "--file",
        archive,
        "--directory",
        directory,
        "manifest.json",
        name,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      inspectImageArchive(archive, expected).imageId,
      `sha256:${hash}`,
    );
    assert.throws(
      () =>
        inspectImageArchive(archive, { ...expected, revision: "b".repeat(40) }),
      /revision must match/,
    );
    assert.throws(
      () =>
        inspectImageArchive(archive, { ...expected, platform: "linux/amd64" }),
      /expected release tag/,
    );
    await writeFile(
      join(directory, name),
      JSON.stringify({
        os: "linux",
        architecture: "arm64",
        config: { User: "root" },
      }),
    );
    assert.equal(
      spawnSync("tar", [
        "--create",
        "--file",
        archive,
        "--directory",
        directory,
        "manifest.json",
        name,
      ]).status,
      0,
    );
    assert.throws(
      () => inspectImageArchive(archive, expected),
      /content must match its digest/,
    );
    for (const variant of [
      { architecture: "amd64", user: "node", error: /architecture must match/ },
      { architecture: "arm64", user: "root", error: /non-root node user/ },
    ]) {
      const bytes = Buffer.from(
        JSON.stringify({
          os: "linux",
          architecture: variant.architecture,
          config: {
            User: variant.user,
            Labels: { "org.opencontainers.image.revision": revision },
          },
        }),
      );
      const variantName = `${createHash("sha256").update(bytes).digest("hex")}.json`;
      await writeFile(join(directory, variantName), bytes);
      await writeFile(
        join(directory, "manifest.json"),
        JSON.stringify([
          {
            Config: variantName,
            RepoTags: [`mill:${version}-arm64`],
            Layers: [],
          },
        ]),
      );
      assert.equal(
        spawnSync("tar", [
          "--create",
          "--file",
          archive,
          "--directory",
          directory,
          "manifest.json",
          variantName,
        ]).status,
        0,
      );
      assert.throws(
        () => inspectImageArchive(archive, expected),
        variant.error,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
