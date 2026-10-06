---
title: "REST and MCP clients"
description: "Connect external clients with personal API keys or OAuth."
---

Mill lets external clients read and update work through REST or remote MCP. REST uses a personal API key with your current permissions. MCP uses OAuth approved by a person in Mill. You do not need an LLM key in Mill.

Install Mill and complete [workspace setup](/getting-started) before connecting a client. Use your final HTTPS URL for a remote connection. Loopback HTTP works for local development when `ALLOW_INSECURE_LOCALHOST=true`; this exception does not permit HTTP on a remote server.

## Create a personal API key

Open **Account settings → API Keys** at `/settings/api-keys` and choose **Create API key**. Enter a **Name** and choose **Expiry**: 30, 60, 90, or 365 days. The default is 30 days. There is no access-scope or board selector. A key belongs to the person creating it; another administrator does not own it.

The **Copy your API key** dialog reveals the complete token once. Choose **Copy API key**, save it in the external client's secret store, and choose **Done**. Mill stores a hash. Keep the token out of prompts, repositories, browser screenshots, and task comments. Later metadata shows the name, expiry, last use, and revocation state without revealing the token.

A personal API key uses its human owner's current role across all accessible boards, including boards created later. A Viewer can read; Members and Admins can change work within their role. Disabling the account, expiring the key, or revoking it ends access. Password changes and account recovery also revoke existing keys.

Personal API keys use REST only. They cannot use `/mcp`, account/security routes, the team directory, invitations, workspace administration, credential management, or OAuth consent. Use a browser session for those human actions. See [access security](/authentication#external-credential-boundaries) for the distinction from OAuth.

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

Mill returns the task ID, stable identifier, and current `version`. Include that version when editing, changing status, or deleting the task. A conflict means another person or client changed it. Read the task again and decide how to apply your update; do not blindly overwrite the newer version. Deleting a task permanently removes only that task, its comments, notifications, and activity. Former subtasks are independent tasks after upgrade. Deleting a board permanently removes its tasks and related discussion. See [the REST reference](/rest-reference) for filters, comments, statuses, and errors.

## Use remote MCP

Open **Account settings → MCP Guide** at `/settings/mcp`. Choose Codex, Claude Code, Cursor, VS Code, or Other clients to see the setup for your current Mill instance. Copy the configuration from its filename header, follow the sign-in guidance below it, and approve the boards the client may use. These configurations use OAuth; they do not need a personal API key.

The configuration formats follow the clients' own guides: [Codex](https://developers.openai.com/codex/mcp/), [Claude Code](https://code.claude.com/docs/en/mcp), [Cursor](https://cursor.com/docs/mcp), and [VS Code](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

Set the MCP server URL to `https://tasks.example.com/mcp` in a client that supports Streamable HTTP. Connect using [MCP OAuth](#connect-with-oauth). Personal API keys do not authenticate MCP. An already authorized client sends its OAuth access token as a bearer header:

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

Tool availability depends on the current role/scope. Board deletion is a human-Admin REST/UI action, not an MCP tool. Removed tool names are unavailable; old field arguments fail validation. A completed pre-migration retry key returns terminal `410` rather than replaying an obsolete response. Read [the API reference](/rest-reference) and [upgrade guidance](/upgrades) for details.

## Connect with OAuth

For a client that supports MCP OAuth, enter the same `/mcp` URL. The client discovers Mill's authorization server, registers itself or supplies a public HTTPS client metadata document, and opens the consent page. Sign in to Mill and review the requesting client's name, callback and read or read/write scopes. Keep access to all boards or narrow **Approved boards** to the boards the client needs, then choose **Allow access**. Choose **Deny** if the request is unexpected. The connection belongs to your account and can act only within your current role and the access you approved.

Mill does not verify the brand or ownership of a dynamically registered client name. The consent page identifies it as unverified. Check that the connection came from the client you intended to use before allowing access.

Mill supports authorization code grants with PKCE S256 and the exact MCP resource URL. The client must send `resource=https://tasks.example.com/mcp` at both authorization and token exchange. Redirect URIs must match the client's registration exactly and use HTTPS or loopback HTTP. Mill rejects duplicate parameters, invalid scopes, reused or expired codes, and cross-origin consent requests. Authorization codes expire after two minutes; pending consent expires after ten minutes.

OAuth tokens expire after 30 days and apply only to `/mcp`. They cannot be used as REST API tokens. Mill does not issue refresh tokens; reconnect after expiry. A replayed authorization code revokes the token it issued. You can also revoke the connection from API keys or through the OAuth revocation endpoint. Current membership, role and approved access are checked during approval, token exchange and authenticated requests.

Client metadata documents must be public HTTPS JSON, use their exact document URL as `client_id`, and declare `token_endpoint_auth_method: "none"`. Mill rejects private or reserved network addresses, IP-literal URLs, redirects, documents over 32 KiB, and requests exceeding five seconds. DNS answers are checked and pinned for the connection. A metadata document does not make a client trustworthy; review consent before granting access.

## Revoke or diagnose a connection

Open **API keys**, choose the owning key's revoke action, and confirm **Revoke API key**. Revocation takes effect on the next request and removes the key from the list. Revoked keys and connections are omitted from every page; expired keys remain visible until revoked. Personal API-key activity identifies the human owner. OAuth activity identifies the person who approved the connection and distinguishes OAuth actions from direct human actions. Workspace-wide audit history is not included in v1.

Mill 1.0.0 starts from one initial database migration. Private pre-launch installations that used the older sequence need the maintainer's conversion procedure before starting this version; do not change their migration ledger by hand. See [upgrades](/upgrades).

Deleting a board removes it from OAuth approved-board grants. A restricted OAuth connection loses that board; when no approved boards remain, Mill revokes it rather than broadening access. Unrestricted OAuth connections and personal API keys continue to apply to remaining and future accessible boards.

A `401` means authentication is missing, expired, revoked, or no longer has an active owner. A `403` means the owner's role or a human-only boundary denies the action, or an OAuth scope/approved board denies it. A `409` usually needs a fresh task version or a restarted board cursor sequence. On `429`, wait for the `Retry-After` interval before retrying. Repeated failures should be checked against [troubleshooting](/troubleshooting) and [the API reference](/rest-reference).

## In the app

### Task activity

<Tabs>
  <Tab title="Desktop">
    <Frame>
      <div className="mill-guide-screenshot">
        <div className="mill-product-light">
          <img
            src="/assets/screenshots/release-v1/task-activity-light.png"
            alt="Task activity in Mill."
            width="1280"
            height="900"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/task-activity-dark.png"
            alt="Task activity in Mill."
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
            src="/assets/screenshots/release-v1/task-activity-mobile-light.png"
            alt="Task activity in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/task-activity-mobile-dark.png"
            alt="Task activity in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
      </div>
    </Frame>
  </Tab>
</Tabs>

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

### MCP Guide

<Tabs>
  <Tab title="Desktop">
    <Frame>
      <div className="mill-guide-screenshot">
        <div className="mill-product-light">
          <img
            src="/assets/screenshots/release-v1/mcp-guide-light.png"
            alt="MCP Guide in Mill."
            width="1280"
            height="900"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/mcp-guide-dark.png"
            alt="MCP Guide in Mill."
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
            src="/assets/screenshots/release-v1/mcp-guide-mobile-light.png"
            alt="MCP Guide in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/mcp-guide-mobile-dark.png"
            alt="MCP Guide in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
      </div>
    </Frame>
  </Tab>
</Tabs>
