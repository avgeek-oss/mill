# Mill B1 release candidate

The proposed tag is `v1.0.0-beta.1`. The repository and build artifacts remain private. These notes describe the September 29 reduced scope; implementation and fresh verification are tracked in [B1 verification](b1-verification.md). Earlier candidate receipts and screenshots remain historical.

## Task lists

Boards appear alphabetically in the fixed Boards sidebar, with Create Project last. Each board has a task list using Backlog, Todo, In Progress, In Review, Done, and Won't Do. Tasks retain stable links, Markdown, assignment, priority, due dates, checklists, comments, mentions, and attributed activity. Search, combined filters, sorting, and pagination help find work.

Task edits and status changes use versions to reject stale writes. Members can permanently delete tasks; human administrators can permanently delete boards and their work. Deletion requires confirmation and cannot be undone in Mill. There are no archive or restore states.

Kanban, editable statuses, manual board/task ordering, labels, task parents/subtasks, portable export/import, and email task notifications are excluded from v1. Upgrading preserves existing task and subtask records as independent tasks; unknown old custom statuses become Todo. Follow [upgrade guidance](upgrades.md) and make a full backup first.

## People and agents

First setup creates the administrator once. Teams use roles, invitations, profiles, time zones, sessions, passkeys, authenticator verification, and recovery. Assignments and mentions produce in-app notifications in the compact header bell. The account/invitation email provider is currently unavailable; administrators share private invitation links and operators can issue recovery links.

External agents use scoped, revocable credentials or OAuth with REST and remote MCP. Current membership and board restrictions apply to every operation. Human-only administration remains unavailable to agent credentials. Mutations support retry keys, versions, and bounded rate limits; task activity identifies human and agent actions. Workspace-wide audit history is excluded.

## Self-hosting and release review

The production image serves the application and API as a non-root process. Compose needs PostgreSQL, persistent storage, and private configuration. Mill applies checksummed migrations at startup. Full PostgreSQL backup and restore preserve work, account state, notifications, and credentials; there is no portable-work export/import feature.

CI and release review must verify source checks, real database behavior, browser journeys, dependency audit, production installation, prior-schema migration, and backup restore for this revision. Packaging produces private archives, checksums, and a source/version manifest. It does not publish a registry image or release.

Physical passkeys and the operator's chosen HTTPS proxy need checks in that environment. Local virtual-authenticator and loopback proof must remain labeled accordingly. Publication requires independent review and applicable owner authorization.
