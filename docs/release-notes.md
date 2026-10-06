# Mill v1 release candidate

The proposed tag is `v1.0.0`. The repository and build artifacts remain private while this candidate is reviewed. These notes describe the proposed product and migration behavior. Release acceptance depends on current-revision source, browser, packaging, upgrade/restore, and hosted CI evidence recorded in the release pull request and CI artifacts.

## Task lists

Tasks have no checklist or comment-editing feature. The initial schema contains only the supported v1 model.

Operate → Boards opens an alphabetical card overview with separate Backlog, To Do and In Progress counts for each board. The plus button on this page creates a board. Each board has a task list using Backlog, Todo, In Progress, In Review, Done, and Won't Do. Tasks have Task or Bug types, defaulting to Task, and retain stable links, Markdown, assignment, priority, due dates, comments, mentions, and activity. A theme-colored task icon or red bug icon appears before each task ID in the list. Search, combined filters, sorting, and pagination help find work. Search tasks sits above the table; filters and sort live in the secondary panel, with visible labels and accessible names. On smaller screens, the Filters button opens the navigation drawer. The ellipsis after New task opens Board settings or a separate Delete board confirmation.

Tasks open on dedicated pages with independently saved fields and inline retry/conflict recovery. UI creation asks for Title, Type, Description and Assignee; REST/MCP retain the full creation contract. Type appears above Status on the task page and saves independently with Activity history. Existing tasks start with Task type and keep their identifiers and history. Board search, filters, sort, page and page size persist in URL parameters and task return links. Task edits and status changes use versions to reject stale writes. Members can permanently delete tasks; human administrators can permanently delete boards and their work. Deletion requires confirmation and cannot be undone in Mill. There are no archive or restore states.

Kanban, editable statuses, manual board/task ordering, labels, task parents/subtasks, portable export/import, and email task notifications are excluded from v1. Upgrading preserves existing task and subtask records as independent tasks; unknown old custom statuses become Todo. Follow [upgrade guidance](upgrades.md) and make a full backup first.

The task actions menu includes Duplicate task. It opens a modal with a `[Copy] ` title prefix, the original description, type and priority, Backlog status and an empty assignee. The user confirms creation after reviewing the fields. The copy has a fresh identifier and no due date, comments or previous activity.

Task properties include an optional Start date before Due date. Both are calendar dates, save independently with retry/conflict recovery, and can be set or cleared through REST and MCP. Existing tasks begin without a start date; duplicated tasks leave both dates empty.

## People and client connections

First setup creates the administrator once. Teams use roles, invitations, profiles, time zones, sessions, passkeys as the only second factor, and single-use passkey recovery codes. Assignments and mentions produce in-app notifications in the compact header bell. The account/invitation email provider is currently unavailable; administrators share private invitation links and operators can issue recovery links.

Personal API keys use the human owner's current permissions for REST across all accessible boards; creation accepts only Name and Expiry of 30, 60, 90, or 365 days. MCP OAuth creates a human-owned connection with approved read or read/write scopes and optional board restrictions. Clients do not need a separate identity to connect. There is no Agent directory, management, task assignment or filter in the application, REST or MCP.

Personal keys and OAuth are revocable and enforce current membership and role. Human-only administration remains unavailable to both credential types. Mutations support retry keys, versions, and bounded rate limits; task activity identifies the responsible person and distinguishes OAuth connections from human actions. Workspace-wide audit history is excluded. Navigation includes Account settings and Team settings. API keys belong to Account settings; member management belongs to Team settings → Members. People actions sit above member/invitation tables without redundant headings. Shared Avatars use email/name lookup with initials fallback; table lines, role/status Chips, explanatory text, and secondary/danger controls follow Towbar. Remote MCP and Backups widgets are removed; their operator and connection guides remain available.

## Self-hosting and release review

The production image serves the application and API as a non-root process. Compose needs PostgreSQL, persistent storage, and private configuration. Mill applies checksummed migrations at startup. Full PostgreSQL backup and restore preserve work, account state, notifications, and credentials; there is no portable-work export/import feature.

The pre-launch migration sequence has been consolidated into `001_initial.sql` for fresh installations. Startup verifies its checksum and rejects databases using the retired sequence. Those private development installations must be converted using the maintainer procedure, preserving a recoverable copy of the original schema. The release is not an automatic upgrade from the earlier private candidates. Read [upgrades](upgrades.md) before changing an existing installation.

CI and release review must verify source checks, real database behavior, browser journeys, dependency audit, production installation, pre-launch conversion, and backup restore for this revision. Packaging produces private archives, `source-manifest.json` with tracked source file hashes, `release-manifest.json`, and `SHA256SUMS`. It does not publish a registry image or release.

Physical passkeys and the operator's chosen HTTPS proxy need checks in that environment. Local virtual-authenticator and loopback proof must remain labeled accordingly. Publication requires independent review and applicable owner authorization.
