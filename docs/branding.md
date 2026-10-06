# Mill brand foundation

The October 2 local brand pass uses a literal tower mill and a warm brown UI theme. It preserves the shared Towbar component compositions while giving Mill its own accent and warm neutral surfaces. The owner approved the logo and palette on October 3. Documentation design, final public compositions and publication remain separate gates; see [documentation design review](docs-design-review.md).

## Assets

- Source: [tower mill master](../assets/brand/mill-mark-source.png), generated with the built-in image tool.
- Application mark: [128px PNG](../apps/web/public/brand/mill-mark.png), supporting the 32px lockup at up to 4× density.
- Browser icon: [64px PNG](../apps/web/public/brand/mill-favicon.png).
- Touch icon: [180px PNG](../apps/web/public/brand/mill-touch-icon.png).

The same transparent mark works on light and dark surfaces. Asset derivatives retain the source artwork and alpha; they only change pixel dimensions for delivery. The application uses the shared MillMark component in navigation and the identity frame, including consent. Images have reserved dimensions, preserve their proportions, and are decorative beside the visible Mill name.

The generation prompt was: “Literal tower mill with four cream sails, tapered cocoa-brown tower, brown cap and small door. Towbar-style miniature 3D object, three-quarter orthographic perspective, smooth materials, rounded bevels, minimal broad seams, strong silhouette at 32px, transparent background, no lettering or badge.” The final refinement used the original Mill draft as the edit target and Towbar's logo as a style reference. No Towbar artwork is shipped in Mill.

The asset pack also includes light/dark wordmarks and lockups, a currentColor monochrome SVG, and a 1200×630 social preview. SVG wordmarks use Inter with system sans-serif fallback; lockups embed the delivered mark, while the social composition embeds the full-resolution source. The monochrome mark is a separate flat vector adaptation for single-color use. Logo and palette approval does not establish approval of every public composition or publication.

- [Light lockup](../apps/web/public/brand/mill-lockup-light.svg) and [dark lockup](../apps/web/public/brand/mill-lockup-dark.svg)
- [Light wordmark](../apps/web/public/brand/mill-wordmark-light.svg) and [dark wordmark](../apps/web/public/brand/mill-wordmark-dark.svg)
- [Monochrome mark](../apps/web/public/brand/mill-mark-monochrome.svg)
- [Social preview PNG](../apps/web/public/brand/mill-social.png) and [editable SVG composition](../apps/web/public/brand/mill-social.svg)

## Theme

[Theme tokens](../packages/web-design-system/src/styles/mill-theme.css) override HeroUI's semantic roles through the existing CSS base layer. Cocoa accents sit on nearly neutral white and gray surfaces in light mode, with light brown accents on near-black surfaces in dark mode. Secondary controls, tables, menus, dialogs, focus rings and accent chips derive their colors from those roles. Success, warning and danger hues retain their existing semantic definitions.

The [brand module](../apps/web/src/brand.tsx) and browser theme-color use the matching background values. Metadata uses their sRGB hex equivalents for browser compatibility: light `#f7f7f6` and dark `#060605`. The initial browser theme-color matches the light background and tracks the active theme after initialization. CSS tokens remain OKLCH.

Every overridden color declaration is listed below. The inherited blue accent and cool/neutral surfaces are replaced to establish the chosen brown brand and matching neutral hue; role aliases keep component color relationships consistent. Derived hover, soft, foreground and focus roles continue to use HeroUI's existing formulas.

