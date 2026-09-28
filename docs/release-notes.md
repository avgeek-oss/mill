# Mill B1 release candidate

The proposed tag is `v1.0.0-beta.1`. The repository and build artifacts remain private during review. These notes describe the release scope; release readiness is established by [the verification matrix](b1-verification.md) and the coordinating owner's independent review.

## Task board

Mill centers on boards with ordered statuses, Kanban and list views, task detail links, combined search/filtering, and keyboard/touch task movement. Tasks support assignments, priorities, labels, due dates, checklists, safe Markdown, comments, mentions, and activity. The fixed Boards list loads every board and places Create Project last. Deleting a task permanently removes its descendant subtasks and comments; a human administrator can permanently delete a board and all its work. There are no archive or restore states. Concurrent edits use versions and return an explicit conflict.

## Team and agents

The first installation creates its administrator once. Teams use Admin, Member, and Viewer roles, invitations, profiles, time zones, session controls, passkeys, authenticator verification, and recovery. B1 uses a notification bell for in-app assignment/mention notifications and private invitation links. Email delivery is unavailable.

External agents use scoped, revocable credentials or OAuth with REST and remote MCP. Restrictions apply across boards and resource IDs; human-only administrative actions stay unavailable to agent credentials. Retry-sensitive mutations support idempotency and bounded rate limits. Activity and audit history identify human and agent actions.

## Self-hosting

The production image runs the web application and API as a non-root process. Docker Compose requires PostgreSQL only, persists its data, validates configuration, and applies checked migrations at startup. Full backup/restore and portable work export/import cover different recovery needs. Portable export version 2 omits archive/deletion state and preserves board task numbering; older exports skip deleted work and import archived work as ordinary work. Installation, team workflows, agents, operations, and contributor documentation are included.

## Review and publication

CI requires formatting, lint, types, integration tests, browser journeys, dependency audit, production image build, fresh installation, schema upgrade, and backup restore. Packaging produces private image/source archives, checksums, and a source/version manifest. It does not publish a public registry image or release.

Physical passkey devices and an operator's chosen HTTPS proxy need verification in that operator's environment. Local software-authenticator or loopback smoke evidence must remain identified as such. See [B1 verification](b1-verification.md) for exact results and open gaps on the reviewed commit.
