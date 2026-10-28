# Mill 1.0.6

Boards now have card and table views, with prefixes, creators and last activity in the table. Board settings have separate General and Danger zone pages. General settings can update a unique board prefix, including the identifiers of its existing tasks.

Task lists default to priority order. Search, filter and sort controls sit together above the list. Select tickets individually or with a table header checkbox, then update status, assignee, priority, start date or due date in bulk. Assignee supports searching people and unassigning tickets. Bulk changes are transactional, check every task version and preserve assignment notification preferences.

Tasks have a separate Markdown acceptance criteria field in creation, editing, duplication, REST and MCP. The creation dialog places type, assignee, priority and status in one desktop row and stacks them on phones. Comments support collapsed nested replies, with up to three reply levels. Comment actions no longer appear in task activity, whose columns are Action, Actor and Date.

Navigation reuses cached task and board data while refreshing, and leaving an unsent comment opens a confirmation dialog. Updated table spacing, date clear buttons, priority icons and mobile bulk controls keep the interface consistent. Toasts appear above the selection bar when it is open.

This release adds forward migrations 006–008 for board metadata, comment replies and acceptance criteria. Existing descriptions and comments are preserved. Back up your database before upgrading the matching API and UI images. The optional local fixture command is for development only and does not run during installation or upgrade.

## 1.0.5

This release uses public npm packages for the shared design system and Mintlify documentation tools. API-key and MCP connection tables share their desktop and mobile layouts, display consistent client names and icons, and omit the obsolete All boards permission label. API and UI images both use version 1.0.5.

## 1.0.4

Mill 1.0.4 uses the shared MCP consent form. You choose Read-only, Write or Administrator access, bounded by your current team role. New connections follow your current board access without a separate board selector. Any role change revokes existing connections and pending approvals, requiring re-authentication. API and UI images use the same version. Use the public image references in the release’s `mill-images.json` for installation or upgrades.

## Task attachments

Optional image/PDF attachments use private S3-compatible storage. Files appear below the task description, and a secondary Upload attachment button opens a dialog with a file chooser and drop area. Dropping a file onto the task page opens the dialog and starts uploading. Cards show two files per row below desktop width and four on desktop, with compact preview, download and delete actions. Expanded PDF previews have page controls. Comments and Activity remain tabs.