| Theme | Token                  | Previous HeroUI value         | Mill value              |
| ----- | ---------------------- | ----------------------------- | ----------------------- |
| Light | `--accent`             | `oklch(0.6204 0.195 253.83)`  | `oklch(0.44 0.077 55)`  |
| Light | `--accent-foreground`  | `var(--snow)`                 | `oklch(0.99 0.005 65)`  |
| Light | `--background`         | `oklch(0.9702 0 0)`           | `oklch(0.975 0.001 65)` |
| Light | `--foreground`         | `var(--eclipse)`              | `oklch(0.26 0.024 55)`  |
| Light | `--surface`            | `var(--white)`                | `oklch(0.995 0.001 65)` |
| Light | `--surface-secondary`  | `oklch(0.9524 0.0013 286.37)` | `oklch(0.958 0.002 65)` |
| Light | `--surface-tertiary`   | `oklch(0.9373 0.0013 286.37)` | `oklch(0.935 0.002 65)` |
| Light | `--overlay`            | `var(--white)`                | `var(--surface)`        |
| Light | `--muted`              | `oklch(0.5517 0.0138 285.94)` | `oklch(0.505 0.019 55)` |
| Light | `--default`            | `oklch(94% 0.001 286.375)`    | `oklch(0.942 0.002 65)` |
| Light | `--default-foreground` | `var(--eclipse)`              | `var(--foreground)`     |
| Light | `--field-background`   | `var(--white)`                | `var(--surface)`        |
| Light | `--field-foreground`   | `oklch(0.2103 0.0059 285.89)` | `var(--foreground)`     |
| Light | `--segment`            | `var(--white)`                | `var(--surface)`        |
| Light | `--segment-foreground` | `var(--eclipse)`              | `var(--foreground)`     |
| Light | `--border`             | `oklch(90% 0.004 286.32)`     | `oklch(0.87 0.002 65)`  |
| Light | `--separator`          | `oklch(92% 0.004 286.32)`     | `oklch(0.91 0.002 65)`  |
| Dark  | `--accent`             | `oklch(0.6204 0.195 253.83)`  | `oklch(0.76 0.092 60)`  |
| Dark  | `--accent-foreground`  | `var(--snow)`                 | `oklch(0.2 0.017 55)`   |
| Dark  | `--background`         | `oklch(12% 0.005 285.823)`    | `oklch(0.12 0.002 55)`  |
| Dark  | `--foreground`         | `var(--snow)`                 | `oklch(0.955 0.012 65)` |
| Dark  | `--surface`            | `oklch(0.2103 0.0059 285.89)` | `oklch(0.17 0.003 55)`  |
| Dark  | `--surface-secondary`  | `oklch(0.257 0.0037 286.14)`  | `oklch(0.195 0.003 55)` |
| Dark  | `--surface-tertiary`   | `oklch(0.2721 0.0024 247.91)` | `oklch(0.22 0.004 55)`  |
| Dark  | `--overlay`            | `oklch(0.2103 0.0059 285.89)` | `oklch(0.205 0.003 55)` |
| Dark  | `--muted`              | `oklch(70.5% 0.015 286.067)`  | `oklch(0.74 0.008 65)`  |
| Dark  | `--default`            | `oklch(27.4% 0.006 286.033)`  | `oklch(0.235 0.004 55)` |
| Dark  | `--default-foreground` | `var(--snow)`                 | `var(--foreground)`     |
| Dark  | `--field-background`   | `oklch(0.2103 0.0059 285.89)` | `var(--surface)`        |
| Dark  | `--field-foreground`   | `var(--foreground)`           | `var(--foreground)`     |
| Dark  | `--segment`            | `oklch(0.3964 0.01 285.93)`   | `oklch(0.31 0.004 55)`  |
| Dark  | `--segment-foreground` | `var(--foreground)`           | `var(--foreground)`     |
| Dark  | `--border`             | `oklch(28% 0.006 286.033)`    | `oklch(0.285 0.004 55)` |
| Dark  | `--separator`          | `oklch(25% 0.006 286.033)`    | `oklch(0.235 0.004 55)` |

## October 4 dark surface refinement

The dark theme now uses lower lightness and much less chroma on its neutral surfaces. This removes the heavy brown cast while retaining the brown accent and a clear progression between the page, table rows, controls and overlays. Light mode retains its existing colors. Every changed declaration in `mill-theme.css` is recorded below; the fixed hue retains subtle warmth.

