# Mill homepage and docs

This is the generated Mintlify project for **mill.fyi**. It shares one native header, search and footer across the homepage and documentation. The header version comes from the root `package.json` and links to the release notes.

Maintain the homepage in `docs/home.mdx` and its scoped styles in `docs/home.css`. Guide sources live in `docs/*.md`; the generator adds metadata, rewrites guide links and maps `api.md` to `/rest-reference` because Mintlify reserves `/api`. Edit those sources and run `pnpm docs:build`. Do not edit the generated homepage, guides, styles or assets by hand.

Refresh application images with `pnpm docs:screenshots`, then run `pnpm docs:build`. The screenshot manifest records every captured section and its desktop/mobile light/dark variants. Captures use disposable example data at 2× density, with desktop and mobile viewport images in both themes. `pnpm docs:screenshots:check` validates section, theme, device and guide mappings without starting a capture. Use `pnpm docs:screenshots --section board` to refresh one section with a separate diagnostic receipt.

From the repository root, run `pnpm docs:dev` to open the local Mintlify preview at `http://localhost:4174`. Run `npx --yes mint@4.2.970 broken-links` and `npx --yes mint@4.2.970 validate` from this directory to inspect site links and check the build. Review desktop and mobile layouts in both themes separately from those technical checks.

To capture the documentation pages themselves, refresh the application images, regenerate the site and keep that preview running. Then run `pnpm docs:screenshots --docs-only --docs-url http://localhost:4174`. It checks that the preview serves the current application images before capturing the homepage and every configured guide in both themes and viewport sizes.

The owner confirmed hosting on mill.fyi. Configure the existing Mintlify project to use `docs/mintlify` as its content root only after the release and repository access are approved. Verify the project connection, deployment branch and preview before publication. There is no hosted Mill app in this plan; operators install their own instance at a URL they choose. After authorized publication, verify HTTPS, per-page canonical URLs, redirects and homepage/docs links at mill.fyi. Local generation does not change the hosting account or DNS.
