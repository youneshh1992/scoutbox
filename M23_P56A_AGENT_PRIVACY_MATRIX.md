# M23 P5.6A — Agent Privacy Matrix

Who may see what, once the Agent product exists (P5.6B–E). Thirteen viewer
columns (mandate §100), sixteen data rows. Nothing in this matrix widens
any existing Player / Club / Trial / Decision boundary; several rows
restate existing rules so the Agent product cannot be read as an
exception to them.

Legend: **FULL** the whole record; **OWN** only records the viewer is a
party to / author of; **SUMMARY** a reduced projection named in the note;
**SHARED** only what the data owner explicitly shared to that viewer;
**—** nothing, and the refusal is indistinguishable from "does not exist"
where the row says *concealed*.

Viewer definitions: *Licensed Agent* = the agent named on an `active`,
client-confirmed agreement with the subject (otherwise treated as *Other
Agent at Same Agency* if affiliated, else nothing). *Other Agent at Same
Agency* = a `licensed_agent` at the same agency not named on the
agreement. *Agency Admin / Analyst / Assistant / Finance* =
`agencyAffiliations.tier`. *Engaging / Releasing / Other Club* = the club
org's users with their existing club-app rights. *Grassroots* = a
grassroots club org. *T&S* = Trust & Safety.

Two cross-cutting rules apply to every cell:

1. **Minors.** For a regulatory minor, every agency-side column is **—**
   (concealed) unless the row says "minor pathway", and then only for the
   Licensed Agent with a verified minors authorisation, inside a
   guardian-consented pathway, re-evaluated on every read.
2. **Blocks.** A block by the player/guardian against the agency turns
   every agency-side column to **—** at read time, agreement or not.

---

## The matrix

