#!/usr/bin/env bash
# Prints the buildx bake definition for both Mill release images on one
# architecture. Publish release images and its rehearsal share it, so the
# rehearsal builds exactly what a release builds.
#
# RELEASE_OUTPUT=push   push each image to GHCR by digest (release runs)
# RELEASE_OUTPUT=local  load each image into the local Docker daemon as
#                       mill-<component>:rehearsal-<architecture> (rehearsals)
#
# Inputs come from the environment: ARCHITECTURE, SOURCE_COMMIT,
# RELEASE_VERSION, CREATED, SOURCE_URL and BUILDER_ID.
set -euo pipefail
case "${RELEASE_OUTPUT:-}" in
  push | local) ;;
  *)
    echo "RELEASE_OUTPUT must be push or local" >&2
    exit 1
    ;;
esac
jq -n '
  def output($component):
    if env.RELEASE_OUTPUT == "push"
    then "type=image,name=ghcr.io/avgeek-oss/mill-\($component),push-by-digest=true,name-canonical=true,push=true"
    else "type=docker,name=mill-\($component):rehearsal-\(env.ARCHITECTURE)"
    end;
  def image($component): {
    context: ".",
    dockerfile: "Dockerfile",
    target: $component,
    platforms: ["linux/\(env.ARCHITECTURE)"],
    args: {SOURCE_COMMIT: env.SOURCE_COMMIT, RELEASE_VERSION: env.RELEASE_VERSION},
    labels: {
      "org.opencontainers.image.created": env.CREATED,
      "org.opencontainers.image.revision": env.SOURCE_COMMIT,
      "org.opencontainers.image.source": env.SOURCE_URL,
      "org.opencontainers.image.version": env.RELEASE_VERSION
    },
    attest: ["type=provenance,mode=max,builder-id=\(env.BUILDER_ID)", "type=sbom"],
    output: [output($component)]
  };
  {group: {default: {targets: ["api", "web"]}}, target: {api: image("api"), web: image("web")}}
'
