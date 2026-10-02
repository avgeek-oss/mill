---
title: "Upgrades"
description: "Migrate an existing installation with a tested backup."
---

Read the new version's release notes and verification evidence before changing an installation. Record your current source commit or immutable image digest, then make and test a [full backup](/backup).

## Task assignment and checklist retirement

Migration `010_task_assignment_without_assignee.sql` allows an Agent to remain on a task when its human assignee is cleared. When a human is assigned, that person still needs access to the Agent. The migration removes checklist entries from the active task table and public task responses. Existing nonempty checklists are copied to the private `retired_task_checklists` table, keyed by task ID, so an operator can recover them from a full database backup if the feature returns. Deleting a task also deletes its retired checklist data. The old application cannot write checklist changes after this migration; upgrade the application and database together.

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

For MCP OAuth after migration 008, create a personal Agent in the human interface or ask an administrator for access to a team Agent, then reconnect and select it at consent. A person without an eligible Agent cannot approve a connection. Creating an Agent never reactivates a revoked token. Personal REST keys follow migration 009 below.

An Agent on a task is optional, separate from the human assignee, and never executes work automatically. An Agent may be assigned without a human assignee. Setting or changing that binding requires access for the actor and, if a person is also assigned, for that person. Test that binding and your external connection after upgrade. Keep the pre-upgrade backup and compatible old application if you need to recover the earlier credential model in a separate project.

## Personal API keys and team access migration

Migration `009_agents_access.sql` separates personal REST API keys from Agent OAuth. It revokes all preexisting API keys and removes their Agent, board, scope, OAuth-client, and resource bindings. Existing Agent-bound OAuth connections remain intact. Tasks, task history, and human sessions remain. Completed retry response content becomes terminal `410`; its identity remains so an old mutation cannot run again.

After readiness succeeds, sign in and open **API keys**. Choose **Create API key**, enter a **Name**, and choose **Expiry**: 30, 60, 90, or 365 days. Copy the one-time token into the REST client's secret store and choose **Done**. There is no Agent, scope, or board selector. Replace the old client token and check a permitted REST request. Revoked old keys stay revoked; they cannot be recovered from the metadata list or re-enabled.

A new personal key uses its human owner's current role across all accessible boards, including boards created later. It cannot use MCP or human-only management routes. Keep OAuth for MCP: approval still requires an eligible existing human-created Agent and retains granted scopes and optional approved boards.

Team Agents gain the **All team members** policy, which covers current and future active members. Individual grants remain separate; the active creator receives a pinned grant and cannot be removed from it. Disabling All team members keeps the creator and selected individual grants. People who lose access have affected task Agent bindings cleared and OAuth connections revoked. A preserved OAuth connection still needs current owner membership and Agent access on every request.

Before upgrading an existing installation, test a full backup. Review team access, personal-key replacement, and OAuth access after startup. Migration 009 does not reactivate credentials previously revoked by migration 008. Keep the old application and pre-upgrade backup for recovery in a separate installation.

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

Private review artifacts include a saved image, source archive, `source-manifest.json`, `release-manifest.json`, and `SHA256SUMS`. The source manifest records each tracked source file's path, byte length, and SHA-256 digest. Choose the package matching your server's architecture. The packaging gate checks the image's Linux architecture, source revision, non-root user, and config digest against the clean source commit.

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

The release gate must verify startup from the prior schema, preserved task/comment/member/history/session data, fixed-status conversion, migration 008's unbound-credential revocation without automatic Agent creation, migration 009's API-key revocation/unbinding with OAuth preservation and dynamic team access, and restoration of a generated full backup including Agents/access grants. Record the reviewed revision and observed results before using the new application version.
