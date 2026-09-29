# Mill B1 architecture and interfaces

Mill runs one Hono HTTP service serving the built React application and REST/MCP, with PostgreSQL as its only required backing service. Node 24 and pnpm 11.5.3 are pinned. Dependencies are public. The self-contained design system adapts Apache-licensed Towbar primitives and uses OSS HeroUI and public fonts/icons. No hosted agent runtime, queue service, private package, or LLM key is needed.

## Current product model

The September 29 v1 model is a task list with alphabetical boards and fixed task statuses: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `wont_do`. Tasks retain identifiers, Markdown, human assignee, optional Agent attribution, priority, calendar due date, checklist, comments, and human/agent activity. There are no Kanban lanes, status resources, manual positions, labels, or parent/subtask relationships. Archive/restore, a separate Inbox, workspace-wide audit history, portable export/import, and email task delivery are excluded.

People are accounts with membership roles; Agents are separate identities created through the human UI. A personal Agent is available only to its creator. Administrators manage team Agents and assign access to explicit active people; Admin status alone does not grant use. The Agent contract contains `id`, `name`, `scope`, `creatorId`, `memberIds`, `version`, `createdAt`, and `updatedAt`. Agents are attribution and permission records, not an execution runtime.

Personal API keys and OAuth bind an eligible existing Agent. OAuth consent must select one and cannot proceed with an empty eligible list. It never creates an Agent automatically. A task's nullable `agentId` and derived `agentName` are independent of `assigneeId`. Non-null Agent attribution requires an active human assignee with access. Setting/changing the binding checks both actor and assignee access; unrelated task edits preserve an existing valid binding without requiring the actor to gain Agent access. No task assignment launches jobs or external calls.

Shared contracts live in `packages/contracts/src/index.ts`. Database access uses `sql` from `packages/database/src/index.ts`, with snake_case rows transformed to camelCase. Applied migration files are immutable; changes require a new reviewed migration.

## HTTP boundaries

Routes return JSON. API errors use `{error}` with meaningful status codes; some errors include a stable `code`. `/api` resolves a human session or agent credential into `Actor` and enforces mutation Origin, role, scope, and board access. Authenticated non-auth mutations run in one database transaction, revalidate current membership/session/credential authority, and retain versions for conflict detection. Retry keys reserve method/path/query/body identity and encrypted response content atomically. Health endpoints separately check liveness and bounded database readiness.

Identity exports `authRoutes` under `/api/auth` and `sessionActor(request)`. It owns setup, passwords, sessions, passkeys, authenticator/recovery, membership/invitations, and profile preferences. Accounts use Admin/Member/Viewer roles; preferences contain only in-app assignments and mentions. The current account/invitation provider is unavailable, so invitations use privately shared links and recovery uses the operator command.

Domain exports `domainRoutes` under `/api`: board CRUD; task list/create/detail/PATCH/DELETE; comments; task activity; in-app notifications; workspace settings. Board detail is `{board}`. Task detail is `{task,comments,activity,commentsPage,activityPage}` with bounded optional previews. PATCH task uses `status` and current `version`; no separate move endpoint remains. Permanent board deletion needs a human Admin; task deletion needs Member authority. See [REST API](api.md) for exact fields and bounds.

Agent routes support eligible reads and human-only management. `GET /api/agents` returns eligible Agents; `manage=true` requires a human Member or Admin and supports the management view. Personal changes require the creator; team changes require a human Admin. External clients have no Agent creation/management tools. Navigation separates People, Agents at `/settings/agents`, personal API keys at `/settings/api-keys`, and Team settings at the retained `/settings/workspace` route.

External exports credential and OAuth routes plus `/mcp`. REST uses revocable hashed keys bound to an existing Agent; OAuth tokens are restricted to MCP and retain that selected binding. OAuth retains HTTPS/PKCE/resource binding and protected client metadata fetch. Agent writes delegate to the same running domain handlers and cannot administer identity/workspace security. Permissions depend on the owner's current role, current selected-Agent access, credential scopes, and optional approved boards. Credential names label a particular key/connection; they do not create Agent identities.

## Persistence and concurrency

Identity owns the singleton workspace, members, and security tables. Domain owns boards, fixed-status tasks, comments, task activity, and notifications. Agents and explicit team access grants have their own tables. Task writes lock the owning board and check the expected row version, preserving numbering and preventing silent lost updates. Board metadata and Agent access changes serialize through the workspace. Current authority is locked/rechecked so a grant removal, account disablement or credential revocation cannot leave a waiting write with stale access.

Boards and Agents page by case-insensitive name, exact name, and UUID; their accessible-list revisions invalidate old cursors after a change. Tasks use filter-bound, revision-protected deterministic keysets with UUID tie breakers and a default newest-created sort. A changed task-list revision returns `409` with `code:"task_list_changed"`; clients restart the same filtered list rather than mixing pages.

Permanent deletion cascades the deleted work's comments, notifications, and activity. A task has no descendants after the list migration. Deleting a board also removes scoped credential/OAuth references and revokes credentials whose explicit approved board set becomes empty. Retry records referencing deleted content retain terminal identities but remove response content; delete acknowledgments remain replayable.

## Forward migration and backups

Migration 005 activated archived work and purged previously soft-deleted work. Migration 006 removed workspace-wide audit storage while retaining existing task activity. [Migration 007](../packages/database/migrations/007_fixed_task_statuses.sql) replaces column references with fixed statuses, removes manual positions/labels/parent links, and turns former subtasks into independent tasks. It preserves task IDs, identifiers, content, assignments, checklists, comments, actor records, and existing activity details. Historical activity fields remain byte-for-byte even when they describe the earlier model. Recognized status names map to fixed values; unknown names become `todo`.

Migration 007 removes obsolete email notification preferences and invalidates completed old retry content without freeing its identities for re-execution. It does not add a legacy portable importer.

[Migration 008](../packages/database/migrations/008_agents.sql) adds explicit Agents/access grants, task bindings and credential/OAuth Agent references. Preexisting credentials without a binding are revoked; pending earlier OAuth grants expire, and completed earlier retry content becomes terminal without freeing its request identity. No Agent is invented for a legacy credential. Tasks, history and human sessions remain. Operational PostgreSQL backups preserve complete installation state, including Agents and access grants, and require the original encryption secret. See [upgrades](upgrades.md) and [backup/recovery](backup.md). Fresh permission, migration and restore evidence remains a gate in [B1 verification](b1-verification.md); receipts through `7fc132` are historical for this revision.
