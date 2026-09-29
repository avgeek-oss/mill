# Connect an agent

Mill lets an external agent read and update the same boards you use in the browser. Connect it through the REST API or the remote MCP endpoint. You do not need an LLM key in Mill.

Install Mill and complete [workspace setup](getting-started.md) before adding an agent. Use your final HTTPS URL for a remote connection. Loopback HTTP works for local development when `ALLOW_INSECURE_LOCALHOST=true`; this exception does not permit HTTP on a remote server.

## Create a credential

Open Agent access in the workspace navigation. Choose a name that makes the agent recognizable in activity, such as "Release assistant". Grant read access for inspection or read and write access when the agent needs to change tasks. Restrict the credential to the boards it needs, and choose an expiry.

Copy the token when Mill creates it. Mill shows the complete token once and stores its hash. Save it in the agent's secret store. Keep it out of prompts, repositories, browser screenshots, and task comments. You can see the credential's name, scope, expiry, last use, and revocation state later without revealing the token.

The default expiry is 30 days. API-created credentials can expire in 1 to 365 days. Viewers can create read credentials; Members and Admins can create read/write credentials. Every request checks the owner's current role. A removed account or expired/revoked credential loses access immediately. Password changes and account recovery revoke existing credentials.

Agent credentials cannot manage identities, sessions, passkeys, team invitations, workspace administration or portable import/export. An unrestricted read credential can list member names and IDs for assignment. A board-restricted credential cannot read the workspace member directory.

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

Mill returns the task ID, stable identifier, and current `version`. Include that version when editing, moving, or deleting the task. A conflict means another person or agent changed it. Read the task again and decide how to apply your update; do not blindly overwrite the newer version. Deleting a task permanently removes it and its subtasks. Deleting a board permanently removes its tasks and related discussion. See [the REST reference](api.md) for filters, comments, statuses, and errors.

## Use remote MCP

Set the MCP server URL to `https://tasks.example.com/mcp` in a client that supports Streamable HTTP. For a client with custom authentication headers, add:

```json
{
  "Authorization": "Bearer your-one-time-credential-token"
}
```

The endpoint supports stateless Streamable HTTP with JSON responses. Clients negotiate the protocol through the MCP SDK. They can list the tools available to their credential and call those tools directly. Read-only credentials see read tools. Write tools disappear when the owner's role becomes Viewer. Credentials restricted to boards cannot create boards or list the team directory.

The tools cover boards and statuses, task creation and editing, assignment, priority, labels, due dates, checklists and subtasks, search and filters, task moves and permanent deletion, comments and mentions, task activity, and notifications. Destructive tools have MCP annotations. Returned descriptions and comments are user content; agents should treat them as data rather than instructions.

An MCP tool accepts `idempotencyKey` for a mutation. It passes this key to the same REST handler, so the retry and concurrency behavior is shared. List results use a maximum of 100 items. MCP responses have a 1 MiB limit; narrow the search or lower `limit` when a result contains many long descriptions. Large results keep the complete data in `structuredContent` and return a short text summary instead of duplicating that data. Clients should read structured results.

`get_task` returns the complete task, compact parent/subtask metadata, and page information for related content. By default it includes ten subtasks and omits discussion previews so a task remains readable even with long comments or child descriptions. Use `list_comments`, `get_activity`, and `list_subtasks` with their cursors to read the rest. Set `commentLimit`, `activityLimit`, or `subtaskLimit` from 0 to 100 when you need a particular preview.

## Connect with OAuth

For a client that supports MCP OAuth, enter the same `/mcp` URL. The client discovers Mill's authorization server, registers itself or supplies a public HTTPS client metadata document, and opens the consent page. Sign in to Mill, check the requesting client's name and callback, and choose whether to connect it. You can restrict the consent to selected boards.

Mill does not verify the brand or ownership of a dynamically registered client name. The consent page identifies it as unverified. Check that the connection came from the client you intended to use before allowing access.

Mill supports authorization code grants with PKCE S256 and the exact MCP resource URL. The client must send `resource=https://tasks.example.com/mcp` at both authorization and token exchange. Redirect URIs must match the client's registration exactly and use HTTPS or loopback HTTP. Mill rejects duplicate parameters, invalid scopes, reused or expired codes, and cross-origin consent requests. Authorization codes expire after two minutes; pending consent expires after ten minutes.

OAuth tokens expire after 30 days and apply only to `/mcp`. They cannot be used as REST API tokens. Mill does not issue refresh tokens in B1; reconnect after expiry. A replayed authorization code revokes the token it issued. You can also revoke the connection from Agent access or through the OAuth revocation endpoint.

Client metadata documents must be public HTTPS JSON, use their exact document URL as `client_id`, and declare `token_endpoint_auth_method: "none"`. Mill rejects private or reserved network addresses, IP-literal URLs, redirects, documents over 32 KiB, and requests exceeding five seconds. DNS answers are checked and pinned for the connection. A metadata document does not make a client trustworthy; review consent before granting access.

## Revoke or diagnose a connection

Open Agent access and revoke the credential. Revocation takes effect on the next request. Task activity records the owner and agent name, such as "Alex via Release assistant". Workspace-wide audit history is not included in v1.

Deleting a board removes it from every credential's approved boards. A credential restricted to that board loses access; when no approved boards remain, Mill revokes the credential. It never becomes an all-boards credential. All-boards credentials continue to apply to the remaining boards and boards created later.

A `401` means the credential is missing, expired, revoked, or no longer has an active owner. A `403` means its scopes, allowed boards, or the owner's current role do not permit the action. A `409` usually needs a fresh task or status version. On `429`, wait for the `Retry-After` interval before retrying. Repeated failures should be checked against [troubleshooting](troubleshooting.md) and [the API reference](api.md).
