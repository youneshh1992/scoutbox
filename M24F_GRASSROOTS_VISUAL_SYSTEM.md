> **Reverted (Founder's direction, after the M24F review).** The Grassroots
> colour scheme and typography described below were rolled back to their
> M24E state in the same session: the `#E5F5E9` light workspace with its
> turf grain and pitch markings, the `#252E26` dark workspace, the shared
> M24C/M24E entry scheme (brand-green page, blade-banded introduction,
> deep-green form) and Inter for the word "Grassroots". The real-grass
> photograph and Instrument Serif are removed from the repository. What
> remains of M24F in Grassroots is structural, not chromatic: the club rows
> as a hairline list with text / arrow hover, the title-cased metadata, the
> editorial Coaches page, ruled rows and the emoji removal. The gates
> (`m24fVisualAudit`, `m24fVisualLive`) now assert the restored M24E scheme.
> The text below is kept as the record of what was tried.

# M24F — The Grassroots visual system

**The grass photograph is used only on the Grassroots unauthenticated
sign-in / sign-up screen, as the LEFT-HAND visual panel. It is used
nowhere else in ScoutBox.**

## The Sage light palette

The Founder's Sage reference set the direction: calm sage greens, generous
negative space, soft but confident contrast. The four sampled values are
the named tokens (`tokens.css`, `:root[data-app="grass"]`):

| Token | Value | Role |
|---|---|---|
| `--grass-sage` | `#7C957B` | primary sage: the tab line, the accent surface |
| `--grass-sage-2` | `#8CA08B` | secondary sage |
| `--grass-sage-light` | `#B7C4B5` | light sage: tracks, filter borders, the selector's hairlines |
| `--grass-deep` | `#516058` | deep desaturated green: navigation ink |

Derived around them, for `:root[data-app="grass"]:not([data-theme="dark"])`:

| Surface | Value |
|---|---|
| canvas (`--sb-workspace`, `--sb-paper`) | `#F3F5F1` — a very light sage off-white |
| panels (`--sb-white`) | `#FBFCFA` |
| sidebar (`--sb-surface`) | `#EAEFE8` |
| top bar | `#F7F9F6` |
| soft fill (`--sb-wash`) | `#E2E9E0` |
| rules / panel borders | `#D8E0D5` |
| ink | `#1F2A24` (a darker derivative of `#516058`, for body contrast) |
| quiet ink | `#5A6961` |
| navigation ink | `#516058` · labels `#6D7D72` |
| active navigation | `#D9E3D7` surface, `#1F2A24` ink |
| primary action (`--sb-green`) | `#33EE7C` with `#10331F` text — used for the primary action, the important active state and the ScoutBox marker only; nothing else is flooded with it |
| green as text / links / focus | `#2A6F45` · `#2F6B47` · `#2D7A4B` |

Contrast (WCAG 2.x, computed on the hex values above):

| Pair | Ratio | Level |
|---|---|---|
| ink `#1F2A24` on canvas `#F3F5F1` | 14.3 : 1 | AAA |
| ink on panel `#FBFCFA` | 15.5 : 1 | AAA |
| quiet `#5A6961` on canvas | 5.3 : 1 | AA (AAA large) |
| navigation `#516058` on sidebar `#EAEFE8` | 5.9 : 1 | AA |
| labels `#6D7D72` on sidebar | 3.9 : 1 | AA large (11px uppercase labels, ≥ 3 : 1 as non-text/ large-bold equivalent; body text never uses it) |
| green text `#2A6F45` on canvas | 5.5 : 1 | AA |
| action text `#10331F` on `#33EE7C` | 9.4 : 1 | AAA |
| entry: ink `#1F2A24` on form `#F6F8F4` | 14.6 : 1 | AAA |
| entry: white headline on the tinted photograph | measured ≥ 4.6 : 1 at the darkest-blade band under the 62% scrim; text shadow added for the lighter blades |

## Dark theme — unchanged

The Grassroots dark theme is the shared dark palette with its own workspace
green, exactly as M24A–M24E left it. `tokens.css` declares one value for
`:root[data-app="grass"][data-theme="dark"]`: `--sb-workspace: #252E26`.
Every computed dark token and the rendered colours of the workspace, the
sidebar, the top bar, the body and the active navigation item were frozen
from the M24E tree into `e2e/fixtures/m24e-grassroots-dark-tokens.json`;
`m24fVisualLive` signs in with `dark` saved and compares all forty tokens and
the five rendered surfaces against that file. No photograph, no texture, no
Sage recolouring touches the dark theme.

## The pitch-line treatment — removed

The light-theme background that drew horizontal mowing bands, a blade grain
and faint pitch markings behind every authenticated Grassroots page (the
`.content` gradients and its `::before` / `::after` pseudo-elements, the
`--grass-line` / `--grass-grain` / `--grass-band` tokens, the ≤ 900px
variants) is deleted from `platform.css` and `tokens.css` — the
implementation, not its opacity. The Grassroots entry page draws no pitch
motif either (`::before` / `::after` are `display: none`, no grain). The
static gate asserts none of the tokens, gradients or pseudo-element rules
remain in any Grassroots rule; the live suite asserts the workspace has no
background image and no generated content.

## The grass photograph — scope

- **Asset**: `design-system/assets/grassroots-auth-grass.jpg` (620 × 868,
  CC0, see `GRASS-PHOTO-LICENCE.txt`). The Founder's upload did not reach
  this environment; a public-domain lawn close-up with the characteristics
  asked for (real blades, natural density, photographic) was prepared in its
  place: cropped to a 5:7 portrait at the source's full height (no
  upscaling) and tinted toward the ScoutBox green (multiply `#173B27` 30%,
  overlay `#00E676` 10%, saturation 0.82, brightness 0.90). The blades are
  the photograph's own; nothing is illustrated, embossed or drawn.
