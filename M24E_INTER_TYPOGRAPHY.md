# M24E — Inter is the product typeface

## Source

Inter 4.1 by Rasmus Andersson, SIL Open Font License 1.1, taken from the
official release archive (`github.com/rsms/inter`, `Inter-4.1.zip`) because
the supplied files did not reach this environment; the two variable files
are the same faces Google Fonts distributes under the names the brief uses,
and they are stored under those names:

| File | Face | Where |
|---|---|---|
| `Inter-VariableFont_opsz,wght.ttf` (879 KB) | upright, weight axis 100–900, optical-size axis 14–32 | `design-system/fonts/` (the four portals share it) and `scoutbox-player/assets/fonts/` (Expo bundles assets from inside the app, so the Player needs its own copy — the one duplication) |
| `Inter-Italic-VariableFont_opsz,wght.ttf` (910 KB) | italic, the same axes | the same two places |
| `Inter-OFL.txt` | the licence | beside each copy |

Nothing is fetched from Google Fonts or any other host at runtime: the
portals ship the files as Vite assets (inlined as data URIs in the
single-file demos), the Player web export ships them as Metro assets, and
iOS / Android bundle them with the app.

## Weights

Variable weights, no duplicate static files: 400 regular (body), 500
medium (navigation, metadata), 600 semibold (labels, buttons, tabs), 700
bold (headings, names), 800 extra-bold only where the reference asks for
it. The italic file serves `font-style: italic`; the browser never obliques
the upright face because the italic face is declared for the same family.
`font-optical-sizing: auto` lets Inter's optical-size axis follow the text
size. No text size was changed for Inter.

## Portals (`design-system/fonts.css`, `tokens.css`)

```
@font-face { font-family: 'Inter'; font-style: normal; font-weight: 100 900; font-display: swap; src: url('./fonts/Inter-VariableFont_opsz,wght.ttf') format('truetype'); }
@font-face { font-family: 'Inter'; font-style: italic; font-weight: 100 900; font-display: swap; src: url('./fonts/Inter-Italic-VariableFont_opsz,wght.ttf') format('truetype'); }
--sb-font: 'Inter', -apple-system, system-ui, 'Segoe UI', sans-serif;
```

Every portal already read `--sb-font` on `html`, `body`, buttons, inputs,
`kbd` and the tokens root, so body copy, headings, forms, buttons, tabs,
navigation, tables, metadata, notifications, cards, drawers, modals and the
entry screens all moved with the token. The launcher page follows the same
rule.

## Player (`components/Text.tsx`, `app/_layout.tsx`)

- **Web**: `_layout.tsx` registers both files as ONE family `Inter` with the
  100–900 range and the italic style (expo-font would register each file as
  a single-weight face and the browser would synthesise the rest), and sets
  `html, body, input, textarea, button` to Inter. `Text` / `TextInput` keep
  `fontWeight` and `fontStyle`, so `600` is the real semibold and italic the
  real italic.
- **iOS / Android**: expo-font registers the upright file as `Inter` and the
  italic file as `Inter-Italic` (`useFonts` before the first draw); the
  weight travels as `fontWeight`, the italic as the family name, so the
  platform never obliques an upright face. Native rendering is unverified
  in this environment (no simulator); the registration and the code path
  are the same expo-font mechanism the previous static faces used.
- `fontFamily: 'monospace'` on identifiers and codes is kept as asked.

## The wordmark exception

The ScoutBox wordmark — **ScoutBox**, the green square, ™ — keeps Albert
Sans ExtraBold. It is the established brand mark and is deliberately
distinct from the product typography. Only `.wordmark` (`--sb-font-brand`)
in the portals and `Wordmark.tsx` (`<Text brand>`, the `AlbertSans-ExtraBold`
face) on the Player reach for it. For that one use the repository keeps
`design-system/fonts/AlbertSans[wght].ttf` + `AlbertSans-normal.woff2` and
`scoutbox-player/assets/fonts/AlbertSans-ExtraBold.ttf`; the italic and the
other static Albert Sans faces are deleted. Nothing else names Albert Sans
(`design-system/reference/ScoutBox-Design-Explorer.html` is the archived
reference page and is not shipped).

## Verified

`m24dAuthLive`: computed Inter on labels, buttons and the headline of every
entry screen, `document.fonts.check` for the 400 / 600 / italic faces, the
wordmark in Albert Sans. `m24eScrollLive` F: computed Inter on heading,
body, button, navigation and form label inside Pro, Grassroots, Agent and
Trust & Safety; on the Player, the two faces registered as one family with
the 100–900 range, every piece of text, the bottom navigation and the page
heading in Inter, the wordmark in the brand face, and no font warning in
any console.