Members and administrators can upload, preview, download and delete files; viewers can read them. Files are limited to 20 MiB, and completion verifies their stored bytes before exposing them. PostgreSQL retains metadata and a durable cleanup queue; the bucket retains completed files. Enable the storage runtime values after upgrading both images. Without storage configuration, ordinary task management works as before. See [task attachments](task-attachments.md) and [storage configuration](configuration.md#s3-source).

## Task lists

Tasks have no checklist or comment-editing feature. The initial schema contains only the supported v1 model.

Operate → Boards opens an alphabetical card overview with separate Backlog, To Do and In Progress counts for each board. The Create Board button on this page creates a board. Each board has a task list using Backlog, Todo, In Progress, In Review, Done, and Won't Do. Tasks have Task or Bug types, defaulting to Task, and retain stable links, Markdown, assignment, priority, due dates, comments, mentions, and activity. A theme-colored task icon or red bug icon appears before each task ID in the list. Search, combined filters, sorting, and pagination help find work. Search tasks sits above the table. Filters and the separate sort icon beside search open modals, with visible labels and accessible names. The secondary sidebar groups Tasks under Board, General under Settings, and Delete board under Danger zone. General settings opens the Board details widget; Delete board opens a separate deletion widget and confirmation for administrators. The task list has no three-dot menu.

Tasks open on dedicated pages with independently saved fields and inline retry/conflict recovery. UI creation asks for Title, Description and Acceptance criteria, with Type, Assignee, Priority and Status controls; REST/MCP retain the full creation contract. Type appears above Status on the task page and saves independently with Activity history. Existing tasks start with Task type and keep their identifiers and history. Board search, filters, sort, page and page size persist in URL parameters and task return links. Task edits and status changes use versions to reject stale writes. Members can permanently delete tasks; human administrators can permanently delete boards and their work. Deletion requires confirmation and cannot be undone in Mill. There are no archive or restore states.

Kanban, editable statuses, manual board/task ordering, labels, task parents/subtasks, portable export/import, and email task notifications are excluded from v1. Upgrading preserves existing task and subtask records as independent tasks; unknown old custom statuses become Todo. Follow [upgrade guidance](upgrades.md) and make a full backup first.

The task actions menu includes Duplicate task. It opens a modal with a `[Copy] ` title prefix, the original description, type and priority, Backlog status and an empty assignee. The user confirms creation after reviewing the fields. The copy has a fresh identifier and no due date, comments or previous activity.

Task properties include an optional Start date before Due date. Both are calendar dates, save independently with retry/conflict recovery, and can be set or cleared through REST and MCP. Existing tasks begin without a start date; duplicated tasks leave both dates empty.

## People and client connections

First setup creates the administrator once. Teams use roles, invitations, profiles, time zones, sessions, passkeys as the only second factor, and single-use passkey recovery codes. Assignments and mentions produce in-app notifications in the compact header bell. Account and invitation email can be enabled with a configured SMTP server; without it, administrators share private invitation links and operators can use the documented recovery procedure. Task email notifications are outside this release.

Personal and team API keys use explicit Read-only, Edit, or Administrative grants for REST; creation requires Name, Permissions, and Expires after (30 days, 90 days, 1 year, or Never). MCP OAuth creates a human-owned connection with approved `viewer`, `member`, or `admin` scopes and the owner's current board access. Clients do not need a separate identity to connect. There is no Agent directory, management, task assignment or filter in the application, REST or MCP.

Personal keys and OAuth are revocable and enforce current membership and role; team keys are revocable and use their stored team policy. Identity, account security, membership, and credential management remain browser-only. Mutations support retry keys, versions, and bounded rate limits; task activity identifies the responsible person and distinguishes OAuth connections from human actions. Workspace-wide audit history is excluded. Navigation includes Account Settings and Team Settings. Personal keys belong to Account Settings; team keys and member management belong to Team Settings. Create invitation actions sit above member/invitation tables without redundant headings. Shared Avatars use email/name lookup with initials fallback; table lines, role/status Chips, explanatory text, and secondary/danger controls follow Towbar. Remote MCP and Backups widgets are removed; their operator and connection guides remain available.

## Self-hosting and release review

Separate API and UI images run as non-root processes. Compose starts the API and UI from one release version, connected to your existing PostgreSQL database. An optional overlay runs PostgreSQL too. Set the database URL, application secret, public UI origin, and public API origin for the basic setup. Installations need Docker Compose and downloaded configuration files. Both services expose separate host ports; browsers call the API directly with credentialed requests, while OAuth discovery and MCP live on the API origin. Mill applies checksummed migrations at startup. Full PostgreSQL backup and restore preserve work, account state, notifications, and credentials; there is no portable-work export/import feature.

The pre-launch migration sequence has been consolidated into `001_initial.sql` for fresh installations. Startup verifies its checksum and rejects databases using the retired sequence. Those private development installations must be converted using the maintainer procedure, preserving a recoverable copy of the original schema. The release is not an automatic upgrade from the earlier private candidates. Read [upgrades](upgrades.md) before changing an existing installation.

The source CI gate runs documentation checks, formatting, lint, types, operations tests, real PostgreSQL tests, dependency audit, and build. The production CI gate exercises a disposable container installation, migration checks, persistent data, backup and restore, proxy behavior, and image security. Desktop and mobile routes in both themes still require manual review; there is no automated browser CI gate. Pre-launch conversion is verified separately against a recoverable source snapshot.

The release workflow requires a stable tag on current `main`, passing exact-commit CI, and a public repository. It publishes native AMD64 and ARM64 images to `ghcr.io/avgeek-oss/mill-api` and `ghcr.io/avgeek-oss/mill-web`, checks their indexes, aliases, labels, and anonymous access, then installs the paired immutable digests on both architectures. Only after both installation gates pass does it publish the GitHub release with `mill-images.json`. Use matching version tags with the image-only Compose file, or pin its `images.api` and `images.web` references; release publication does not deploy Mill to a server. A separate workflow can prepare source and image archives with `source-manifest.json`, `release-manifest.json`, and `SHA256SUMS` for review. Those archives are not the public installation path.

Physical passkeys and the operator's chosen HTTPS proxy need checks in that environment. Local virtual-authenticator and loopback proof must remain labeled accordingly. See the [release verification checklist](publishing-checklist.md) for the remaining evidence before publication.
