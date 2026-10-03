# M24F.2 — The Grassroots visual system (light), the entry, and the Agent navigation

Baseline `e5fe716`. This supersedes the Sage direction of M24F (reverted in
`88993b8`) for the LIGHT theme only. The DARK Grassroots theme is unchanged
from M24E, token for token (the frozen fixture
`e2e/fixtures/m24e-grassroots-dark-tokens.json` is still compared live).

## 1. The authenticated LIGHT workspace

Follows the dashboard reference the Founder supplied: a deep navy sidebar,
a cool near-white canvas, white surfaces, two quiet secondary washes (blue
and green), the ScoutBox green for the one primary action.

| Role | Token | Value |
|---|---|---|
| Canvas | `--sb-workspace`, `--sb-paper` | `#F7F9FC` |
| Sidebar | `--sb-surface` (the sidebar reads it) | `#063856` |
| Top bar, panels, inputs | `--sb-topbar`, `--sb-white`, `--sb-input` | `#FFFFFF` |
| Secondary blue wash | `--sb-wash`, `--sb-candidate-bg`, `--sb-avatar-bg`, `--sb-count-bg` | `#EEF4FB` |
| Secondary green wash | `--sb-note`, `--sb-nav-active-bg`, `--sb-mine` | `#EAF8F0` |
| Primary action | `--sb-green` / `--sb-green-ink` | `#33EE7C` / `#0B2A18` |
| Primary text | `--sb-ink` | `#0B1C2D` |
| Secondary text | `--sb-quiet` | `#5B6B7A` |
| Rules | `--sb-rule`, `--sb-panel-border` | `#E3E9F0` |
| Green text, links | `--sb-green-text`, `--sb-link` | `#0F7A44`, `#1B6F49` |

Declared in `design-system/tokens.css` under
`:root[data-app="grass"]:not([data-theme="dark"])`. The sidebar re-declares
its own ink, quiet, rule, wash, avatar and active tokens on `.sidebar`
(`platform.css`) so the navy column carries white type, a translucent
white wash on hover, a green inset bar and a green icon on the active
destination, and a readable salmon Sign out (`#FFB4A8`).

No turf grain, no pitch markings and no photograph stand behind the light
workspace: the M24E grain and marking rules are now scoped to
`[data-theme="dark"]`.

### Contrast (WCAG, computed)

| Pair | Ratio |
|---|---|
| Ink `#0B1C2D` on canvas `#F7F9FC` | 16.3 |
| Quiet `#5B6B7A` on canvas | 5.2 |
| Green text `#0F7A44` on canvas | 5.1 |
| Link `#1B6F49` on canvas | 5.8 |
| Green ink `#0B2A18` on the green action `#33EE7C` | 10.1 |
| White on the navy sidebar `#063856` | 12.3 |
| Sidebar quiet (white at 72 %) on navy | 7.1 |
| Sidebar navigation `#CFDBE6` on navy | 8.7 |
| Sidebar section label `#8FA6BA` on navy | 4.9 |
| Sign out `#FFB4A8` on navy | 7.2 |
| Note ink `#14532D` on the green wash `#EAF8F0` | 8.3 |

Every text pair is at or above 4.5 : 1.

## 2. The Home

`scoutbox-grassroots/src/homeScreen.tsx`. In order: a welcome line (first
name, club, role); ONE primary action chosen by the first rule that applies
(a trial awaiting its mandatory report → File the trial report; unread
messages → Open your inbox; an unverified club → Complete club
verification; otherwise Find players near you) with one quiet sentence
saying why; a row of counts read from the club's own endpoints
(shortlisted, open requests, trials awaiting report, squad size — a count
the server refuses is simply absent); Needs your attention (unchanged:
unread messages, verification requests for reviewers); **Club progress** —
five facts with an honest state word each (club verification, safeguarding
certificate, club email domain, positions being recruited, squad
coverage), no invented percentage; **Recent activity** — up to eight
compact feed rows; **Quick actions** — four text links. Nothing on the Home
is a card; nothing is a filled tile.

## 3. The entry (sign-in) left panel

- **All diagonal lines removed** from the introduction panel — not faded.
  The M24E blade bands (`repeating-linear-gradient(103deg …)`) are gone
  from `platform.css`.
- **The real-grass photograph** (`design-system/assets/grassroots-auth-grass.jpg`,
  licence beside it) is permitted here and nowhere else. The rule lives in
  `scoutbox-grassroots/src/styles.css`, so no other bundle carries the
  bytes and no authenticated screen can reach it.
- **One very subtle centre-circle and halfway-line motif** over the
  photograph: a 2 px ring at 36 % of the panel in white at 16 % and a 1 px
  vertical line at 13 %, drawn as CSS gradients (decorative; the panel's
  accessible name is its headline).
- **Restrained copy**: the headline "Your club. Your community. Your next
  player.", one sentence ("Federation-registered grassroots clubs, scouting
  within 50 km of their ground."), no bullet points at any width. The demo
  build shows "DEMO ENVIRONMENT" as a small uppercase line, not a notice.
  `AuthPage` renders no list when `points` is empty.

## 4. Agent — active navigation in gold

The Agent's active navigation state is gold in both themes, for every
destination (sections, children, shortcuts), never green:

| Theme | Active background | Active text | Bar / icon |
|---|---|---|---|
| Dark (default) | `rgba(199,169,107,.14)` | `#D0B57B` | `#C7A96B` |
| Light (cream) | `#F7F1E3` | `#7A5A1C` | `#A67C2E` |

Not colour-only: the active destination also carries a 3 px inset bar on
its left edge and `aria-current` (unchanged). Contrast: `#D0B57B` on the
dark sidebar 9.3 : 1; `#7A5A1C` on `#F7F1E3` 5.6 : 1.

## Tests

`m24fVisualAudit` (tokens, dark-only grain, no bands, photo scope),
`m24fVisualLive` (the entry at four widths in both saved themes, the light
workspace at 390 / 1024 / 1440, the dark fixture), `m24f2DensityAudit` and
`m24f2DensityLive` (the Home's hierarchy, the Agent gold at both themes,
the centre-circle rule, no diagonal gradient on the panel).