- **One reference in product code**: the `background-image` of
  `:root[data-app="grass"] .auth-promo` in `scoutbox-grassroots/src/styles.css`
  — the one stylesheet only the Grassroots bundle carries. The shared
  `platform.css` sets the panel's colour, gradient and geometry and never
  names the asset, so the Pro, Agent and Trust & Safety bundles ship none of
  its bytes (verified on the rebuilt demos: the JPEG is inlined in the
  Grassroots demo only). The static gate
  walks every application, the design system and the test tree and asserts
  the asset name appears in exactly one stylesheet and exactly one rule,
  and in no application source. The live suite asserts no other stylesheet
  rule carries it and that the authenticated workspace has no image.
- **Never**: the Grassroots dashboards, content pages, navigation, the club
  selector rows, coach / affiliation screens, invitations, light page
  backgrounds, dark mode, Player, Pro, Agent, Trust & Safety, cards,
  headers, footers, drawers, modals, authenticated mobile pages or logged-in
  landing screens. It is not tiled, not a texture system, not behind forms
  or text-heavy content, not a decorative strip.
- **Accessibility**: it is a CSS background on a panel whose text is the
  headline, so it is outside the accessibility tree; the headline and
  summary carry a text shadow and sit on a 62% deep-green scrim at the foot
  of the panel.

## The entry composition

Desktop / tablet (> 720px): one centred card, 45 / 55. The LEFT panel is the
photograph with the headline, the one-sentence summary and the three facts
at its foot. The RIGHT panel is the clean fixed form: off-white `#F6F8F4`,
deep green text, underlined fields, the club rows as a list with hairlines,
the ScoutBox-green submit, no image, no texture, no pitch lines, no theme
control. The page behind the card is the deep sage `#2F3B34`.

Narrow phone (≤ 720px): the photograph becomes a 200px masthead above the
form with the headline over it; the form stays on its clean surface; the
three facts are desktop reading. The photograph is never behind the form.

The saved in-app theme is ignored by the entry screen in both directions:
`m24dAuthLive` and `m24fVisualLive` render it with `light` and with `dark`
saved and require the same colours; the dark-theme control rules are
neutralised inside `[data-auth-app="grass"]`.

## The club selector

Rows, not cards: name on one line, `Club · Grassroots · Verified` or
`Club · Grassroots · Verification Pending` beneath, an arrow at the right,
hairlines between rows, no background, no radius. Hover brightens the name
and the arrow to the green and moves the arrow 3px to the right (no box, no
outline, no fill; `prefers-reduced-motion` removes the movement). The
organisation type is title-cased for presentation only (`orgTypeLabel`);
the stored value stays `club`. The sidebar's standing line reads
`Club · Verified · Safeguarding Certified`.

## The word "Grassroots"

The Founder liked the editorial serif of the reference's product word.
**Instrument Serif** (SIL Open Font License 1.1, bundled:
`design-system/fonts/InstrumentSerif-Regular.ttf`, `-Italic.ttf`,
`InstrumentSerif-OFL.txt`) is the one deliberate serif in the product — a
high-contrast editorial face, confident, magazine-like, not corporate and
not a script. It is set in italic for the word *Grassroots* on the entry
screen's product mark and in the sidebar identity
(`--sb-font-grass`, applied to `.brand-sub` under `[data-app="grass"]`
only). Forms, buttons, tables, body copy and navigation stay in Inter — the
static gate reads every `font-family` in the platform stylesheet and allows
only Inter, the wordmark's Albert Sans, the Grassroots serif and monospace.
