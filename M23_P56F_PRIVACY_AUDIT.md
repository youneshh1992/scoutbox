# M23 P5.6F — the privacy audit (reconstructed)

> **P5.6F was reconstructed from the frozen `b8556c1` base after an ephemeral
> container loss. The reconstructed implementation is evidenced independently;
> original lost P5.6F hashes are historical references only.**

What P5.6F attacked across the P5.6A privacy matrix, not what the matrix says.

---

## 1. Same-agency privacy

Four agency roles besides the representing agent, all inside the **owning**
agency, against the client-scoped surfaces:

| Caller | client record | own client list names the mandate |
| --- | --- | --- |
| a licensed colleague | refused | no |
| an analyst | refused | no |
| an assistant | refused | no |
| finance | refused | no |
| the agency **administrator** | refused | — |
| the representing agent | **200** | yes |

The last row is what makes the others meaningful: the wall is between *people*,
not around the agency, and the control proves the surface works at all. That is
P5.6A DR-26 — one agent for conflict purposes, separate people for data.

## 2. The minors wall, and the age oracle

The wall is not "an agent sees a redacted minor"; it is that a minor is
**indistinguishable from a player who does not exist**:

| Probe | Minor | Non-existent | Identical? |
| --- | --- | --- | --- |
| mandate request | refused | refused | **byte-identical** |
| forged `dob` + `isAdult` + `guardianConsent` + `minorPathway` | refused | refused | **byte-identical to the ghost** |
| agent player search | absent | absent | — |

The minor pathway is disabled in **every** jurisdiction, and the assertion checks
every value in `MINOR_PATHWAY_PRODUCTION_ENABLED` rather than the three named
ones, so a jurisdiction added later cannot default to open.

**And a new one this milestone (F-8).** A player whose date of birth is unknown
used to be read as an **adult** — `new Date(null)` is the epoch, not an invalid
date. That is a privacy and safeguarding failure as much as an authorization one:
an age-unknown player would have been exposed to adult pathways. Unknown age now
fails closed on both age paths, and the minor gate blocks with
`SUBJECT_DOB_UNKNOWN`.

## 3. Counts, cursors and totals

A count that counts rows the caller cannot see is a disclosure. Asserted on the
agent client list, the opportunity board and the transaction list: `total` either
does not exist or equals exactly the number of rows returned.

On the agency-reaches-club-lists question, measured directly: `/org/rooms`
returns `items: []`, `total: 0` and **every funnel count 0** to an agency. The
1,452 bytes it returns are schema and vocabulary, not data.

## 4. Deep links after authority loss

The agent terminates her own mandate, then re-uses the ids she already holds:

| Link | Result |
| --- | --- |
| the client's opportunities | refused |
| the relationship record itself | **200 — deliberately.** P5.6B keeps an ended mandate as the agent's own history. |

That last row is why the assertion is about **contents** rather than status: the
record carries no Passport, no assessments and no contacts. History is not access.

## 5. Cross-tenant and cross-platform

- twelve `/org` surfaces probed with an agency token: **zero** references to
  another org's case, player or user;
- a genuine club case id is concealed **byte-identically** to an invented one,
  across four routes;
- a foreign agency cannot open another agency's mandate.

## 6. Error privacy

Every refusal the hardening suite provoked is swept at the end: none is a 5xx,
none carries a stack trace or a file path, and none mentions an offer, a
commission, a signing or a fee.

## 7. Grassroots

The P5.6A matrix says "Grassroots. No agent surface." Now observed rather than
inferred: no agency vocabulary in the shell or the navigation, five agent-lane
routes refused 403, no agent field in the player projection, no date of birth in
the player list, and the radius filter still withholding **12 of 14** players a
professional club can see — with each of six withheld ids answering **403,
identically**, so the radius is neither a mere list filter nor an existence
oracle.