| Row | Player | Guardian | Licensed Agent | Other Agent Same Agency | Agency Admin | Agency Analyst | Agency Assistant | Agency Finance | Engaging Club | Releasing Club | Other Club | Grassroots | T&S |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1. Player public profile | FULL (own) | FULL (child) | FULL (adult; minor pathway) | FULL (adult only, `visibleToOrg`) | same | same | same | — | existing club rule | existing | existing | existing | FULL |
| 2. Private Passport (beyond `recruitment`) | FULL | FULL | SHARED (player's own M15 share only) | — | — | — | — | — | SHARED (existing) | SHARED | — | SHARED | FULL |
| 3. Representation agreement (parties, scope, term, status, jurisdiction) | OWN | OWN (child) | OWN | SUMMARY: client name + status only, and only if client set `shareWithAgencyStaff` (DR-25); else — | SUMMARY (same condition) | SUMMARY (same) | SUMMARY (same) | SUMMARY (existence + term for invoicing, same condition) | SUMMARY: agent identity + agreement id + verification state, only inside a Transaction the club is party to | same | — | — | FULL |
| 4. Agreement fee terms | OWN | OWN | OWN | — | OWN-agency (DR-30: admin sees fee terms of agreements at the agency) | — | — | FULL (agency's) | — (fee terms of an *agreement* are not transaction terms) | — | — | — | FULL |
| 5. Guardian consent (approach / agreement) | SUMMARY (minor sees "your guardian consented", no content) | FULL (own) | SUMMARY: exists, kind, at, policy version; **never the guardian's identity beyond the consent record's display name chosen by the guardian** | — | — | — | — | — | — | — | — | — | FULL |
| 6. Minor data (identity, DOB, location) | FULL | FULL | minor pathway only: name, age band, MA; **never DOB, never location** (existing `:716` rule) | — | — | — | — | — | existing club rule (verified + safeguarding-certified) | existing | existing | existing | FULL |
| 7. Club interest (requests, trial invitations, opportunities the club sent) | FULL | FULL | SHARED (what the client shared, A62) | — | — | — | — | — | OWN | OWN | — | OWN | FULL |
| 8. Trial (schedule, attendance, family view) | FULL (family view) | FULL | SHARED (family view only, never `trialDetails.private` beyond what the client sees) | — | — | — | — | — | OWN (existing) | — | — | OWN | FULL |
| 9. Private club assessment | published feedback only (existing) | same | **—** (never; §191) | — | — | — | — | — | OWN (blind rule) | — | — | OWN | FULL |
| 10. Internal recruitment decision (M23 P5) | shared summary only if the club shares (existing) | same | **—** (never; §191) | — | — | — | — | — | OWN | — | — | OWN | FULL |
| 11. Offer (future) | reserved | reserved | reserved (P5.6D+, not designed) | — | — | — | — | — | reserved | — | — | — | FULL |
| 12. Transaction terms (fee, payer, instalments as data) | OWN (individual party) | OWN | OWN (representing agent) | — | OWN-agency (DR-30) | — | — | OWN-agency | OWN (party) | OWN (party) | — | — | FULL |
| 13. Agent private notes | **—** | **—** | OWN | per `shareWithAgencyStaff`? **No**: notes are agency records; visible to `agency_admin` and the author only (DR-26) | OWN-agency | — | — | — | — | — | — | — | FULL (on report / dispute only; otherwise —) |
| 14. Conflict result (outcome, reason codes, policy version) | SUMMARY (outcome + codes for transactions naming them) | SUMMARY | FULL for own transactions | — | FULL for agency transactions | — | — | — | SUMMARY (outcome + codes; **never the other side's agents**) | SUMMARY | — | — | FULL |
| 15. Regulatory documents (licence, registration, DBS letter, minors authorisation) | SUMMARY: verification state + `verifiedAt` of *their* agent | same | OWN | SUMMARY: colleague's verification state (agency compliance dashboard) | SUMMARY (states) | SUMMARY | SUMMARY | — | SUMMARY: state of the agent in a Transaction the club is party to | same | — | — | FULL |
| 16. Invoices (data only) | OWN (if addressed to the player) | OWN | OWN | — | FULL (agency's) | — | — | FULL (agency's) | OWN (if addressed to the club) | same | — | — | FULL |

Additional rows the mandate did not list but the product needs:

| Row | Player | Guardian | Licensed Agent | Other Agent Same Agency | Agency Admin | Analyst | Assistant | Finance | Engaging | Releasing | Other Club | Grassroots | T&S |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 17. Trust Score | FULL (self) | FULL | SUMMARY (`pro_club` projection: level, weight, safe signal codes; DR-21) | — | — | — | — | — | existing | existing | existing | existing | FULL |
| 18. Agent's own profile / directory entry | public part | public part | OWN | public part | FULL (agency's agents) | public | public | public | public | public | public | public | FULL |
| 19. Prospect (CRM row; adult only) | — (the player is not told they are a prospect: nothing exists to tell, no access was granted) | — | OWN | per agency policy: name only | FULL (agency's) | FULL | FULL | — | — | — | — | — | FULL |
| 20. Block against the agency | OWN | OWN | — (sees `NOT_VISIBLE`, never "blocked") | — | — | — | — | — | — | — | — | — | FULL |

**Currency note (FA 2026-27, R-E2b, DR-45).** Where an England-governed
agreement has the agency as a party and an unrevoked `agency_performance`
consent from all parties, a licensed, FA-registered colleague performing
under it is treated as *Licensed Agent* for that agreement's rows (3, 7,
8, 12, 14, 15, 17) for as long as the consent stands, and is recorded as
the performer; every other "Other Agent at Same Agency" cell is
unchanged. The route is disabled in production until L-9. No other cell
in this matrix moved in the currency closure.

## Column notes

- **Player.** Sees every record naming them (agreements, consents,
  transactions they are a party to, conflict outcomes and codes,
  invoices addressed to them, their agent's verification state). Never
  sees agent private notes or the agency's internal fee split.
- **Guardian.** The same for each child, plus their own consents. A
  minor sees a contentless summary of guardian-managed items (existing
  minors' inbox pattern, `server.mjs:2968-2992`).
- **Licensed Agent.** "Client-level" access is the *sum* of: public
  profile, `recruitment`-visibility Passport, Trust Score summary,
  whatever the client shared (A62), the agreement, transactions they
  represent in, their notes, their documents. Nothing club-private
  reaches them by any path: rows 9 and 10 are absolute.
- **Other Agent at Same Agency.** Default nothing beyond the existence of
  a client in the agency's list (name + status) when the client allows
  staff visibility. Same-agency agents are Connected for conflict
  purposes (R-F15), and Chinese walls are L-4; until counsel says
  otherwise the product does not pretend a wall exists by *sharing*
  more, and does not pretend one is required by sharing less than the
  client chose.
- **Agency Admin.** Sees the agency's agreements, transactions, fee terms
  and invoices (they run the business, DR-30) but **not** client Passport
  data, trials, shared club interest or notes unless the client's
  `shareWithAgencyStaff` allows and the admin is also a licensed agent
  named on the agreement. An admin who is not licensed performs no
  regulated action.
- **Agency Analyst / Assistant.** Read-only client list and agreement
  summaries under the client's staff-sharing setting; assistants may
  upload documents on an agent's instruction (A21). Neither sees fee
  terms or notes.
- **Agency Finance.** Fee terms, transaction terms, invoices. No client
  Passport, no trials, no notes, no conflict detail beyond outcome.
- **Engaging / Releasing Club.** Inside a Transaction they are party to:
  the agent's identity and verification state, the agreement's existence
  and scope (not its fee terms), the transaction terms they are party
  to, the conflict outcome and reason codes. Never the other side's
  agents or agreements beyond that. Their own Rooms, assessments and
  decisions stay theirs.
- **Other Club.** Nothing about agents or agreements. `player.agentName`
  (self-reported) remains visible as today, labelled self-reported until
  P5.6E.
- **Grassroots.** No agent surface. Grassroots orgs are never agencies
  and never parties to regulated transactions in this design.
- **T&S.** Full, with the existing limitation (shared key + declared
  reviewer) and with agent private notes visible only on a report or a
  dispute involving that note's subject.

## Same-agency privacy (§53 of the final report)

Agents at one agency are one "agent" for conflicts and separate people for
data. The default is **least sharing**: an agent's clients are theirs;
the agency admin sees the business records; a colleague sees the client
list only if the client opted in. When an agent leaves, the agency keeps
the business records (agreements as history, invoices), loses client-level
access immediately, and the departing agent keeps nothing agency-owned
(notes, documents uploaded as agency records) — DR-26.

## Invariants (become test group L)

1. No agent column ever returns a row-9 or row-10 record, by any route,
   in any state, including after the club shares a decision summary with
   the player (the player may forward text; the *record* never flows).
2. `visibleToOrg` (agency ∧ minor → false) holds for rows 1, 6, 7, 8, 17,
   19 outside the minors pathway, and the minors pathway never grants
   rows 6 (DOB/location), 9, 10, 17.
3. A block flips every agency-side cell to **—** without touching the
   agreement ledger.
4. A refusal never distinguishes "does not exist", "minor", "blocked",
   "another agency's client" (concealment at step 4/8).
5. Fee terms never appear in an audit projection, an event payload, a
   notification text or a conflict reason.
6. Regulatory documents are downloaded only through the M14 evidence gate
   with a session-bound signed URL; possession of a URL is never
   authority.
