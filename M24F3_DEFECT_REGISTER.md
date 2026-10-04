# M24F.3 — Defect register

Defects found while enforcing the one-line rule, and what was done. Items marked
*test-side* changed a suite, not the product.

| # | Where | Found by | What | Fix | State |
| --- | --- | --- | --- | --- | --- |
| 1 | Player Inbox (M24F.2) | density crawl | A request opened as a card stack: subject, full message, notes, verified line, report note and a reply field all visible before any tap; no conversation list. | Rewritten as a conversation list of `PreviewRow`s with Request / Trial / Offer / Signing labels; request detail keeps Accept / Decline visible and folds the rest behind "View full message". | Fixed (R2) |
| 2 | Player Inbox | design review | A trial invitation looked like any other request — no distinct signal. | Warm gold accent edge + "Trial" label on the row and the TRIAL INVITATION kicker in the detail; AA contrast in both themes, checked by the static gate. | Fixed (R2) |
| 3 | Football Passport root | density crawl | 2 730 visible characters at 390 px: the disclaimer, evidence counts, conflict text and "Where is this from?" on every timeline row. | Root reduced to status / club / availability / evidence word + four-row timeline; everything else behind About / View evidence / Review / opened rows. 933 characters after. | Fixed (R3) |
| 4 | Trust Score root | density crawl | Policy version, strengths, gaps and the demo note on the root. | Root = score, band, "Evidence confidence only", "View breakdown"; the rest inside. | Fixed (R3) |
| 5 | Opportunity board / fit | density crawl | Board 5 892 and fit 6 159 visible characters at 390 px; descriptions, requirements and reasons always open. | One-line rows; details behind "View details"; fit one line + "Check fit", reasons behind "Why". | Fixed (R3) |
| 6 | Portals (all four) | density crawl | 80 long paragraphs on root screens (page hints, server notes, static notices). | `Hint` / `About` in `design-system/About.tsx`; every hint routed through it; static notices wrapped. 0 unaccepted long paragraphs after. | Fixed (R4) |
| 7 | Trust & Safety, Agent | source grep | Machine timestamps with seconds (`toLocaleString()` / `toLocaleTimeString()` without options). | `design-system/time.ts` (`fmtStamp`, `fmtClock`); Player fallbacks in M23Trial through `time.ts`. | Fixed (R1/R4) |
| 8 | Player Development | density crawl | "These are counts of agreed work…" and the reminder note as root sub-notes; target limitation and plan limitation as paragraphs. | Folded behind "About these counts", "About this target", "About this plan". | Fixed (R4) |
| 9 | Player Messages | after capture | "Needs your acknowledgement" rendered each notice as a three-line paragraph with a full-width primary button. | One-line Disclosure per notice; full text and Acknowledge inside. | Fixed (R4) |
| 10 | Discover ordering line (Pro / Grassroots) | density crawl | 182-character ordering statement on the root; the m18.2 suites read it by `[data-ordering]`. | Shortened to one line that still names what the order is not (ability, Trust Score); EN + FR. | Fixed (R4) |
| 11 | `m24f3InboxLive` seeding | first run | `POST /org/rooms` returns `room.roomId`, not `room.id`; every seeded call hit `ROOM_NOT_FOUND`. | Suite reads `roomId`. *test-side* | Fixed |
| 12 | `m24f3InboxLive` at 390 px | second run | Offer / Signing event rows asserted before the notifications request had returned. | Suite waits for the rows. *test-side* | Fixed |
| 13 | `m24f3MinimalLive` safety line | third run | The Messages tab keeps an opened request as page state across tab switches, so the list (and the safeguarding line) was not on screen. | Suite leaves the detail through its back control; the control gained `testID="detail-back"`. Behaviour kept (returning to where you were is intended). | Fixed |
| 14 | Density crawler | measurement | Text inside closed `<details>` and inside inactive (aria-hidden) Expo tab screens was counted as visible. | Crawler excludes closed details content and aria-hidden ancestors. *tooling* | Fixed |

## Accepted, not changed

- Consent and confirmation wording on Player › Clubs › Requests / History (legal flows).
- The m20 governing sentence, the Agent development-provider notice, notification
  bodies — see the "Allowed exceptions" section of `M24F3_MINIMALISM_RULES.md` and the
  fix column of `M24F3_SCREEN_DENSITY_AUDIT.md`.
