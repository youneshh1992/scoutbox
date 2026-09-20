# M23 P5.6F — the security and authorization audit (reconstructed)

> **P5.6F was reconstructed from the frozen `b8556c1` base after an ephemeral
> container loss. The reconstructed implementation is evidenced independently;
> original lost P5.6F hashes are historical references only.**

What was attacked, what held, and what did not.

---

## 1. The authorization order, tested by its consequences

P5.6A fixes nine steps and states that a route stops at the first refusal, so a
refusal never reveals more than the step it failed at.

| Step | The attack | Result |
| --- | --- | --- |
| 1–2 authenticate / resolve | a player token on an agent route; a club token on five agent routes; the shared admin key on `/ts/*` | refused in all cases (403 / 401 `REVIEWER_AUTH_REQUIRED`) |
| 3 agency membership | a colleague whose affiliation was ended **mid-session** | refused on the very next request, on five agent routes, with no re-login in between |
| 4 conceal foreign resource | an agency reading a real club case | **byte-identical** to an invented id — 404 `ROOM_NOT_FOUND` — across four routes |
| 5 licence | an agent with no verified facet | refused; the refusal is about the caller's own state and names no player |
| 6 representation | all six non-active states, an unconfirmed "active", a foreign agent, a legacy mirror | none grants |
| 7 policy / conflict | see §3 | |
| 8 block / safeguarding | a minor vs a player who does not exist; and an **unknown age** | byte-identical; unknown age fails closed |
| 9 mutate | rev and idempotency | see `M23_P56F_CONCURRENCY_IDEMPOTENCY.md` |

## 2. The one predicate, and the three holes in the same idea

Everything asks *does this agreement grant this agent access?* through one
function. Two fail-open holes were found there, and a third of the **same kind**
was found in the age layer.

| Row | Before | After |
| --- | --- | --- |
| term begins in a year | **granted** | refused |
| term begins in 1 ms | **granted** | refused |
| `startAt` `NaN` / ISO string / `Infinity` | **granted** | refused |
| `endAt` an ISO string, already past | **granted for ever** | refused |
| `endAt` `NaN` / numeric string / `Infinity` | **granted for ever** | refused |
| no `endAt` (open-ended, FFAR 12(5)) | granted | granted — still |
| in term | granted | granted |
| **`dob: null`** (F-8) | **adult** | age unknown, never adult |
| `dob: 0` / `false` | **adult** | age unknown, never adult |
| real 17-year-old | minor | minor |
| real adult | adult | adult |

**A boundary that is absent keeps its meaning. A boundary that is present must be
readable and satisfied.** F-2, F-3 and F-8 are one rule applied in three fields,
and stating it that way is what found the third.

## 3. Conflict severity, as a property

Twenty-five outcome pairs aggregated through `mostSevere` against the implemented
order, plus the downgrades §6 forbids, each asserted individually:

- a prohibition is never downgraded to consent-required;
- nor to `CLEAR`;
- nor to manual review — an absent answer cannot soften a definite one;
- nor to insufficient data;
- uncertainty is never resolved as permission;
- and "needs review" still outranks "clear", so the order is not simply
  "always refuse".

The evaluation fingerprint is key-order independent (`inputHashOf` /
`canonicalJson`), so two recordings of the same facts compare equal while
different facts do not.

The implementation is **stricter** than the P5.6A contract's printed order; that
divergence is F-4, recorded rather than reconciled by editing a frozen document.

## 4. Attributed compliance decisions (G-C0)

| Attack | Result |
| --- | --- |
| the shared admin key on `/ts/*` | 401 `REVIEWER_AUTH_REQUIRED` — "the shared admin key is not a reviewer" |
| an agent session on `/ts/*` | 401 |
| a reviewer's projection | carries no secret and no hash |
| a wrong secret vs an unknown reviewer id | **one** refusal, byte-identical — the login is not a roster oracle |
| `/ts/me` | `attribution: 'authenticated_reviewer'` |

## 5. Credential guessing

The platform had an IP-scoped throttle all along (F-1 withdrawn, and **re-proved
by execution**: 429 at attempt 41 with `retryAfterMs`). What it lacked was a
per-account budget, and it spent the anti-guessing budget on successes. Both are
addressed by `login_failure`, whose seven properties are each measured — see F-5
in the defect register for the table.

## 6. What an attacker still cannot reach

Asserted, not assumed:

- **club-private recruitment intelligence** — twelve `/org` surfaces probed with
  an agency token: **zero** references to another org's case, player or user; and
  a real club case id is concealed byte-identically to an invented one;
- **the Passport** — five candidate writer routes, none exists or is permitted;
- **the Trust Score** — two candidate writer routes, absent;
- **a minor** — not through a mandate request, not through a compliance context,
  not through an agent player search, and not by forging `dob`, `isAdult`,
  `guardianConsent` or `minorPathway` in the body (the forged request is refused
  identically to one naming a player who does not exist);
- **a player of unknown age** — no longer mistaken for an adult (F-8);
- **another party's documents** — nine visibility classes, an unknown class
  failing closed, `T_AND_S_ONLY` writable by nobody;
- **an Offer** — no lifecycle state, event, document type or writer. The strings
  `offer_made` / `offer_accepted` / `offer_declined` do appear in the **club-side**
  funnel vocabulary, which is pre-existing M23 P4/P5 product and explicitly not a
  P5.6F violation (§15). Checking that distinction mattered: it is the kind of
  grep hit that gets misfiled as a breach.
