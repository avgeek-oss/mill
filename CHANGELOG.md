# Changelog

## 1.0.5 (2026-10-13)

- Install shared UI and Mintlify documentation packages from public npm without GitHub package credentials.
- Keep API and UI images at version 1.0.5.
- Use the shared API-key and MCP connection tables on desktop and mobile, without the obsolete All boards permission label.

## 1.0.4 (2026-10-11)

- Use the shared MCP consent form with user-selected Read-only, Write or Administrator access, without a board selector.
- Revoke MCP connections and pending approvals after any membership role change; existing board restrictions remain enforced until revocation.
- Upgrade the shared design system to 1.2.15 and keep API and UI images on version 1.0.4.

## 1.0.3 (2026-10-11)

- Support Codex OAuth client metadata and dynamic registration, including variable loopback callback ports with exact callback binding and PKCE.
- Add explicit administrator consent for MCP connections, with current-role enforcement and permanent removal of administrator authority after demotion.
- Keep API and UI images on version 1.0.3; preserve existing OAuth connections through forward migration 004.

## 1.0.2 (2026-10-11)

- Add optional private S3-compatible task attachments for images and PDFs, shown below the task description with an upload dialog, page-wide drag and drop, verified uploads, two-column mobile and four-column desktop cards with the upload action beneath them, expanded image/PDF previews, inline downloads and cleanup after deletion.

- Use design system 1.2.14 for the shared upload control.
- Enable private attachment storage in the Towbar production manifests and keep API and UI images on version 1.0.2.

## 1.0.1

- Show the shared backend-unavailable screen during startup outages and retry read-only startup checks automatically. Keep authentication failures separate from backend failures.
- Use design system 1.2.9 for the recovery screen and keep the brand, readiness response and MCP server version aligned with the release manifest.

## 1.0.0 (under review)

The first Mill release candidate adds a self-hosted task board with PostgreSQL persistence, team roles, account security, notifications, REST and MCP access, and Docker Compose installation. The [v1 release notes](docs/release-notes.md) describe the supported behavior.

This candidate has not been declared release ready or published by this changelog.
