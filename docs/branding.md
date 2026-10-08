# Mill brand foundation

Mill uses a literal tower mill mark and a brown accent with neutral light and dark surfaces. Use the supplied artwork and semantic theme tokens for application and documentation changes.

## Assets

- Source: [tower mill master](../assets/brand/mill-mark-source.png), generated with the built-in image tool.
- Application mark: [128px PNG](../apps/web/public/brand/mill-mark.png), supporting the 32px lockup at up to 4× density.
- Browser icon: [64px PNG](../apps/web/public/brand/mill-favicon.png).
- Touch icon: [180px PNG](../apps/web/public/brand/mill-touch-icon.png).

The same transparent mark works on light and dark surfaces. Asset derivatives retain the source artwork and alpha; they only change pixel dimensions for delivery. The application uses the shared MillMark component in navigation and the identity frame, including consent. Images have reserved dimensions, preserve their proportions, and are decorative beside the visible Mill name.

The generation prompt was: “Literal tower mill with four cream sails, tapered cocoa-brown tower, brown cap and small door. Towbar-style miniature 3D object, three-quarter orthographic perspective, smooth materials, rounded bevels, minimal broad seams, strong silhouette at 32px, transparent background, no lettering or badge.” The final refinement used the original Mill draft as the edit target and Towbar's logo as a style reference. No Towbar artwork is shipped in Mill.

The asset pack also includes light/dark wordmarks and lockups, a currentColor monochrome SVG, and a 1200×630 social preview. SVG wordmarks use Inter with system sans-serif fallback; lockups embed the delivered mark, while the social composition embeds the full-resolution source. The monochrome mark is a separate flat vector adaptation for single-color use.

- [Light lockup](../apps/web/public/brand/mill-lockup-light.svg) and [dark lockup](../apps/web/public/brand/mill-lockup-dark.svg)
- [Light wordmark](../apps/web/public/brand/mill-wordmark-light.svg) and [dark wordmark](../apps/web/public/brand/mill-wordmark-dark.svg)
- [Monochrome mark](../apps/web/public/brand/mill-mark-monochrome.svg)
- [Social preview PNG](../apps/web/public/brand/mill-social.png) and [editable SVG composition](../apps/web/public/brand/mill-social.svg)

## Theme

[Theme tokens](../apps/web/src/mill-theme.css) override HeroUI's semantic roles through the existing CSS base layer. Cocoa accents sit on nearly neutral white and gray surfaces in light mode, with light brown accents on near-black surfaces in dark mode. Secondary controls, tables, menus, dialogs, focus rings and accent chips derive their colors from those roles. Success, warning and danger hues retain their existing semantic definitions.

The [brand module](../apps/web/src/brand.tsx) and browser theme-color use the matching background values. Metadata uses their sRGB hex equivalents for browser compatibility: light `#f7f7f6` and dark `#060605`. The initial browser theme-color matches the light background and tracks the active theme after initialization. CSS tokens remain OKLCH.

The declarations below set Mill's semantic colors. Derived hover, soft, foreground, and focus roles use the shared theme formulas. Review contrast in the rendered component states when changing these tokens.

| Theme | Token                  | Mill value              |
| ----- | ---------------------- | ----------------------- |
| Light | `--accent`             | `oklch(0.44 0.077 55)`  |
| Light | `--accent-foreground`  | `oklch(0.99 0.005 65)`  |
| Light | `--background`         | `oklch(0.975 0.001 65)` |
| Light | `--foreground`         | `oklch(0.26 0.024 55)`  |
| Light | `--surface`            | `oklch(0.995 0.001 65)` |
| Light | `--surface-secondary`  | `oklch(0.958 0.002 65)` |
| Light | `--surface-tertiary`   | `oklch(0.935 0.002 65)` |
| Light | `--overlay`            | `var(--surface)`        |
| Light | `--muted`              | `oklch(0.505 0.019 55)` |
| Light | `--default`            | `oklch(0.942 0.002 65)` |
| Light | `--default-foreground` | `var(--foreground)`     |
| Light | `--field-background`   | `var(--surface)`        |
| Light | `--field-foreground`   | `var(--foreground)`     |
| Light | `--segment`            | `var(--surface)`        |
| Light | `--segment-foreground` | `var(--foreground)`     |
| Light | `--border`             | `oklch(0.87 0.002 65)`  |
| Light | `--separator`          | `oklch(0.91 0.002 65)`  |
| Dark  | `--accent`             | `oklch(0.76 0.092 60)`  |
| Dark  | `--accent-foreground`  | `oklch(0.2 0.017 55)`   |
| Dark  | `--background`         | `oklch(0.12 0.002 55)`  |
| Dark  | `--foreground`         | `oklch(0.955 0.012 65)` |
| Dark  | `--surface`            | `oklch(0.17 0.003 55)`  |
| Dark  | `--surface-secondary`  | `oklch(0.195 0.003 55)` |
| Dark  | `--surface-tertiary`   | `oklch(0.22 0.004 55)`  |
| Dark  | `--overlay`            | `oklch(0.205 0.003 55)` |
| Dark  | `--muted`              | `oklch(0.74 0.008 65)`  |
| Dark  | `--default`            | `oklch(0.235 0.004 55)` |
| Dark  | `--default-foreground` | `var(--foreground)`     |
| Dark  | `--field-background`   | `var(--surface)`        |
| Dark  | `--field-foreground`   | `var(--foreground)`     |
| Dark  | `--segment`            | `oklch(0.31 0.004 55)`  |
| Dark  | `--segment-foreground` | `var(--foreground)`     |
| Dark  | `--border`             | `oklch(0.285 0.004 55)` |
| Dark  | `--separator`          | `oklch(0.235 0.004 55)` |
