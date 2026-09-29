# Mill B1 architecture and interfaces

Mill runs one Hono HTTP service serving the built React application and REST/MCP, with PostgreSQL as its only required backing service. Node 24 and pnpm 11.5.3 are pinned. Dependencies are public. The self-contained design system adapts Apache-licensed Towbar primitives and uses OSS HeroUI and public fonts/icons. No hosted agent runtime, queue service, private package, or LLM key is needed.

## Current product model

The September 29 v1 model is a task list with alphabetical boards and fixed task statuses: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `wont_do`. Tasks retain identifiers, Markdown, assignee, priority, calendar due date, checklist, comments, and human/agent activity. There are no Kanban lanes, status resources, manual positions, labels, or parent/subtask relationships. Archive/restore, a separate Inbox, workspace-wide audit history, portable export/import, and email task delivery are excluded.

Shared contracts live in `packages/contracts/src/index.ts`. Database access uses `sql` from `packages/database/src/index.ts`, with snake_case rows transformed to camelCase. Applied migration files are immutable; changes require a new reviewed migration.

## HTTP boundaries

Routes return JSON. API errors use `{error}` with meaningful status codes; some errors include a stable `code`. `/api` resolves a human session or agent credential into `Actor` and enforces mutation Origin, role, scope, and board access. Authenticated non-auth mutations run in one database transaction, revalidate current membership/session/credential authority, and retain versions for conflict detection. Retry keys reserve method/path/query/body identity and encrypted response content atomically. Health endpoints separately check liveness and bounded database readiness.

Identity exports `authRoutes` under `/api/auth` and `sessionActor(request)`. It owns setup, passwords, sessions, passkeys, authenticator/recovery, membership/invitations, and profile preferences. Accounts use Admin/Member/Viewer roles; preferences contain only in-app assignments and mentions. The current account/invitation provider is unavailable, so invitations use privately shared links and recovery uses the operator command.

Domain exports `domainRoutes` under `/api`: board CRUD; task list/create/detail/PATCH/DELETE; comments; task activity; in-app notifications; workspace settings. Board detail is `{board}`. Task detail is `{task,comments,activity,commentsPage,activityPage}` with bounded optional previews. PATCH task uses `status` and current `version`; no separate move endpoint remains. Permanent board deletion needs a human Admin; task deletion needs Member authority. See [REST API](api.md) for exact fields and bounds.

External exports credential and OAuth routes plus `/mcp`. REST uses revocable hashed credentials; OAuth tokens are restricted to MCP. OAuth retains HTTPS/PKCE/resource binding and protected client metadata fetch. Agent writes delegate to the same running domain handlers and cannot administer identity/workspace security. Permissions depend on the owner's current role and optional approved boards.

## Persistence and concurrency

Identity owns the singleton workspace, members, and security tables. Domain owns boards, fixed-status tasks, comments, task activity, and notifications. Task writes lock the owning board and check the expected row version, preserving numbering and preventing silent lost updates. Board metadata changes serialize through the workspace. Boards page by case-insensitive name, exact name, and UUID; the accessible-list revision invalidates old cursors after a change. Tasks use filter-bound, revision-protected deterministic keysets with UUID tie breakers and a default newest-created sort. A changed task-list revision returns `409` with `code:"task_list_changed"`; clients restart the same filtered list rather than mixing pages.

Permanent deletion cascades the deleted work's comments, notifications, and activity. A task has no descendants after the list migration. Deleting a board also removes scoped credential/OAuth references and revokes credentials whose explicit approved board set becomes empty. Retry records referencing deleted content retain terminal identities but remove response content; delete acknowledgments remain replayable.

## Forward migration and backups

Migration 005 activated archived work and purged previously soft-deleted work. Migration 006 removed workspace-wide audit storage while retaining existing task activity. [Migration 007](../packages/database/migrations/007_fixed_task_statuses.sql) replaces column references with fixed statuses, removes manual positions/labels/parent links, and turns former subtasks into independent tasks. It preserves task IDs, identifiers, content, assignments, checklists, comments, actor records, and existing activity details. Historical activity fields remain byte-for-byte even when they describe the earlier model. Recognized status names map to fixed values; unknown names become `todo`.

Migration 007 removes obsolete email notification preferences and invalidates completed old retry content without freeing its identities for re-execution. It does not add a legacy portable importer. Operational PostgreSQL backups preserve complete installation state and require the original encryption secret. See [upgrades](upgrades.md) and [backup/recovery](backup.md). Fresh upgrade/restore evidence for the reduced model remains a release gate, separately from historical receipts.
