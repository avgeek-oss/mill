# REST and MCP clients

Mill lets external clients read and update work through REST or remote MCP. Both transports accept personal and team API keys with explicit permissions. MCP also accepts OAuth approved by a person in Mill. You do not need an LLM key in Mill.

Install Mill and complete [workspace setup](getting-started.md) before connecting a client. Use your final HTTPS URL for a remote connection. Loopback HTTP works for local development when `ALLOW_INSECURE_LOCALHOST=true`; this exception does not permit HTTP on a remote server.

## Create a personal API key

Open **Account Settings → API Keys** at `/settings/api-keys` and choose **Create API key**. Enter a **Name**, choose **Permissions** (Read-only, Edit, or Administrative permissions), and choose **Expires after** (30 days, 90 days, 1 year, or Never). All three selections are required. A personal key belongs to the person creating it. Administrators create and revoke team keys under **Team Settings → Team API Keys** at `/team-settings/team-api-keys`; a team key belongs to the team, not its creator. Only an administrator can select Never.

The **Copy your API key** dialog reveals the complete token once. Choose **Copy API key**, save it in the external client's secret store, and choose **Done**. Mill stores a hash. Keep the token out of prompts, repositories, browser screenshots, and task comments. Later metadata shows the name, expiry, last use, and revocation state without revealing the token.

A personal key uses its stored grant within its human owner's current active membership and role. Demotion permanently narrows the grant, even after later promotion. A team key uses its stored team grant independently of the creator's later membership. Read-only permits reads; Edit permits routine work changes; Administrative permissions permits permitted business administration such as board deletion. No key can exceed its issuer's authority at creation. Expiry or revocation ends access; disabling an owner also ends personal-key access. Password changes and account recovery revoke that owner's personal keys.

