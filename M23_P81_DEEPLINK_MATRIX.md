# M23 P8.1 — Deep-link matrix

Old links into a Room, a Contact, a Trial, an Offer and a signing package
(§25, §69), opened after the world changed. The rule: **every open
reauthorizes against current state on the server; the client redirects to
the current resource only when the server says the opener may see it; else
the resource is concealed** (the same 404 as a fabricated id, or a 403 that
names a rule about the opener, never about the resource). Checks:
`m23RecruitmentJourneyHardeningE2E` group N, `m23RecruitmentJourneyHardeningLive`
D/L, the P8 live D group.

| Link | After | Server answer on open | Client behaviour |
| --- | --- | --- | --- |
| Room `#/recruitment/rooms/:id/:tab` | the opener's role removed from the room (restricted room) | 403 `ROOM_RESTRICTED` / `ROOM_PERMISSION_REQUIRED` on the room read | the Room says it is not open to them; the list re-reads (live C; hardening live L4) |
| Room | the opener removed from the org | 401 on every call (`ORG_AUTH_REQUIRED`: the session itself was revoked at removal; `USER_REMOVED` at any new login); the stream closed | the app signs the user out to the login screen |
| Room | the case ended (withdrawn / archived / closed) | 200: the Room reads; every mutation refuses by state; the strip names `CASE_ENDED`, no control | read-only tabs; the strip shows no act (live D; hardening W) |
| Room | the player blocked the org | 200: the Room reads with `playerAvailable: false`; every forward act refuses | the strip names the act with `BLOCKED`; the player header reads withheld |
| Room tab of another org's case | — | 404 `ROOM_NOT_FOUND` (the same body as a fabricated id) | "not found" |
| Contact `…/:roomId/contact` (a Contact id in the tab) | the Contact cancelled | 200: the Contact reads as cancelled; edit / send refuse | the row shows cancelled, no control |
| Contact | the case moved on (trial_scheduled) | the tab reads; a new send is refused `CONTACT_CASE_STATE` | the compose control is hidden (`case.acceptsContact` false) |
| Trial `…/trial` (a Trial id) | the Trial cancelled or completed | 200 read; mutations refuse by state | state word, no act |
| Trial | the recipient removed their account | the Trial reads with `subjectRemovedAt`; acts refuse `SUBJECT_REMOVED` | the row says the subject is gone |
| Offer `…/offer` (an Offer id) | the revision superseded | 200: the Offer reads with the LIVE revision current and the old one in its history | the panel shows the current revision; the old one is history |
| Offer | the Offer withdrawn | 200 read; issue / revise per state; the recipient's link shows WITHDRAWN with no answer control | no answer control (hardening O1) |
| Offer (recipient) `…/offers/:id` | the recipient is no longer the route (a guardian whose child came of age) | 404 `OFFER_NOT_FOUND` on the guardian route; the player's own route reads it | the old link says not found |
| Offer (recipient) | the case put on hold | 200 read, `answerable: false`, `notAnswerableReason: CASE_PAUSED` | the panel explains, no control; after the resume the control returns (D-P81-1) |
| Package `…/signing` (a package id) | the package superseded | 200: the package reads with the current revision; a signature on the old revision refuses | the current revision is offered |
| Package | the package voided or cancelled | 200 read, state VOIDED / CANCELLED; no act | state word; no control |
| Package (recipient) `…/signings/:id` | the package superseded / expired | 200 read of the current revision; the notification target resolves to the current package over the same Offer (`superseded: true`) | the app opens the current package and says the item was updated (§31) |
| Package (recipient) | the player blocked the org | 200 read (their own package); their signature is their act; completion by the club is refused | — |
| Agent client `#/clients/:rel/:tab` | the representation ended / expired / disputed; the licence lapsed; the affiliation removed | 403 with the rule (`decision.code`) on the journey, Offers and signings routes; the agreement row reads by status | the client page says the record is not open to them; the journey line is gone (live G7; hardening K, live L5) |
| Agent client | a same-agency colleague's link | 404 `REPRESENTATION_NOT_FOUND` (unshared) or 403 `AGENT_ACTION_NOT_PERMITTED` on a summary row | "not found" / "a summary row does not open a client" |
| Agent Offer / package link | the client un-shared the Offer | the Offer and its package vanish from the agent's lists (skipped, not counted) | the line disappears on the next read |
| Player journey line `/(tabs)/opportunities` | a case ended with nothing shared | nothing listed for that club | no line (live P6) |
| Player notification "Open" | any of the above | the `target` is resolved at read time; a resource the player may no longer open resolves to `null` | the row is plain text (no Open button) |
| Browser back / forward into any of the above | — | every screen re-reads on `pageshow` / focus / visibility (P8.1 app-level refetch; the strip's own re-read) | the stale control is gone before it can be used (live D8–D9; hardening live L7) |

## Why concealment is consistent

- Every recruitment lookup is org-scoped first (`findRoom`, `findContact`,
  `findTrial`, `offerFor`, `packageFor`, `findOwnAgreement`): a foreign
  resource and a fabricated id produce the same status and the same body.
- Role and membership are read from the live user row on every request
  (`orgAuth`, `roomRole`); nothing is cached in the session.
- The agent's grants are derived on every read (`agentGrants`:
  `decide('client_private')`, `basisFor`, `licenceCurrentFor`).
- Notification targets are resolved when the list is read, never stored
  (`notificationTargetFor`), so a stale row cannot carry a stale
  destination.
- The under-18 wall on the discovery routes (`UNDER_18_WALL`,
  `VERIFIED_CLUBS_ONLY`, `NOT_VISIBLE`) names its rule on purpose
  (N-P81-2); it is not a recruitment-resource link.
