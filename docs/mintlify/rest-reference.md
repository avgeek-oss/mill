---
title: "REST API"
description: "Fields, permissions, pagination, errors, and OAuth/MCP endpoints."
---

Mill serves JSON under `/api`, remote MCP at `/mcp`, and OAuth endpoints on the same origin configured by `MILL_BASE_URL`. REST and MCP share domain validation, transactions, versions, retry behavior, and current-role checks. Personal REST keys use the human owner's accessible boards; MCP OAuth additionally enforces scopes and optional approved boards.

Start with [REST and MCP clients](/clients) for connections, [accounts and team access](/authentication) for human routes, or [access security](/authentication#external-credential-boundaries) for authorization boundaries.

## Authentication and limits

Browser requests use the `mill_session` cookie; mutations require the configured public `Origin`. REST clients use `Authorization: Bearer mill_…` from a personal API key belonging to a human account. Keys use that account's current permissions without scope or board restrictions. OAuth tokens belong to the person approving the connection and authorize `/mcp` only, not public REST.

Authenticated requests are limited to 240 per minute per person or credential; anonymous requests to 120 per minute per client address. MCP dispatch also uses the REST limit. `429` includes `Retry-After: 60`. Ordinary request bodies are bounded to 2 MiB, credential/OAuth bodies to 16 KiB, and MCP requests/tool responses to 1 MiB.

Use `Idempotency-Key` for POST/PATCH/DELETE under `/api` outside human authentication. Keys are 8–128 letters, digits, or `. _ : -` without spaces. A key binds the person/credential, method, path/query, and exact JSON bytes for 24 hours. Exact retries replay saved status/body with `Idempotency-Replayed: true`; different content with the same key returns `409`. Saved responses are encrypted, including one-time tokens.

Permanent deletion clears cached response content referencing removed work while retaining retry identities. Those retries return `410` with `code:"retry_invalidated"` and cannot recreate the work; delete acknowledgments remain retryable. Upgrading to the fixed-status schema also invalidates completed old responses while retaining their keys because their shapes are obsolete. Authentication has separate one-time challenge/token behavior.

## Responses and pagination

Collections return `{items}`; paginated collections also return `{hasMore,nextCursor}`. Treat cursors as opaque and continue with the same filters. Tasks, comments, activity, and notifications default to 50 items and accept `limit=1..100`; boards default to 100 with the same maximum. Credentials default/max 200 and invitations default/max 100. The team directory returns at most 1,000 members per page and includes `hasMore` and `nextCursor` for continuation. A changed member directory returns `409 member_list_changed`; restart without a cursor.

Boards use case-insensitive name order, then the exact name and UUID to resolve ties: `lower(name),name,id`. `directory=true` supports the same complete accessible directory for navigation. A board cursor binds the person, accessible board set, directory mode, and list revision. A changed board list returns `409` with `code:"board_list_changed"`; restart without a cursor. Invalid/foreign cursors return `400`. Task continuation also binds a list revision: a concurrent edit, status change, insertion, or deletion returns `409` with `code:"task_list_changed"`. Restart the current filtered/sorted task list without a cursor; do not continue old pages. Credential/invitation cursors are owner/workspace-scoped UUID anchors.

Single mutations return `{board}`, `{task}`, or `{comment}`. Domain deletes return `{ok:true}`. Fields are camelCase. Resource IDs are UUIDs; a task's stable human identifier such as `OPS-17` is a label, not the API path ID.

Generic API failures return `{error:{code,message,requestId}}`. Use `error.code` to choose recovery behavior and `error.message` for readable feedback. The same correlation ID appears in `X-Request-Id` on successful and failed requests. A supplied request ID must be at most 100 characters containing only letters, digits or `._:-`; invalid values are replaced with a generated UUID. IDs do not authorize an action. Server failures omit database details and credentials.

An expired identity-confirmation window returns `403 REAUTHENTICATION_REQUIRED`; complete real identity verification before retrying the initiating operation, at most once automatically. Other `403` failures do not request reauthentication. Unknown fields in authentication and domain mutation bodies are rejected. OAuth protocol failures retain `{error,error_description}` rather than the generic envelope.

| Status | Meaning                                           | Client action                               |
| ------ | ------------------------------------------------- | ------------------------------------------- |
| `400`  | Invalid input or cursor                           | Correct the request                         |
| `401`  | Missing/expired/revoked authentication            | Sign in or reconnect                        |
| `403`  | Role, scope, board, or Origin denies access       | Review approved access                      |
| `404`  | Resource or route does not exist                  | Check its ID or supported route             |
| `409`  | Stale version/list cursor or retry-key mismatch   | Read current state and reconcile            |
| `410`  | Old retry content invalidated by deletion/upgrade | Reload before a new change                  |
| `413`  | Request or response exceeds a bound               | Send less data or narrow the read           |
| `429`  | Rate limit reached                                | Wait for `Retry-After`                      |
| `500`  | Server could not complete the request             | Inspect health/logs and retry appropriately |
| `503`  | Password verification capacity is busy            | Wait for `Retry-After` before retrying      |

## Permissions

Viewers read work, comments, and task history. Members also create/change boards and tasks, comment, and permanently delete tasks. Human Admins additionally manage membership/workspace settings and permanently delete boards. Every active member can access workspace boards. Personal API keys inherit that current access. OAuth connections can narrow it to approved boards and read or read/write scope.

Every credential inherits its owner's current role and active membership. Administration, credentials, identity settings, and consent require a human session. Personal API keys cannot call any `/api/auth` route, including the team directory. Board-restricted OAuth connections cannot create boards or list members; unscoped OAuth can resolve basic member metadata through MCP. Notifications stay within the owner's account and, for scoped OAuth, approved boards. Authorization is rechecked before a mutation commits.

## Boards

| Method and path          | Request                                 | Response                                    |
| ------------------------ | --------------------------------------- | ------------------------------------------- |
| `GET /api/boards`        | Optional `directory`, `limit`, `cursor` | `{items,hasMore,nextCursor}` alphabetically |
| `POST /api/boards`       | `{name,prefix?,description?}`           | `201 {board}`                               |
| `GET /api/boards/:id`    | Board UUID                              | `{board}`                                   |
| `PATCH /api/boards/:id`  | `{version,name?,description?}`          | `{board}`                                   |
| `DELETE /api/boards/:id` | `{version}`; human Admin                | `{ok:true}`                                 |

Names are 1–100 characters and descriptions at most 10,000. Custom prefixes match `^[A-Z][A-Z0-9]{1,9}$` and stay fixed after creation. There is no manual board order.

Board list items include `backlogCount`, `inProgressCount`, `todoCount` and `activeCount` for all tasks in each board. The first three count only their corresponding `backlog`, `in_progress` and `todo` statuses. The retained Active aggregate counts `todo`, `in_progress` and `in_review`, excluding Backlog and terminal states. Cards show In Progress, Todo and Backlog. These counts are independent of task pagination. Individual board, create and update responses keep their existing fields.

Board deletion permanently removes its tasks, comments, notifications, and task activity. Explicit OAuth board scopes lose that board and are revoked when no approved boards remain. There is no archive, trash, or restore API.

## Fixed task statuses

Every board uses these same values; there are no status resources or custom-status routes.

| API `status`  | Display name |
| ------------- | ------------ |
| `backlog`     | Backlog      |
| `todo`        | Todo         |
| `in_progress` | In Progress  |
| `in_review`   | In Review    |
| `done`        | Done         |
| `wont_do`     | Won't Do     |

## Tasks

| Method and path              | Request                                  | Response                                             |
| ---------------------------- | ---------------------------------------- | ---------------------------------------------------- |
| `GET /api/boards/:id/tasks`  | Search/filter/sort/pagination query      | `{items,total,page,revision,hasMore,nextCursor}`     |
| `POST /api/boards/:id/tasks` | `{title,...task fields}`                 | `201 {task}`                                         |
| `GET /api/tasks/:id`         | Optional `commentLimit`, `activityLimit` | `{task,comments,activity,commentsPage,activityPage}` |
| `PATCH /api/tasks/:id`       | `{version,...changed task fields}`       | `{task}`                                             |
| `DELETE /api/tasks/:id`      | `{version}`; Member                      | `{ok:true}`                                          |

| Field         | Accepted value                                      |
| ------------- | --------------------------------------------------- |
| `title`       | Nonempty text, at most 300 characters               |
| `status`      | One fixed value above; creation defaults to `todo`  |
| `description` | Markdown text, at most 100,000 characters           |
| `assigneeId`  | Active member UUID or `null`                        |
| `type`        | `task` (default), `bug`                             |
| `priority`    | `none`, `low`, `medium`, `high`, `urgent`           |
| `startDate`   | `YYYY-MM-DD` or `null`; creation defaults to `null` |
| `dueDate`     | `YYYY-MM-DD` or `null`                              |

PATCH can change status and other fields atomically. It requires the current row version, which increments on mutation. An actual status change records `task.moved` with `{fromStatus,status}`; edited non-status fields record `task.updated`. Existing historical activity details remain intact after migration and may contain earlier field names.

Tasks have one optional human assignee. Task creation, updates and filters reject `agentId`; responses do not contain Agent fields.

Start and due dates are optional calendar dates without a time or time zone. Responses include both fields; each can be set or cleared independently through creation or PATCH.

Task deletion removes only that task and its discussion, notifications, and activity. Former subtasks are independent tasks after migration and survive deletion of their former parent. Repeating a delete without its retry key returns `404`. Task numbers are not reused within an existing board.

Task detail returns the complete requested task. `commentLimit` and `activityLimit` accept 0–100 and default to 100 for REST. Each preview has `{hasMore,nextCursor}`; use the corresponding comments/activity endpoint to continue. A zero-sized preview has a null cursor; start that endpoint without a cursor.

Task list queries can be combined:

Task responses include `type`, either `task` or `bug`. Creation defaults to `task`; updates can change `type` with the current `version` and record it in activity. Type edits preserve the task identifier and status-change clock.

Without a `status` filter, Done and Won't Do tasks remain visible for 24 hours after entering that status, then leave the default list. Search and other filters retain this rule. Set `status=done` or `status=wont_do` to include all tasks in that status, including older ones. Tasks remain accessible by their direct links. Task responses include read-only `statusChangedAt`; unrelated edits do not restart the window. Counts and pagination cover the visible results, and expiry invalidates default-list pagination revisions.

| Parameter          | Value                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------- |
| `q`                | Title, description, or identifier search; at most 300 characters                      |
| `status`           | One fixed status code                                                                 |
| `assigneeId`       | Member UUID or `unassigned`                                                           |
| `priority`         | One priority value                                                                    |
| `sort`             | `createdAt` (default), `updatedAt`, `title`, `dueDate`, `priority`, `status`          |
| `limit`, `cursor`  | Maximum 100 and a cursor from the same filter/sort context                            |
| `page`, `revision` | Positive page number and optional returned revision; cannot be combined with `cursor` |

Creation/update sorts are newest first. Title is case-insensitive ascending; due date is ascending with undated tasks last; priority runs urgent through none; status follows Backlog, Todo, In Progress, In Review, Done, Won't Do. UUIDs break ties. Page requests clamp to the last available page and return the actual `page` with `total` and `revision`. Send that revision on subsequent page requests to reject a changed result with `409 task_list_changed`. Cursor continuation remains available for clients.

```sh
curl --fail-with-body "$MILL_URL/api/tasks/TASK_UUID" \
  -X PATCH \
  -H "Authorization: Bearer $MILL_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: release-task-edit-001' \
  --data '{"version":3,"status":"in_review","priority":"urgent"}'
```

## Comments, mentions, and activity

| Method and path                | Request              | Response                                   |
| ------------------------------ | -------------------- | ------------------------------------------ |
| `GET /api/tasks/:id/comments`  | `limit`, `cursor`    | `{items,hasMore,nextCursor}`; newest first |
| `POST /api/tasks/:id/comments` | `{body,mentionIds?}` | `201 {comment}`                            |
| `DELETE /api/comments/:id`     | `{version}`          | `{ok:true}`                                |
| `GET /api/tasks/:id/activity`  | `limit`, `cursor`    | `{items,hasMore,nextCursor}`; newest first |

Comment Markdown is nonempty and at most 10,000 characters. Mentions use `@their-email`, `user:UUID` links, or active UUIDs in `mentionIds`. Assignment/mention notifications respect in-app preferences. Comments cannot be edited after creation. Only the author or a human Admin can delete a comment. An OAuth client can delete its owner's comments within approved boards and write scope, but cannot moderate others. Activity retains `actorId`, `actorName`, and `actorKind` (`human` or `oauth`), identifying the person responsible for the action.

New activity records also include `detail.connection` with `type` (`session`, `api-key`, or `oauth`) and the originating `requestId`. This distinguishes browser, REST and MCP changes while retaining the same human owner. It contains no tokens or credential values and survives revocation. Historical records without this metadata remain unattributed to a connection type.

## Notifications and settings

| Method and path            | Request                                   | Response                                 |
| -------------------------- | ----------------------------------------- | ---------------------------------------- |
| `GET /api/notifications`   | Optional `unread=true`, `limit`, `cursor` | `{items,unreadCount,hasMore,nextCursor}` |
| `PATCH /api/notifications` | `{ids,read?}` or `{all:true,read?}`       | `{ok:true,updated}`                      |
| `GET /api/workspace`       | Human member session                      | `{workspace}`                            |
| `PATCH /api/workspace`     | Human Admin; `{name}`                     | `{workspace}`                            |

Read-state changes default to `read:true`; false marks unread. An OAuth client's reads/writes remain in its owner's account and board scope. A human can PATCH `/api/auth/profile` with `notificationPreferences:{assignments,mentions}`. Task notifications are in-app only; email task delivery is excluded.

## Earlier-client compatibility

Columns/custom statuses, task moves/manual order, task parents/subtasks, labels, and portable export/import are removed. Their routes return `404`; old structural payload fields and list queries such as `columnId`, `label`, or `parentId` return `400`. `subtaskLimit` is rejected, and `sort=position` is unsupported. Archive/deleted-state query parameters also return `400`. Change task status through PATCH with a fixed `status` value and current `version`.

A retained completed retry key from before migration returns terminal `410`, including on a removed route, rather than replaying an obsolete shape or repeating the mutation. See [upgrades](/upgrades) before changing an existing installation.

## Credentials

| Method and path               | Request                                   | Response                                                    |
| ----------------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| `GET /api/credentials`        | Human session; optional `limit`, `cursor` | `{items,hasMore,nextCursor}` with metadata, no token hashes |
| `POST /api/credentials`       | Human session; `{name,expiresInDays?}`    | `{credential,token}` once                                   |
| `DELETE /api/credentials/:id` | Owner's human session                     | `{revoked:true}`                                            |

API keys belong to the person who creates them; an Admin does not gain another person's key ownership. A name is trimmed, nonempty, and at most 120 characters. Expiry defaults to 30 days and accepts only 30, 60, 90, or 365. `agentId`, `scopes`, and `boardIds` are rejected. The token is revealed once; later responses contain metadata without tokens or hashes.

Personal API-key metadata has `tokenType:"api-key"`, null `boardIds`, and an empty stored `scopes` list. Runtime access comes from the human owner's current role and active membership across all accessible boards, including future boards. Viewer keys read; Member/Admin keys can change work within current role and human-session boundaries. Keys cannot use MCP, human-only management routes, or other owners' credentials. The same credential listing also includes the owner's OAuth connections, their scopes, and optional approved-board metadata. Revoked credentials are excluded before pagination; expired credentials remain listed until revoked. An owned cursor remains valid if its credential is revoked between pages. Neither credential type has Agent fields.

## Health and backups

`GET /health/live` checks service liveness. `GET /health/ready` checks PostgreSQL and returns the application version; neither needs a session or exposes account data. Full [PostgreSQL backup and restore](/backup) preserve work and identity. There is no portable export/import endpoint.

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

Consent details return `clientName`, `clientId`, `clientTrust`, `redirectUri`, `scope`, `expiresIn`, `user:{name,role}`, and `canApprove`. A Viewer cannot approve requested write access. Approval creates a connection owned by that person. Omit `boardIds` to approve all accessible boards or provide 1–100 unique existing board UUIDs to restrict the connection. The server rechecks current membership and role during approval, token exchange and authenticated requests. There is no identity-selection step; `agentId` is rejected.

Authorization needs `response_type=code`, `client_id`, exact `redirect_uri`, `resource`, `scope=read` or `scope=read write`, `code_challenge`, and `code_challenge_method=S256`. `state` is returned unchanged, and `iss` identifies Mill. Token exchange needs `grant_type=authorization_code`, `code`, `code_verifier`, the same `redirect_uri` and `resource`, and the client's declared authentication method. Consent codes expire after two minutes and can be consumed once. Tokens expire after 30 days; refresh-token grants are not supported.

OAuth errors use `{error,error_description}` with OAuth error names. Unauthenticated MCP responses include the protected-resource metadata URL in `WWW-Authenticate`. A tool outside the credential's access returns `insufficient_scope`. Tool operation failures appear as MCP `isError:true` results and preserve the REST error message. See [client connection steps](/clients) for the supported workflow and revocation behavior.

## In the app

### Personal API keys

<Tabs>
  <Tab title="Desktop">
    <Frame>
      <div className="mill-guide-screenshot">
        <div className="mill-product-light">
          <img
            src="/assets/screenshots/release-v1/api-keys-light.png"
            alt="Personal API keys in Mill."
            width="1280"
            height="900"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/api-keys-dark.png"
            alt="Personal API keys in Mill."
            width="1280"
            height="900"
            loading="lazy"
          />
        </div>
      </div>
    </Frame>
  </Tab>
  <Tab title="Mobile">
    <Frame>
      <div className="mill-guide-screenshot mill-guide-screenshot-mobile">
        <div className="mill-product-light">
          <img
            src="/assets/screenshots/release-v1/api-keys-mobile-light.png"
            alt="Personal API keys in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/api-keys-mobile-dark.png"
            alt="Personal API keys in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
      </div>
    </Frame>
  </Tab>
</Tabs>
