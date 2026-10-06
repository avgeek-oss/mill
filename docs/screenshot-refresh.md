# Refresh documentation screenshots

The screenshot manifest at `tools/docs-screenshots.json` maps each application section to the documentation pages that use it. The capture script refreshes all sections in light and dark themes, at 1280 × 900 CSS pixels on desktop and 390 × 844 CSS pixels on mobile. Images use 2× pixel density for clear text; the receipt records both viewport and image dimensions.

Build the application, then run:

```sh
pnpm build
pnpm docs:screenshots
```

Use the same local PostgreSQL configuration as browser verification. The script creates a new isolated database schema, starts a temporary loopback server, and creates an example workspace through the real API. It never logs in to an existing installation. The example includes multiple boards, tasks, people, comments, notifications, and API keys. API key values, passwords, invitation links and session cookies are never written to the screenshot receipt or shown in captured dialogs.

The script captures every manifest entry, including setup, sign-in, empty, missing-page and server-error states. It replaces assets under `docs/screenshots/release-v1` and writes file dimensions, hashes, guide mappings, failures and cleanup status to `tmp/docs-screenshots-receipt.json`. A missing section, failed page or unconfirmed schema cleanup fails the command. The generator copies these assets into the Mintlify site; run the documentation build after refreshing them.

To capture every page of the documentation site as well, start the local Mintlify preview and supply its loopback URL:

```sh
pnpm docs:screenshots --docs-url http://localhost:4174
```

This mode refreshes application assets, regenerates the Mintlify site, checks that the preview serves the current image hashes, then captures every routed page and the homepage in both themes and at both widths. It loads images throughout each page before capturing and selects Mobile examples at the mobile width. Full documentation-page captures go to `tmp/docs-page-screenshots`; application assets remain limited to the visible viewport.

To capture only an already regenerated documentation preview without changing application assets:

```sh
pnpm docs:screenshots --docs-only --docs-url http://localhost:4174
```

Validate the manifest and guide mappings without starting a database or browser:

```sh
pnpm docs:screenshots:check
```

Review the resulting images before committing them. Screenshot examples are local documentation fixtures, not evidence of a production deployment. Rebuild and recapture whenever shared components, application layouts or the documented workflow changes.

For a focused capture while investigating a single section, use `--section board-settings`. This writes a separate section receipt and does not establish that the full set has been refreshed. Failed captures retain a diagnostic image and HTTP status/path information under `tmp`, without recording response bodies or credentials. Requests are paced to respect Mill's normal rate limits.

After a failed full capture, `pnpm docs:screenshots --resume` keeps complete sections only when their image hashes, dimensions and content-readiness checks still pass, the previous isolated schema was removed, and the application build has not changed. Remaining sections use a new isolated workspace. The receipt records both capture phases; rebuilding the application requires a fresh full capture.
