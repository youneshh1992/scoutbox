# M23 P6 — Minor and guardian model

## 1. The rule (§13)

An Offer's recipient is resolved at ISSUE, and again at every recipient
read and answer, through the P3 recipient rule `resolveContactRecipient`
(`m23/contact.mjs`) — the same function Contact and Trial use. It returns
the adult player, or the verified guardian route for a minor, or a refusal
(`CONTACT_GUARDIAN_REQUIRED`, `CONTACT_RECIPIENT_UNAVAILABLE`,
`CONTACT_BLOCKED`). Age is `isAdult(player, onDate)` from `domain.mjs`,
which reads the date of birth through the P5.7 strict parser and the
jurisdiction's age of majority: a null, false, `0`, impossible or future
date of birth is never an adult (#51; m23OfferE2E A91).

## 2. Fail closed: the pathway is CLOSED in this build

No jurisdiction-specific legal policy for an Offer to a player under the
age of majority is encoded. `MINOR_OFFER_PATHWAY_ENABLED` is a frozen
table with every jurisdiction — and the default — `false`;
`minorOfferPathwayOpen(jurisdiction)` reads it and refuses unknown or
prototype names. Consequences:

- a DRAFT may be written on a minor's case (club-private; the readiness
  surface names `MINOR_PATHWAY_CLOSED` and the Issue button is disabled);
- ISSUE is refused with 422 `OFFER_RECIPIENT_INVALID` and
  `reasons:['MINOR_PATHWAY_CLOSED']` when the recipient resolves to a
  guardian route (#23, #24); forcing the request from the API gets the same
  answer (live F1c);
- therefore no revision is ever addressed to a guardian in this build; the
  guardian routes exist and are fail-closed (they act only on a revision
  whose `recipientSnapshot.type === 'guardian'` naming THEM); Amara's
  screen lists none;
- a minor's own device lists nothing and cannot answer (#23b: 404); the
  player-app share-with-agent route refuses a minor (403
  `OFFER_NOT_PERMITTED`).

Opening a jurisdiction is a policy-table change plus a legal review (the
pure test A8b shows the mechanism); nothing in the routes needs to change.

## 3. When the pathway opens (already encoded, dormant)

- `recipientSnapshot` freezes `{ type:'guardian', guardianId, playerId,
  minor:true }` at issue;
- `responderMatches` lets only THAT guardian answer (#24, #25: another
  guardian, the child, an agent are refused);
- at answer time the live rule is re-derived: a guardian who lost control
  of the child, or a child who became an adult since issue, gets 422
  `OFFER_RECIPIENT_INVALID` (§15);
- a guardian's block on the club applies as the player's would (accept
  refused, decline allowed);
- notifications go to the guardian, never the child; the child's own
  device shows only the outcome line (the M23Offer component renders
  `offersOutcomeOnly` where the server marks a guardian-managed row).

## 4. What is NOT changed

No general agency discovery of minors, no minor Agent representation
pathway (the P5.6B minor gate is untouched; the agent projection is
adult-only through `client_private`), no Trust or Passport mutation, no
50 km rule change. The guardian-managed trial and contact rules are
reused, not duplicated.
