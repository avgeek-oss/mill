# Mill B1 release candidate

The proposed tag is `v1.0.0-beta.1`. The repository and build artifacts remain private while this candidate is reviewed. These notes describe the proposed product and migration behavior. Release acceptance depends on current-revision source, browser, packaging, upgrade/restore, and hosted CI evidence recorded in the private B1 verification matrix.

## Task lists

This candidate removes checklists from task pages, REST and MCP. Migration 010 retains existing nonempty checklist data in a private retired table for possible future restoration. A task can now have an Agent without a human assignee; any human assigned alongside that Agent must have access to it. Fresh verification must cover this reduced model.

Boards appear alphabetically in the secondary Boards sidebar, with a plus button beside its heading. Each board has a task list using Backlog, Todo, In Progress, In Review, Done, and Won't Do. Tasks retain stable links, Markdown, human assignment, optional Agent attribution, priority, due dates, comments, mentions, and activity. Search, combined filters, sorting, and pagination help find work. Filter controls keep accessible names without visible labels. The ellipsis after New task opens Board settings or a separate Delete board confirmation.

Tasks open on dedicated pages with independently saved fields and inline retry/conflict recovery. UI creation asks only for Title, Description and Assignee; REST/MCP retain the full creation contract. Board search, filters, sort, page and page size persist in URL parameters and task return links. Task edits and status changes use versions to reject stale writes. Members can permanently delete tasks; human administrators can permanently delete boards and their work. Deletion requires confirmation and cannot be undone in Mill. There are no archive or restore states.

Kanban, editable statuses, manual board/task ordering, labels, task parents/subtasks, portable export/import, and email task notifications are excluded from v1. Upgrading preserves existing task and subtask records as independent tasks; unknown old custom statuses become Todo. Follow [upgrade guidance](upgrades.md) and make a full backup first.

## People and agents

First setup creates the administrator once. Teams use roles, invitations, profiles, time zones, sessions, passkeys, authenticator verification, and recovery. Assignments and mentions produce in-app notifications in the compact header bell. The account/invitation email provider is currently unavailable; administrators share private invitation links and operators can issue recovery links.

Agents are distinct from People and are created in the human interface. A personal Agent is available only to its creator. A team Agent is managed by administrators and available to selected active people or all current and future members. The active creator keeps a pinned individual grant. Personal API keys use the human owner's current permissions for REST across all accessible boards; creation accepts only Name and Expiry of 30, 60, 90, or 365 days. MCP OAuth requires an eligible existing Agent and retains scopes and optional board grants. It cannot create an Agent; no eligible Agent means consent cannot be approved.

A task's Agent is separate from its human assignee. An Agent can be assigned without a human assignee. The acting person must have access, and any selected human assignee must also have access; unrelated edits retain a valid existing binding. Assignment has no execution side effects. REST and MCP can change both fields with the same checks as the UI.

Personal keys and OAuth are revocable and enforce current membership and role. Only OAuth has selected-Agent, scope, and board restrictions. Human-only administration remains unavailable to both credential types. Mutations support retry keys, versions, and bounded rate limits; task activity identifies human and agent actions. Workspace-wide audit history is excluded. Navigation uses Agents, API keys, and Team settings. People actions sit above member/invitation tables without redundant headings. Shared Avatars use email/name lookup with initials fallback; table lines, role/status Chips, explanatory text, and secondary/danger controls follow Towbar. Remote MCP and Backups widgets are removed; their operator and connection guides remain available.

## Self-hosting and release review

The production image serves the application and API as a non-root process. Compose needs PostgreSQL, persistent storage, and private configuration. Mill applies checksummed migrations at startup. Full PostgreSQL backup and restore preserve work, account state, notifications, and credentials; there is no portable-work export/import feature.

Migration 008 revokes preexisting credentials that have no explicit Agent binding. It preserves tasks, task history, and human sessions and creates no Agents automatically. Migration 009 then revokes and unbinds previous API keys while preserving existing Agent-bound OAuth connections. After upgrade, replace REST keys through API keys with Name and Expiry; reconnect OAuth only when the connection is expired, revoked, or no longer eligible. Team access now supports all current and future members and pins active creators' individual grants. Read [upgrades](upgrades.md) before changing an existing installation.

CI and release review must verify source checks, real database behavior, browser journeys, dependency audit, production installation, prior-schema migration, and backup restore for this revision. Packaging produces private archives, `source-manifest.json` with tracked source file hashes, `release-manifest.json`, and `SHA256SUMS`. It does not publish a registry image or release.

Physical passkeys and the operator's chosen HTTPS proxy need checks in that environment. Local virtual-authenticator and loopback proof must remain labeled accordingly. Publication requires independent review and applicable owner authorization.
