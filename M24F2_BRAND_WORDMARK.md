# M24F.2 — The ScoutBox™ wordmark

## The defect

The ™ sat a full gap to the right of the green square, reading as a
separate word: "ScoutBox ■  TM". The square (6 px in the sidebar, 8 px on
an entry heading) and the 7 px `gap` of the brand row pushed the mark
13–15 px away from the final "x".

## The recipe (one, shared)

The wordmark is the word "ScoutBox" in Albert Sans with a green square on
the baseline after the "x"; the ™ sits **above the square**, small and
raised, so it reads as part of the final letter — "ScoutBox™". The
optical gap between the "x" and the ™ is 2 px.

**Portals** — `design-system/platform.css`:

```css
.brand .tm, .login h1 .tm { font-size: 8px; line-height: 1; font-weight: 700; letter-spacing: 0.4px;
  align-self: flex-start; position: relative; top: 1px; margin: 0 0 0 calc(-6px - 7px + 2px); }
.login h1 .tm, .auth-form h1 .tm { font-size: 9px; top: 2px; margin-left: calc(-8px - 7px + 2px); }
```

The negative margin is `−(square) − (row gap) + 2 px`, so the mark lands
exactly over the square with the 2 px optical gap, in the sidebar, on
every entry heading (`.login h1`, `.auth-form h1`) and in the mobile
header, because they all compose the same `.wordmark` + `.tm` siblings.
`<sup class="tm" aria-label="trademark">TM</sup>` is announced as
"trademark", never read as the word "tm"; the brand itself is announced as
"ScoutBox".

**Player** — `scoutbox-player/src/components/Wordmark.tsx`: the row aligns
on the baseline; after the text a 2 px-offset column (`wordmark-mark`)
stacks the TM (`fontSize = max(7, round(size × 0.3))`,
`accessibilityLabel="trademark"`) above the green square, the column as
tall as the text's line-height, so the lock-up is identical to the portals'
at every size (onboarding, the headers, the guardian page).

## Where it appears

Portal sidebar (four apps), portal entry heading (four apps), the mobile
header, the Player onboarding and headers, the launcher.

## Verified

`m24f2DensityAudit`: the CSS carries the raised recipe and no rule
re-introduces the old gap; `Wordmark.tsx` stacks TM over the square.
`m24f2DensityLive`: at 390, 640×360, 1024 and 1440 on the Player,
Grassroots and Agent the TM's left edge is within the square's column
(≤ 6 px from the end of the word, never beyond it), its top is in the upper
half of the word, its font-size ≤ 10 px, and it carries the "trademark"
label. Close-ups: `design-system/screenshots/m24f2-after-*-wordmark-*.png`.
