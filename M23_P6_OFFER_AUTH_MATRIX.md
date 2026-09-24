# M23 P6 — Offer authorization matrix

Every row is enforced server-side on every request; the apps only decide
what to show. "Concealed" means the same 404 body as for an Offer that does
not exist (`OFFER_NOT_FOUND` / `ROOM_NOT_FOUND`).

## 1. Club (Pro / Grassroots) — room roles (`roomCan`, m17/shared.mjs)

| Act | viewer (0) | contributor / scout (1) | room_lead (2) | recruitment_admin (3) | foreign club |
| --- | --- | --- | --- | --- | --- |
| read the Offer surface, an Offer, its history (`offer_view`) | ✓ | ✓ | ✓ | ✓ | concealed (ROOM_NOT_FOUND / OFFER_NOT_FOUND) |
| draft, edit a draft, open a revision (`offer_draft`) | ✗ 403 OFFER_NOT_PERMITTED | ✗ 403 | ✓ | ✓ | concealed |
| issue, withdraw (`offer_issue`) | ✗ 403 | ✗ 403 | ✓ | ✓ | concealed |
| accept / decline for the player | ✗ (no route) | ✗ | ✗ | ✗ | ✗ |
| write `offer_made` / `offer_accepted` / `signed` by hand | ✗ 422 evidence required | ✗ | ✗ | ✗ | concealed |

The role is re-derived from the room at every request (`roomRole`), so a
user whose role changed between draft and issue is refused at issue (#8).
A player, guardian or agent token on any `/org/rooms/:id/offers` or
`/org/offers/:id` route is 401 (router auth).

## 2. Recipient — player

| Condition (re-derived NOW via `resolveContactRecipient`) | list / read | accept | decline | share with agent | document |
| --- | --- | --- | --- | --- | --- |
| adult, the Offer's subject, revision addressed to `player` | ✓ | ✓ | ✓ | ✓ (adult only) | ✓ on issued revisions |
| adult, another player's Offer | concealed | concealed | concealed | concealed | concealed |
| adult who blocked the club | ✓ | ✗ 403 OFFER_BLOCKED | ✓ (closure) | ✓ | ✓ |
| minor (own device) | nothing listed (no revision is addressed to a minor in this build) | concealed | concealed | ✗ 403 OFFER_NOT_PERMITTED | concealed |
| any revision not live / expired / withdrawn / superseded / answered | ✓ read | ✗ 409 named state | ✗ 409 named state | — | ✓ read |
| draft (never issued) | invisible | concealed | concealed | concealed | concealed |

## 3. Recipient — guardian

| Condition | list / read | accept / decline |
| --- | --- | --- |
| the revision's `recipientSnapshot` names THIS guardian and the child is still theirs | ✓ | ✓ (pathway must also be open — closed in this build) |
| another guardian, or the child left their control | concealed | concealed / 422 OFFER_RECIPIENT_INVALID |
| an adult's Offer | concealed | concealed |
| a player token on `/guardian/…` | 401 | 401 |

## 4. Agent

| Condition | `GET /org/agent/clients/:rel/offers` |
| --- | --- |
| the agreement is not this agent's own (same-agency colleague, agency administrator without a summary share) | 404 REPRESENTATION_NOT_FOUND (nothing says an Offer exists) |
| own agreement but the P5.6E `client_private` decision refuses NOW (ended, disputed, licence lapsed, minor, block) | 403 with the decision's code |
| scope does not include `employment` or `transfer` | 403 SCOPE_INSUFFICIENT |
| authorised, but the client has not shared this Offer | empty list |
| authorised and shared by the client (adult, own act) | read-only terms and state of issued revisions; no documents, no note |
| any write (`accept`, `decline`, `issue`, …) | no route (404) |
| agent token on `/player/offers/*` | 401 |

## 5. Admin / Trust & Safety

No Offer route is registered on the admin or reviewer routers. An
administrator sees an Offer only through the existing case audit (ids and
states), never its terms. Deliberate (§42): admin UI existing is not a
reason to expose every Offer.

## 6. Recipient-driven case moves

Accept/decline move the case with the recipient as `actor` through
`applyLifecycleTransition` under the `recruitment_admin` role of the
validator (the Trial pattern); the club user never names those actions
successfully because the evidence — a response row by the snapshotted
recipient — exists only when the recipient acted.
