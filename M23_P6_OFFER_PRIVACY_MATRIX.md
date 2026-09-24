# M23 P6 — Offer privacy matrix

What each audience can read of an Offer, field by field. "—" means the
field is absent from the payload (not redacted to null: its existence is
not disclosed either). Enforced by the three view functions in
`m28/offer.mjs` and the audience rules of the event registry; swept by
sentinels in m23OfferE2E (groups F, H, I, U) and m23OfferLive (N10).

| Field | Club (room reader) | Recipient (player / guardian) | Agent (client shared) | Same-agency colleague / agency admin | Event stream (org channel) | Notification text | Journey / analytics |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Offer id, status, revision numbers | ✓ | ✓ (issued only) | ✓ (issued only) | — (404) | id + status word | id as `refId` | id + derived status |
| terms (role, squad, start, end, conditions) | ✓ | ✓ | ✓ | — | — | — | — |
| `recipientMessage` | ✓ | ✓ | ✓ | — | — | — | — |
| `internalNote` | ✓ | — | — | — | — | — | — |
| documents | ✓ (label, vault id) | ✓ by Offer id + bytes on request | — | — | — | — | — |
| `expiresAt`, `issuedAt` | ✓ | ✓ | ✓ | — | — | — | — |
| `decisionId` | ✓ (id only) | — | — | — | — | — | — |
| the decision's rationale / reasons | — (a decision record, not an Offer field) | — | — | — | — | — | — |
| `transactionId`, readiness snapshot | ✓ | — | — | — | — | — | — |
| transaction notes / parties | — | — | — | — | — | — | — |
| assessment content, Box Cam observations | — | — | — | — | — | — | — |
| `recipientSnapshot` | type + minor flag | — | — | — | — | — | — |
| responses (who: kind, when) | ✓ + decline reason | ✓ (own) | ✓ (kind, when) | — | status word | factual line | — |
| withdraw reason | ✓ | — | — | — | — | — | — |
| `firstViewedAt` (receipt) | ✓ | — | — | — | — | — | — |
| `agentShared` | ✓ (boolean) | ✓ | (`sharedAt`) | — | — | — | — |
| WHICH agent | — | (their own choice) | self | — | — | — | — |
| history | full | issue/withdraw/answers/share only (no draft or internal entries) | — | — | — | — | — |
| error bodies | codes + allowlisted fields | codes only; a state word, never a note or blocker detail beyond codes | codes | 404 body identical to a missing Offer | — | — | — |

## Rules the matrix encodes

1. **Draft privacy (§14, #5, #6).** A DRAFT revision is invisible to the
   recipient and to the agent — not redacted, absent: the Offer is not
   listed until a revision was issued, and a draft withdrawn before issue
   never appears.
2. **Concealment (§50, §51).** A foreign club, another player, a guardian
   of other children, a same-agency colleague and an invented id all read
   the same body. m23OfferE2E #49/#50 asserts byte-identical bodies.
3. **Events (§35, §36).** All six Offer events are `org_private` with
   payload `orgId, roomId, offerId` (+ the status word on `offer_responded`).
   The registry throws on any other key in non-production; the club stream
   never carries a term, and the player stream never carries an Offer event
   at all — the recipient hears through a notification.
4. **Notifications (§37).** A factual line and the Offer id. "issued you an
   Offer… Accepting is not a signing." / "withdrawn" / "accepted — signing
   pending". Category `offer_updates`, not mandatory.
5. **P5 (§10, #36).** The decision's note never enters any Offer payload;
   the club view carries the decision id only.
6. **Transactions (§11, #37).** A recipient payload names no transaction; a
   refusal carries blocker CODES only.
7. **Agent (§12, §33).** Only what the client shared, only while the
   mandate holds NOW, no documents, no note; no route accepts for a client.
8. **Admin.** No Offer terms reach the admin or Trust & Safety surfaces.
