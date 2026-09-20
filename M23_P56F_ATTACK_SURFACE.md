# M23 P5.6F — the Agent attack surface (reconstructed)

> **P5.6F was reconstructed from the frozen `b8556c1` base after an ephemeral
> container loss. The reconstructed implementation is evidenced independently;
> original lost P5.6F hashes are historical references only.**

What an attacker can reach, counted rather than remembered.

---

## 1. The surface, measured

Routes registered by the four Agent-domain modules, counted from the source at
this tip:

| Module | Routes | What it is |
| --- | --- | --- |
| `m24` | 29 | agents, agencies, representation relationships |
| `m25` | 31 | policy, conflict, consent, reviewers, the minor gate |
| `m26` | 39 | the transaction workspace |
| `m27` | 10 | the integration seam to Contact / Inbox / Trial / P5 |
| **total** | **109** | |

Counted by matching `(orgRouter|playerRouter|guardianRouter|adminRouter|tsRouter).(get|post|patch|delete|put)('` in each module's `index.mjs`. The original
P5.6F reported 117 by a method that is no longer recoverable; **109 is what this
tip measures**, and the discrepancy is recorded rather than reconciled by
adopting the older number.

All of them hang off shared Express routers. That matters: no Agent route has a
private authentication path, so nothing in this domain can be secured by being
hard to find.

## 2. The single choke point

Every one of the 109 eventually asks one question — *does this agreement grant
this agent access?* — through **one** function, `agreementGrantsAccess` in
`m24/shared.mjs`.

That is the domain's greatest strength and its largest single risk, and this
milestone demonstrated both: two fail-open holes in that one function
(F-2, F-3) were simultaneously present on every one of the 109 routes. A domain
with one predicate is auditable; it is also uniformly wrong when the predicate is.

## 3. What an attacker brings

| Capability | Where it is tested |
| --- | --- |
| a valid session for the **wrong kind** of actor (player token, club token, admin key) | hardening A, T, I |
| a session that was valid and whose **underlying authority changed** (affiliation ended, reviewer revoked, mandate terminated) | hardening A/live, V |
| membership of the **owning agency** but not the mandate | hardening D/live |
| **ids they legitimately hold** from an earlier, permitted state | hardening V |
| a **forged body** (`dob`, `isAdult`, `guardianConsent`, `status`, `ownerAgentUserId`) | hardening J, AD |
| a **malformed record** in the store — an imported or legacy row | hardening A, and F-2/F-3/F-8 |
| **volume** — repeated writes, repeated guesses, invite/withdraw loops | hardening AA, AB |
| **races** — two answers to one question | hardening AC |

## 4. The four boundaries that carry the most

1. **Agent ↔ their own client.** The mandate. Everything else in the domain
   hangs from it, which is why the term rule is where the defects were.
2. **Agent ↔ their agency colleagues.** The least intuitive wall in the product:
   one agency, but data separated by *person*, because the conflict rules need one
   agent while privacy needs separate people (P5.6A DR-26).
3. **Agency ↔ club.** Two directions, and the interesting one is the reverse:
   a club must not reach `/org/agent/*`.
4. **Anyone ↔ a minor.** Not "a redacted minor" but *indistinguishable from a
   player who does not exist*.

## 5. What is deliberately NOT on the surface

Asserted as absent, because an absence nobody tests is an assumption:

- **no Offer workflow.** No `offer_made`, `offer_accepted`, `offer_declined`
  state, event or writer; no document type names one.
- **no signing writer.** `db.signings` is not written from any Agent module —
  `m26/index.mjs` says so in a comment and the tests confirm it.
- **no Passport writer.** Five candidate routes probed; none exists or is permitted.
- **no Trust writer.**
- **no minor pathway.** `MINOR_PATHWAY_PRODUCTION_ENABLED` is `false` in every
  jurisdiction, and every value is checked rather than the three named ones.

## 6. Where the reconstruction looked that the original did not

The original pass found F-2, F-3 and F-5 in the representation and auth layers.
Re-running the same reasoning over the *age* layer found **F-8**: `new Date(null)`
is the epoch rather than an invalid date, so a record with no date of birth
computed as a 56-year-old and read as an **adult** on both age paths. The import
path stores exactly that shape.

The lesson for the surface map is that "unreadable input in a security decision"
was a **class** of defect, not three instances of one. F-2, F-3 and F-8 are the
same mistake in three different fields.
