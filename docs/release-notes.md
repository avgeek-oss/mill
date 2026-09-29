# Mill B1 release candidate

The proposed tag is `v1.0.0-beta.1`. The repository and build artifacts remain private. These notes describe the September 29 explicit-Agent and interface revision on top of the reduced task-list scope. Fresh verification is tracked in [B1 verification](b1-verification.md). Receipts through candidate `7fc132` and earlier screenshots are historical for this revision.

## Task lists

Boards appear alphabetically in the fixed Boards sidebar, with a plus button beside its heading. Each board has a task list using Backlog, Todo, In Progress, In Review, Done, and Won't Do. Tasks retain stable links, Markdown, human assignment, optional Agent attribution, priority, due dates, checklists, comments, mentions, and activity. Search, combined filters, sorting, and pagination help find work. Filter controls keep accessible names without visible labels. The ellipsis after New task opens Board settings or a separate Delete board confirmation.

Task edits and status changes use versions to reject stale writes. Members can permanently delete tasks; human administrators can permanently delete boards and their work. Deletion requires confirmation and cannot be undone in Mill. There are no archive or restore states.

Kanban, editable statuses, manual board/task ordering, labels, task parents/subtasks, portable export/import, and email task notifications are excluded from v1. Upgrading preserves existing task and subtask records as independent tasks; unknown old custom statuses become Todo. Follow [upgrade guidance](upgrades.md) and make a full backup first.

## People and agents

First setup creates the administrator once. Teams use roles, invitations, profiles, time zones, sessions, passkeys, authenticator verification, and recovery. Assignments and mentions produce in-app notifications in the compact header bell. The account/invitation email provider is currently unavailable; administrators share private invitation links and operators can issue recovery links.

Agents are distinct from People and are created in the human interface. A personal Agent is available only to its creator. A team Agent is managed by administrators and available to explicitly assigned people. API keys are personal and bind a selected existing Agent; OAuth requires the same eligible selection and cannot create an Agent. No eligible Agent means consent cannot be approved.

A task's Agent is separate from its human assignee. Setting an Agent requires an active assignee and access for both the acting person and assignee; unrelated edits retain a valid existing binding. Assignment has no execution side effects. REST and MCP can change both fields with the same checks as the UI.

Scoped, revocable keys and OAuth retain current membership and board restrictions. Human-only administration remains unavailable to agent credentials. Mutations support retry keys, versions, and bounded rate limits; task activity identifies human and agent actions. Workspace-wide audit history is excluded. Navigation uses Agents, API keys, and Team settings. Remote MCP and Backups widgets are removed; their operator and connection guides remain available.

## Self-hosting and release review

The production image serves the application and API as a non-root process. Compose needs PostgreSQL, persistent storage, and private configuration. Mill applies checksummed migrations at startup. Full PostgreSQL backup and restore preserve work, account state, notifications, and credentials; there is no portable-work export/import feature.

Migration 008 revokes preexisting credentials that have no explicit Agent binding. It preserves tasks, task history, and human sessions and creates no Agents automatically. After upgrade, create an Agent in the UI and issue a new personal key or reconnect OAuth. Read [upgrades](upgrades.md) before changing an existing installation.

CI and release review must verify source checks, real database behavior, browser journeys, dependency audit, production installation, prior-schema migration, and backup restore for this revision. Previous candidate receipts do not satisfy these gates. Packaging produces private archives, checksums, and a source/version manifest. It does not publish a registry image or release.

Physical passkeys and the operator's chosen HTTPS proxy need checks in that environment. Local virtual-authenticator and loopback proof must remain labeled accordingly. Publication requires independent review and applicable owner authorization.
