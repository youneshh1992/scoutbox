# M23 P3 — The Contact Contract (as built)

This supersedes `M23_CONTACT_CONTRACT.md` for anything it contradicts and
keeps that document in place as the record of what was frozen **before**
Contact was built. Where the two differ, the difference is listed in §0 with
the reason, so the reader can see what the implementation changed and what it
confirmed.

The governing rule is unchanged: **the recruitment lifecycle must describe
what has actually happened.** `contacted` asserts that a real person was
really approached.

---

## 0. Chronology — what changed between the freeze and the build

| P2 freeze said | P3 built | why |
|---|---|---|
| transport states `draft, queued, sent, delivered, failed, bounced, read, responded` on the Contact object | `draft, delivered, failed, responded, recorded, cancelled` | The transport of record is the in-app Inbox: the request row is written in the same transaction as the Contact, so there is no observable `queued` or `sent` moment, and ScoutBox does not track reading. `bounced` belongs to email, which is a courtesy copy with its own state field, never the Contact's status. `recorded` and `cancelled` were implied by §3 and §9 and are now explicit. |
| "at minimum `delivered`" satisfies `contact_delivered` | `delivered`, `responded`, `recorded` satisfy it; `draft`, `failed`, `cancelled` never do | Same rule, enumerated. |
| §6 "`recordContact` is `room_lead` and above" | `contact_write` = room lead and above; `contact_view` = every room viewer | Confirmed; reading history is internal and open to the room. |
| §8 sending bound to `clientKey` | create, send and external record each bound to a `clientKey` **with a payload fingerprint**, stored on the record | A replay after a restart must still be the same send; a reused key with different content must be refused, not silently replayed. |
| §11 open: how long a recorded external contact stays valid | **Decided** — see §11 | — |
| (not addressed) a draft for someone the club cannot contact | refused at compose time, and the rule runs again at send time | "Access to a player is not permission to contact them" applies to the intent as much as to the act; a draft that could never be sent is a place to store text about a person the club may not approach. |
| (not addressed) a second message before the first is answered | one delivered, unanswered in-app contact per organisation and player per 72 hours (`CONTACT_COOLDOWN`, deterministic, `retryAt` given) | The recipient's silence is an answer for a while. |
| (not addressed) what the recipient's answer is | a state of the Contact (`responded`, with kind, by, at, and the recipient's own words), never a case status | §2's separation, applied to the answer. |

Everything below restates the contract as it now stands.

## 1. What `contacted` means, and what it does not

`contacted` means a recruitment communication **was actually delivered** to
the person the platform routes it to, or a legitimate external contact **was
recorded as having happened** by a named person at the organisation.

It does not mean: a draft was opened, saved or edited; a Contact object
exists; someone pressed "plan contact" (`contact_planned`); a message was
queued; an email provider accepted a payload; a send failed.

## 2. The Contact object's states are not lifecycle states

`draft → delivered | failed | cancelled`, `failed → delivered | failed |
cancelled`, `delivered → responded`; `responded`, `recorded`, `cancelled`
final. None of these is a case status. A response, a decline, a failure after
delivery, a block after delivery: the case stays where it is.

## 3. Which states satisfy the precondition

`delivered`, `responded`, `recorded`, for a Contact of **this org and this
player** that is integrity-sound. The evidence provider answers
`{ satisfied, sourceType: 'recruitment_contact', sourceId }` or
`no_contact_delivered`; a missing store answers `contacts_store_unavailable`
(fails closed).

A delivered in-product contact and a recorded external contact are the same
class of fact and are distinguishable in the record (`channel`, `recordedBy`,
`occurredAt`), because one is observed and the other is attested.

## 4. Failure does not move the case backwards

A failed send keeps the draft, records the attempt with its code, and moves
nothing. A resend is a new attempt on the same Contact. A failure after the
case reached `contacted` leaves it there.

## 5. Minors route to the guardian; agencies never reach minors

