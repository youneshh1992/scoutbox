# M24E — Every application has a way out

| App | Sign out | Switch organisation | Where | Returns to |
|---|---|---|---|---|
| Pro | `Sign out` (`data-testid="sign-out"`) | `Switch organisation` (`switch-org`) | the account block at the bottom of the sidebar, under the person's name, beside the language choice | the entry screen with the organisation rows |
| Grassroots | `Sign out` | `Switch club` | the same account block | the entry screen (Sign in \| Register club, the club rows) |
| Agent | `Sign out` | `Switch profile` | the same account block | the entry screen: AGENCY / the agency / (in the demo) "Choose a profile to continue." |
| Trust & Safety | `Sign out` | — (one key, no organisation) | the account block at the bottom of the sidebar | the key screen, key field cleared |
| Player | `Sign out` (`sign-out`) | `Switch account` (`switch-account`) | You › Account (and the guardian dashboard), after the rules | the entry screen; Switch account opens it on Sign in |

Plain rows in the account block with a 14px icon, quiet colour (Sign out in
the ink colour, Switch in the quiet colour), never a bright button; each
carries an accessible name (`aria-label` = its text; the Player's `Button`
sets `accessibilityLabel`). On a phone the account block is the end of the
drawer; the Player's exits are on the Account tab.

## What sign out does

All five go through the mechanism the pre-M24 session fixes established:

- **Pro / Grassroots / Agent** — `logout()` in each `App.tsx`:
  `revokeSession` POSTs `/auth/logout` with the bearer (keepalive, fire and
  forget — PM-4), the session is removed from `localStorage`
  (`scoutbox-club-session` / `scoutbox-grassroots-session` /
  `scoutbox-agent-session`), identity-scoped drafts are cleared, the
  workspace unmounts (its event stream and live connections end with it)
  and the `Login` renders. Both exits call the same `logout`; "Switch" is
  the name of the same action for someone who means to come back as another
  organisation / profile. Other tabs of the same browser leave the
  workspace through the storage event (PM-3).
- **Trust & Safety** — `signOut()` forgets the key and every record it had
  loaded and returns to the key screen. The key is a credential sent with
  each request; the server keeps no session for it, so there is nothing
  to revoke.
- **Player** — `logout()` in `state.tsx` revokes the current identity's
  token on the server (`client.logout`), forgets it on the device, clears
  every identity-bound piece of state (`clearIdentityState`) and the stored
  session, then `router.replace('/onboarding')` (or `/onboarding?mode=signin`
  for Switch account). No identity carries over: the next person signs in
  as themselves; tokens of other identities are never reused automatically.

## Verified

- `m24dAuthLive` (M24E block): Pro — Sign out lands on the entry screen,
  the old token is refused (401), the entry screen is the fixed appearance
  while the saved theme is kept, Back shows no workspace, a protected deep
  link (`#/recruitment`) stops at the entry screen, signing back in restores
  the theme, Switch organisation returns to the rows; Grassroots — Switch
  club returns to the rows with Sign in / Register club; Agent — Switch
  profile returns to the agency screen with the old token refused; Trust &
  Safety — Sign out clears the key; Player — Sign out and Switch account
  are named and quiet, Switch account ends the identity and opens Sign in,
  a protected route afterwards stops at the entry screen.
- `preM24SweepLive` S1–S3, S5: the portal exit revokes on the server (PM-4),
  the other tab leaves (PM-3), a removed colleague is signed out on the next
  refresh signal, the Player's exit forgets and revokes the token.
- `crosstab`, `liveIntegration`: cross-tab behaviour unchanged.
