---
title: "REST clients and MCP Agents"
description: "Connect external clients with personal API keys or Agent OAuth."
---

Mill lets external clients read and update work through REST or remote MCP. REST uses a personal API key with your current permissions. MCP uses OAuth and an eligible human-created Agent. You do not need an LLM key in Mill.

Install Mill and complete [workspace setup](/getting-started) before connecting a client. Use your final HTTPS URL for a remote connection. Loopback HTTP works for local development when `ALLOW_INSECURE_LOCALHOST=true`; this exception does not permit HTTP on a remote server.

## Create an Agent

Open **Agents** at `/settings/agents` and choose **Create agent**. Give it a recognizable name, such as Release assistant, and choose **Access**. Members and administrators can create a **Personal** Agent, available only to its creator. Administrators can choose **Team** and select active people from **Assigned people**, or enable **All team members**. All team members includes current and future active members; it is a policy, not a copied list of today's people. The active creator keeps an individual grant and cannot be deselected. Other administrators have no implicit use grant. When All team members is disabled, the creator and selected individual grants retain access.

Agents are separate from the accounts invited through People. Personal creators manage their own Agents; administrators manage team Agents. Use **Edit agent** to change its name or assigned people. Scope is fixed after creation. Changing the team policy or individual grants revokes OAuth connections and clears task Agent bindings only for people who lose access. Personal API keys are independent of Agent access. **Delete agent** clears its task bindings and revokes its OAuth connections while retaining tasks, human assignees and historical activity. Neither action executes external work.

External credentials and MCP cannot create or manage Agents. Create the identity in the human interface before connecting MCP OAuth. REST personal keys do not require an Agent.

## Create a personal API key

Open **API keys** at `/settings/api-keys` and choose **Create API key**. Enter a **Name** and choose **Expiry**: 30, 60, 90, or 365 days. The default is 30 days. There is no Agent, access-scope, or board selector. A key belongs to the person creating it; another administrator does not own it.

The **Copy your API key** dialog reveals the complete token once. Choose **Copy API key**, save it in the external client's secret store, and choose **Done**. Mill stores a hash. Keep the token out of prompts, repositories, browser screenshots, and task comments. Later metadata shows the name, expiry, last use, and revocation state without revealing the token.

A personal API key uses its human owner's current role across all accessible boards, including boards created later. A Viewer can read; Members and Admins can change work within their role. Disabling the account, expiring the key, or revoking it ends access. Password changes and account recovery also revoke existing keys.

