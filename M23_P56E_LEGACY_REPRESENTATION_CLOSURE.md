# M23 P5.6E — the legacy representation closure

Two things in this codebase are called "representation". Only one of them is
authority. This document says which, and how the other was closed.

## 1. The two lanes

| | Canonical | Legacy |
| --- | --- | --- |
| Store | `db.representationAgreements` | `db.representations` |
| Built by | M23 P5.6B | M13 F10 |
| Names an individual agent | yes (`agentUserId`) | **no** (`agentUserId: null`) |
| Requires the client's confirmation | yes | no |
| Carries scope, jurisdiction, term | yes | partially |
| Grants access | **yes**, via `agreementGrantsAccess` | **no** |

M13 F10 was a club-side record that a player was "represented" — a note about the
market, written by whoever was looking. It was never a mandate, and it never
carried the individual who held one.

## 2. What P5.6E changed

Three things, in the order they matter:

1. **The predicate cannot be satisfied by a legacy row.** Every P5.6E surface
   goes through `agentClientBasis`, which wraps `agreementGrantsAccess(a,
   agentUserId, now)` and is always asked about a **named** agent. A row whose
   `agentUserId` is `null` fails its own test: there is no agent for the
   predicate to match. Asserted purely four ways (C-p1 … C-p4), including the
   adversarial case of a caller with no id at all — a null agent asking about a
   null agent is still refused (C-p1).

2. **The legacy lane was closed as a writer.** No P5.6E route writes
   `db.representations`, and no new code path reads it for authority.

3. **The legacy row still reads as history.** A mirrored row may still show as
   `active` on the surfaces that showed it before (C-p5). This is deliberate. The
   record says what a club once noted; rewriting it would be a lie about what
   happened. What changed is that it grants nothing — the predicate withholds
   authority, not a rewrite of the past.

## 3. Why the mirror does not even register as "not active"

`agentClientBasis` distinguishes three answers:

```
{ ok: true,  … }                          an active mandate
{ ok: false, status: 'expired' | 'disputed' | 'proposed' | … }   a mandate that is not active
{ ok: false, status: null }               nothing at all
```

A legacy mirror produces the **third**, not the second (C-p4). It names nobody, so
there is nothing to be non-active about. This matters because the second answer is
reported to the agent — who already knows their relationship exists — while the
third is what a third party gets. A mirror must not be able to tell a stranger
that some relationship is in some state.

## 4. The rule that made this in scope

§105: *if an older path can bypass current Agent authorization, that is IN SCOPE;
fix the root cause and add a regression.*

The legacy lane was exactly such a path: a surface that asked "is this player
represented?" of `db.representations` would have answered yes for a row nobody
confirmed and no agent holds. The closure is at the root — one predicate, asked
about a named individual — rather than a filter at each call site.

## 5. Two other legacy paths audited and left alone

| Path | Could it bypass? | Verdict |
| --- | --- | --- |
| `player.agentName` on the Pro player view | It is a free-text market note, not an authority. It is already withheld from grassroots orgs, and P5.6E's club presence projection does not read it. | no change |
| M12 `representation` stage words on a case | Vocabulary, not authority. No route consults them for access. | no change |

Neither is used as authority anywhere, so neither was changed. Recording that they
were looked at is part of the closure: an audit that only lists what it changed
does not say what it checked.

## 6. The regression

`scripts/m23AgentIntegrationE2E.mjs` group **C** (five pure assertions) is the
permanent guard. It builds a legacy mirror by hand — the shape M13 F10 produced,
with `agentUserId: null` — and asserts that it grants nothing, produces no basis,
reaches no surface, and does not register as a non-active relationship, while
still reading as the history it is.
