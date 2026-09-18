# M23 P5.6B — Agent Privacy Verification

What each actor can and cannot see or do in ScoutBox Agent after P5.6B, and
the test that proves each cell. The frozen model is the P5.6A privacy
matrix (`M23_P56A_AGENT_PRIVACY_MATRIX.md`); this document records what
the tree now enforces, test by test. Suite abbreviations: **E** =
`scoutbox-server/scripts/m23AgentE2E.mjs`, **P** =
`scoutbox-server/scripts/m23AgentPersistence.mjs`, **L** =
`e2e/m23AgentLive.test.mjs`, **D** = `e2e/m23AgentDemoSpotcheck.test.mjs`.

---

## 1. Who sees what — the implemented matrix

| Data | Licensed agent (own client, ACTIVE) | Licensed agent (own client, PROPOSED / DISPUTED / ENDED) | Same-agency colleague | Other agency | Club user | Player (subject) | Shared T&S key |
|---|---|---|---|---|---|---|---|
| Relationship record (status, scope, term, dates, history) | full | full | **summary** (id, status, dates, client name) only if the client toggled sharing, else 404 (E M7, M11–M15) | 404 (E N8–N10; every read is scoped to `agencyOrgId`) | 403 (E F4–F5, N1–N2) | own record, full, plus their own dispute reason (E D34, L C2) | list, read-only, **no dispute reason** (E R1–R2, L E6) |
| Client identity | public view (`playerViewForOrg`) + `accessBasis: active_confirmed_relationship` (E M1, L D1) | minimal (id, name, position, age, club, country) with `accessBasis: pending_request` / `none`; **name null** when blocked or removed (E K10–K11, O6, U3) | client name only in the summary | — | — | — | ids only |
| Client's opportunities board | yes, the player's own board through the same engine (E M2–M4, L D3–D4) | **409 REPRESENTATION_NOT_ACTIVE** (E K18, M21, L B20) | 403 (E M13) | 404 | 403 | own | — |
| Agent's licence facets | own: state, reference, provenance, note | own | team row: state only, never a number (E G7–G8) | — | — | **state + honest caveat**, never a reference (E L2–L3, L C3–C4) | states + provenance; references and numbers withheld (E R4, D-P56B-6) |
| Dispute reason | **never** (E D33, M20, L E4) | never | never | never | never | own | never (E R2, L E6) |
| Agency team, roles | read | read | read; write only `agency_admin` | 404 | 403 | — | — |
| Agency audit feed | 403 (E L20) | 403 | `agency_admin` only; content-free rows (E T2) | — | 403 | — | — |
| Player's Passport, Trust, Box Cam, contacts | **no route exists** (E S9–S12) | no route | no route | no route | unchanged M15/M16.2 rules | own | unchanged |

## 2. The eight privacy claims, each with its evidence

1. **A request is not access.** `agreementGrantsAccess` is false for a proposal; the detail says `access: false`, the client identity carries `accessBasis: pending_request`, and the board answers 409. — E D14, K18–K20; L B19–B20.
2. **A colleague at the same agency sees nothing unless the client chooses.** Tomás (admin + licensed agent) and Ben (analyst) get 404 for Ana's client; after Kola toggles `shareWithAgencyStaff` Ben sees a summary with no scope, history, client data or access basis; after Kola withdraws the toggle Ben is back to 404; Tomás's aggregate board stays empty. — E M5–M15; L N2c, N3.
3. **A dispute suspends access and its reason stays with the client.** After Mateus disputes, Ana's `access` is false, the board is 409, neither side can end or re-confirm, the agent cannot re-request around it, and the reason string appears in no agent, admin, audit or notification body. — E M18–M27, R2, T2, E2; L E1–E6.
4. **A minor is unreachable.** Never in the lookup, whatever the query; a request naming a minor is the uniform 404; a minor's My Agent is empty with `minor: true`; a minor cannot act; the recorded `minors_authorisation` facet activates nothing. — E H6–H7, J5, K7, N6–N7; L B15, N10–N10b.
5. **A block ends solicitation.** A player who blocked the agency vanishes from the lookup, a request to them is the uniform 404, confirming through a block is refused and explained, and after a block the agent's record shows the client as unavailable with no name. — E O1–O6.
6. **Deletion leaves an id-only tombstone.** After the player deletes their account the agent's record survives with `subjectRemovedAt`, no name, no access; the stored row has no dispute reason and no player attribution in its history; the tombstone survives a restart. — E U1–U5, W8.
7. **The shared Trust & Safety key can look and not touch.** Two read-only admin routes; seventeen conceivable adjudication routes answer 404; the disputed relationship and the profile are byte-identical afterwards; agent facets are not M14 claims. — E R1–R10; L E6.
8. **Nothing leaks across the wire that the registry did not allow.** The nine Agent events are `org_private`/`org_internal` with ids-only payloads; the SSE frame Ana receives on confirmation carries no client name; notifications to the player never carry a reference number. — E T1, L12–L13; L C4.

## 3. Refusal shapes

Every refusal in the E suite carried a status and a machine code, none
carried a stack, an internal field or a dispute reason (E E2, 98+ refusals
collected). Concealment uses 404 for a foreign agency's record, a
colleague's record, an unknown id, `__proto__` and `constructor` alike
(E N8–N10). The subject check on a request is uniform: does-not-exist,
minor, invisible, blocked and an organisation id all answer
`404 PLAYER_NOT_FOUND` (E K6–K8, H7, O2), and the agent's own verification
refusal comes first so a refused agent learns nothing about the subject.

## 4. What the client apps show, and what they never show

- **Agent app** never renders a licence number on the team, compliance or
  client screens (E G8, H17; L N5 sweeps ten screens for offer, negotiation,
  commission, fee and transaction-room wording). The Home screen states in
  its own words that no offer, negotiation, fee or contract happens there.
- **Player app** shows the agent's display name, agency and the licence
  **state** with the honest caveat ("Verified against recorded provenance
  in ScoutBox; check the provenance before relying on it" / "This agent's
  licence is NOT verified in ScoutBox"), never a reference (L C3–C4, D
  player section).
- **Club apps** are untouched: a club's player view carries no P5.6B
  relationship or agent name (E N11); the M16.2 Trust projection has no
  agent term (E N12, DR-21 deferred).

## 5. What is deliberately not verified here

- The dispute is terminal in P5.6B: no surface resolves it. The privacy of
  a *resolution* is a P5.6C matter, gated on attributed T&S identity (G-C0).
- No guardian surface exists for agent relationships because no minor
  relationship exists.
- The legacy F10 lane (`db.representations`, the player's earlier
  Representation section, the club app's Representation screen) keeps its
  M13 privacy rules; P5.6B mirrors its rows read-only and changes nothing
  in that lane (P §2–§3).
