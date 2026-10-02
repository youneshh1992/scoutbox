# M24D — Authentication and onboarding: the personality pass

The M24C composition stays — the dark football green page and form, the
bright green introduction, the Grassroots turf, the Agent's own two
backgrounds, the Trust & Safety key screen, `ScoutBox▪™` with Albert Sans,
"Built by Guni & Younes". What changed is the discipline inside it: one
focal point, one primary action per step, rows instead of cards, no icon
circles, no emoji, no badges, short copy, more air.

## The reset, per application

| App | Removed | Now |
|---|---|---|
| **Player** (`app/onboarding.tsx`) | the two role cards with emoji in circles (🏃 / 🛡️) and a chevron, the 🔗 pairing link, the ✓ / 🛡 check lists in cards, avatar circles on the demo rows, the step dots, the nested cards inside every step, the two stacked sign-in forms with two primary buttons | **Create your ScoutBox account** / *Choose how you're joining ScoutBox.* / rows **Player → · Parent → · Guardian → · Use an invitation code →** on hairlines; "Clubs come to you. You never pay to be seen." as one quiet line; Sign in is one form at a time (Parent or guardian \| Player (18+)) with one primary action, labels, show / hide, validation and preserved input; steps are plain groups with a heading and "Step n of 5"; the promises are a plain list with the brand square as marker |
| **Agent** (`scoutbox-agent/src/App.tsx`) | the agency card with `agency` / plan pills, the demo roster as outlined buttons with role pills, the duplicate agency badge, the demo pill | **AGENCY** / North Star Sports Agency / *Choose a profile to continue.* / rows **Tomás Rivera — Agency administrator → · Ana Costa — Licensed agent → · Ben Okoro — Analyst →**; several agencies are rows too; dark `#121415 / #202223`, cream `#FDFAF4 / #F9F6EF` and the muted gold label unchanged |
| **Pro** (`scoutbox-club/src/App.tsx`) | nine pills on the organisation cards, the outlined card boxes, the demo pill | organisation rows: name, one quiet line (type · plan · Trusted Partner · Verified), an arrow, the chosen one named in green with a check; fields unchanged (no field icons, no badges) |
| **Grassroots** | the pills and card boxes, the registration box heading and three-sentence paragraph | rows as Pro; Sign in \| Register club tabs kept; registration opens with one sentence and one primary action; the turf stays on the introduction |
| **Trust & Safety** | — (already minimal) | one sentence under the headline; the admin key, one button; "Staff access is issued by ScoutBox." |

Shared (`design-system/AuthShell.tsx`, `platform.css`): `AuthRow` (a
`button.org-card.auth-row` with `.org-name`, `.auth-row-meta`, an arrow;
`aria-pressed` only when it selects), `AuthSectionLabel`, `AuthNote`, and a
`summary` sentence on `AuthPage`. Under 720px the introduction shows the
headline and that sentence only — the three points are desktop reading — so
a phone is wordmark, headline, sentence, form, secondary action.

## Spacing

Player: 24px horizontal gutters, 24px between blocks, 32px+ between
sections, 16–24px between fields (`scroll`, `panel`, `group`, `choiceList`
in `makeStyles`). Portals: 48px panel padding on desktop (32 / 24 on a
phone), 24px between blocks, 20px between fields, 52px rows.

## Progressive disclosure

Step 1 chooses the account type (rows); step 2 asks for the information
(About you → Your football, or Guardian account); step 3 verifies or pairs
(email code → ID → disclaimer → child, or the pairing code). Nothing about
the flows, the endpoints, the guardian / minor rules, the session or the
refusals changed; a failed attempt keeps the non-sensitive input and shows
the server's reason in a `role="alert"`.

## Preserved for the suites

`.org-card`, `.org-name`, `.enter-row input / select`, `button.primary`,
`login-signature`, `demo-identities`, `demo-as-<tier>`, `auth-tab-*`,
`text=Enter` rows, "Our promises to every player", "Pair and enter",
"I have a code from my parent/guardian" (on the sign-in step). The Player's
welcome rows carry `auth-choice-player / -parent / -guardian / -code`;
`uiSpotcheck` now pairs through **Use an invitation code**.

## Verification

`e2e/m24dAuthLive.test.mjs` — every portal at 320 / 360 / 390 / 430 / 768 /
1024 / 1280 / 1440 (no overflow, the card and the one primary action inside
the viewport, ≥ 40px targets, points hidden on a phone, every field
labelled, every button named, the password reveal announcing aria-pressed,
an empty submission producing a role=alert, Tab reaching the submit with a
visible ring, choice rows as pressed buttons, tabs with aria-selected,
contrast ≥ 4.5:1 on every text, no pill / emoji / icon circle, ≥ 24px
gutters on a phone); the Agent's demo roster rows; the Player at 320 / 360 /
390 / 430 / 1024 / 1440 (the 430px column, the four rows ≥ 44px, one form and
one primary action on sign-in, role=alert, keyboard, contrast, no
authenticated bottom navigation).
