# M24B — Recruitment navigation: category → subcategory

The long flat recruitment tab strips (thirteen tabs on a Recruitment Room,
seven on an agent's client, six on a transaction, nine stacked sections on
the player's Opportunities screen) are replaced by two levels:

```
TOP-LEVEL CATEGORY            a segmented control — the current one is heavier,
                              carries a dot and aria-current
  → SUBCATEGORY               light underline tabs (a real ARIA tablist)
      content                 the ARIA tabpanel of the selected subcategory
```

**Hard rule: no category holds more than five subcategories.** It is data
(`CASE_NAV_MAX_SUBS = 5` in `design-system/caseNav.ts`), checked by
`validateCaseNav` on every application's model and asserted by
`e2e/caseNav.test.mjs` for Pro, Grassroots, Agent (client and transaction)
and Player. A sixth item fails the suite.

This is a navigation / information-architecture change only. No canonical
domain was merged, no lifecycle semantics, Contact, Trial, Assessment,
Decision, Offer or Signing logic changed, no new data is exposed to the
Player or the Agent, no authorization changed, no store was duplicated, no
lifecycle state was created. Sidebar = destinations; page tabs = functions.

## Why categories are UI organisation only

The canonical lifecycle is the server's journey projection
(`GET /org/rooms/:id/journey`, `/player/journeys`, `/org/agent/clients/:id/journey`).
A category such as **Evaluation** or **Deal** is a label on a screen: it is
never persisted, never sent to the server, never read as truth, and the
Journey strip stays above the navigation on every page of a Room so where a
case *is* comes from the records, not from which tab is open. The models are
plain data (`caseNav.ts` in each app) and the server does not know the word.

## Deep links

Every case keeps its routing architecture; a link now names the category and
the subcategory, and every old form still resolves:

| Case | Canonical form | Still accepted |
|---|---|---|
| Room (Pro / Grassroots) | `#/recruitment/rooms/:id/evaluation/assessments`, `…/deal/offer`, `…/engagement/trial` | `…/:id/<tab>` (the flat tab the server emits in notifications and next actions: overview, contact, trial, assessments, decision, offer, signing), `…/:id/<category>` (its first page), `…/:id` (Overview › Summary) |
| Agent client | `#/clients/:id/recruitment/contacts`, `…/transaction/offers` | `…/:id/<tab>` (contacts, offers — the server's notification tabs — and every old tab), `…/:id` (Overview › Summary) |
| Agent transaction | `#/transactions/:id/records/documents` | `…/:id/<tab>` (overview, parties, compliance, documents, messages, timeline) |
| Player | `/opportunities?cat=offer&tab=offer-documents` | `?cat=` alone (its first page), `?tab=` alone (found in its category), nothing (My journey › Overview) |

A subcategory under the wrong category, an unknown segment, or a third
segment is a malformed link and opens nothing — exactly as before. Opening a
case pushes a history entry; changing a page replaces it, so Back closes the
case and Forward reopens it on the page that was open (R10–R12 in
`m24CaseNavLive`). Notification targets are unchanged on the server
(`{ kind: 'room', roomId, tab }`, `{ kind: 'client', clientId, tab }`,
`{ kind: 'trial' | 'offer' | 'signing' }`); the clients resolve the flat
`tab` to its category, and the player's bell opens
`/opportunities?cat=<trial|offer|signing>`. P8 / P8.1 current-resource
selection and re-authorization are untouched: every route still re-reads
and re-authorizes server-side, and a page the person may no longer open
shows the refusal the server returns.

## How mobile differs

At 360 and 390 px nothing shrinks: the category row and the page row scroll
sideways, the current category and the current page are scrolled into view
when chosen, every target is at least 44 px tall and no label goes below
13 px. On the portals the category counts hide and the breadcrumb line hides;
on the Player the categories are 44 px pills and the pages are the existing
underline tabs. From 768 px up both rows fit without scrolling. The player
app stays a mobile app.

## Accessibility

Category row: a `<nav aria-label="Areas of this case">` of buttons, the
current one `aria-current="true"`, Arrow / Home / End move between them.
Page row: `role="tablist"` with `role="tab"`, `aria-selected`,
`aria-controls` → the `role="tabpanel"` with `aria-labelledby` back to the tab
and an `aria-label`; Arrow / Home / End move, Enter / Space activate (native
buttons), every tab is in the Tab order; the platform focus ring applies.
Only the current category's pages are in the DOM: a page an audience may not
see is absent, never rendered hidden.

---

## ScoutBox Pro — Recruitment Room (`scoutbox-club/src/caseNav.ts`)

Audience: the club's recruitment staff (room role from the server).
Canonical destination: `#/recruitment/rooms/:id/…`.

| Category | Subcategories | What it is |
|---|---|---|
| **Overview** | Summary · Journey · Tasks · Activity | Summary: status, lead, Trust Score (evidence confidence), health, readiness, missing evidence, latest activity. Journey: the server's projection in full — current stage, completed stages with their basis, the records on the case, lifecycle. Tasks: the server-derived next action plus the room's own tasks (existing function, moved here). Activity: the room activity feed. |
| **Player** | Passport · Combine · Development | The player's own truth layer (the Football Passport, Combine results, the development plan) — kept distinct from what the club thinks. These three existing functions were not in the brief; they are a category of their own rather than crammed into Evaluation. |
| **Evaluation** | Evidence · Assessments · Decision · Second Look | Unchanged panels; Second Look lists this player's Second Look items read from the existing queue (`/org/second-look`), with a link to the queue. |
| **Engagement** | Discussion · Contact · Trial · Inbox | Discussion first — internal talk before shared communication, the M23 P3 rule the suites assert; it never travels. Contact and Trial unchanged. Inbox: the conversations with this player read from Messages (`/org/channels`, filtered by player), read-only here with a link to Messages — nothing reaches the player from the Room. |
| **Deal** | Offer · Signing · Documents | Offer and Signing workflows unchanged. Documents: every document on the case's Offers and signing packages, listed where it lives (Offer revision N / signing revision N, digest), opening a signing document through the existing route; there is no new document store. |
| **History** | Timeline · Previous decisions · Previous trials · Previous offers · Previous signings | Read-only. Timeline is the journey timeline (moved from Activity). The other four are the canonical records read back (`/decision` history, `/trials`, `/offers`, `/signing`) filtered to what is no longer live; no input, no primary action. |

Largest category: 5 (History).

## ScoutBox Grassroots — Recruitment Room (`scoutbox-grassroots/src/caseNav.ts`)

Audience: grassroots club staff. Same destination. Simpler than Pro: the
player's record and the club's review share one area, Decision sits with
Recruitment, History is shorter, no Second Look.

| Category | Subcategories |
|---|---|
| **Overview** | Summary · Journey · Tasks · Activity |
| **Player review** | Passport · Evidence · Assessments · Combine · Development |
| **Recruitment** | Discussion · Contact · Trial · Inbox · Decision |
| **Agreement** | Offer · Signing · Documents |
| **History** | Timeline · Previous trials · Previous offers |

Largest category: 5. Minor safeguards, the 50 km rule and the verified-club
rules are server rules and are untouched by where a page sits.

## Player — Opportunities (`scoutbox-player/src/caseNav.ts`)

Audience: the player (the guardian page keeps its own sections). Destination:
`/(tabs)/opportunities`. Everything reads the endpoints the screen already
read; nothing club-private exists here (watchlist, priority, assessment,
decision rationale, Room discussion, Second Look, shortlist state, notes —
asserted absent by `caseNav.test.mjs` and sentinel-swept by the live suites).

| Category | Subcategories | Source |
|---|---|---|
| **My journey** | Overview · Current stage · Tasks · Activity | `/player/journeys` — the stage word and next action are the server's; Tasks lists the next actions the server names with a "Go there" into the category that holds the record; Activity is the full timeline |
| **Club contact** | Messages · Contact | the session's channels and inbox requests, read-only summaries; answering stays in the Inbox (the one place the safeguarding wording and slot picker live) |
| **Trial** | Invitation · Schedule · Details | trial invitations (inbox), the M23 trial workflow (schedule, confirm / decline / cancel), the M12 trial-day details (staff checks, arrival, consent, safety pack) |
| **Offer** | Offer · Documents · Response | `/player/offers`: the terms and the accept / decline act; the documents; your answer, agent sharing and earlier revisions |
| **Signing** | Signing · Documents · Contract | `/player/signings`: status, parties and the sign act; the document and its digest; the contract days and the completion record |
| **Board** | Open roles · Fit check · Squad invites · Follow-ups | the opportunities board the screen always carried — not journey records, kept reachable in its own category |

Largest category: 4. The brief's "Trial › Evidence" is not built: no
player-side trial-evidence record exists (Box Cam evidence a club links is
the club's record, behind the player's consent shown under Details), and
nothing was manufactured.

## Agent — client and transaction (`scoutbox-agent/src/caseNav.ts`)

Audience: the agent whose relationship it is; every page reads an endpoint
the agent already had and each refuses on its own terms (disclosure, scope,
licence) at read time. Authorization is exactly as frozen.

| Category | Subcategories | Source |
|---|---|---|
| **Overview** | Summary · Journey · Tasks · Activity | identity + relationship summary; the factual journey line; "waiting on your client" derived from the server's `awaitingClientResponse` / `clientActionRequired` / `awaitingClientConfirmation` flags (nothing invented, nothing actionable by the agent); relationship history |
| **Player** | Profile · Representation · Compliance | profile fields; the agreement (existing, with Withdraw / End); the compliance contexts naming this client, each linking into Conflicts & compliance |
| **Recruitment** | Contact · Trial · Opportunities | existing read-only projections |
| **Transaction** | Offer · Signing · Documents | the shared Offers; the signing progress (moved out of the Offers list to its own page); the transaction workspaces this client is a party to, linking to their Documents — clubs never disclose Offer or signing documents to an agent |
| **History** | Timeline · Previous offers · Previous signings | the full shared timeline; terminal Offers; terminal signing packages |

Transaction workspace (`#/transactions/:id/…`): **Workspace** (Overview ·
Parties · Compliance) and **Records** (Documents · Messages · Timeline).
Largest category: 4 (client), 3 (transaction).

## Trust & Safety

No recruitment case navigation was added. The admin app has no Recruitment
Room, client or transaction surface and must not become a recruitment
decision-maker; it exposes only verification, compliance, safeguarding,
moderation and audit, as before. Its grouped page tabs are not recruitment
categories and were not changed.

## Files

- `design-system/caseNav.ts` — model types, `CASE_NAV_MAX_SUBS`, `validateCaseNav`, `resolveTab`, `parseCaseSegments`, `caseSegments`.
- `design-system/CaseNav.tsx` — the two-row control, `casePanelProps`, `CaseCrumb`; styles in `design-system/platform.css` (`.casenav*`).
- `scoutbox-club/src/caseNav.ts`, `roomCase.tsx` (the new read-only panels), `roomsScreens.tsx`, `nav.ts`, `i18n.ts`; the same in `scoutbox-grassroots`.
- `scoutbox-agent/src/caseNav.ts`, `screens.tsx`, `transactions.tsx`, `nav.ts`, `i18n.ts`.
- `scoutbox-player/src/caseNav.ts`, `components/CaseNav.tsx`, `M23Journey.tsx` (four views), `M23Offer.tsx` / `M23Signing.tsx` (view prop), `M23Trial.tsx` (standalone empty state), `M24Contact.tsx`, `app/(tabs)/opportunities.tsx`, `NotificationBell.tsx`, `i18n.ts`.
- Frames from the demo bundles: `design-system/screenshots/m24b-*.png` (Pro Room at 1440 and 390, Grassroots at 390, Agent client and transaction at 1440, Player at 390 and 360).
- Tests: `e2e/caseNav.test.mjs` (max-5 and routing, node), `e2e/m24CaseNavLive.test.mjs` (every category and page of Pro, Grassroots, Agent and Player at 360 / 390 / 768 / 1024 / 1280 / 1440, keyboard, deep links, private absence), `e2e/caseNavHelpers.mjs` (how a suite reaches a page), and the M17 / M23 suites updated to the hierarchy with their workflow assertions unchanged.
