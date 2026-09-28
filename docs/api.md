# REST API

Mill serves JSON REST endpoints under `/api`, MCP at `/mcp`, and OAuth discovery and grant endpoints on the same origin. Use the public URL configured in `MILL_BASE_URL`. The API and MCP handlers enforce the same roles, scopes, board restrictions, validation, ordering, and row versions.

For a first agent connection, start with [Connect an agent](agents.md). Human authentication and security routes are documented in [authentication](authentication.md).

## Authentication and limits

Browser requests use the `mill_session` cookie. Browser mutations need an `Origin` matching Mill's public origin. API clients use `Authorization: Bearer mill_…` with a scoped credential. OAuth tokens apply only to `/mcp`; they cannot authorize public REST calls.

Authenticated requests are limited to 240 per minute per person or credential. Anonymous requests are limited to 120 per minute per client address. A call through MCP also dispatches through the REST handlers and uses their limit. `429` responses include `Retry-After: 60`. The server bounds ordinary request bodies to 2 MiB, portable imports to 32 MiB, credential/OAuth bodies to 16 KiB, and MCP requests and tool responses to 1 MiB.

Use `Idempotency-Key` for POST, PATCH, and DELETE requests under `/api` outside human authentication. A key is 8 to 128 letters, digits, or `. _ : -`, without spaces. Mill binds it to the authenticated person or credential, method, path/query, and exact JSON bytes for 24 hours. Retrying the same request returns the saved status/body and `Idempotency-Replayed: true`. Reusing the key for a different request returns `409`. Saved responses are encrypted, including one-time credential tokens. Permanent deletion clears the saved response content for mutations that reference the removed work but retains their retry keys. Exact retries return `410` with `code: "retry_invalidated"` and cannot recreate deleted work. The delete response itself remains retryable. Upgrading from the older archive model also retains completed retry keys with a terminal `410` response because those responses lack resource metadata. Authentication routes have their own one-time challenge/token behavior.

## Response and error shapes

Collections return `{ "items": [...] }`. Paginated collections also return `hasMore` and `nextCursor`; send that cursor with the same filters on the next request. Task, comment, and notification lists default to 50 and accept `limit=1..100`. Boards default to 100 and accept `limit=1..100`, retaining position/ID order and the chosen collection and credential board scope. Credentials default to 200 and accept `limit=1..200`; invitations default to 100 and accept `limit=1..100`. Board cursors are opaque strings bound to the current user, selected collection, allowed boards, and board order. A changed board collection returns `409` with `code: "board_list_changed"`; discard its loaded pages and restart without a cursor. Credential and invitation UUID cursors must belong to the same credential owner or administrator's workspace respectively. Invalid or foreign anchors return 400. Statuses are bounded to 50 per board, and the team directory returns at most 1,000 members without continuation metadata.

For a coherent board directory, use `directory=true` and continue one cursor sequence. The directory contains every existing accessible board. Metadata, creation, deletion, or order changes return `409` and require restarting the whole directory. Archive and deleted-state query parameters return `400`.

Board and task deletes return `{ "ok": true }`. Other single-object mutations return `{ "board": ... }`, `{ "column": ... }`, `{ "task": ... }`, or `{ "comment": ... }`. Object fields use camelCase. Task IDs are UUIDs. The `identifier` field, such as `OPS-17`, is a stable label for a person; use the UUID in API paths.

REST failures return `{ "error": "Description of the problem" }`.

| Status | Meaning                                                     | Client action                               |
| ------ | ----------------------------------------------------------- | ------------------------------------------- |
| `400`  | Invalid input or an invalid pagination cursor               | Correct the input                           |
| `401`  | Missing or invalid authentication                           | Sign in or reconnect the agent              |
| `403`  | Role, scope, board, or Origin does not allow access         | Ask an administrator to review access       |
| `404`  | Object or route does not exist                              | Check its ID or link                        |
| `409`  | Stale row version, conflicting order, or retry-key mismatch | Fetch current state before changing it      |
| `410`  | Retry content was invalidated by deletion or upgrade        | Reload before starting a new change         |
| `413`  | Body or export exceeds its size limit                       | Send less data or use a database backup     |
| `429`  | Request limit reached                                       | Wait for `Retry-After`                      |
| `500`  | Server could not complete the request                       | Retry once, then inspect server health/logs |

