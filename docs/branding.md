# Mill brand foundation

The October 2 local brand pass uses a literal tower mill and a warm brown UI theme. It preserves the shared Towbar component compositions while giving Mill its own accent and warm neutral surfaces. This is a reviewable local implementation, not final brand approval or public publication.

## Assets

- Source: [tower mill master](../assets/brand/mill-mark-source.png), generated with the built-in image tool.
- Application mark: [128px PNG](../apps/web/public/brand/mill-mark.png), supporting the 32px lockup at up to 4× density.
- Browser icon: [64px PNG](../apps/web/public/brand/mill-favicon.png).
- Touch icon: [180px PNG](../apps/web/public/brand/mill-touch-icon.png).

The same transparent mark works on light and dark surfaces. Asset derivatives retain the source artwork and alpha; they only change pixel dimensions for delivery. The application uses the shared MillMark component in navigation and the identity frame, including consent. Images have reserved dimensions, preserve their proportions, and are decorative beside the visible Mill name.

The generation prompt was: “Literal tower mill with four cream sails, tapered cocoa-brown tower, brown cap and small door. Towbar-style miniature 3D object, three-quarter orthographic perspective, smooth materials, rounded bevels, minimal broad seams, strong silhouette at 32px, transparent background, no lettering or badge.” The final refinement used the original Mill draft as the edit target and Towbar's logo as a style reference. No Towbar artwork is shipped in Mill.

The asset pack also includes light/dark wordmarks and lockups, a currentColor monochrome SVG, and a 1200×630 social preview. SVG wordmarks use Inter with system sans-serif fallback; lockups embed the delivered mark, while the social composition embeds the full-resolution source. The monochrome mark is a separate flat vector adaptation for single-color use. Public publication and final owner visual approval remain separate gates.

- [Light lockup](../apps/web/public/brand/mill-lockup-light.svg) and [dark lockup](../apps/web/public/brand/mill-lockup-dark.svg)
- [Light wordmark](../apps/web/public/brand/mill-wordmark-light.svg) and [dark wordmark](../apps/web/public/brand/mill-wordmark-dark.svg)
- [Monochrome mark](../apps/web/public/brand/mill-mark-monochrome.svg)
- [Social preview PNG](../apps/web/public/brand/mill-social.png) and [editable SVG composition](../apps/web/public/brand/mill-social.svg)

## Theme

[Theme tokens](../packages/web-design-system/src/styles/mill-theme.css) override HeroUI's semantic roles through the existing CSS base layer. Cocoa accents on cream surfaces become light brown accents on warm charcoal in dark mode. Secondary controls, tables, menus, dialogs, focus rings and accent chips derive their colors from those roles. Success, warning and danger hues retain their existing semantic definitions.

The [brand module](../apps/web/src/brand.tsx) and browser theme-color use the matching background values. Metadata uses their sRGB hex equivalents for browser compatibility: light `#faf6f3` and dark `#120d0b`. The initial browser theme-color changes from `#fafafa` to `#faf6f3`, and tracks the active theme after initialization. CSS tokens remain OKLCH.

Every overridden color declaration is listed below. The inherited blue accent and cool/neutral surfaces are replaced to establish the chosen brown brand and matching neutral hue; role aliases keep component color relationships consistent. Derived hover, soft, foreground and focus roles continue to use HeroUI's existing formulas.

