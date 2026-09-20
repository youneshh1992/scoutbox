# M23 P5.6F — concurrency, idempotency and input validation (reconstructed)

> **P5.6F was reconstructed from the frozen `b8556c1` base after an ephemeral
> container loss. The reconstructed implementation is evidenced independently;
> original lost P5.6F hashes are historical references only.**

Three mechanisms, and the classification of every Agent-domain mutation across
them. The point of writing the classification down is that "this mutation has no
idempotency key" is only acceptable when somebody decided it, and the decision is
recorded.

---

## 1. The mechanism, as the repo actually implements it

The idempotency key travels in the **body** as `clientKey`
(`normaliseClientKey` in `m23/contact.mjs`: a string of 1–64 characters), not in
an `Idempotency-Key` header. The reconstruction learned this the way it should be
learned — by asserting the header version, watching two "replays" create two
different rows, and reading the route rather than assuming the convention.

A replay answers with `idempotent: true`, so a replay is **labelled** rather than
silently indistinguishable from a fresh act.

## 2. The classification

| Mutation | Guard | Why that one |
| --- | --- | --- |
| representation request | **key + cooldown** | it reaches a person; a replay must not send a second ask |
| client confirm / decline / terminate / dispute | **key + rev** | a client's answer is a one-time act with a version |
| disclosure change (`PATCH …/sharing`) | **rev** | three choices on one record, one rev per change, so two questions cannot be answered in one race |
| compliance context create / parties / representations | **key + rev** | each writes a party or a basis into a regulated record |
| consent request | **key** | it asks a party something; a replay must not ask twice |
| consent answer (grant / decline / revoke) | **key + rev** | the answer itself, raced between two tabs |
| transaction create / parties / representations / terms / status | **key + rev** | every one is a regulated write with a visible state |
| transaction documents | **key + rev** | a document is an artefact; a replay must not file two |
| transaction notes | **rev only** | a small append whose duplicate is visible to its author; a key would be ceremony |
| transaction links | **rev only** | it overwrites one field |
| handoff invite / withdraw | **key + rev + quota** | it notifies two people, and the pair is a loop (P5.6E E-16) |
| opportunity share / withdraw | **key + quota** | it notifies the client, and the pair is a loop |
| reviewer provisioning / revocation | **rev** | a roster change, behind an administrator |
| policy publication | **dual control** | the only mechanism that changes what the rules *are* |

**Nothing is left "neither justified".** The two `rev only` rows are the
deliberate ones.

## 3. What the races prove

| Race | Result |
| --- | --- |
| two disclosure writes reading the same rev | the first lands; the second is **409** |
| the same `clientKey`, same payload | replays the original answer, `idempotent: true` |
| the same key, a different payload | **409 `REPRESENTATION_IDEMPOTENCY_CONFLICT`**, not a second row |
| a non-string key (`12345`) | **400 `AGENT_CLIENT_KEY_INVALID`** — a key that stringifies differently on two calls is not a key |
| revoke a reviewer while their session is live | the session is refused on its next request |
| end an affiliation while the agent's session is live | every agent route is refused on the next request |
| a mandate terminated, then its ids reused | client-scoped surfaces refused; the record itself remains as history with nothing private in it |

The session ones matter most for a hardening pass: they are the cases where the
*state* changed and the *session* did not, which a suite that logs in fresh for
every assertion never sees.

## 4. Input validation

Sixteen non-boolean values are sent to the disclosure parser — `'yes'`, `'true'`,
`'false'`, `'0'`, `'1'`, `0`, `1`, `-1`, `''`, `'on'`, `'off'`, `[]`, `{}`,
`null`, `undefined`, `NaN` — and **none** is accepted as "yes". A real boolean
`true` is accepted and a real `false` is stored as `false`, so the parser is
strict rather than broken. An unknown key reaches no stored field, and there are
exactly three keys.

Term length: a non-integer, `0`, above the FFAR 12(3) two-year cap, `NaN`, `[]`
and `{}` are all refused; an absent term takes the documented default.

Permissions: `__proto__` and `constructor` are not permissions.

Elsewhere: a forged `dob`, `isAdult`, `guardianConsent` or `minorPathway` on a
mandate request changes nothing and is refused identically to a request naming a
player who does not exist.

## 5. What the fail-open findings add to this picture

F-2, F-3 and F-8 were not race conditions — they were **validation** failures in
security decisions: a value that could not be read was treated as a constraint
that did not exist. The lesson is the same one this section is about: in a
security decision, *unreadable* must mean *refuse*, never *ignore*.

Twenty-two temporal cases and eight age cases now assert it, and the legal shapes
(open-ended term; a real date of birth) still work.