## Permissions

Viewers read boards, tasks, comments, and activity. Members also create and change work. Admins manage membership, workspace settings, audit, export/import, and permanent board deletion. Every account has access to the workspace's boards. A credential can narrow this to an explicit board list and read or read/write scope.

Agents can perform board and task workflows within that ceiling. Administration requires a human administrator session even when the credential owner is an Admin. Credential and consent management require a human session. Board-scoped credentials cannot read the team directory or workspace settings; notifications are restricted to the owner's allowed boards.

## Boards and statuses

| Method and path                | Request                                  | Response                                    |
| ------------------------------ | ---------------------------------------- | ------------------------------------------- |
| `GET /api/boards`              | Optional `directory`, `limit`, `cursor`  | `{items,hasMore,nextCursor}` in board order |
| `POST /api/boards`             | `{name,prefix?,description?}`            | `{board}` and default statuses              |
| `GET /api/boards/:id`          | Board UUID                               | `{board,columns}`                           |
| `PATCH /api/boards/:id`        | `{version,name?,description?,beforeId?}` | `{board}`                                   |
| `DELETE /api/boards/:id`       | `{version}`; human Admin                 | `{ok:true}`                                 |
| `GET /api/boards/:id/columns`  | Board UUID                               | `{items}` in status order                   |
| `POST /api/boards/:id/columns` | `{name,color?}`                          | `{column}`                                  |
| `PATCH /api/columns/:id`       | `{version,name?,color?,beforeId?}`       | `{column}`                                  |
| `DELETE /api/columns/:id`      | `{version,moveToColumnId?}`              | `{ok:true}`                                 |

Board names are at most 100 characters; status names are at most 80. A custom prefix must match `^[A-Z][A-Z0-9]{1,9}$`. Prefixes stay fixed after creation. Allowed status colors are `gray`, `blue`, `green`, `yellow`, `orange`, `red`, `purple`, and `pink`.

For ordering, `beforeId` inserts before the named item. Explicit `null` moves to the end. Board/status changes carry the current `version`. Mill locks and normalizes the order transactionally; a concurrent edit returns a conflict instead of silently replacing it. Deleting a status that contains tasks requires another status in the same board. Keep at least one status.

Deleting a board requires a human Admin and its current version. It permanently removes its statuses, tasks, descendant subtasks, comments, notifications, and work activity. Scoped credentials lose the board reference and are revoked when no allowed boards remain; pending OAuth grants are narrowed or removed. The audit retains only deletion attribution and the removed UUID. There is no archive, trash, or restore endpoint.

## Tasks

| Method and path               | Request                             | Response                                                                          |
| ----------------------------- | ----------------------------------- | --------------------------------------------------------------------------------- |
| `GET /api/boards/:id/tasks`   | Search/filter/sort/pagination query | `{items,hasMore,nextCursor}`                                                      |
| `POST /api/boards/:id/tasks`  | `{title,columnId?,...task fields}`  | `{task}`                                                                          |
| `GET /api/tasks/:id`          | Task UUID; optional preview limits  | `{task,comments,activity,subtasks,parent,commentsPage,activityPage,subtasksPage}` |
| `GET /api/tasks/:id/subtasks` | `limit`, `cursor`                   | Compact child `{items,hasMore,nextCursor}`                                        |
| `PATCH /api/tasks/:id`        | `{version,...changed task fields}`  | `{task}`                                                                          |
| `POST /api/tasks/:id/move`    | `{version,columnId,beforeId?}`      | `{task}`                                                                          |
| `DELETE /api/tasks/:id`       | `{version}`                         | `{ok:true}`                                                                       |

Task detail keeps the complete requested task and returns compact metadata for its parent/subtasks. Child descriptions and checklists are read through the child's own task endpoint. Set `commentLimit`, `activityLimit`, and `subtaskLimit` to 0–100 to choose each preview size; REST defaults to 100. Each preview has a corresponding `{hasMore,nextCursor}` page field. A zero-sized preview has a `null` cursor; start the matching paged endpoint without a cursor to read it. The comments, activity, and subtasks endpoints support continued pagination.

