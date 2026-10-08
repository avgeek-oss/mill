# Release verification checklist

Use this checklist for the exact revision proposed for release. Record results in the release pull request and CI artifacts. Keep fixture credentials, private screenshots, database dumps, and local verification logs out of the published source and packages.

## Source and application checks

- Run `pnpm verify` against a disposable PostgreSQL database. Resolve formatting, lint, type, integration, dependency-audit, and build failures.
- Manually review desktop and phone routes in light and dark themes, including keyboard and touch controls, long content, loading, errors and retry behavior. Record the routes, states and results reviewed.
- Verify setup, invitations, sign-in, recovery, passkeys, sessions, profile preferences, and account settings. Check configured email delivery and private-link behavior against the documented capability.
- Verify Admin, Member, and Viewer permissions, current membership, last-administrator protection, invitation authority, and session or credential revocation during concurrent requests.
- Verify board and task creation, field updates, comments, notifications, deletion, search, filters, sorting, pagination, and URL restoration. Check concurrency, version conflicts, and idempotent retries without losing drafts or attribution.
- Exercise REST and MCP with actual clients. Check OAuth/PKCE, scopes, approved boards, expiry, and revocation. Preserve the distinction between browser sessions, personal REST keys, and human-owned MCP connections.
- Check shared component reuse, accessible names, focus restoration, reduced motion, bounded popovers, and readable light/dark contrast. Keep success and error feedback in toast alerts.

## Installation and data preservation

- Run `pnpm verify:production` from a clean checkout with the documented package-registry access. Confirm the installation does not require a sibling checkout or private runtime dependencies.
- Verify native `linux/amd64` and `linux/arm64` images, non-root runtime, readiness, persistent PostgreSQL, restart behavior, and the documented HTTPS/proxy configuration.
- Verify a clean baseline installation and rejection of incompatible migration ledgers without changing their data. Before publication, rehearse guarded prelaunch conversion with a recoverable source snapshot and compare retained records. After publication, use forward migrations and keep applied files immutable.
- Create and restore a full database backup in an isolated installation. Verify retained work, account state, credentials, and recovery with the original `MILL_SECRET` and matching configuration.
- Review dependency and image vulnerabilities, licenses, third-party notices, bundled assets, and the distributable file manifest for secrets or private material.
- Check physical passkeys, configured mail delivery, public DNS, certificates, and proxy behavior in the intended deployment environment. Local fixtures do not establish those outcomes.

## Documentation and release artifacts

- Keep installation instructions, configuration, API/MCP contracts, security guidance, release notes, and screenshots aligned with the supported behavior.
- The full source gate includes the documentation link check. Review the rendered documentation at desktop and phone widths in both themes. Use current, crisp screenshots without private data; the manual documentation capture tool is optional.
- Require the `verify` and `production` CI gates for the reviewed commit. Review both architecture packages and validate `SHA256SUMS`, source revision, image architecture, and the packaged notices.
- Verify version/tag metadata, source and release manifests, download destinations, and beginner installation instructions before publishing.
- For the staged GHCR publisher, require a stable tag on the current `main` revision, the latest exact-commit Required CI result, both native platform images, registry labels, and the digest-pinned `mill-images.json`. Inspect both release installation evidence bundles: each must pull the registry image and pass installation, persistence, backup/restore, HTTPS proxy, and image security checks without rebuilding Mill.
- The repository and `ghcr.io/avgeek-oss/mill` package remain private. Authenticated pulls require GitHub package access. Changing public visibility is a separate release decision.
- Obtain the applicable release and deployment authorization. Repository visibility, artifact publication, website publication, merge, and deployment are separate actions; local verification does not perform them.
