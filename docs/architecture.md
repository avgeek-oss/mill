# Mill v1 architecture and interfaces

Mill runs one Hono HTTP service serving the built React application and REST/MCP, with PostgreSQL as its only required backing service. Node 24 and pnpm 11.5.3 are pinned. Dependencies are public. The self-contained design system adapts Apache-licensed Towbar primitives and uses OSS HeroUI and public fonts/icons. No hosted runtime, queue service, private package, or LLM key is needed.

## Current product model

The current v1 model is a task list with alphabetical boards and fixed task statuses: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `wont_do`. Tasks retain identifiers, Markdown, an optional assignee, priority, calendar due date, comments, and activity. There are no Agents, checklists, Kanban lanes, status resources, manual positions, labels, or parent/subtask relationships. Archive/restore, a separate Inbox, workspace-wide audit history, portable export/import, and email task delivery are excluded.

People are accounts with membership roles. Personal and team API keys accept required Name, Permissions (Read-only, Edit, or Administrative permissions), and Expires after (30 days, 90 days, 1 year, or Never). Personal keys use their stored grant within the owner's current active role, while team keys use stored team policy independently of the creator's later membership. MCP OAuth connections belong to the person approving consent and add granted scopes and optional approved boards to that person's current role. An explicitly empty restricted set grants no board access. Task assignment records responsibility and does not launch jobs or external calls.

Shared contracts live in `packages/contracts/src/index.ts`. Database access uses `sql` from `packages/database/src/index.ts`, with snake_case rows transformed to camelCase. Applied migrations are immutable. `002_key_policies.sql` advances the reviewed `001_initial.sql` baseline without rewriting existing data.

## HTTP boundaries

Routes return JSON. API errors use `{error: {code, message, requestId}}` with meaningful status codes; OAuth endpoints retain their protocol error shape. `/api` resolves a browser session or API key into `Actor`; the MCP dispatcher resolves an API key or human-owned OAuth connection. Browser mutations enforce Origin, and all domain actions enforce current role and board access. API keys enforce stored grants; OAuth additionally enforces requested scopes and approved boards. Authenticated non-auth mutations run in one database transaction, revalidate current membership/session/credential authority, and retain versions for conflict detection. Retry keys reserve method/path/query/body identity and encrypted response content atomically. Health endpoints separately check liveness and bounded database readiness.

Identity exports `authRoutes` under `/api/auth` and `sessionActor(request)`. It owns setup, passwords, sessions, passkeys and their single-use recovery codes, membership/invitations, and profile preferences. Accounts use Admin/Member/Viewer roles; preferences contain only in-app assignments and mentions. The current account/invitation provider is unavailable, so invitations use privately shared links and recovery uses the operator command.

Domain exports `domainRoutes` under `/api`: board CRUD; task list/create/detail/PATCH/DELETE; comments; task activity; in-app notifications; workspace settings. Board detail is `{board}`. Task detail is `{task,comments,activity,commentsPage,activityPage}` with bounded optional previews. PATCH task uses `status` and current `version`; no separate move endpoint remains. Permanent board deletion needs Admin authority; task deletion needs Member authority. See [REST API](api.md) for exact fields and bounds.

Navigation separates personal keys at `/settings/api-keys` and Admin-managed team keys at `/team-settings/team-api-keys`. There is no Agent directory, management route, task binding or MCP tool.

External exports credential and OAuth routes plus `/mcp`. REST and MCP accept revocable hashed personal and team keys; OAuth tokens are restricted to MCP. OAuth retains HTTPS/PKCE/resource binding and protected client metadata fetch. Client writes delegate to the same running domain handlers and cannot administer identity/workspace security. Personal-key permissions are bounded by their stored grant and owner's active membership and current role; demotion permanently narrows that grant. Team-key permissions use their stored team grant. OAuth also checks granted scopes and optional approved boards. All credential management and human security/administration require a browser session. Credential names label a particular key or connection.

## Persistence and concurrency

Identity owns the singleton workspace, members, and security tables. Domain owns boards, fixed-status tasks, comments, task activity, and notifications. Task writes lock the owning board and check the expected row version, preserving numbering and preventing silent lost updates. Board metadata and current authority changes serialize through the workspace. Authority is locked and rechecked so account disablement, role changes or credential revocation cannot leave a waiting write with stale access.

Boards page by case-insensitive name, exact name, and UUID; their accessible-list revisions invalidate old cursors after a change. The active member directory also returns revision-bound continuation beyond 1,000 people; changed membership data returns `409 member_list_changed`. Tasks use filter-bound, revision-protected deterministic keysets with UUID tie breakers and a default newest-created sort. A changed task-list revision returns `409` with `code:"task_list_changed"`; clients restart the same filtered list rather than mixing pages.

Permanent deletion cascades the deleted work's comments, notifications, and activity. Deleting a board also removes scoped OAuth references and revokes connections whose explicit approved board set becomes empty. Retry records referencing deleted content retain terminal identities but remove response content; delete acknowledgments remain replayable. Activity identifies the responsible person or team key and distinguishes browser, API-key, and OAuth actions.

## Initial schema and backups

[The initial migration](../packages/database/migrations/001_initial.sql) creates the supported v1 schema directly. It contains no Agent tables or fields, Kanban columns, checklist storage or historical upgrade transformations. Startup serializes migration application with an advisory lock and verifies stored checksums before serving requests. The forward key-policy migration preserves legacy grants without broadening them. An incompatible pre-launch ledger is rejected without changing its data.

Operational PostgreSQL backups preserve the complete installation and require the original encryption secret. See [upgrades](upgrades.md) and [backup/recovery](backup.md).