API keys can use REST and `/mcp`. They cannot use account/security routes, the team directory, invitations, team settings, credential management, or OAuth consent. Use a browser session for those human actions. See [access security](authentication.md#external-credential-boundaries) for the distinction from OAuth.

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

Mill returns the task ID, stable identifier, and current `version`. Include that version when editing, changing status, or deleting the task. A conflict means another person or client changed it. Read the task again and decide how to apply your update; do not blindly overwrite the newer version. Deleting a task permanently removes only that task, its comments, notifications, and activity. Former subtasks are independent tasks after upgrade. Deleting a board permanently removes its tasks and related discussion. See [the REST reference](api.md) for filters, comments, statuses, and errors.

## Use remote MCP

Open **Account Settings → MCP Guide** at `/settings/mcp`. Choose Codex, Claude Code, Cursor, VS Code, or Other clients to see the setup for your current Mill instance. Copy the configuration for your client and follow its setup link if needed. These configurations use OAuth; choose approved boards during the connection consent step. A client that supports bearer-token MCP authentication can use an API key instead.

The configuration formats follow the clients' own guides: [Codex](https://developers.openai.com/codex/mcp/), [Claude Code](https://code.claude.com/docs/en/mcp), [Cursor](https://cursor.com/docs/mcp), and [VS Code](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

Set the MCP server URL to `https://tasks.example.com/mcp` in a client that supports Streamable HTTP. Connect using [MCP OAuth](#connect-with-oauth) or an API key. An authorized client sends its OAuth token or API key as a bearer header:

```json
{
  "Authorization": "Bearer your-oauth-access-token"
}
```

The endpoint supports stateless Streamable HTTP with JSON responses. Clients negotiate the protocol through the MCP SDK. They can list the tools available to their credential and call those tools directly. Read-only credentials see read tools. Write tools disappear when the owner's role becomes Viewer. Credentials restricted to boards cannot create boards or list the team directory.

The 16 tools cover alphabetical boards, task creation/editing, fixed status changes, assignment, priority, start and due dates, search/filtering, permanent task deletion, comments/mentions, attributed task activity, and in-app notifications. There are no custom-status, manual-order, parent/subtask, label, or portable export/import tools. Destructive tools have MCP annotations. Returned descriptions and comments are user content; clients should treat them as data rather than instructions.

An MCP tool accepts `idempotencyKey` for a mutation. It passes this key to the same REST handler, so the retry and concurrency behavior is shared. List results use a maximum of 100 items. MCP responses have a 1 MiB limit; narrow the search or lower `limit` when a result contains many long descriptions. Large results keep the complete data in `structuredContent` and return a short text summary instead of duplicating that data. Clients should read structured results.

`get_task` returns the complete task plus comments/activity preview page information. Both previews default to zero so long descriptions remain readable. Set `commentLimit` or `activityLimit` to 0–100 when needed, or use `list_comments` and `get_activity` with returned cursors. Task detail has no parent or subtask relationships.

Task `type` is `task` or `bug` and defaults to `task`. Both `create_task` and `update_task` accept it; updates require the current version.

Task `status` uses `backlog`, `todo`, `in_progress`, `in_review`, `done`, or `wont_do`. Creation defaults to `todo`; use `update_task` with `taskId`, current `version`, and `status` to change it. Do not send a column UUID or a manual position. `list_tasks` combines `q`, `status`, `assigneeId` (UUID or `unassigned`), `priority`, `sort`, `limit`, and `cursor`; default `sort` is `createdAt`, newest first.

| Tools                                                                 | Purpose                                                   |
| --------------------------------------------------------------------- | --------------------------------------------------------- |
| `list_boards`, `get_board`                                            | Read alphabetical boards and settings                     |
| `create_board`, `update_board`                                        | Create/edit permitted boards                              |
| `list_tasks`, `get_task`, `create_task`, `update_task`, `delete_task` | Find, read, change, or permanently delete tasks           |
| `list_comments`, `add_comment`, `delete_comment`                      | Read, add, or delete permitted comments                   |
| `get_activity`                                                        | Read attributed task history                              |
| `list_notifications`, `mark_notifications`                            | Read/change the owner's scoped in-app notification state  |
| `list_members`                                                        | Resolve assignment/mentions when workspace access permits |

Tool availability depends on the current role/scope. Board deletion is available to an Admin browser session or an Administrative personal/team API key through REST; it is not an MCP tool. OAuth, Read-only and Edit grants cannot delete boards. Removed tool names are unavailable; old field arguments fail validation. A completed pre-migration retry key returns terminal `410` rather than replaying an obsolete response. Read [the API reference](api.md) and [upgrade guidance](upgrades.md) for details.

## Connect with OAuth

For a client that supports MCP OAuth, enter the same `/mcp` URL. The client discovers Mill's authorization server, registers itself or supplies a public HTTPS client metadata document, and opens the consent page. Sign in to Mill and review the requesting client's name, callback and read or read/write scopes. Keep access to all boards or narrow **Approved boards** to the boards the client needs, then choose **Allow access**. Choose **Deny** if the request is unexpected. The connection belongs to your account and can act only within your current role and the access you approved.

Mill does not verify the brand or ownership of a dynamically registered client name. The consent page identifies it as unverified. Check that the connection came from the client you intended to use before allowing access.

Mill supports authorization code grants with PKCE S256 and the exact MCP resource URL. The client must send `resource=https://tasks.example.com/mcp` at both authorization and token exchange. Redirect URIs must match the client's registration exactly and use HTTPS or loopback HTTP. Mill rejects duplicate parameters, invalid scopes, reused or expired codes, and cross-origin consent requests. Authorization codes expire after two minutes; pending consent expires after ten minutes.

OAuth tokens expire after 30 days and apply only to `/mcp`. They cannot be used as REST API tokens. Mill does not issue refresh tokens; reconnect after expiry. A replayed authorization code revokes the token it issued. You can also revoke the connection from MCP Connections or through the OAuth revocation endpoint. Current membership, role and approved access are checked during approval, token exchange and authenticated requests.

Client metadata documents must be public HTTPS JSON, use their exact document URL as `client_id`, and declare `token_endpoint_auth_method: "none"`. Mill rejects private or reserved network addresses, IP-literal URLs, redirects, documents over 32 KiB, and requests exceeding five seconds. DNS answers are checked and pinned for the connection. A metadata document does not make a client trustworthy; review consent before granting access.

## Revoke or diagnose a connection

Open **Account Settings → API Keys** to revoke a personal key, **Team Settings → Team API Keys** to revoke a team key, or **Account Settings → MCP Connections** to revoke an authorized app. Confirm **Revoke key** or **Revoke connection**. Revocation takes effect on the next request and removes the key from the list. Revoked keys and connections are omitted from every page; expired keys remain visible until revoked. Personal API-key activity identifies the human owner, team-key activity identifies the team key, and OAuth activity identifies the person who approved the connection. Task activity distinguishes browser, API-key and OAuth actions.

Mill applies the checksummed initial schema and a forward key-policy migration. Private pre-launch installations that used an older sequence need the maintainer's conversion procedure; do not change their migration ledger by hand. See [upgrades](upgrades.md).

Deleting a board removes it from OAuth approved-board grants. A restricted OAuth connection loses that board; when no approved boards remain, Mill revokes it rather than broadening access. Unrestricted OAuth connections and personal API keys continue to apply to remaining and future accessible boards.

A `401` means authentication is missing, expired, revoked, or no longer has an active owner. A `403` means the owner's role or a human-only boundary denies the action, or an OAuth scope/approved board denies it. A `409` usually needs a fresh task version or a restarted board cursor sequence. On `429`, wait for the `Retry-After` interval before retrying. Repeated failures should be checked against [troubleshooting](troubleshooting.md) and [the API reference](api.md).
