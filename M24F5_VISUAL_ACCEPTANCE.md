# M24F.5 — Final founder visual acceptance pass

Baseline `a993577` (M24F.4). Every screen below was captured from the demo bundles,
opened and looked at before anything was changed, then captured and looked at
again after the change. Tests passing was never taken as the design passing: each
finding here came from a screenshot.

Captures: `design-system/screenshots/m24f5-*` (final tree). The review page that
groups them PLAYER / GRASSROOTS / PRO / AGENT / TRUST & SAFETY is published as a
private artifact (link in the final report).

## 1. What the first look found (current tree, before M24F.5)

### Player
| Screen | Finding |
| --- | --- |
| Home | Recent was a two-column date / text table with dividers and truncated at 320; "Clubs within reach 1 · 50 km" was cryptic |
| Activity | The same table rhythm |
| Development | Latest feedback showed a truncated quote; Progress read "Active goals 3 · 1/5"; two About rows |
| Combine | The Club Combine count sat as a sub-note |
| Evidence | Counts as sub-notes; "Oct 2, 2026" (US date); no LATEST / CATEGORIES labels |
| Passport | "strong coverage" in lower case; a doubled rule under the tabs |
| Offer | Compressed; an "Offers" heading repeating the tab and kicker; the status squeezed into a two-column fact row; "Starts … · Ends …"; a doubled rule under the tabs |
| Trial thread | A large filled yellow card |
| Explore › Trial | "10/4/2026" (US date), lowercase "pending"; doubled rule under the tabs |
| You › Clubs | "since 2026-05", a raw "org-eastport" input value, three-line agent rows, settled consents repeating their full legal wording, a wall of transaction facts, US dates |
| Guardian | 6 938 px: the twelve child sections all open beneath the management rows; one ISO date in the safety pack |
| Demo badge | System font; it covered the Player tab labels and the portal sidebar footer |
| Monospace | The passport share URL and two style sheets |

### Portals
| Screen | Finding |
| --- | --- |
| Director Dashboard | Intro paragraph, four filters, a "no colleague" sentence and a meta sentence above the counts; captions under funnel and time; lower-case raw stage names; ~6 800 px of detail tables with `<code>` internal record names |
| Nobody Missed | Duplicate heading ("Not yet evaluated (3)" above "Needs review · 3") |
| Grassroots Open Days | Raw ISO date in headings; the post form always open (six inputs); a pill row per open day with raw codes (u16, open); Edit styled as plain text |
| Grassroots Squad | Radar link styled as plain text; a match-day paragraph |
| Pro Film Room | 13 tag chips over the clip covering the player's name; the caption collided with the native video controls |
| Rooms | Five explanatory lines; the table clipped its Open room column at 1280 |
| Briefs / Watchlists | Raw snake_case values (semi_pro, developing_evidence) and a raw slug (combine-box-touch-60) |
| Matching | Raw fieldset boxes; two long intro lines |
| Second Look | The governing sentence three times (one as a red alert); pink boxes |
| Staff & Security | A giant settings form, about twelve sections open |
| Verification | Lower-case raw claim labels; a dispute input open on every claim; start forms open for an administrator who had finished every step; three always-open forms on References; a two-line tab intro on Transactions |
| Integrations | HMAC documentation inline; raw row codes; ISO date of birth; a browser-blue link |
| Agent Home | Two About links plus a "What this workspace is" heading; "FIFA licence facet" |
| Agent Transactions | The count grid rendered as five stacked full-width rows; duplicate heading; two About |
| Agent Compliance / Profile | Four explanatory paragraphs; raw policy ids; ISO dates; "facet by facet" headings; a verify form open on verified facets; raw history codes |
| T&S Verification | Raw machine codes (DOCUMENT_AUTHENTICITY_UNCONFIRMED, emailDomainAlignment=passed); "Dns" |
| T&S Trust | A monospace parameter dump |
| T&S Agent transactions | SCREAMING codes, pending_review, an outcome repeated by its own reason code |
| Everywhere | Monospace in `<code>` / `<kbd>` / `<pre>` and inline styles |

## 2. What changed

### Player (R1)
- Home and Activity: Recent and the Activity page are a timeline — a dot and rail,
  the day above, the event below, no dividers; "1 club within 50 km".
- Development: Latest feedback reads "You · 1 Oct"; Progress "3 active goals";
  one "About this plan" row.
