# Security

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/avgeek-oss/mill/security/advisories/new) when it is enabled for the repository. If the reporting form is unavailable, contact an owner listed in [MAINTAINERS.md](MAINTAINERS.md) through their GitHub profile and request a private reporting channel. Do not post passwords, tokens, account recovery links, backups, or exploit details in an issue.

Include the affected version or commit, deployment configuration with secrets removed, reproduction steps, and impact. A disposable test workspace is enough; do not send real customer data. Maintainers will confirm receipt, investigate, and coordinate a fix and disclosure with the reporter.

## Supported versions

During v1 review, security fixes target the reviewed development branch. After publication, the latest release is supported. Operators should read upgrade notes and keep tested backups before upgrading.

## Operator responsibilities

Use HTTPS for every remote installation. Protect `.env` and database backups, restrict access to the Docker host, update the reverse proxy and host, and grant members and client credentials only the access they need. Revoke credentials and sessions when access ends. Backups include account hashes, encrypted authenticators, and tokens; treat them as private account data.

Mill does not execute external code or connect to an LLM provider. Clients call the permissioned API or MCP server. UI visibility is not an authorization boundary; the server checks each request.
