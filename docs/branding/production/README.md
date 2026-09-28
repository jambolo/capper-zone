# Rally Row production artwork

Primary treatment: off-white lettering and upper R, electric-blue middle row, and
coral lower row on midnight navy. Updated September 28, 2026.

## Typography roles

| Application | Approved treatment |
| --- | --- |
| Interface page and section headlines | Barlow Condensed Bold (700), upright, sentence case |
| Body text, buttons, controls, and data | Inter/system sans-serif; tabular numerals for aligned data |
| Logo wordmark | Fixed, condensed, slanted Anton outlines in the supplied artwork |
| Logo tagline | Fixed Inter outlines: "A little insight. A lot to talk about." |

The bundled Anton and Inter fonts reproduce the logo artwork. Barlow Condensed is
the separately selected interface headline font and is not included in this logo
asset package. The repository's `docs/branding.md` records the approved messaging
and full brand direction.

## Logo files

| File | Use |
| --- | --- |
| [Primary logo](svg/rally-row-primary.svg) | Transparent horizontal logo for navy backgrounds |
| [Primary logo with tagline](svg/rally-row-tagline-primary.svg) | Transparent primary logo with the selected tagline |
| [Logo with navy background](svg/rally-row-tagline-on-navy.svg) | Complete primary color treatment with its background included |
| [Stacked logo](svg/rally-row-stacked-primary.svg) | Transparent vertical composition for navy backgrounds |
| [Secondary logo](svg/rally-row-on-light.svg) | Navy, blue, and coral for light backgrounds |
| [Secondary logo with tagline](svg/rally-row-tagline-on-light.svg) | Secondary treatment with the selected tagline |
| [Black logo](svg/rally-row-mono-black.svg) | Single-ink use on light backgrounds |
| [White logo](svg/rally-row-mono-white.svg) | Single-ink use on dark backgrounds |

Standalone marks use the `rally-row-mark-` filename prefix. SVG is the master
format: all lettering is outlined, with no embedded raster images, linked assets,
or font dependencies. PNG exports are in [png](png), at four times the SVG's
nominal dimensions. The stacked PNG also includes the navy background.

## Favicon files

| File | Use |
| --- | --- |
| [favicon.svg](favicon/favicon.svg) | Scalable browser icon with a navy tile |
| [favicon.ico](favicon/favicon.ico) | Browser fallback containing 16, 32, and 48 pixel images |
| `favicon-16.png`, `favicon-32.png`, `favicon-48.png`, `favicon-64.png` | Individual browser icon sizes |
| [apple-touch-icon.png](favicon/apple-touch-icon.png) | 180 pixel icon with an opaque background |
| `favicon-192.png`, `favicon-512.png` | Larger square icon exports |

Every icon derives from the same three master paths used in the logo. The favicon
omits lettering and adds a navy tile so its colors remain consistent on browser
tabs with light or dark backgrounds. The web app uses the SVG and ICO favicons and
Apple touch icon, copied into `apps/web/public`, along with the primary horizontal
logo in `apps/web/public/brand`. Keep these published copies aligned with the masters.

The app's interface fonts and their licenses are hosted in `apps/web/public/fonts`.
Barlow Condensed Bold comes from [Google Fonts](https://github.com/google/fonts/tree/main/ofl/barlowcondensed);
Inter comes from this package's source files.

## Usage

- Use the primary treatment on navy `#101B2D`. Off-white is `#F5F7FB`, blue is `#2667FF`, and coral is `#FF6B5E`.
- Reserve the navy-lettered version for light surfaces. The monochrome exports use pure black `#000000` or pure white `#FFFFFF` when only one ink is available.
- Keep at least one quarter of the mark's height clear around visible artwork. Add surrounding space where a supplied crop is tighter.
- Use the horizontal logo without its tagline below 360 pixels wide. Use the standalone mark below 160 pixels wide.
- Keep the logo's proportions, row spacing, colors, and lettering fixed. Avoid shadows, gradients, outlines, and rearranged rows.
- Use the SVG master for print layout. The supplied files use RGB colors; process-color conversion belongs in the printer's color-managed workflow.

## Source and reproduction

The abstract R was rebuilt as three smooth vector paths from the approved concept.
The wordmark uses outlined Anton lettering, condensed and slanted for the approved
broadcast style. The tagline uses outlined Inter. The logo is a vector refinement
of the approved raster concept, rather than a pixel-exact trace.

Font sources and their SIL Open Font License notices are retained in [source](source):
[Anton](https://github.com/google/fonts/tree/main/ofl/anton) and
[Inter](https://github.com/google/fonts/tree/main/ofl/inter).
The font files are unchanged; the artwork's letter outlines carry the visual adjustments.

The built-in image generation tool supplied a refinement reference. Its transparent
outputs showed edge artifacts, so final SVG and PNG assets use the clean vector
reconstruction. The generation prompts and color correction are recorded in
[the prompt log](source/generation-prompts.md).

On Windows, rebuild the text outlines with PowerShell:

```powershell
./source/outline-type.ps1
./source/outline-type.ps1 -FontFile Anton-Regular.ttf -Text 'RALLY ROW' -Output wordmark.json
```

With Node.js and the `sharp` package available, rebuild the exports:

```powershell
node ./source/build-assets.cjs
```

[preview.png](preview.png) displays the exported logo variants and native-size favicons.
