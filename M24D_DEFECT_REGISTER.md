# M24D — Defect register

Defects found while implementing and verifying the navigation
simplification and the auth / onboarding personality pass. Severity:
Critical (breaks a flow or exposes data), High (a required behaviour
missing), Medium (wrong but recoverable), Low (cosmetic).

| # | Severity | Where | Found by | Defect | Status |
|---|---|---|---|---|---|
| D1 | High | Pro / Grassroots sidebar (`navui.tsx`) | design review | with the group accordion in place, navigating across sections left every section the person had passed through expanded, so the sidebar could still list 13 links (N14 measured it) | **Fixed** — arriving anywhere keeps exactly one section open (`Sidebar` effect); N14 and m24dNavLive C11 assert one open section |
| D2 | High | Portal entry rows (`platform.css`) | screenshot review | the new choice rows inherited `flex-direction: column` from the old card rule: name, meta and arrow stacked and centred | **Fixed** — rows are `flex-direction: row`, text left, arrow right; m24dAuthLive asserts the arrow sits to the right of the name on one line |
| D3 | Medium | Player `caseNav.ts` | caseNav suite | a pre-M24D link `?cat=board` (no tab) fell back to My journey › Overview instead of the Board page | **Fixed** — `PLAYER_LEGACY_CATS` maps the old category to journey › board; asserted |
| D4 | Medium | Player `onboarding.tsx` | expo lint | an unescaped apostrophe in the new sentence (react/no-unescaped-entities) | **Fixed** |
| D5 | Medium | Player `M23Journey.tsx` | typecheck | the folded Tasks block passed `testID` to `Row`, which has no such prop | **Fixed** — a plain `View` |
| D6 | Low | Trust & Safety entry | m24dAuthLive | the key screen had no one-sentence summary, so a phone showed only the headline | **Fixed** — `summary` added |
| D7 | Low | emoji sweep | diff review | the sweep left empty `<Text>` / `<Muted>` elements, an `icon=""` prop on the Player's stat tiles, `'' + t(…)` in Pro / Grassroots verification notifications and stray zero-width joiners | **Fixed** — removed; typecheck 5/5 |
| D8 | Low | m24dAuthLive (test) | first run | the suite treated the Agent's static agency name (`p.org-card`, kept so older suites still find it) as a choice row; the Trust & Safety Tab-walk could not reach a submit that is disabled while empty | **Fixed** in the suite — rows are `button.org-card`; the walk types first |
| D9 | Low | navLive N15 (test) | first run | the group heading locator matched rendered text, which CSS uppercases | **Fixed** — the locator uses the group's `aria-label` |
| D10 | Low | uiSpotcheck, m13DemoSpotcheck (tests) | demo spot checks | they clicked "I'm a parent / guardian" and the Operations group for Delivery centre | **Fixed** — the Parent row; the Delivery & Billing group |

Open: none Critical, none High, none Medium, none Low in the delivered
tree. Deferred presentation items (not defects) are in
`M24D_VISUAL_PERSONALITY_AUDIT.md` under "Noted for a later pass".
