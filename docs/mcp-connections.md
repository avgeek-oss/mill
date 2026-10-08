# MCP connections

Mill exposes a remote MCP server at your installation's `/mcp` URL. A compatible client can connect with OAuth, which you approve in Mill, or with a [personal or team API key](api-keys.md) if it supports bearer-token MCP authentication. Mill does not run the client or require an LLM key for task management.

## Connect a client with OAuth

Open **Account Settings → MCP Guide** and choose your client: Codex, Claude Code, Cursor, VS Code, or Other clients. Copy the configuration shown for your installation. The guide uses the configured public API origin plus `/mcp`; remote connections need HTTPS. Local HTTP OAuth works automatically when `MILL_API_URL` is an exact loopback origin.

Start the connection in your client. It opens Mill's consent page. Sign in, check the client name and callback, and review whether it asks for read-only or read/write access. A dynamically registered client name is unverified; an HTTPS metadata document describes a client but does not verify who started the request. Approve only a connection you started.

Under **Approved boards**, choose **All allowed boards** or one specific board. This choice can only narrow what your current role permits. A Viewer cannot approve write access. Choose **Allow access** to finish the connection or **Deny** to refuse it. If Mill asks you to confirm your identity again, complete that step before approving. The resulting connection belongs to your account and follows later role or membership changes.

## Review and revoke access

Open **Account Settings → MCP Connections** to see connected clients, their read or read/write permission, approved board access, expiry and last use. Use **Revoke connection** when a client no longer needs access. Revocation takes effect on the next request. Deleting a board removes it from restricted grants; if it was the connection's last approved board, Mill revokes the connection.

OAuth access tokens work only with `/mcp`, expire after 30 days, and have no refresh token. Reconnect from the client when one expires. A board-restricted connection cannot create boards or list the team directory. MCP tools available to the client depend on its approved scopes, boards and your current role; its writes use the same task versions and retry behavior as REST. There are no Agent, Kanban, custom-status, checklist or file-upload tools.

If a connection fails, check the exact `/mcp` URL, HTTPS or loopback setting, current role, requested scope and board choice. A `401` usually means the credential expired or was revoked; a `403` means the action exceeds the approved access. See [client troubleshooting](troubleshooting.md#an-mcp-client-cannot-connect) and the [full REST/MCP guide](clients.md).
