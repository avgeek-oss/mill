# Mill brand foundation

Mill uses the tower mill artwork designed in Sketch and a brown accent with neutral light and dark surfaces. Use the supplied artwork and semantic theme tokens for application and documentation changes.

## Assets

The editable source is [Mill.sketch](https://github.com/avgeek-oss/mill/blob/main/assets/brand/Mill.sketch), copied unchanged from the design document. Keep only the exported assets used by the application and documentation:

- Application mark: [256px transparent PNG](https://github.com/avgeek-oss/mill/blob/main/apps/web/public/brand/mill-mark.png).
- Browser icon: [64px PNG](https://github.com/avgeek-oss/mill/blob/main/apps/web/public/brand/mill-favicon.png), exported from the favicon symbol.
- Touch icon: [180px PNG](https://github.com/avgeek-oss/mill/blob/main/apps/web/public/brand/mill-touch-icon.png).
- Social preview: [1200×630 PNG](https://github.com/avgeek-oss/mill/blob/main/apps/web/public/brand/mill-social.png), exported from Sketch's OpenGraph group.

The application combines the icon-only MillMark with the name rendered as text through the shared BrandLockup component. The sidebar also supplies its logo and title separately. Do not embed the app name in a logo image. Images have reserved dimensions, preserve their proportions, and are decorative beside the visible Mill name. The social card includes text because link previews display it as one image.

Documentation copies the application mark, favicon, and social card during `pnpm docs:build`. Unused wordmarks, combined logo images, alternate exports, and intermediate PNG masters are not kept in the repository; regenerate artwork from the Sketch source when needed.

## Export from Sketch

From the repository root on a Mac with Sketch installed:

```sh
sketchtool=/Applications/Sketch.app/Contents/MacOS/sketchtool
export_dir=$(mktemp -d)
"$sketchtool" export layers assets/brand/Mill.sketch \
  --items=C8AE01E3-9256-4388-B4DE-98D2C5CEDD25 \
  --formats=png --scales=0.64,0.45 --output="$export_dir" \
  --overwriting=YES --without-activating=YES
"$sketchtool" export layers assets/brand/Mill.sketch \
  --items=0E57921F-4D51-421D-829B-0966928463BA \
  --formats=png --scales=0.16 --output="$export_dir" \
  --overwriting=YES --without-activating=YES
"$sketchtool" export layers assets/brand/Mill.sketch \
  --items=1E62C943-841F-46B7-96A6-867BFD302407 \
  --formats=png --scales=1 --output="$export_dir" \
  --overwriting=YES --without-activating=YES
cp "$export_dir/mill_light_transparent@0.6x.png" apps/web/public/brand/mill-mark.png
cp "$export_dir/mill_light_transparent@0.5x.png" apps/web/public/brand/mill-touch-icon.png
cp "$export_dir/mill_favicon@0.2x.png" apps/web/public/brand/mill-favicon.png
cp "$export_dir/OpenGraph.png" apps/web/public/brand/mill-social.png
pnpm docs:build
```

Sketch rounds the scale suffixes in filenames. Verify the exports are 256×256, 180×180, 64×64, and 1200×630 pixels respectively, and preserve transparency in the mark and icons.

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
