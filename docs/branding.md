# Mill brand foundation

Mill uses the tower mill artwork designed in Sketch and a brown accent with neutral light and dark surfaces. Use the supplied artwork and semantic theme tokens for application and documentation changes.

## Assets

The editable source is [Mill.sketch](https://github.com/avgeek-oss/mill/blob/main/assets/brand/Mill.sketch), copied unchanged from the design document. Native exports are kept in [assets/brand/exports](https://github.com/avgeek-oss/mill/tree/main/assets/brand/exports): seven 1024×1024 PNG variants for transparent, edged, opaque, and favicon use, plus the 1200×630 Open Graph card. Sketch names the 1024px exports `@2x`; their actual dimensions are 1024×1024.

- Source PNG: [1024px transparent mark](https://github.com/avgeek-oss/mill/blob/main/assets/brand/mill-mark-source.png).
- Application mark: [256px PNG](https://github.com/avgeek-oss/mill/blob/main/apps/web/public/brand/mill-mark.png), supporting the 32px lockup at high pixel density.
- Browser icon: [64px PNG](https://github.com/avgeek-oss/mill/blob/main/apps/web/public/brand/mill-favicon.png), exported from the favicon symbol.
- Touch icon: [180px PNG](https://github.com/avgeek-oss/mill/blob/main/apps/web/public/brand/mill-touch-icon.png).
- Social preview: [1200×630 PNG](https://github.com/avgeek-oss/mill/blob/main/apps/web/public/brand/mill-social.png) and [native SVG export](https://github.com/avgeek-oss/mill/blob/main/apps/web/public/brand/mill-social.svg) of Sketch's OpenGraph group.

The application uses the transparent mark through the shared MillMark component in navigation and the identity frame, including consent. Images have reserved dimensions, preserve their proportions, and are decorative beside the visible Mill name. Documentation copies the application assets during `pnpm docs:build`; the retained static site assets use the same exports.

Light/dark wordmarks and lockups remain available. SVG wordmarks use Inter with system sans-serif fallback; lockups embed the corresponding full-resolution Sketch mark. The currentColor monochrome SVG is a separate flat vector adaptation for single-color use.

- [Light lockup](https://github.com/avgeek-oss/mill/blob/main/apps/web/public/brand/mill-lockup-light.svg) and [dark lockup](https://github.com/avgeek-oss/mill/blob/main/apps/web/public/brand/mill-lockup-dark.svg)
- [Light wordmark](https://github.com/avgeek-oss/mill/blob/main/apps/web/public/brand/mill-wordmark-light.svg) and [dark wordmark](https://github.com/avgeek-oss/mill/blob/main/apps/web/public/brand/mill-wordmark-dark.svg)
- [Monochrome mark](https://github.com/avgeek-oss/mill/blob/main/apps/web/public/brand/mill-mark-monochrome.svg)

## Export from Sketch

From the repository root on a Mac with Sketch installed:

```sh
sketchtool=/Applications/Sketch.app/Contents/MacOS/sketchtool
"$sketchtool" export layers assets/brand/Mill.sketch \
  --items=C8AE01E3-9256-4388-B4DE-98D2C5CEDD25,44BF5C0F-3D7E-446F-A392-74E63EE68334,04636875-A2D2-4024-A964-2D5CC35D4242,5A94D076-6099-4F7D-8A17-7B323695E056,F07C6ECF-5C2F-46AC-AB0B-1D7067784F33,9B02298D-9D2A-481A-BB3D-782055A4F7B3,0E57921F-4D51-421D-829B-0966928463BA \
  --formats=png --scales=2.56 --output=assets/brand/exports \
  --overwriting=YES --without-activating=YES
"$sketchtool" export layers assets/brand/Mill.sketch \
  --items=1E62C943-841F-46B7-96A6-867BFD302407 \
  --formats=png --scales=1 --output=assets/brand/exports \
  --overwriting=YES --without-activating=YES
```

Use the transparent light symbol ID `C8AE01E3-9256-4388-B4DE-98D2C5CEDD25` at scale `0.64` for the 256px application mark and `0.45` for the 180px touch icon. Export the favicon symbol ID `0E57921F-4D51-421D-829B-0966928463BA` at scale `0.16` for the 64px browser icon. The OpenGraph group can also export as SVG at scale `1`. Copy those exports to the existing asset paths, update the embedded marks in the light/dark lockups, and run `pnpm docs:build` to synchronize documentation assets.

## Theme

[Theme tokens](https://github.com/avgeek-oss/mill/blob/main/apps/web/src/mill-theme.css) override HeroUI's semantic roles through the existing CSS base layer. Cocoa accents sit on nearly neutral white and gray surfaces in light mode, with light brown accents on near-black surfaces in dark mode. Secondary controls, tables, menus, dialogs, focus rings and accent chips derive their colors from those roles. Success, warning and danger hues retain their existing semantic definitions.

The [brand module](https://github.com/avgeek-oss/mill/blob/main/apps/web/src/brand.tsx) and browser theme-color use the matching background values. Metadata uses their sRGB hex equivalents for browser compatibility: light `#f7f7f6` and dark `#060605`. The initial browser theme-color matches the light background and tracks the active theme after initialization. CSS tokens remain OKLCH.

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
