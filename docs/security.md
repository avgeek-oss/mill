# Security

Use HTTPS for remote access and keep PostgreSQL private. Keep the reverse proxy and host updated. Use the [configuration guide](configuration.md) to set up the public UI and API URLs.

Protect `.env`, the Docker host, and full database backups. A backup contains accounts, password hashes, client credential records, and encrypted authentication data; treat it as private account data. Preserve the original `MILL_SECRET` in your recovery plan so a restore can read protected values. Store encrypted backup copies away from the host and [practice a restore](backup.md#back-up-an-existing-or-managed-database).

Grant people and external clients only the access they need. Review **Account Settings → Sessions**, personal API keys and MCP Connections when a device or client is no longer trusted. Admins should also review **Team Settings → Members** and **Team API Keys** when a person leaves. Revoke credentials that are no longer needed; removing a member immediately ends their personal access, while a team key remains governed by its stored team policy. See [accounts and team access](authentication.md#external-credential-boundaries).

Passkeys require `localhost` or an HTTPS DNS hostname. Save single-use recovery codes when you register your first passkey. Password recovery does not remove passkeys; if the passkey and codes are lost, the server operator must use the explicit [account-recovery procedure](authentication.md#recover-an-account). Mill does not execute external code or connect to an LLM provider; clients call the permissioned API or MCP server. UI visibility is not an authorization boundary: the server checks authorization for every UI, REST, and MCP request.

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/avgeek-oss/mill/security/advisories/new). If that form is unavailable, email [support@avgeek.ltd](mailto:support@avgeek.ltd) to arrange a private channel. Include the affected version, a reproduction with secrets removed, and likely impact. Do not post exploit details, passwords, tokens, recovery links, or backups in a public issue.

For endpoint limits, OAuth consent and retry behavior, see the [REST API](api.md) and [client guide](clients.md).
