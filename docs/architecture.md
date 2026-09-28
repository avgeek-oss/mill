# Mill B1 architecture and interfaces

Mill runs one Hono HTTP service serving a built React application and REST/MCP, with PostgreSQL as the only required backing service. Node 24 and pnpm 11.5.3 are pinned. All dependencies are public. The local design system adapts Apache-licensed Towbar primitives and uses OSS HeroUI and Inter. No hosted agent execution, private package, queue service, or LLM key is required.

## Implementation ownership

- Coordinator: root workspace tooling, database connection/migrations, HTTP integration, verification matrix, end-to-end integration, commits and PR.
- Identity: `apps/api/src/auth.ts`, `apps/api/src/auth/**`, migration `001_identity.sql`, `tests/auth*.test.ts`, identity API documentation.
- Boards: `apps/api/src/domain.ts`, `apps/api/src/domain/**`, migration `002_boards.sql`, `tests/domain*.test.ts`, domain API documentation.
- Agents: `apps/api/src/external.ts`, `apps/api/src/external/**`, migration `003_external.sql`, `tests/external*.test.ts`, API/MCP documentation.
- Web: `apps/web/**`, `packages/web-design-system/**`, browser journeys in `tests/browser/**`.
- Operations: Docker/Compose, operational scripts, CI, release/community documentation (excluding architecture and verification).

Do not edit another owner's files without coordinating. Use `sql` from `packages/database/src/index.ts`; postgres camel transform maps returned snake_case fields to camelCase. Migration files are immutable once verification begins. Root shared contracts are `packages/contracts/src/index.ts`. `apps/api/src/http.ts` exports `Env`, `actor(c)`, `requireRole(c,min,boardId)`, `badRequest`, and `conflict`.

## HTTP contract

All API routes return JSON, mutation errors `{error: string}` with meaningful 400/401/403/404/409/429 codes. API routes are rooted at `/api`. Root middleware resolves `sessionActor(request)` from identity and `credentialActor(request)` from external credentials, enforces trusted browser mutation Origin, and puts `Actor` in Hono context. All endpoints enforce roles and agent read/write scopes; mutations must not bypass these. Authenticated non-auth mutations share one database transaction and recheck current membership/session/credential authority before committing. Retry-sensitive mutations also reserve an idempotency key bound to method, path, query, and body, with encrypted persisted responses in the same transaction. `/health/live` tests the running process; `/health/ready` returns a bounded 503 if PostgreSQL is unavailable.

Identity exports `authRoutes: Hono<Env>` mounted at `/api/auth` and `sessionActor(request): Promise<Actor|null>`. It handles GET `/status`, POST `/setup` `{workspaceName,name,email,password}`, POST `/login`, POST `/logout`, GET `/me`, PATCH `/profile`, GET/DELETE `/sessions`, passkeys, TOTP and recovery. Team routes live in this router: GET `/members`, POST `/invitations` `{email,role}`, GET `/invitations`, POST `/accept-invitation`, PATCH/DELETE `/members/:id`. Member IDs equal user IDs. Authenticated `/me` returns `{user,workspace}`; user includes role, notification preferences, timeZone, MFA/passkey state.

Domain exports `domainRoutes: Hono<Env>` mounted at `/api`. GET/POST `/boards`; GET/PATCH `/boards/:id`; POST `/boards/:id/restore`; GET/POST `/boards/:id/columns`; PATCH/DELETE `/columns/:id`; GET/POST `/boards/:id/tasks`; GET/PATCH/DELETE `/tasks/:id`; POST `/tasks/:id/move` `{columnId,beforeId?,version}`; POST `/tasks/:id/restore`; GET/POST `/tasks/:id/comments`; PATCH/DELETE `/comments/:id`; GET `/tasks/:id/activity`; GET/PATCH `/notifications`; GET `/audit`; GET/PATCH `/workspace`; GET `/export`; POST `/import`. Collections use `{items,...}`; GET board detail returns `{board,columns}`; task detail `{task,comments,activity}`. Creating returns `{board}`/`{column}`/`{task}`/`{comment}`. Mutations requiring concurrency include expected `version`. DELETE tasks soft-deletes; PATCH archived restores archives. Board task search supports q,columnId,assigneeId,priority,label,archived,deleted,sort,limit,cursor with bounded max 100. Default statuses: Backlog, In progress, Done. Workspace is singleton.

External exports `externalRoutes: Hono<Env>` mounted at `/` and `credentialActor(request): Promise<Actor|null>`. Credentials GET/POST `/api/credentials`, DELETE `/api/credentials/:id`; OAuth discovery and authorization/token/consent/revocation endpoints; `/mcp` streamable HTTP. Scope names `read` and `write`; board restrictions optional. Delegate mutations through the running domain router or shared service to preserve invariants. OAuth requires HTTPS except explicit loopback dev. Agent identity remains tied to current member permissions.

## Data and correctness

Identity owns singleton `workspace` (id UUID, name text, created_at), `users` (id UUID, name,email,role,time_zone,...), sessions and identity tables. Domain references users and workspace, stores ordered boards/statuses/tasks with row versions, transactional rank normalization under board lock, notification and append-only activity/audit records. External owns credentials, OAuth clients and grants. Export/import excludes passwords, sessions, authenticators and credentials; restores board/task/comment/member metadata while preserving the operator's administrator access. Operational backups restore full PostgreSQL state. No file uploads are included in B1; task Markdown links are supported with safe protocols.