Task fields:

| Field         | Accepted value                                                                    |
| ------------- | --------------------------------------------------------------------------------- |
| `title`       | Nonempty text, at most 300 characters                                             |
| `description` | Markdown text, at most 100,000 characters                                         |
| `assigneeId`  | Active member UUID or `null`                                                      |
| `priority`    | `none`, `low`, `medium`, `high`, `urgent`                                         |
| `labels`      | At most 20 labels, each 1 to 40 characters                                        |
| `dueDate`     | `YYYY-MM-DD` or `null`                                                            |
| `checklist`   | At most 100 `{id,text,done}` entries with unique IDs; text at most 500 characters |
| `parentId`    | Parent task UUID in the same board, or `null`; cycles are rejected                |

The status can be chosen at creation. Use the move endpoint for later status/order changes, or include `columnId` and optional `beforeId` in a task PATCH to change its status and other fields together. A task mutation increments `version`. Moving also updates ranks and affected row versions, so read the current task before another edit. Delete permanently removes the task, all descendant subtasks, comments, notifications, and task activity. It requires Member access and the current version. The audit retains deletion attribution and the removed UUID without task content. Repeating a delete without its retry key returns `404`. Task numbers are never reused within an existing board.

Task list query parameters can be combined:

| Parameter         | Value                                                                          |
| ----------------- | ------------------------------------------------------------------------------ |
| `q`               | Search in title, description, and identifier; at most 300 characters           |
| `columnId`        | Status UUID                                                                    |
| `assigneeId`      | Member UUID or `unassigned`                                                    |
| `priority`        | One priority value                                                             |
| `label`           | One label                                                                      |
| `sort`            | `position` (default), `title`, `dueDate`, `priority`, `updatedAt`, `createdAt` |
| `limit`, `cursor` | Maximum 100 and a cursor from the same filter/sort context                     |

Example edit:

```sh
curl --fail-with-body "$MILL_URL/api/tasks/TASK_UUID" \
  -X PATCH \
  -H "Authorization: Bearer $MILL_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: release-task-edit-001' \
  --data '{"version":3,"priority":"urgent","checklist":[{"id":"review","text":"Review the release notes","done":true}]}'
```

## Comments, mentions, and activity

| Method and path                | Request                      | Response                     |
| ------------------------------ | ---------------------------- | ---------------------------- |
| `GET /api/tasks/:id/comments`  | `limit`, `cursor`            | `{items,hasMore,nextCursor}` |
| `POST /api/tasks/:id/comments` | `{body,mentionIds?}`         | `{comment}`                  |
| `PATCH /api/comments/:id`      | `{version,body,mentionIds?}` | `{comment}`                  |
| `DELETE /api/comments/:id`     | `{version}`                  | `{ok:true}`                  |
| `GET /api/tasks/:id/activity`  | `limit`, `cursor`            | `{items,hasMore,nextCursor}` |

Comment bodies are nonempty Markdown with at most 10,000 characters. Mention a member with `@their-email`, a `user:UUID` mention link, or `mentionIds` containing active member UUIDs. Assignment/mention notifications respect the recipient's preferences. Only the author or a human Admin can edit/delete a comment, within the credential's allowed boards. An agent can change its owner's comments but cannot moderate other people's comments. Activity records `actorId`, `actorName`, and `actorKind` (`human` or `agent`).

## Notifications and settings

| Method and path            | Request                                   | Response                                            |
| -------------------------- | ----------------------------------------- | --------------------------------------------------- |
| `GET /api/notifications`   | Optional `unread=true`, `limit`, `cursor` | `{items,unreadCount,hasMore,nextCursor}`            |
| `PATCH /api/notifications` | `{ids,read?}` or `{all:true,read?}`       | `{ok:true,updated}`                                 |
| `GET /api/workspace`       | Human member session                      | `{workspace}`                                       |
| `PATCH /api/workspace`     | Human Admin; `{name}`                     | `{workspace}`                                       |
| `GET /api/audit`           | Human Admin; `limit`, `cursor`            | Combined work/security `{items,hasMore,nextCursor}` |

Notification changes default to `read:true`. `read:false` marks them unread. An agent's notification list and updates stay within its board scope and its owner's account. Use `PATCH /api/auth/profile` with `notificationPreferences:{assignments,mentions}` to change preferences from a human session.

