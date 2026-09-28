# Upgrades

Read the new version's release notes and verification evidence before changing an installation. Record your current source commit or immutable image digest, then make and test a [full backup](backup.md).

## Upgrade a source installation

```sh
bash tools/backup.sh --project mill --env-file .env --output backups/before-upgrade.dump
git fetch --tags origin
git checkout <reviewed-release-tag-or-commit>
docker compose --project-name mill --env-file .env build --pull mill
docker compose --project-name mill --env-file .env up --detach --wait --wait-timeout 180
curl --fail http://127.0.0.1:4321/health/ready
```

Replace the placeholder with the exact reviewed revision. Keep `.env` and the PostgreSQL volume. Mill applies new migrations at startup and checks the hashes of old ones. Test sign-in, a board, a task edit, and agent access after readiness succeeds.

## Upgrade a packaged image

Private review artifacts include a saved image, source archive, `release-manifest.json`, and `SHA256SUMS`. Choose the package matching your server's architecture. The packaging gate checks the image's Linux architecture, source revision, non-root user, and config digest against the clean source commit.

Verify all files before loading them:

```sh
# Linux, from the extracted artifact directory
sha256sum --check SHA256SUMS
# macOS alternative
shasum --algorithm 256 --check SHA256SUMS
```

Load the image with `docker load --input <image-archive>`, and set `MILL_IMAGE` to the `imageTag` recorded in `release-manifest.json`. Keep the manifest with your backup records. Start with `docker compose --project-name mill --env-file .env up --no-build --detach --wait`.

The B1 packaging workflow does not publish a registry image or public release. Publication is an owner decision after independent review. Do not invent a public image URL during private review.

## Roll back

An older application image may not support an upgraded schema. Do not point it at the new database unless the release notes explicitly confirm compatibility. Restore the pre-upgrade backup into a separate project with the matching old image first. Verify the data, then move the original HTTPS proxy to the recovered service during maintenance.

Database major-version upgrades need a tested PostgreSQL upgrade plan. Changing the container tag across majors while reusing a volume is not a supported shortcut.

CI's production runner verifies startup from an earlier local schema, preserves task/comment/member data, and tests restoring the generated backup. The exact reviewed commit and results are in [B1 verification](b1-verification.md).