| Theme | Token                  | Previous HeroUI value         | Mill value              |
| ----- | ---------------------- | ----------------------------- | ----------------------- |
| Light | `--accent`             | `oklch(0.6204 0.195 253.83)`  | `oklch(0.44 0.077 55)`  |
| Light | `--accent-foreground`  | `var(--snow)`                 | `oklch(0.99 0.005 65)`  |
| Light | `--background`         | `oklch(0.9702 0 0)`           | `oklch(0.975 0.006 65)` |
| Light | `--foreground`         | `var(--eclipse)`              | `oklch(0.26 0.024 55)`  |
| Light | `--surface`            | `var(--white)`                | `oklch(0.995 0.003 65)` |
| Light | `--surface-secondary`  | `oklch(0.9524 0.0013 286.37)` | `oklch(0.958 0.008 65)` |
| Light | `--surface-tertiary`   | `oklch(0.9373 0.0013 286.37)` | `oklch(0.935 0.011 65)` |
| Light | `--overlay`            | `var(--white)`                | `var(--surface)`        |
| Light | `--muted`              | `oklch(0.5517 0.0138 285.94)` | `oklch(0.505 0.019 55)` |
| Light | `--default`            | `oklch(94% 0.001 286.375)`    | `oklch(0.942 0.01 65)`  |
| Light | `--default-foreground` | `var(--eclipse)`              | `var(--foreground)`     |
| Light | `--field-background`   | `var(--white)`                | `var(--surface)`        |
| Light | `--field-foreground`   | `oklch(0.2103 0.0059 285.89)` | `var(--foreground)`     |
| Light | `--segment`            | `var(--white)`                | `var(--surface)`        |
| Light | `--segment-foreground` | `var(--eclipse)`              | `var(--foreground)`     |
| Light | `--border`             | `oklch(90% 0.004 286.32)`     | `oklch(0.87 0.012 65)`  |
| Light | `--separator`          | `oklch(92% 0.004 286.32)`     | `oklch(0.91 0.009 65)`  |
| Dark  | `--accent`             | `oklch(0.6204 0.195 253.83)`  | `oklch(0.76 0.092 60)`  |
| Dark  | `--accent-foreground`  | `var(--snow)`                 | `oklch(0.2 0.017 55)`   |
| Dark  | `--background`         | `oklch(12% 0.005 285.823)`    | `oklch(0.165 0.009 55)` |
| Dark  | `--foreground`         | `var(--snow)`                 | `oklch(0.955 0.012 65)` |
| Dark  | `--surface`            | `oklch(0.2103 0.0059 285.89)` | `oklch(0.218 0.013 55)` |
| Dark  | `--surface-secondary`  | `oklch(0.257 0.0037 286.14)`  | `oklch(0.252 0.015 55)` |
| Dark  | `--surface-tertiary`   | `oklch(0.2721 0.0024 247.91)` | `oklch(0.288 0.017 55)` |
| Dark  | `--overlay`            | `oklch(0.2103 0.0059 285.89)` | `oklch(0.252 0.015 55)` |
| Dark  | `--muted`              | `oklch(70.5% 0.015 286.067)`  | `oklch(0.74 0.02 65)`   |
| Dark  | `--default`            | `oklch(27.4% 0.006 286.033)`  | `oklch(0.29 0.016 55)`  |
| Dark  | `--default-foreground` | `var(--snow)`                 | `var(--foreground)`     |
| Dark  | `--field-background`   | `oklch(0.2103 0.0059 285.89)` | `var(--surface)`        |
| Dark  | `--field-foreground`   | `var(--foreground)`           | `var(--foreground)`     |
| Dark  | `--segment`            | `oklch(0.3964 0.01 285.93)`   | `oklch(0.38 0.019 55)`  |
| Dark  | `--segment-foreground` | `var(--foreground)`           | `var(--foreground)`     |
| Dark  | `--border`             | `oklch(28% 0.006 286.033)`    | `oklch(0.34 0.018 55)`  |
| Dark  | `--separator`          | `oklch(25% 0.006 286.033)`    | `oklch(0.29 0.016 55)`  |

## Verification

Numerical sRGB/WCAG review of the new literal color pairs: all declared colors are within sRGB. Primary button text contrast is 7.74:1 light and 8.28:1 dark. Foreground/background is 14.52:1 light and 16.89:1 dark. Muted text on the secondary-control background is 4.98:1 light and 6.12:1 dark. These measurements cover the declared pairs, not every possible composited component state; rendered review and the broader Towbar audit remain separate evidence.

The initial brand pass had local build, typecheck, and focused browser evidence for light/dark boards and tasks, the dark creation modal/calendar, the 390×844 phone drawer, the bundled guide, and the identity frame on an incomplete OAuth-consent route. Those observations do not establish the current release candidate. Fresh source, browser, and production checks are underway; record their exact revision and results in [B1 verification](b1-verification.md). Release delivery and public brand approval remain separate gates.