## Credentials

| Method and path               | Request                                                 | Response                                                    |
| ----------------------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| `GET /api/credentials`        | Human session; optional `limit`, `cursor`               | `{items,hasMore,nextCursor}` with metadata, no token hashes |
| `POST /api/credentials`       | Human session; `{name,scopes,boardIds?,expiresInDays?}` | `{credential,token}` once                                   |
| `DELETE /api/credentials/:id` | Owner's human session                                   | `{revoked:true}`                                            |

Scopes are `["read"]` or `["read","write"]`. Omit `boardIds` for workspace board access, or supply 1 to 100 existing board UUIDs. Expiry defaults to 30 days and accepts 1 to 365. A credential remains tied to its owner's current role and active membership. It cannot create other credentials.

## Portable data and health

`GET /api/export` returns a `mill-portable` version 2 JSON document with workspace, member metadata, boards, statuses, tasks, and comments. Boards include `nextNumber` to preserve task numbering even after deletion. Archive and deletion-state fields are absent. It requires a human Admin, excludes all authentication secrets and credentials, and has a 32 MiB response limit. Each document supports at most 100 boards; exporting a larger workspace returns `413` with backup guidance. This document limit does not impose a workspace-wide board quota. `POST /api/import` accepts version 2 and legacy version 1 documents. Version 1 imports treat archived records as ordinary work and skip deleted boards, deleted tasks, their descendants, and associated comments. Deleted work is never recreated. Imports have the same 32 MiB limit and add boards, tasks, and comments without replacing existing data. Imported member metadata does not grant login access or change existing members' roles. New imported people start disabled and need an administrator invitation to join. The operator retains administrator access. For a larger workspace or full identity/history recovery, use [PostgreSQL backup and restore](backup.md).

`GET /health/live` reports service liveness. `GET /health/ready` checks PostgreSQL and returns the application version. Neither needs a session. The response contains no credentials or personal data.

## OAuth and MCP

| Method and path                                 | Purpose                                                      |
| ----------------------------------------------- | ------------------------------------------------------------ |
| `GET /.well-known/oauth-authorization-server`   | Issuer, endpoints, PKCE, client auth, and supported scopes   |
| `GET /.well-known/oauth-protected-resource/mcp` | MCP resource and authorization server                        |
| `POST /oauth/register`                          | Public dynamic client registration with JSON client metadata |
| `GET /oauth/authorize`                          | Code authorization request; redirects to human consent       |
| `GET /api/oauth/consent/:id`                    | Human session reads requesting client and access             |
| `POST /api/oauth/consent/:id`                   | Human session; `{allow,boardIds?}`; returns `{redirectTo}`   |
| `POST /oauth/token`                             | Form-encoded authorization-code exchange                     |
| `POST /oauth/revoke`                            | Form-encoded RFC 7009 token revocation                       |
| `POST /mcp`                                     | MCP Streamable HTTP JSON-RPC                                 |

The base protected-resource discovery path is also supported. Registration accepts `client_name`, `redirect_uris`, `token_endpoint_auth_method` (`none`, `client_secret_basic`, `client_secret_post`), `grant_types:["authorization_code"]`, and `response_types:["code"]`. Confidential clients receive a one-time secret; public clients use PKCE without a secret.

Authorization needs `response_type=code`, `client_id`, exact `redirect_uri`, `resource`, `scope=read` or `scope=read write`, `code_challenge`, and `code_challenge_method=S256`. `state` is returned unchanged, and `iss` identifies Mill. Token exchange needs `grant_type=authorization_code`, `code`, `code_verifier`, the same `redirect_uri` and `resource`, and the client's declared authentication method. Consent codes expire after two minutes and can be consumed once. Tokens expire after 30 days; refresh-token grants are not supported.

OAuth errors use `{error,error_description}` with OAuth error names. Unauthenticated MCP responses include the protected-resource metadata URL in `WWW-Authenticate`. A tool outside the credential's access returns `insufficient_scope`. Tool operation failures appear as MCP `isError:true` results and preserve the REST error message. See [agent connection steps](agents.md) for the supported workflow and revocation behavior.