- Evidence: LATEST (the clip as a picture, "2 Oct · Verified clip") and
  CATEGORIES with right-aligned counts (Video 2, Combine 3, Coach references 0,
  Verified attendance 2).
- Combine: Club Combine count on the right, not as a sub-note.
- Passport: "Strong coverage"; one rule under the tabs.
- Offer: the club at 26 px, "Under-23s · Central midfielder", "1 Jul 2027 – 30 Jun
  2029", the status on its own line with "Revision 1 · Expires 16 Oct · 15:31"
  beneath, Accept / Decline, View terms, "Offer acceptance is not a signature.";
  no repeated heading; one rule under the tabs.
- Messages / Trial: the trial message is an edge accent with a "Trial" label —
  no filled yellow card anywhere in the inbox.
- Explore: the first section's rule sits on the tab line (no doubled rule).
- Clubs: human dates through the device locale; status words through the
  locale table; a settled consent folds its wording behind "About this consent";
  each transaction is a summary line, its confirm action and one Details row.
- Guardian: the twelve child sections are rows under the child's name
  (6 938 → 3 507 px); the safety-pack date reads "10 Oct".
- Demo badge: Inter 10 px, clear of the tab labels and the sidebar footer.
- Monospace removed from the Player.

### Portals (R2)
- Director Dashboard: the root is Period, four counts, funnel, time by stage,
  coverage and needs attention (≤ 5). Filters, the governing principle with its
  window and calculation time, and every detail panel open from "More filters",
  "About these figures" and "Show all figures". 2 598 → ~118 visible words.
  Three columns from 1 180 px.
- Nobody Missed: one heading per group.
- Grassroots: Open Days post form behind "Post an open day"; human dates; one
  quiet meta line per open day ("U16 · 1 registered"); Edit and the squad's radar
  link in link colour; the match-day note behind About.
- Film Room: tags under the clip; the caption under the stage; the overlay lifted
  56 px clear of the video controls.
- Rooms: the three explanatory lines behind About; position and age in the
  player cell; Open room one line in link colour.
- Briefs, Matching, Watchlists: humanised criteria; fieldsets replaced by plain
  groups; one definition each.
- Second Look: the governing sentence once, as a plain notice.
- Staff & Security: nine settings rows with their state.
- Verification: capitalised claim labels; dispute behind "Dispute this…"; start
  forms fold once every step is done; the credential, reference, invitation and
  conflict forms behind one row each; the Transactions intro behind About.
- Integrations: webhook guidance behind its row; humanised review line; bare
  content links in link colour everywhere (zero-specificity rule).
- Agent: one About on Home; "FIFA licence"; "Verification" / "Your verification";
  counts in one row on Transactions; compliance notes behind About; human dates;
  verified facets fold their form behind "Submit a new reference"; the account
  line reads "Agency".
- Trust & Safety: codes read as words with acronyms kept (DNS, IDV, FIFA, MFA,
  SSO); trust parameters behind "Technical parameters"; agent-transaction
  statuses humanised and an outcome no longer repeated by its own reason.
- Monospace: `code, pre, samp` use Inter; inline monospace removed.

## 3. Invariants kept
- **Safeguards:** guardian-managed markers, the no-ghosting rule, under-18
  invitation and minors-readiness wording, the safety pack — all visible.
- **Offer ≠ Signing:** "Offer acceptance is not a signature." under every offer;
  the transaction confirmation line stays beside its action.
- **Box Cam ≠ Assessment:** the word never appears on Box Cam (asserted live).
- **Trust Score ≠ talent score:** "Evidence confidence only" on the Player;
  "not football ability" in Pro; the T&S statement stays.
- **Nobody Missed ≠ ranking:** "not a measure of scouting quality … nothing here
  is ranked" stays on the root, and the ordering line says no ordering is a
  quality rank.

## 4. Rules held
- Roots: one primary line, at most one secondary line, a chevron; no sub-note
  habit; at most one short root sentence except legal, safeguarding, consent or
  error wording (asserted per screen and width by the live suites).
- Inter computed everywhere; the wordmark (Albert Sans) and the Grassroots
  editorial face are the only others.
- Zero emoji; no seconds in any rendered time.
- Grassroots: navy sidebar, light canvas, grass photograph only on sign-in, no
  diagonals; the radar read state has no border; squad names unbordered.
- Agent: gold navigation.
