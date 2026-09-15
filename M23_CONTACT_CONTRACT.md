# M23 — The Contact Semantic Contract

Frozen before Contact is built, because the questions below get answered
implicitly by the first implementation if they are not answered explicitly
first — and an implicit answer is one nobody can disagree with until it ships.

The governing rule applies to Contact more sharply than to anything else in the
lifecycle: **the recruitment lifecycle must describe what has actually
happened.** A case that says `contacted` is asserting that a real person was
really approached. Nothing else in P2 makes a claim about the world outside
ScoutBox except `signed`.

---

## 1. What `contacted` means, and what it does not

`contacted` means a recruitment communication **was actually initiated**, or a
legitimate external contact **was recorded as having happened**.

It does **not** mean any of:

| Not this | Because |
|---|---|
| a staff member opened a draft | nothing left the building |
| a Contact object was created | a record of intent is not the act |
| a form was started or saved | same |
| someone pressed "plan contact" | that is `contact_planned`, which already exists |
| a message was queued | queued is not sent |
| a provider accepted the payload | accepted ≠ delivered (M13's delivery centre already draws this line) |

## 2. The transport states are NOT lifecycle states

`draft`, `queued`, `sent`, `delivered`, `failed`, `bounced`, `read`,
`responded` belong to the **Contact object**. They are its states, and it needs
all of them.

None of them is a case status. **A case does not change position in
recruitment because an email bounced.** A bounce is a fact about an address; the
club's pursuit of the player is exactly where it was.

This is the same separation M13's delivery centre already enforces for
notifications, and reusing that vocabulary rather than inventing a second one
is the point.

## 3. Which transport state satisfies the precondition

`contacted` requires `contact_delivered` evidence. The provider must answer
`satisfied: true` for exactly one condition:

> A contact record exists for **this org and this player**, it is not
> cancelled or withdrawn, and it has reached a state that means the recipient
> could have received it.

Concretely, at minimum `delivered`. `sent` is **not** enough on its own: "we
handed it to a provider" is a fact about our infrastructure, not about the
player. Where a transport genuinely cannot report delivery (a phone call, an
in-person conversation at a fixture), the club **records** the contact
explicitly and that recorded act is the evidence — attributed to the named
person who recorded it, with the date they say it happened.

A recorded external contact and a delivered in-product contact are the same
class of fact and satisfy the same requirement. They are distinguishable in the
record (`channel`, `recordedBy`) and must be, because one is attested and the
other is observed.

## 4. Failure does not move the case backwards

If a contact fails after the case reached `contacted`, the case **stays** at
`contacted` and the failure is recorded on the contact. Moving the case back
would assert that the approach never happened, which is false — it happened and
did not arrive.

Retrying a failed contact creates no new lifecycle transition. The case is
already where it is.

## 5. Minors route to the guardian, and that is not new

Contact routing for a player under 18 goes to the guardian. This is the
platform's existing rule (`routedTo: 'guardian'`), enforced before M23 existed,
and Contact must use it rather than re-deriving it.

A guardian-routed contact that is delivered satisfies `contact_delivered` for
the case. The player is not separately contacted and the case does not wait for
the player.

## 6. Who may perform the action

`recordContact` is `room_lead` and above, as declared today. Contact is an
outward-facing act with a real person on the other end; a contributor may
propose one, and the existing task and comment machinery is where that
proposal lives.

## 7. What the player sees

The player or guardian sees **the contact itself** — it was sent to them. They
do not see the case, its status, its history or the fact that it moved.

The case moves **because** the contact exists, through the precondition. The
player never addresses the case, and `sharedRecordsFor` already implements
exactly this: it returns the records that crossed a share boundary and no case
id.

Before a contact is delivered, the club's interest remains undetectable, and
the journey answers a player `CASE_NOT_FOUND` byte-identically to a case that
never existed.

## 8. Idempotency and double-send

Sending is bound to the caller's `clientKey`, as every lifecycle action already
is. A retried send with the same key is the same send.

The lifecycle transition to `contacted` is separately idempotent and happens
**once**: a second delivered contact to the same player does not produce a
second `room_status_changed` entry, because the case is already at `contacted`
and a self-transition is `LIFECYCLE_NO_CHANGE`.

## 9. What Contact must NOT do

- **Must not write a case status directly.** It records a contact; the
  lifecycle reads it through the evidence provider. Same direction as signings:
  fact → lifecycle, never lifecycle → fact.
- **Must not create a second history.** Contact events live on the contact.
  Only the transition appends to `case.history`.
- **Must not add a lifecycle state per transport state.** See §2.
- **Must not make interest detectable.** A player must not be able to infer an
  open case from a difference in any answer, including a rate limit, a timing
  difference or an error code.
- **Must not bypass `visibleToOrg`.** An agency sees no minor,
  unconditionally; grassroots fails closed on missing location and enforces the
  50 km radius. Contact adds no exception and no new access path.
- **Must not let a failed delivery fabricate a status.** See §4.

## 10. What P2 already guarantees for it

| Guarantee | Where |
|---|---|
| `contacted` is unreachable without evidence | `STATUS_EVIDENCE_REQUIRED`, keyed by target |
| every inbound edge carries the identical burden | the table is keyed by target, not by `(from, to)` |
| a missing provider fails closed | `NULL_EVIDENCE_PROVIDER`, `not_implemented` |
| the transition writes one history entry | `applyLifecycleTransition`, the single writer |
| the reason code matches the event | `applicableFrom` + `recordContact`'s own `contact_made` |
| a client cannot name the destination | there is no `PATCH { stage }` |

Contact's job is to supply one evidence kind — `contact_delivered` — to a gate
that already exists and already refuses.

## 11. The open question this contract does not settle

**How long a recorded external contact stays valid as evidence.** A phone call
attested to have happened three years ago is a weaker basis for `contacted`
than one last week, and the product has no opinion yet.

Recorded here rather than guessed: an expiry rule invented now, before anyone
has seen how clubs record external contacts, would be a number defended by
nothing. The phase that ships Contact should decide it with a reason, and until
then the provider answers on existence rather than on recency.
