# M24E — The entry screens have one appearance

Login, sign-up and entry screens render in ONE fixed appearance. There is
no light / dark / night control before sign-in, and the screen never
follows the theme the person saved inside the application.

## What was removed

| App | Control removed | Where it was |
|---|---|---|
| Pro | `ThemeToggle` in the entry toolbar | `scoutbox-club/src/App.tsx` `Login` |
| Grassroots | `ThemeToggle` in the entry toolbar | `scoutbox-grassroots/src/App.tsx` `Login` |
| Agent | `ThemeToggle` in the entry toolbar | `scoutbox-agent/src/App.tsx` `Login` |
| Trust & Safety | `ThemeToggle` in the key screen toolbar | `scoutbox-admin/src/App.tsx` |
| Player | `ThemeSwitch` in the entry header | `scoutbox-player/src/app/onboarding.tsx` |

Five toggles removed. The authenticated toggles stay exactly where they
were (the portal top bar, the Player's page header and the guardian
dashboard).

## The fixed appearance

- **Pro, Grassroots, Trust & Safety**: the M24C.3 scheme — dark football
  green page and form (`#173B27`), bright green introduction (`#00E676`,
  turf on Grassroots), white / `#CFDFD0` text. The `--auth-*` tokens on
  `.login.auth-page` never read `data-theme`; the page declares
  `color-scheme: dark` so native controls (select, scrollbars) match
  whatever the document attribute says.
- **Agent**: its own dark personality, fixed — `#121415` introduction,
  `#202223` form, cream `#FDFAF4` ink, the muted gold `Agent` label on its
  cream badge. The previous rule that mapped the entry screen onto the
  saved cream / dark workspace tokens is gone; nothing on the Agent entry
  screen follows `data-theme`.
- **Player**: the entry screen already drew itself from `AUTH_PANEL` /
  `AUTH_PAGE`; now the surround outside the 430px column and the page body
  are the entry green too while `/onboarding` is open (`MobileViewport`),
  whatever appearance the player saved.

## Theme storage is untouched

`sb-theme:pro | grass | agent | safety | player` is written only by the
authenticated toggle and read again after sign-in. Sign out does not
delete it. The pre-paint script in each `index.html` still stamps the saved
theme on `<html>` so the workspace never flashes; the entry screen ignores
the stamp.

Verified by `m24dAuthLive`: for each portal the entry screen's page, form,
introduction and ink colours are identical with `dark` and with `light`
saved; no `[data-theme-toggle]`, `.p-theme-toggle` or `role="switch"` on
any entry screen; inside Pro the toggle is present, toggling to dark
persists across a reload, after Sign out the entry screen is the fixed
green while the saved `dark` remains in storage, and signing back in
restores `data-theme="dark"`. The Player's entry screen has no switch;
once signed in the switch is there.