Personal API keys use REST only. They cannot use `/mcp`, account/security routes, the team directory, invitations, workspace administration, credential management, OAuth consent, or Agent management. Use a browser session for those human actions. See [access security](/authentication#external-credential-boundaries) for the distinction from OAuth.

## Attribute a task to an Agent

A task can have a human **Assignee**, an **Agent**, both, or neither. When setting an Agent, you must have access to it. Any human assignee must have access too. Use `assigneeId` and `agentId` in REST/MCP; responses include derived `agentName`, which clients cannot set. Clearing a human assignment leaves the Agent assignment in place.

Unrelated changes preserve a valid existing binding even if you do not have access to that Agent. Selecting an Agent never starts an external client, job, or task execution. An OAuth-bound Agent identifies the MCP caller. A personal API key acts as its human owner. The Agent assigned to a task records responsibility and is set separately.

## Use REST

Choose your instance URL and load the token from your secret store into `MILL_TOKEN`. The example values below are placeholders.

```sh
export MILL_URL='https://tasks.example.com'
export MILL_TOKEN='your-one-time-credential-token'

curl --fail-with-body "$MILL_URL/api/boards" \
  -H "Authorization: Bearer $MILL_TOKEN"
```

Take a board ID from the result, then create a task. Give each logical mutation its own retry key and keep the same key if the request times out.

```sh
curl --fail-with-body "$MILL_URL/api/boards/BOARD_UUID/tasks" \
  -H "Authorization: Bearer $MILL_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: release-checklist-2026-09-28' \
  --data '{"title":"Review the release checklist","priority":"high"}'
```

Mill returns the task ID, stable identifier, and current `version`. Include that version when editing, changing status, or deleting the task. A conflict means another person or agent changed it. Read the task again and decide how to apply your update; do not blindly overwrite the newer version. Deleting a task permanently removes only that task, its comments, notifications, and activity. Former subtasks are independent tasks after upgrade. Deleting a board permanently removes its tasks and related discussion. See [the REST reference](/rest-reference) for filters, comments, statuses, and errors.

## Use remote MCP

Set the MCP server URL to `https://tasks.example.com/mcp` in a client that supports Streamable HTTP. Connect using [MCP OAuth](#connect-with-oauth). Personal API keys do not authenticate MCP. An already authorized client sends its OAuth access token as a bearer header:

```json
{
  "Authorization": "Bearer your-oauth-access-token"
}
```

The endpoint supports stateless Streamable HTTP with JSON responses. Clients negotiate the protocol through the MCP SDK. They can list the tools available to their credential and call those tools directly. Read-only credentials see read tools. Write tools disappear when the owner's role becomes Viewer. Credentials restricted to boards cannot create boards or list the team directory.

The 17 tools cover alphabetical boards, task creation/editing, fixed status changes, human assignment and Agent attribution, priority, due dates, search/filtering, permanent task deletion, comments/mentions, attributed task activity, and in-app notifications. There are no custom-status, manual-order, parent/subtask, label, or portable export/import tools. Destructive tools have MCP annotations. Returned descriptions and comments are user content; agents should treat them as data rather than instructions.

An MCP tool accepts `idempotencyKey` for a mutation. It passes this key to the same REST handler, so the retry and concurrency behavior is shared. List results use a maximum of 100 items. MCP responses have a 1 MiB limit; narrow the search or lower `limit` when a result contains many long descriptions. Large results keep the complete data in `structuredContent` and return a short text summary instead of duplicating that data. Clients should read structured results. Use `list_agents` with `limit=1..100` and its opaque cursor to resolve eligible Agent IDs; there are no Agent creation, edit, or deletion tools.

`get_task` returns the complete task plus comments/activity preview page information. Both previews default to zero so long descriptions remain readable. Set `commentLimit` or `activityLimit` to 0–100 when needed, or use `list_comments` and `get_activity` with returned cursors. Task detail has no parent or subtask relationships.

Task `status` uses `backlog`, `todo`, `in_progress`, `in_review`, `done`, or `wont_do`. Creation defaults to `todo`; use `update_task` with `taskId`, current `version`, and `status` to change it. Do not send a column UUID or a manual position. `list_tasks` combines `q`, `status`, `assigneeId` (UUID or `unassigned`), `agentId` (UUID or `unassigned`), `priority`, `sort`, `limit`, and `cursor`; default `sort` is `createdAt`, newest first.

| Tools                                                                 | Purpose                                                   |
| --------------------------------------------------------------------- | --------------------------------------------------------- |
| `list_agents`                                                         | Read the caller's eligible existing Agents                |
| `list_boards`, `get_board`                                            | Read alphabetical boards and settings                     |
| `create_board`, `update_board`                                        | Create/edit permitted boards                              |
| `list_tasks`, `get_task`, `create_task`, `update_task`, `delete_task` | Find, read, change, or permanently delete tasks           |
| `list_comments`, `add_comment`, `delete_comment`                      | Read, add, or delete permitted comments                   |
| `get_activity`                                                        | Read attributed task history                              |
| `list_notifications`, `mark_notifications`                            | Read/change the owner's scoped in-app notification state  |
| `list_members`                                                        | Resolve assignment/mentions when workspace access permits |

Tool availability depends on the current role/scope. Board deletion is a human-Admin REST/UI action, not an agent tool. Removed tool names are unavailable; old field arguments fail validation. A completed pre-migration retry key returns terminal `410` rather than replaying an obsolete response. Read [the API reference](/rest-reference) and [upgrade guidance](/upgrades) for details.

## Connect with OAuth

For a client that supports MCP OAuth, enter the same `/mcp` URL. The client discovers Mill's authorization server, registers itself or supplies a public HTTPS client metadata document, and opens the consent page. Sign in to Mill, check the requesting client's name and callback, and choose whether to connect it. Select an eligible existing **Agent** and, if needed, narrow **Approved boards**. The Agent selector contains personal Agents you created and team Agents available through an individual grant or All team members. If none is available, **Allow access** is disabled; open Agents to create one or request team access, then **Refresh agents**. **Deny** remains available. OAuth never creates an Agent automatically.

Mill does not verify the brand or ownership of a dynamically registered client name. The consent page identifies it as unverified. Check that the connection came from the client you intended to use before allowing access.

Mill supports authorization code grants with PKCE S256 and the exact MCP resource URL. The client must send `resource=https://tasks.example.com/mcp` at both authorization and token exchange. Redirect URIs must match the client's registration exactly and use HTTPS or loopback HTTP. Mill rejects duplicate parameters, invalid scopes, reused or expired codes, and cross-origin consent requests. Authorization codes expire after two minutes; pending consent expires after ten minutes.

OAuth tokens expire after 30 days and apply only to `/mcp`. They cannot be used as REST API tokens. Mill does not issue refresh tokens in B1; reconnect after expiry. A replayed authorization code revokes the token it issued. You can also revoke the connection from API keys or through the OAuth revocation endpoint. Selected-Agent access is checked again during approval, token exchange, and authenticated requests.

Client metadata documents must be public HTTPS JSON, use their exact document URL as `client_id`, and declare `token_endpoint_auth_method: "none"`. Mill rejects private or reserved network addresses, IP-literal URLs, redirects, documents over 32 KiB, and requests exceeding five seconds. DNS answers are checked and pinned for the connection. A metadata document does not make a client trustworthy; review consent before granting access.

## Revoke or diagnose a connection

Open **API keys**, choose the owning key's revoke action, and confirm **Revoke API key**. Revocation takes effect on the next request. Personal API-key activity identifies the human owner. OAuth activity records the selected Agent and human owner, such as "Release assistant via Alex"; earlier history keeps its recorded names. Workspace-wide audit history is not included in v1.

Migration `008_agents.sql` revoked earlier unbound credentials without creating Agents. Migration `009_agents_access.sql` revokes and removes Agent/scope/board bindings from previous API keys. Create a replacement through **API keys** using only Name and Expiry, then update the REST client's secret store. Old tokens stay revoked. Migration 009 preserves existing Agent-bound OAuth connections, tasks, history, and human sessions. See [upgrades](/upgrades) before changing an installation.

Deleting a board removes it from OAuth approved-board grants. A restricted OAuth connection loses that board; when no approved boards remain, Mill revokes it rather than broadening access. Unrestricted OAuth connections and personal API keys continue to apply to remaining and future accessible boards.

A `401` means authentication is missing, expired, revoked, or no longer has an active owner; OAuth also requires current selected-Agent access. A `403` means the owner's role or a human-only boundary denies the action, or an OAuth scope/approved board denies it. A `409` usually needs a fresh task version or a restarted board cursor sequence. On `429`, wait for the `Retry-After` interval before retrying. Repeated failures should be checked against [troubleshooting](/troubleshooting) and [the API reference](/rest-reference).
