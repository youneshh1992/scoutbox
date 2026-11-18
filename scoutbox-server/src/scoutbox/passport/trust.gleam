//// The Trust Score's sources and routes (domains/passport/trust/trust.mjs). Each source is read from the records
//// of the domain that owns it, so the same fact is counted once and a UI projection is never what gets scored.
////
//// Box Cam's sessions and Combine attempts are read as stored records only: their analysis is moving to a service
//// of its own, and how its results reach this server is not designed yet. No provider here can produce simulated
//// evidence, so a profile never includes any (`simulatedEvidenceIncluded` is false).
////
//// Not ported yet: `/player/trust-profile/explain`, the guardian's view, the policy route and the band metrics.

import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess, type PlayerAccess}
import scoutbox/identity/players.{type Player}
import scoutbox/passport/passport_rules
import scoutbox/passport/sources
import scoutbox/passport/trust_rules.{type Profile}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/assessments as assessment_row
import scoutbox/rows/box_sessions as session_row
import scoutbox/rows/combine_attempts as attempt_row
import scoutbox/rows/evidence as evidence_row
import scoutbox/rows/id
import scoutbox/rows/org_squad_members as squad_row
import scoutbox/rows/orgs
import scoutbox/rows/representation_agreements as agreement_row
import scoutbox/rows/ver_claims
import scoutbox/rows/ver_references as reference_row
import scoutbox/verification/claims
import scoutbox/vocab/box_provider
import scoutbox/vocab/claim_type
import sqlight
import wisp.{type Request, type Response}

fn rows_for(
  read: Read,
  columns: String,
  table: String,
  where: String,
  player_id: id.PlayerId,
  order: String,
  decoder: decode.Decoder(a),
) -> Result(List(a), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> columns
      <> " FROM "
      <> table
      <> " WHERE "
      <> where
      <> " ORDER BY "
      <> order,
    [id.player_sql(player_id)],
    decoder,
  )
}

fn org(read: Read, org_id: id.OrgId) -> Result(Option(orgs.Row), Fail(e)) {
  store.one(
    read,
    "SELECT " <> orgs.columns <> " FROM orgs WHERE id = ?",
    [id.org_sql(org_id)],
    orgs.decoder(),
  )
  |> result.map(option.from_result)
}

fn claim(
  read: Read,
  claim_id: id.ClaimId,
) -> Result(Option(ver_claims.Row), Fail(e)) {
  store.one(
    read,
    "SELECT " <> ver_claims.columns <> " FROM ver_claims WHERE id = ?",
    [id.claim_sql(claim_id)],
    ver_claims.decoder(),
  )
  |> result.map(option.from_result)
}

/// The strongest displayable identity claim; failing that, `identityVerified` as a ScoutBox review.
fn identity(
  read: Read,
  p: Player,
  now: Int,
) -> Result(Option(trust_rules.Assurance), Fail(e)) {
  use found <- result.try(store.query(
    read,
    "SELECT "
      <> ver_claims.columns
      <> " FROM ver_claims WHERE subject_id = ? AND claim_type = ? ORDER BY rowid",
    [
      sqlight.text(id.player_to_string(p.row.id)),
      sqlight.text(claim_type.to_string(claim_type.PersonIdentity)),
    ],
    ver_claims.decoder(),
  ))
  use best <- result.map(
    list.try_fold(found, None, fn(best, c) {
      use o <- result.map(case c.organisation_id {
        Some(o) -> org(read, o)
        None -> Ok(None)
      })
      let eff = claims.effective_status(c, org: o, subject_removed: False, now:)
      case eff.displayable, claims.assurance_for_claim(c) {
        True, Some(a) -> {
          let a = case a {
            claims.Authoritative -> trust_rules.Authoritative
            claims.OrganisationAttested -> trust_rules.OrganisationAttested
            claims.ScoutboxDocumentReview -> trust_rules.ScoutboxDocumentReview
          }
          case best {
            Some(b) ->
              case
                trust_rules.assurance_rank(a) > trust_rules.assurance_rank(b)
              {
                True -> Some(a)
                False -> best
              }
            None -> Some(a)
          }
        }
        _, _ -> best
      }
    }),
  )
  case best, p.row.identity_verified {
    Some(_), _ -> best
    None, True -> Some(trust_rules.ScoutboxDocumentReview)
    None, False -> None
  }
}

fn verified_claim(read: Read, r: reference_row.Row) -> Result(Bool, Fail(e)) {
  use c <- result.map(claim(read, r.provenance_claim_id))
  case c {
    Some(c) -> c.status == ver_claims.Verified
    None -> False
  }
}