The server derives the recipient on every create, send and record: an adult
(canonical `isAdult`, GB 18 / KR 19) is contacted directly; a minor is
contacted through exactly one verified guardian (identity verified,
disclaimer accepted, listed as the child's guardian, not removed); when more
than one qualifies the player's designated guardian decides; when none does
the contact **fails closed** (`CONTACT_GUARDIAN_REQUIRED`) with no direct
fallback. Visibility is the existing `visibleToOrg` wall, so an agency has no
route to a minor and a grassroots club none outside its radius. A block by the
player or the guardian refuses compose and send, and refuses acceptance of a
message that was delivered before the block (declining stays possible).

## 6. Who may act

| action | role |
|---|---|
| read the history, the routing, the case gate | any room viewer |
| draft, edit, cancel, send, record external | room lead and above |
| respond | the recipient the server routed to, through the existing respond routes |

Roles are read per request. A demotion refuses the next write on the same
token; a removal refuses everything.

## 7. What the player or guardian sees

The contact itself, in the existing Inbox: organisation, named scout, subject,
body, a reply field, Accept / Decline. Never the case, its status, its history,
the fact that it moved, a case id, a contact id, or anything drafted and not
sent. A minor sees the existing guardian-managed outcome line and nothing of
the message. Before delivery the club's interest is undetectable, and every
recipient-side surface is byte-free of internal text (the sentinel proof).

## 8. Idempotency, double-send, one transition

Create, send and external record are bound to a `clientKey` with a payload
fingerprint stored on the record: the same key with the same payload replays
the stored result (including after a restart); the same key with a different
payload is `CONTACT_IDEMPOTENCY_CONFLICT`; an already-delivered contact
answers `CONTACT_ALREADY_SENT`. Every mutation requires `expectedRev` with no
coercion. The case transition to `contacted` happens once; later contacts
record `LIFECYCLE_NO_CHANGE` on themselves.

## 9. What Contact must not do — confirmed

Must not write a case status directly (it never does: `advanceCase` calls the
canonical validator and single writer). Must not create a second history
(contact events live on the contact; only the transition appends to the case).
Must not add a lifecycle state per transport state. Must not make interest
detectable (identical 404s, no timing or rate-limit oracle: the limiter is
per organisation, the cooldown is answered only to the organisation). Must
not bypass `visibleToOrg`. Must not let a failed delivery fabricate a status.
Must not describe an email as delivered.

## 10. What the platform already guaranteed, and P3 relied on

The evidence-keyed gate, the identical burden on every inbound edge, the
fail-closed null provider, the single writer, the reason code tied to the
action, the absence of any `PATCH { stage }`. P3 supplied one evidence kind to
a gate that already refused, and the request writer, Inbox, respond routes,
channels, notifications, mailer, events, audit, limiter, concurrency and
moderation it needed were all already there.

## 11. How long a recorded external contact stays valid — decided

**Recordability window: 180 days.** An external contact may be recorded only
if it occurred within the last 180 days (and no more than 15 minutes in the
future, for clock skew). A club records a conversation, not a memory; the
window is long enough for a season's worth of fixture-side conversations to be
entered late and short enough that the person entering it is attesting to
something they can still place.

**Evidentiary validity: indefinite.** Once recorded, the contact stays valid
as evidence for `contacted` for as long as the case exists. The alternative —
a contact that silently stops counting on a date — would make a case that was
honestly `contacted` become dishonest by the passage of time, which is the
opposite of what the gate is for. If a case is closed and reopened long after,
that is a closure/reopen question for P4, which may require fresh evidence
for a fresh pursuit; it is not a property of the Contact.

Both numbers are constants in `CONTACT_LIMITS` (`occurredAtMaxAgeMs`,
`occurredAtSkewMs`), published by the policy route, and asserted at the
boundary by the X group of the server suite.

## 12. State diagram

```
                       ┌──────────── cancel ─────────────┐
                       │                                  ▼
   create ──▶  draft ──┼── send ──▶ delivered ── respond ──▶ responded
                       │      │                       (final)
                       │      └─(transport refused)─▶ failed ──┐
                       │                             ▲   │     │
                       │                 resend ─────┘   │  cancel
                       │                                 ▼     ▼
                       │                              (retry)  cancelled
                       │                                          (final)
   record external ────┴──────────────────────────────▶ recorded (final)

   case:  contact_planned ──(first delivered / recorded)──▶ contacted
          any later contact, response, decline, failure or block: no case change
```
