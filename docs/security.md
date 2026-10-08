# Security

Use HTTPS for every remote installation. Keep the Mill HTTP service bound to a private address behind your reverse proxy, and keep PostgreSQL private. Set `MILL_BASE_URL` to the exact public origin. The default proxy behavior ignores untrusted forwarded addresses. See [configuration](configuration.md) if you need advanced client-address forwarding.

Protect `.env`, the Docker host, and full database backups. A backup contains accounts, password hashes, client credential records, and encrypted authentication data. Preserve the original `MILL_SECRET` in your recovery plan so a restore can read protected values. Store encrypted backup copies away from the host and [practice a restore](backup.md#back-up-an-existing-or-managed-database).

Grant people and external clients only the access they need. Review **Account Settings → Sessions**, personal API keys and MCP Connections when a device or client is no longer trusted. Admins should also review **Team Settings → Members** and **Team API Keys** when a person leaves. Revoke credentials that are no longer needed; removing a member immediately ends their personal access, while a team key remains governed by its stored team policy. See [accounts and team access](authentication.md#external-credential-boundaries).

Passkeys require `localhost` or an HTTPS DNS hostname. Save single-use recovery codes when you register your first passkey. Password recovery does not remove passkeys; if the passkey and codes are lost, the server operator must use the explicit [account-recovery procedure](authentication.md#recover-an-account). Mill does not execute external code or connect to an LLM provider. The server checks authorization for UI, REST, and MCP requests.

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/avgeek-oss/mill/security/advisories/new) once the repository is public and the reporting form is enabled. If that form is unavailable, contact a repository owner through their GitHub profile and request a private reporting channel. Include the affected version, a reproduction with secrets removed, and likely impact. Do not post exploit details, passwords, tokens, recovery links, or backups in a public issue.

For endpoint limits, OAuth consent and retry behavior, see the [REST API](api.md) and [client guide](clients.md).