| Token                 | Previous Mill value     | Current value           | Purpose                                |
| --------------------- | ----------------------- | ----------------------- | -------------------------------------- |
| `--background`        | `oklch(0.165 0.009 55)` | `oklch(0.12 0.002 55)`  | Lower lightness and reduce brown tint  |
| `--surface`           | `oklch(0.218 0.013 55)` | `oklch(0.17 0.003 55)`  | Lower lightness and reduce brown tint  |
| `--surface-secondary` | `oklch(0.252 0.015 55)` | `oklch(0.195 0.003 55)` | Lower lightness and reduce brown tint  |
| `--surface-tertiary`  | `oklch(0.288 0.017 55)` | `oklch(0.22 0.004 55)`  | Lower lightness and reduce brown tint  |
| `--overlay`           | `oklch(0.252 0.015 55)` | `oklch(0.205 0.003 55)` | Lower lightness and reduce brown tint  |
| `--muted`             | `oklch(0.74 0.02 65)`   | `oklch(0.74 0.008 65)`  | Reduce brown tint without dimming text |
| `--default`           | `oklch(0.29 0.016 55)`  | `oklch(0.235 0.004 55)` | Lower lightness and reduce brown tint  |
| `--segment`           | `oklch(0.38 0.019 55)`  | `oklch(0.31 0.004 55)`  | Lower lightness and reduce brown tint  |
| `--border`            | `oklch(0.34 0.018 55)`  | `oklch(0.285 0.004 55)` | Lower lightness and reduce brown tint  |
| `--separator`         | `oklch(0.29 0.016 55)`  | `oklch(0.235 0.004 55)` | Lower lightness and reduce brown tint  |

In `apps/web/src/brand.tsx`, the dark browser theme-color changes from `#120d0b` to `#060605` to match the new background. The sRGB/contrast calculation is recorded in `tmp/darker-theme-color-audit.json`. All declared colors remain in sRGB; body and muted-control text exceed WCAG AA.

## October 5 light surface refinement

The light theme reduces chroma on the page, elevated surfaces, neutral controls, borders and separators. Lightness and hue stay fixed, preserving the existing surface hierarchy with much less brown tint. Accent colors, foreground/muted text and dark mode retain their preceding values. Overlay, field and segment aliases inherit the revised surface automatically.

Every changed declaration in `packages/web-design-system/src/styles/mill-theme.css` is listed below. The brown cast was excessive for neutral surfaces; reducing chroma addresses it without flattening their lightness differences.

| Token                 | Previous Mill value     | Current value           |
| --------------------- | ----------------------- | ----------------------- |
| `--background`        | `oklch(0.975 0.006 65)` | `oklch(0.975 0.001 65)` |
| `--surface`           | `oklch(0.995 0.003 65)` | `oklch(0.995 0.001 65)` |
| `--surface-secondary` | `oklch(0.958 0.008 65)` | `oklch(0.958 0.002 65)` |
| `--surface-tertiary`  | `oklch(0.935 0.011 65)` | `oklch(0.935 0.002 65)` |
| `--default`           | `oklch(0.942 0.01 65)`  | `oklch(0.942 0.002 65)` |
| `--border`            | `oklch(0.87 0.012 65)`  | `oklch(0.87 0.002 65)`  |
| `--separator`         | `oklch(0.91 0.009 65)`  | `oklch(0.91 0.002 65)`  |

The light browser theme-color changes from `#faf6f3` to `#f7f7f6` in both `apps/web/src/brand.tsx` and `apps/web/index.html`. The numerical review is recorded in `tmp/light-surface-color-audit.json`: every declared light color fits sRGB, foreground/background contrast is 14.53:1, muted text on secondary controls is 5.22:1, and muted text on the default role is 4.98:1. Independent source review found no derived-role or metadata mismatch.

## Verification

Numerical sRGB/WCAG review of the new literal color pairs: all declared colors are within sRGB. Primary button text contrast is 7.74:1 light and 8.28:1 dark. Foreground/background is 14.53:1 light and 17.78:1 dark. Muted text on the secondary-control background is 5.22:1 light and 7.22:1 dark. These measurements cover the declared pairs, not every possible composited component state; rendered review and the broader Towbar audit remain separate evidence.

The initial brand pass had local build, typecheck, and focused browser evidence for light/dark boards and tasks, the dark creation modal/calendar, the 390×844 phone drawer, the bundled guide, and the identity frame on an incomplete OAuth-consent route. Exact source, browser and production receipts are recorded in [B1 verification](b1-verification.md) and the private release PR. The October 3 owner approval covers the logo and palette; documentation rework and release delivery remain open.
