# M23 P2.5 — Page Header Contract

What a page in ScoutBox may draw above its content, and what it may not.
Applies to Pro and Grassroots (shared `navui.tsx`), the Player app
(`PageChrome.tsx`), and — by policy though not by code — the T&S console.

## 1. The top bar is the page header

One row, at every width.

| slot | content | rule |
|---|---|---|
| hamburger | ≤ 900px only | opens the drawer |
| **`h1.page-title`** | `<crumb> / <page>` — the owning section muted, the page label bold | the **only** `h1` in the document; text = the nav label of the page (so a test can anchor on it and a screen reader hears it once) |
| live state | a dot while healthy; a red pill with text while reconnecting | the one state a person must act on gets words; the healthy state gets a glyph |
| bell | unread count | unchanged |
| Report / Block | glyph + label; label hidden < 640px, `aria-label` always | never removed on any width (§33) |

Height: `min-height: 48px` with `--chrome-y`/`--chrome-x` padding — 54px on
a phone, 58px on a desktop. The organisation's standing badges live in the
sidebar account block (`OrgChips`), not here.

## 2. What a screen may draw above its content

| element | allowed | rule |
|---|---|---|
| a second page title (`h2` repeating the h1) | **no** | removed from 17 screens per app; navLive N1 asserts `.content h2` is empty on entry |
| a sub-section title (`h2`/`h3`) inside the content | yes | it names a *part* of the page (e.g. Second Look "Compare"), not the page |
| explanatory prose describing the page | **no** | if a page needs a paragraph to say what it is, the label is wrong |
| a **material constraint** | yes, as `p.pagehint` | one line, 12.5px, muted, no box: append-only, no direct channel, guardian routing, no scores, gate notes. If it does not change what the person may do, it is not a constraint |
| a **status warning** | yes, `.notice.warn` | e.g. "3 trials awaiting a mandatory report" — it is state, and it disappears when resolved |
| an error | yes, `.notice.block` | unchanged |
| a page-level tab row | yes, `role="tablist"` | functions of this destination (Room sections, Player Football/You); never destinations |
| filters / primary actions | yes | on the first content row, not in a header block |

## 3. Entity headers (the Recruitment Room)

An entity header is one **identity row** plus one **disclosure**.

```
[ Name   position · age · club            ]   [ Move to ▾ ] [Apply] [Open player profile]
[ Status ] [ Priority ] [ Room health ] [ Restricted ]
Trust Score  74 / 100  [band] [demo]  disclaimer…
evidence confidence — not football ability.  Rooms are ordered by most recent activity; never ranked by Trust Score.
▸ Room details        (lead · owner · updated · source · priority · lead · restricted · tags)
```

Rules: the primary transition and the profile link are visible; facts that
are read once per visit (owner, updated, source) and controls used rarely
(priority, lead, restricted, tags) sit behind the disclosure; the Trust
Score's disclaimer and the no-ranking statement are **never** collapsed
(they are what make the number honest, and four suites assert them); the
conflict notice stays above everything (the one message the person must
not miss). `aria-label="Room header"` and `.badges` (status lives there)
are stable test anchors.

## 4. Player app

`PageHeader({ title, back?, action?, hint? })`: one row — optional back
control, the `h1` (`role="heading"`, level 1, 21px), an optional primary
action, then the bell and ⚑ Report. `hint` is the one-line equivalent of
`.pagehint`. `PageTabs` is a real tablist (`role="tab"`, `aria-selected`)
and reads `?tab=` for deep links. No screen draws its own title row.

## 5. Tokens (Pro + Grassroots `styles.css`)

| token | value | used by |
|---|---|---|
| `--sidebar-w` / `--sidebar-w-collapsed` | 218px / 64px | `.shell`, `.sidebar` |
| `--chrome-x` / `--chrome-y` | 18px / 8px | top bar padding |
| `--title-size` | 17px | `h1.page-title` |
| `--nav-item-py` / `--nav-child-py` | 7px / 5px | sidebar rows |
| `--content-pad` | 18px (16px ≤ 640px) | `.content` |

Changing a token changes every page; no screen sets its own header
spacing.

## 6. How this is enforced

- navLive N1: exactly one `h1`; no `.content h2` on entry; no `.subnav` on
  the desktop.
- navLive N5: phone top bar ≤ 64px; Report / Block has a non-empty
  accessible name at 420px; no horizontal overflow.
- `chromeMetrics` / `roomMetrics` (scratch measurements recorded in
  `M23_P25_FINAL_IA.md` §7) are the before/after evidence.
- Test anchors: `.topbar h1.page-title`, `[aria-label="Room header"]`,
  `[aria-label="Room header"] .badges`, `[aria-label="Room sections"]`,
  `getByRole('tab', { name })`.

## 7. Adding a page later

1. Add the screen id to `nav.ts` (and to a group if its section is
   grouped; `validateNavConfig()` fails the build-time test otherwise).
2. Add EN and FR labels (navConfig fails if either is missing).
3. Do not draw a title. If you need a sentence at the top, ask whether it
   is a constraint; if it is, it is a `.pagehint`; if it is not, delete it.
4. A Contact Workflow, an Offer, an Outcome: a **tab** inside the Room or a
   panel on Signings & Outcomes — not a destination.
