# M23 P8 — Notification and deep-link audit

Every recruitment-journey notification, what it points to, and how each app
opens it (§29–§31, §70). Before P8 no notification carried a link: each row
held a bare `refId` whose id type changed from site to site, the club and
grassroots bells matched on notification *type* only, the agent bell knew only
`rep-` / `ctx-` / `atx-` ids, and the player bell was plain text.

## 1. The mechanism P8 adds

**Server-resolved targets, at read time.** `notificationsFor()` (`server.mjs`)
decorates every row it returns with `target`, computed by
`notificationTargetFor(n, audience)` (`m23/journeyRoutes.mjs`) from the row's
`refId` and the audience it is being read by. Nothing is stored; nothing is
sent in the push payload (push still carries only the text). A target names
the **current, authorized** resource:

| refId | Audience | Target | Re-authorization at read |
| --- | --- | --- | --- |
| `case-` | club staff | `{kind:'room', roomId, tab:'overview'}` | the case must belong to the reader's org |
| `req-` (contact / trial invitation) | club staff | room, tab `contact` or `trial` by request type | org of the request |
| | player / guardian | `{kind:'inbox', requestId}` | the request must be addressed to them |
| `trial-` | club staff | room, tab `trial` | org |
| | player / guardian | `{kind:'trial', trialId}` | the recipient who accepted |
| `rct-` (Contact) | club staff | room, tab `contact` | org |
| | agent | `{kind:'client', clientId, tab:'contacts'}` | only the agent the routing snapshot names |
| `rof-` (Offer) | club staff | room, tab `offer` | org |
| | player / guardian | `{kind:'offer', offerId, offerRevisionId}` — the **live** revision | the snapshotted recipient; a blocked club resolves to nothing |
| | agent | client, tab `offers` | only the agent the client shared with |
| `spk-` (package) / `sign-` (completed row) | club staff | room, tab `signing` | org |
| | player / guardian | `{kind:'signing', signingPackageId, superseded}` — the **current** package over the same Offer (a cancelled, expired or superseded one resolves to the live one and says `superseded: true`) | a required party on a presented revision; a blocked club resolves to nothing |
| | agent | client, tab `offers` | only the agent the client shared the Offer with |
| anything else | any | `null` | the row stays plain text |

Because the target is computed on every read, an Offer revised after the
notification was written opens the current revision, a package replaced after
the notification opens the live package, and a reference the reader may no
longer open (a revoked mandate, a foreign org, a block) opens nothing (§31:
conceal, never crash, never a stale act).

## 2. Every journey notification, after P8

| Emitter | type | Recipient | refId | Target for that recipient |
| --- | --- | --- | --- | --- |
| Contact sent (shared request writer) | `request` | player / guardian | `req-` | inbox → the request |
| Contact routed to an agent | `representation_contact` | agent | `rct-` | client → Contacts |
| Contact answered | `recruitment_room` | club owner / lead | `case-` | room → Overview |
| Trial invited | `request` | recipient | `req-` | inbox |
| Trial schedule proposed / changed / cancelled / completed | `trial_day` | recipient | `trial-` | trial (Opportunities) |
| Trial invitation accepted / schedule confirmed / declined / cancelled | `trial_day` | club | `trial-` (`req-` for a declined invitation) | room → Trial |
| Assessment assigned | `recruitment_room` | assignee | `case-` | room → Overview |
| Decision finalized | `recruitment_room` | club | `case-` | room → Overview (the word only) |
| Offer issued / revised / withdrawn / answered | `recruitment_offer` | recipient, shared agent, club | `rof-` | offer → live revision / client → Offers / room → Offer |
| Signing presented / a party confirmed / completed / cancelled / voided / superseded | `recruitment_signing` | player, agent, club leads | `spk-` | signing → current package / client → Offers / room → Signing |
| Completed signing record | `signing`, `level_up` | player, guardian | `sign-`, player id | signing → current package / none |

## 3. How each app opens a target

| App | Before P8 | After P8 |
| --- | --- | --- |
| Club, Grassroots | type-level screen; `recruitment_room` opened the Rooms list; Offer / signing rows had no Open | a `room` target opens `#/recruitment/rooms/:id/:tab` (the tab route is new: `ROOM_TABS`, `roomTabFromHash`, `hashForRoom(id, tab)`); an unknown tab makes the link malformed; a foreign room reads "does not exist" |
| Agent | only `rep-` / `ctx-` / `atx-` refIds jumped | a `client` target looks up the agent's OWN relationship for that client at click time (`agent.clients`), opens `#/clients/:rel/:tab`; a revoked mandate opens nothing (plain text) |
| Player, Guardian | plain text | a row with a target shows Open → `/(tabs)/inbox` for a request, `/(tabs)/opportunities` for a trial, Offer or signing (`/guardian` for a guardian); the section re-reads on focus so the current record is what renders |

## 4. Contradictory notifications (§29)

Notifications are written by the domain act that happened and are never
rewritten. What P8 changes is what they OPEN: an "Offer accepted" row read
after the signing completed opens the Room's Offer tab (club) or the Offer
(player), where the current state — accepted, then signed — is what renders;
a "Trial scheduled" row for a since-cancelled Trial opens the Trial, which
reads cancelled. No notification opens an obsolete revision as actionable:
the recipient's Offer target is the live revision and the signing target is
the current package.

## 5. Free text in notification bodies (audited, unchanged)

Three trial notifications carry the other side's free-text reason (a club's
cancel reason to the recipient; the recipient's decline or cancel reason to
the club) and task notifications carry the task title to the assignee. Each
is text written FOR that recipient by the other party or by a colleague;
none carries a decision rationale, a term, a digest or an assessment. Left as
is; recorded here so the next milestone can decide whether push and email
should carry them.

## 6. Proof

`m23RecruitmentJourneyE2E` group G (targets for the player's Offer, package
and completed-record rows; the club's rows open the Room's Offer / Signing
tabs; a cancelled package's rows resolve to the live one and say so) and
`m23RecruitmentJourneyLive` group E (the club bell opens the Room tab; the
player bell opens Opportunities) and D (tab links, a bogus tab, a foreign
room, an ended case, back/forward).