/// Names an agent, client-confirmed, active and within its term (agreementInForce).
pub fn agreement_in_force(a: agreement_row.Row, now: Int) -> Bool {
  let ended = case a.end_at {
    Some(end) -> end <= now
    None -> False
  }
  let started = case a.start_at {
    Some(start) -> start <= now
    None -> True
  }
  option.is_some(a.confirmed_at)
  && a.status == agreement_row.Active
  && !ended
  && started
}

fn relationships(
  read: Read,
  p: Player,
  references: List(#(reference_row.Row, Bool)),
  now: Int,
) -> Result(List(trust_rules.Relationship), Fail(e)) {
  use squad <- result.try(rows_for(
    read,
    squad_row.columns,
    "org_squad_members",
    "player_id = ?",
    p.row.id,
    "rowid",
    squad_row.decoder(),
  ))
  // A club's shadow list is not a relationship; prestige is not read, only that it is verified and distinct.
  use clubs <- result.try(
    list.try_fold(squad, [], fn(acc, row) {
      use o <- result.map(org(read, row.org_id))
      case o {
        Some(o) if !o.suspended ->
          case
            list.any(acc, fn(r: trust_rules.Relationship) {
              r.key == "rel:club:" <> id.org_to_string(o.id)
            })
          {
            True -> acc
            False ->
              list.append(acc, [
                trust_rules.Relationship(
                  "rel:club:" <> id.org_to_string(o.id),
                  trust_rules.ClubRelationship,
                  o.verified,
                ),
              ])
          }
        _ -> acc
      }
    }),
  )
  let coaches =
    list.map(references, fn(pair) {
      trust_rules.Relationship(
        "rel:coach:" <> id.org_user_to_string({ pair.0 }.coach_user_id),
        trust_rules.CoachRelationship,
        pair.1,
      )
    })
  use agreements <- result.map(store.query(
    read,
    "SELECT "
      <> agreement_row.columns
      <> " FROM representation_agreements WHERE client_kind = 'player' AND client_id = ? ORDER BY rowid",
    [sqlight.text(id.player_to_string(p.row.id))],
    agreement_row.decoder(),
  ))
  // Keyed on the agency, so moving between agents inside one agency is not a new relationship.
  let agencies =
    agreements
    |> list.filter(agreement_in_force(_, now))
    |> list.map(fn(a) {
      trust_rules.Relationship(
        "rel:agency:" <> id.org_to_string(a.agency_org_id),
        trust_rules.AgencyRelationship,
        True,
      )
    })
  list.flatten([clubs, coaches, agencies])
}

fn evidence(
  read: Read,
  p: Player,
  now: Int,
) -> Result(List(trust_rules.EvidenceItem), Fail(e)) {
  use current <- result.map(current_evidence(read, p.row.id))
  current
  |> list.filter(fn(e) {
    case e.expires_at {
      Some(at) -> at >= now
      None -> True
    }
  })
  |> list.map(fn(e) {
    trust_rules.EvidenceItem(
      key: "ev:" <> id.scouting_evidence_to_string(e.id),
      provenance: case e.verification_status, e.source_kind {
        evidence_row.ClubAssessed, _ -> "verified_club_confirmed"
        evidence_row.CoachConfirmed, _ -> "verified_coach_confirmed"
        _, evidence_row.Guardian -> "guardian_submitted"
        _, _ -> "player_submitted"
      },
      recorded_at: e.recorded_at,
    )
  })
}

/// A player's current evidence records: not superseded by a correction.
pub fn current_evidence(
  read: Read,
  player_id: id.PlayerId,
) -> Result(List(evidence_row.Row), Fail(e)) {
  rows_for(
    read,
    evidence_row.columns,
    "evidence",
    "player_id = ? AND superseded_by_id IS NULL",
    player_id,
    "rowid",
    evidence_row.decoder(),
  )
}

fn simulated(provider: box_provider.BoxProvider) -> Bool {
  provider == box_provider.LocalTest
}

fn box_cam(
  read: Read,
  p: Player,
) -> Result(#(List(trust_rules.BoxSession), List(session_row.Row)), Fail(e)) {
  use sessions <- result.map(rows_for(
    read,
    session_row.columns,
    "box_sessions",
    "player_id = ?",
    p.row.id,
    "rowid",
    session_row.decoder(),
  ))
  #(
    sessions
      |> list.filter(fn(s) { option.is_some(s.finalized_at) })
      |> list.map(fn(s) {
        trust_rules.BoxSession(
          key: "box:" <> id.box_session_to_string(s.id),
          verification_state: option.map(
            s.verification_state,
            session_row.verification_state_to_string,
          ),
          simulated: simulated(s.provider_id),
          ended_at: option.unwrap(s.ended_at, 0),
        )
      }),
    sessions,
  )
}

