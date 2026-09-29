# Upgrades

Read the new version's release notes and verification evidence before changing an installation. Record your current source commit or immutable image digest, then make and test a [full backup](backup.md).

## Permanent deletion migration

Migration `005_permanent_deletion.sql` removes archiving and soft deletion for boards and tasks. Existing archived work becomes ordinary work. Previously deleted boards and tasks are permanently removed, together with their subtasks, statuses, comments, notifications, and activity. Deleting a board removes it from agent scopes and revokes credentials whose last permitted board was removed. Completed retry responses from the earlier schema are cleared because they may contain deleted content. Their keys remain until normal expiry: an exact retry returns `410` and cannot repeat the earlier mutation. Reload Mill and check the current work before making a new change.

Review this change and save a full backup before starting the new application against an existing installation. Once this migration runs, the old application cannot use the new schema. Recover old deleted work from the pre-upgrade backup in a separate installation before upgrading if you need to keep it.

## Fixed-status task list migration

Migration `007_fixed_task_statuses.sql` removes custom columns, manual board/task positions, labels, and task parent links. It keeps every remaining task and former subtask as an independent task with the same ID and identifier. Descriptions, assignments, priorities, due dates, checklists, comments, notifications, and attributed task history remain. Existing activity detail is preserved as stored, including historical field names/status UUIDs.

Old names are trimmed, whitespace-normalized, and matched case-insensitively. Backlog maps to `backlog`; Todo/To do to `todo`; In progress/In_progress to `in_progress`; In review/In_review to `in_review`; Done to `done`; Won't do, Won’t do, Wont do, Wont_do, Cancelled, and Canceled to `wont_do`. All other custom names map to `todo`. Boards become alphabetical. New tasks default to Todo.

The migration removes the obsolete email notification preference. Task delivery is in-app only. It also clears completed old retry response content and retains the retry identity until expiry. Exact retries return terminal `410`, including former routes, and cannot run an obsolete mutation again. Reload the reduced client before starting new work.

Save and test a full database backup before starting this version against an existing installation. Older application versions cannot use the reduced schema. There is no legacy JSON/portable importer; existing portable files do not provide a v1 restore path. Recover an earlier model only from its database backup with a compatible old application in a separate project.

## Explicit Agent migration

Migration `008_agents.sql` adds Agents separate from People, explicit team access grants, and task Agent bindings. It revokes preexisting credentials that lack an Agent binding, including earlier OAuth connections. It creates no Agents automatically and preserves existing tasks, task history, and human sessions. Earlier applied migrations remain unchanged.

After upgrade, open Agents in the human interface. Create a personal Agent or have an administrator create a team Agent and assign eligible people. Open API keys to issue a new personal key bound to an Agent you can access, or reconnect OAuth and select that Agent at consent. A person without an eligible Agent cannot approve a connection. Revoked old keys do not become usable again by creating an Agent.

An Agent on a task is optional, separate from the human assignee, and never executes work automatically. Selecting one requires an active human assignee and access for both actor and assignee. Test that binding and your external connection after upgrade. Keep the pre-upgrade backup and compatible old application if you need to recover the earlier credential model in a separate project.

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

The release gate must verify startup from the prior schema, preserved task/comment/member/history/session data, fixed-status conversion, migration 008's unbound-credential revocation without automatic Agent creation, and restoration of a generated full backup including Agents/access grants. Record the reviewed revision and observed results before using the new application version.
