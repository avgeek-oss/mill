import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  readReleaseImages,
  validateReleaseImages,
  verifyRegistryImage,
} from "./release-images.mjs";

const tag = "v1.0.1";
const commit = "a".repeat(40);
const manifest = {
  version: tag,
  commit,
  platforms: ["linux/amd64", "linux/arm64"],
  images: {
    api: `ghcr.io/avgeek-oss/mill-api@sha256:${"b".repeat(64)}`,
    web: `ghcr.io/avgeek-oss/mill-web@sha256:${"c".repeat(64)}`,
  },
};

function rejects(candidate) {
  assert.throws(() => validateReleaseImages(candidate, tag, commit));
}

test("release manifest binds both native images to a stable version and source", () => {
  assert.deepEqual(validateReleaseImages(manifest, tag, commit), manifest);
  rejects({ ...manifest, commit: "d".repeat(40) });
  rejects({ ...manifest, version: "v1.0.2" });
  rejects({ ...manifest, platforms: ["linux/amd64"] });
  rejects({ ...manifest, extra: true });
});

test("release manifest rejects missing, swapped, mutable or unrelated components", () => {
  for (const component of ["api", "web"]) {
    const other = component === "api" ? "web" : "api";
    rejects({ ...manifest, images: { [other]: manifest.images[other] } });
    for (const invalid of [
      manifest.images[other],
      `ghcr.io/avgeek-oss/mill-${component}:${tag}`,
      `ghcr.io/other/mill-${component}@sha256:${"b".repeat(64)}`,
      `ghcr.io/avgeek-oss/mill@sha256:${"b".repeat(64)}`,
      `ghcr.io/avgeek-oss/mill-${component}@sha256:broken`,
    ]) {
      rejects({
        ...manifest,
        images: { ...manifest.images, [component]: invalid },
      });
    }
  }
  rejects({ ...manifest, images: undefined });
  rejects({ ...manifest, images: { ...manifest.images, worker: "extra" } });
  const { images, ...combined } = manifest;
  rejects({ ...combined, image: images.api });
});

test("installation manifest loading validates the version, source and complete image pair", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "mill-release-images-"));
  const file = path.join(directory, "mill-images.json");
  try {
    await writeFile(file, JSON.stringify(manifest));
    assert.deepEqual(await readReleaseImages(file, tag, commit), manifest);
    await assert.rejects(readReleaseImages(file, tag, "d".repeat(40)));
    await writeFile(
      file,
      JSON.stringify({ ...manifest, images: { api: manifest.images.api } }),
    );
    await assert.rejects(readReleaseImages(file, tag, commit));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function fakeRegistry(configure = (config) => config) {
  const repository = "ghcr.io/avgeek-oss/mill-api";
  const digest = `sha256:${"e".repeat(64)}`;
  const platforms = {
    amd64: `sha256:${"1".repeat(64)}`,
    arm64: `sha256:${"2".repeat(64)}`,
  };
  const calls = [];
  const run = (...args) => {
    calls.push(args);
    assert.deepEqual(args.slice(0, 3), ["buildx", "imagetools", "inspect"]);
    if (args[3] === "--raw")
      return JSON.stringify({
        manifests: Object.entries(platforms).map(([architecture, entry]) => ({
          digest: entry,
          platform: { os: "linux", architecture },
        })),
      });
    const architecture = Object.keys(platforms).find(
      (key) => args[3] === `${repository}@${platforms[key]}`,
    );
    if (architecture) {
      assert.deepEqual(args.slice(4), ["--format", "{{json .Image}}"]);
      return JSON.stringify(
        configure({
          os: "linux",
          architecture,
          config: {
            Labels: {
              "org.opencontainers.image.revision": commit,
              "org.opencontainers.image.version": tag.slice(1),
              "org.opencontainers.image.source":
                "https://github.com/avgeek-oss/mill",
            },
          },
        }),
      );
    }
    return `Name: ${args[3]}\nDigest: ${digest}\n`;
  };
  return { run, calls, expected: `${repository}@${digest}` };
}

test("registry verification reads each platform configuration without pulling layers", () => {
  const registry = fakeRegistry();
  assert.equal(
    verifyRegistryImage("api", tag, commit, registry.run),
    registry.expected,
  );
  assert.ok(registry.calls.every((args) => args[0] === "buildx"));
  assert.equal(
    registry.calls.filter((args) => args.includes("{{json .Image}}")).length,
    2,
  );
  for (const configure of [
    (config) => ({ ...config, architecture: "arm64" }),
    (config) => ({ ...config, os: "windows" }),
    (config) => ({ ...config, config: undefined }),
    (config) => ({
      ...config,
      config: {
        Labels: {
          ...config.config.Labels,
          "org.opencontainers.image.revision": "d".repeat(40),
        },
      },
    }),
  ])
    assert.throws(() =>
      verifyRegistryImage("api", tag, commit, fakeRegistry(configure).run),
    );
});