/// An attempt whose session was invalidated stops contributing. The measured value is not read at all.
fn combine(
  read: Read,
  p: Player,
  sessions: List(session_row.Row),
) -> Result(List(trust_rules.CombineAttempt), Fail(e)) {
  use attempts <- result.map(rows_for(
    read,
    attempt_row.columns,
    "combine_attempts",
    "player_id = ?",
    p.row.id,
    "created_at DESC, id DESC",
    attempt_row.decoder(),
  ))
  list.reverse(attempts)
  |> list.map(fn(a) {
    let invalidated =
      list.any(sessions, fn(s) {
        s.id == a.box_session_id
        && s.verification_state
        == Some(session_row.VerificationStateInvalidated)
      })
    trust_rules.CombineAttempt(
      key: "catt:" <> id.combine_attempt_to_string(a.id),
      protocol_id: a.protocol_id,
      protocol_version: a.protocol_version,
      combine_state: case invalidated {
        True -> "invalidated"
        False -> attempt_row.combine_state_to_string(a.combine_state)
      },
      simulated: a.provider_id == box_provider.LocalTest,
    )
  })
}

/// Attribution only: an assessment's content is never read.
fn assessments(
  read: Read,
  p: Player,
) -> Result(List(trust_rules.AssessmentSource), Fail(e)) {
  use found <- result.try(rows_for(
    read,
    assessment_row.columns,
    "assessments",
    "player_id = ? AND state <> 'draft'",
    p.row.id,
    "rowid",
    assessment_row.decoder(),
  ))
  list.try_map(found, fn(a) {
    use o <- result.map(org(read, a.org_id))
    trust_rules.AssessmentSource(
      key: "asmt:" <> id.assessment_to_string(a.id),
      verified_source: case o {
        Some(o) -> o.verified
        None -> False
      },
    )
  })
}

