# M23 P8.1 — Analytics hardening

The recruitment-journey figures on the Director Dashboard (M20) under a
hostile store: retries, duplicate events, revisions, reopening, second cases,
legacy data, corrupt records and malformed instants (§38–§41). This extends
M23_P8_ANALYTICS_CANONICALIZATION.md (the sources and the counting rule);
nothing there changed. Paths are under `scoutbox-server/m20/`. Checks:
`m23RecruitmentJourneyHardeningE2E` group T (T1–T7), persistence 5.9,
`m23JourneyPerf`, `m20E2E`.

## 1. What can never move a figure (§38)

| Attack | Metric behaviour | Why | Proof |
| --- | --- | --- | --- |
| a refused request (409 / 422 / 403) | nothing changes | every journey figure is derived from RECORDS on read; a refusal writes none | T2 |
| an idempotent replay (a lifecycle key, an issue key, a completion key) | nothing changes | a replay writes no record and no history entry | T2; hardening Q2, V4 |
| a duplicate or out-of-order SSE event | nothing changes | no metric reads the stream; the stream only tells a client to refetch | P8 analytics §1 (canonical event: none) |
| a second Offer revision, a re-invitation, a second package | one count per case per stage | `journey_evidence_funnel` is case-based: `firstAt` takes the EARLIEST qualifying record of the case | P8 A26; T2 |
| a reopened case (Second Look) | counted once; reported in `reopenedInCohort`; never a second cohort row | the case keeps its id; `transitions()` collapses the double reopen entry (`room_status_changed` + `room_reopened` at one instant) | m20E2E; §2 below |
| a second case for the same player | its own row; the ended case keeps its stages; NOTHING inherited — including the club's assessment (D-P81-18) | every store is grouped by `caseId`; assessments (player-keyed records) are attributed to ONE case by the same rule as the projection (D-P81-15) | T3, T4, T7 |
| a legacy case (history only, no record) | `historyOnly` per stage, shown apart, never added to `value` | the evidence functions read records only | P8 D group; hardening S |
| a corrupt record naming the case (an Offer whose pointer is stale, a package with an unknown status) | not counted for the stage it cannot prove (`ISSUED`/`ACCEPTED`/`COMPLETED` are matched on the revision or package status word; an unknown word matches nothing) | the funnel matches exact status words and finite instants | persistence 5.2 (three restarts, the funnel identical); R group |
| a note, a reason, a rationale, a score | never on the wire | the metric carries stage words, counts and median days; the projection strips names off history entries | T5 |

## 2. Reopen analytics — the definition (§39)

A reopen is a lifecycle move out of `withdrawn` / `archived` / `closed`
into `under_review` (the frozen edges). For analytics it means, exactly:

- **The case is the same case.** No metric creates a second row for it.
  The cohort rule is "opened in the window" by the case's `createdAt`, so a
  reopened case belongs to the cohort of its ORIGINAL opening, whatever the
  window of the reopen.
- **`funnel_progression`** counts the first reach of each state per case:
  a reopened case that walks the same states again adds nothing;
  `reopenedInCohort` reports how many cohort cases were reopened.
- **`journey_evidence_funnel`** counts records, and a reopen writes none.
  Records the case earns AFTER the reopen (a new Contact, a new Offer) count
  for the case once, by their earliest instant, exactly as before the
  reopen. Records of the ended period are still the case's records (a
  reopen erases nothing — P8 §W, hardening X).
- **Durations** (`time_in_stage`, `stageVisits`) measure COMPLETED visits;
  a reopened case's second visit to a state is a second visit, its first
  visit is unchanged. `time_trial_requested_to_completed` skips a case whose
  completion instant precedes its request (`done < req`: a reopen can reach
  these out of order) rather than writing a negative.
- **Intervals** in the journey funnel are computed from the records' own
  instants per case and only when the later instant is not before the
  earlier one (`t2 >= t1`), so a reopen (or a test clock) cannot invent a
  negative or a believable fake duration.

## 3. Time-to-stage under corruption (§40)

| Corruption | Behaviour | Where |
| --- | --- | --- |
| a record with a non-finite or non-positive instant | the record proves nothing for that stage (`firstAt` skips it); the case may still count through a sound record | `funnels.mjs firstAt` |
| a history entry whose `at` is malformed | `lastActivityAt` treats it as 0; `stageVisits` drops any visit whose length is negative (`ms >= 0`); the journey validator classifies the case `TEMPORAL_ORDER` (integrity_error) so the strip blocks the act | `timeSeries.mjs`, `journeyModel.mjs` |
| instants out of order (a later entry with an earlier instant) | shown where the instant puts them; never re-sorted into a believable sequence; a negative visit is dropped, never negated | `stageVisits`, journey timeline (P8 §14) |
| an interval whose end precedes its start | omitted from `n` (not clamped, not negated) | `journeyEvidenceFunnel between()` |
| every duration | a median, never a mean; every duration ships the count it could not include (`excluded`, `excludedMeans`) | `timeSeries.mjs` rules 1–2 |

Proof: T6 (no interval reads negative), m20E2E (visits, exclusions),
hardening R group (`TEMPORAL_ORDER`).

## 4. Assessments belong to one case (D-P81-18)

The one player-keyed store the funnel reads is `assessments`. Before P8.1 a
second case for the same player counted `assessed` from the ended case's
assessment — the analytics twin of D-P81-15. Now `assessmentOfCase` applies
the projection's rule: an assessment written in the context of a Trial
belongs to that Trial's case; one written outside a Trial belongs to the
case that was OPEN when it was written (an ended case keeps its own; a
later case inherits none; an assessment older than every case belongs to
the case being read). T7 / T7b / T7c (pure) prove the three shapes.

## 5. Performance (§41)

`m23JourneyPerf` (rerun R5 and R6): one projection is a handful of linear
filters over the store; no N+1, no index, no cache.

| Store | Club projection | Player journeys | Agent projection |
| --- | --- | --- | --- |
| 500 cases, multi-resource | 5.9 ms | 25 ms over 10 cases | 1.8 ms |
| 5 000 cases, multi-resource | 19.9 ms | 118 ms over 100 cases | 1.2 ms |

A 10× store reads a few × slower, never 10² ×. The dashboard's journey
funnel groups every store once per request (`groupBy`), so it is linear in
the number of records plus cohort cases.

## 6. What P8.1 changed here

- `journeyEvidenceFunnel`: `assessed` attributed to one case (D-P81-18).
- The hardening T group reads the metric at its real path
  (`data.pipeline.metrics.journey_evidence_funnel`); T1b guards against the
  vacuous read that R4's first run had (T-P81-24).
- No metric was added, renamed or re-based; no figure is stored.