/// The player's Trust Score, derived at read time from canonical records. It cannot be set.
pub fn profile(read: Read, p: Player, now: Int) -> Result(Profile, Fail(e)) {
  use assurance <- result.try(identity(read, p, now))
  use hist <- result.try(sources.history(read, p.row.id))
  use refs <- result.try(rows_for(
    read,
    reference_row.columns,
    "ver_references",
    "player_id = ? AND status = 'active'",
    p.row.id,
    "rowid",
    reference_row.decoder(),
  ))
  use refs <- result.try(
    list.try_map(refs, fn(r) {
      verified_claim(read, r) |> result.map(fn(v) { #(r, v) })
    }),
  )
  use rels <- result.try(relationships(read, p, refs, now))
  use items <- result.try(evidence(read, p, now))
  use #(box, sessions) <- result.try(box_cam(read, p))
  use attempts <- result.try(combine(read, p, sessions))
  use asmts <- result.map(assessments(read, p))
  trust_rules.calculate(trust_rules.Input(
    is_adult: players.is_adult(p, now),
    identity: assurance,
    history: list.map(hist.rows, fn(r) {
      trust_rules.HistoryRow(
        key: "hist:" <> r.source.type_ <> ":" <> r.source.id,
        provenance: passport_rules.provenance_to_string(r.provenance),
        current: r.current,
      )
    }),
    relationships: rels,
    evidence: items,
    box_sessions: box,
    combine: attempts,
    references: list.map(refs, fn(pair) {
      trust_rules.Reference(
        "ref:" <> id.reference_to_string({ pair.0 }.id),
        pair.1,
      )
    }),
    assessments: asmts,
    allow_simulated: False,
  ))
}

// ---------------------------------------------------------------------------------------------------------- routes

/// `GET /player/trust-profile`.
pub fn player_view(ctx: Ctx, a: PlayerAccess) -> Response {
  let now = clock.now_ms()
  case store.read(ctx.store, profile(_, a.player, now)) {
    Ok(p) ->
      http.json(
        200,
        json.object([
          #("trust", trust_rules.projection(p, trust_rules.SelfViewer)),
        ]),
      )
    Error(e) -> http.internal(e)
  }
}

/// `GET /org/players/:id/trust-profile`. A Trust Score of 100 opens no door that a score of 0 would not.
pub fn org_view(ctx: Ctx, a: OrgAccess, player_id: id.PlayerId) -> Response {
  let now = clock.now_ms()
  let found =
    store.read(ctx.store, fn(read) {
      use found <- result.try(players.for_org(read, player_id, a.org, now))
      case found {
        Some(#(p, access)) if access.visible && !access.blocked ->
          profile(read, p, now) |> result.map(fn(t) { Ok(#(p, t)) })
        Some(_) -> Ok(Error(403))
        None -> Ok(Error(404))
      }
    })
  case found {
    Ok(Ok(#(p, t))) ->
      http.json(
        200,
        json.object([
          #("playerId", id.player_json(p.row.id)),
          // The TypeScript route asks whether the organisation's type is "grassroots", which no type is.
          #("trust", trust_rules.projection(t, trust_rules.ProClubViewer)),
        ]),
      )
    Ok(Error(403)) -> http.error(403, "NOT_VISIBLE")
    Ok(Error(_)) -> http.error(404, "PLAYER_NOT_FOUND")
    Error(e) -> http.internal(e)
  }
}

/// `trustSummary`: the score and band, with the top three strengths by code.
fn summary_fields(p: Profile) -> List(#(String, json.Json)) {
  [
    #("score", json.int(p.score)),
    #("band", json.string(p.band.id)),
    #("bandLabel", json.string(p.band.label)),
    #("policyVersion", json.int(trust_rules.policy_version)),
    #(
      "topEvidenceSignals",
      json.array(list.take(trust_rules.strengths(p), 3), fn(s) {
        json.string(s.code)
      }),
    ),
  ]
}

/// `GET /org/trust-summaries?playerIds=a,b`: in the order requested, never ranked. A player this club cannot see
/// is omitted silently, so absence leaks nothing.
pub fn org_summaries(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  let shape = {
    use ids <- input.field("playerIds", input.optional(input.ids_text(100)))
    input.done(option.unwrap(ids, []))
  }
  use ids <- http.query(req, shape, [])
  let now = clock.now_ms()
  let found =
    store.read(ctx.store, fn(read) {
      // From the query.
      list.try_map(ids, fn(pid) {
        use found <- result.try(players.for_org(
          read,
          id.player(pid),
          a.org,
          now,
        ))
        case found {
          Some(#(p, access)) if access.visible && !access.blocked ->
            profile(read, p, now) |> result.map(fn(t) { [#(p, t)] })
          _ -> Ok([])
        }
      })
      |> result.map(list.flatten)
    })
  case found {
    Ok(items) ->
      http.json(
        200,
        json.object([
          #(
            "items",
            json.array(items, fn(item) {
              json.object([
                #("playerId", id.player_json({ item.0 }.row.id)),
                ..summary_fields(item.1)
              ])
            }),
          ),
          #(
            "note",
            json.string(
              "Evidence confidence — not football ability. Results are returned in the order requested and are never ranked by Trust Score.",
            ),
          ),
        ]),
      )
    Error(e) -> http.internal(e)
  }
}

fn policy_json() -> json.Json {
  json.object([
    #("version", json.int(trust_rules.policy_version)),
    #(
      "weights",
      json.object(
        list.map(trust_rules.weights, fn(w) { #(w.0, json.int(w.1)) }),
      ),
    ),
    #(
      "bands",
      json.array(trust_rules.bands, fn(b) {
        json.object([
          #("id", json.string(b.id)),
          #("label", json.string(b.label)),
          #("min", json.int(b.min)),
          #("max", json.int(b.max)),
        ])
      }),
    ),
  ])
}

/// `trustSnapshot`, with each component's weight, coverage in whole percent (rounded half up, as `Math.round`) and
/// level.
fn snapshot_json(p: Profile, at: Int) -> json.Json {
  let s = trust_rules.snapshot(p)
  json.object([
    #("at", json.int(at)),
    #("score", json.int(s.score)),
    #("band", json.string(s.band)),
    #("policyVersion", json.int(s.policy_version)),
    #(
      "components",
      json.object(
        list.map(p.components, fn(c) {
          let #(key, comp) = c
          #(
            key,
            json.object([
              #("weight", json.int(comp.weight)),
              #("coverage", json.int({ comp.coverage_bp + 50 } / 100)),
              #("level", json.string(comp.level.0)),
            ]),
          )
        }),
      ),
    ),
    #("hash", json.string(s.hash)),
  ])
}

/// `GET /admin/trust/:playerId`. There is no write route: a wrong score is fixed by correcting the evidence or the
/// policy.
pub fn admin_view(ctx: Ctx, player_id: id.PlayerId) -> Response {
  let now = clock.now_ms()
  let found =
    store.read(ctx.store, fn(read) {
      use found <- result.try(players.by_id(read, player_id))
      case found {
        Some(p) -> profile(read, p, now) |> result.map(fn(t) { Some(#(p, t)) })
        None -> Ok(None)
      }
    })
  case found {
    Ok(Some(#(p, t))) ->
      http.json(
        200,
        json.object([
          #("playerId", id.player_json(p.row.id)),
          #("trust", trust_rules.projection(t, trust_rules.TrustSafetyViewer)),
          #("policy", policy_json()),
          #("snapshot", snapshot_json(t, now)),
          #(
            "note",
            json.string(
              "Trust Score is derived at read time from canonical evidence. It cannot be set manually — correct the underlying evidence or the policy, then recalculate.",
            ),
          ),
        ]),
      )
    Ok(None) -> http.error(404, "PLAYER_NOT_FOUND")
    Error(e) -> http.internal(e)
  }
}
