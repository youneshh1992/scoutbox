//// Second Look (domains/discovery/secondLook.mjs): what changed in a player's record since an organisation ended a
//// Room, relevant to the reason it gave. It owns no player truth: the changes are read from the source records on
//// every read, and only the workflow (which item the club reviewed, dismissed or acted on) is stored. Reopening a
//// Room goes through the Rooms' own reopen path.

import gleam/dict
import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/discovery/second_look_rules.{type Candidate, type Change} as rules
import scoutbox/discovery/second_look_store.{type Item} as items
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/orgs.{type Org}
import scoutbox/identity/players.{type Player}
import scoutbox/identity/staff
import scoutbox/messaging/notifications
import scoutbox/passport/trust
import scoutbox/passport/trust_rules
import scoutbox/platform/clock
import scoutbox/platform/effect
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/json_text
import scoutbox/platform/limits
import scoutbox/platform/live_event
import scoutbox/platform/metrics
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/recruitment/cases.{type Room}
import scoutbox/recruitment/room_records
import scoutbox/recruitment/room_routes
import scoutbox/rows/id
import scoutbox/rows/room_decisions as decision_row
import scoutbox/rows/room_snapshot_source_refs as ref_row
import scoutbox/rows/second_look_items as item_row
import scoutbox/vocab/audience
import scoutbox/vocab/room_status
import scoutbox/vocab/source_context
import sqlight
import wisp.{type Request, type Response}

pub const metric_names = [
  "second_look_created", "second_look_reviewed", "second_look_dismissed",
  "second_look_room_reopened", "recruitment_brief_created",
  "recruitment_brief_activated", "nobody_missed_player_reviewed",
  "nobody_missed_player_dismissed", "nobody_missed_player_added_to_room",
]

/// Counters only: nothing that could identify who was missed or reconsidered.
pub fn count(tx: Tx, name: String) -> Result(Nil, Fail(e)) {
  metrics.count(tx, "secondLook", name)
}

/// The `secondLook` group of `/admin/metrics`, with the two policies' versions.
pub fn metrics_json(tx: Tx) -> Result(Json, Fail(e)) {
  use fields <- result.map(metrics.fields(tx, "secondLook", metric_names))
  json.object(
    list.append(fields, [
      #("policyVersion", json.int(rules.policy_version)),
      #("coveragePolicyVersion", json.int(1)),
    ]),
  )
}

// ------------------------------------------------------------------------------------------- change collection

fn rows(
  read: Read,
  sql: String,
  args: List(sqlight.Value),
  decoder: decode.Decoder(a),
) -> Result(List(a), Fail(e)) {
  store.query(read, sql, args, decoder)
}

fn pair(
  first: decode.Decoder(a),
  second: decode.Decoder(b),
) -> decode.Decoder(#(a, b)) {
  use a <- decode.field(0, first)
  use b <- decode.field(1, second)
  decode.success(#(a, b))
}

type EvidenceFact {
  EvidenceFact(
    id: String,
    footage: Bool,
    recorded_at: Int,
    upgraded: Bool,
    reviewed_at: Option(Int),
    correction: Bool,
    replaced_at: Option(Int),
  )
}

/// Every material change in the player's record after `since`, newest first (secondLook.mjs `collectChanges`).
pub fn collect_changes(
  read: Read,
  player_id: id.PlayerId,
  org_id: id.OrgId,
  since: Int,
  now: Int,
) -> Result(List(Change), Fail(e)) {
  let pid = id.player_sql(player_id)
  let oid = id.org_sql(org_id)
  let after = fn(at: Int) { at > since }

  // --- evidence
  use evidence <- result.try(
    rows(
      read,
      "SELECT e.id, e.claim_type = 'footage', e.recorded_at, e.verification_status IN ('coach_confirmed', 'club_assessed'), e.reviewed_at, e.correction_of_id IS NOT NULL, n.recorded_at FROM evidence e LEFT JOIN evidence n ON n.id = e.superseded_by_id WHERE e.player_id = ? ORDER BY e.rowid",
      [pid],
      {
        use id <- decode.field(0, decode.string)
        use footage <- decode.field(1, sqlight.decode_bool())
        use recorded_at <- decode.field(2, decode.int)
        use upgraded <- decode.field(3, sqlight.decode_bool())
        use reviewed_at <- decode.field(4, decode.optional(decode.int))
        use correction <- decode.field(5, sqlight.decode_bool())
        use replaced_at <- decode.field(6, decode.optional(decode.int))
        decode.success(EvidenceFact(
          id:,
          footage:,
          recorded_at:,
          upgraded:,
          reviewed_at:,
          correction:,
          replaced_at:,
        ))
      },
    ),
  )
  use disputes <- result.try(rows(
    read,
    "SELECT d.evidence_id, d.filed_at FROM evidence_disputes d JOIN evidence e ON e.id = d.evidence_id WHERE e.player_id = ? AND d.status = 'open' ORDER BY e.rowid, d.position",
    [pid],
    pair(decode.string, decode.int),
  ))
  let from_evidence =
    list.flat_map(evidence, fn(e) {
      let reviewed = option.unwrap(e.reviewed_at, 0)
      [
        case after(e.recorded_at) && !e.correction {
          True ->
            rules.change(
              case e.footage {
                True -> rules.FullMatchAdded
                False -> rules.EvidenceAdded
              },
              "evidence",
              Some(e.id),
              e.recorded_at,
            )
          False -> None
        },
        // A tier upgrade counts only when it happened after the record was created; evidence written with a tier is
        // a new item, not a later confirmation.
        case after(reviewed) && reviewed > e.recorded_at && e.upgraded {
          True ->
            rules.change(
              rules.EvidenceQualityImproved,
              "evidence",
              Some(e.id),
              reviewed,
            )
          False -> None
        },
        // Superseded: the correcting row carries the clock, the original does not.
        case e.replaced_at {
          Some(at) if at > since ->
            rules.change(rules.EvidenceRemoved, "evidence", Some(e.id), at)
          _ -> None
        },
      ]
    })
  let from_disputes =
    list.map(disputes, fn(d) {
      case after(d.1) {
        True -> rules.change(rules.EvidenceDisputed, "evidence", Some(d.0), d.1)
        False -> None
      }
    })

  // --- verified references
  use references <- result.try(
    rows(
      read,
      "SELECT id, status = 'active', created_at, withdrawn_at FROM ver_references WHERE player_id = ? ORDER BY rowid",
      [pid],
      {
        use id <- decode.field(0, decode.string)
        use active <- decode.field(1, sqlight.decode_bool())
        use created_at <- decode.field(2, decode.int)
        use withdrawn_at <- decode.field(3, decode.optional(decode.int))
        decode.success(#(id, active, created_at, withdrawn_at))
      },
    ),
  )
  let from_references =
    list.flat_map(references, fn(r) {
      let #(ref_id, active, created_at, withdrawn_at) = r
      [
        case active && after(created_at) {
          True ->
            rules.change(
              rules.VerifiedReferenceAdded,
              "reference",
              Some(ref_id),
              created_at,
            )
          False -> None
        },
        case withdrawn_at {
          Some(at) if at > since ->
            rules.change(
              rules.VerifiedReferenceRevoked,
              "reference",
              Some(ref_id),
              at,
            )
          _ -> None
        },
      ]
    })

  // --- Combine: a result from a test-only provider is not recruitment evidence, and an invalidated bound session
  // removes it.
  use combine <- result.try(rows(
    read,
    "SELECT a.protocol_id || '@' || a.protocol_version, a.completed_at FROM combine_attempts a LEFT JOIN box_sessions s ON s.id = a.box_session_id WHERE a.player_id = ? AND a.combine_state = 'combine_verified' AND a.completed_at IS NOT NULL AND a.provider_id <> 'local_test' AND (s.verification_state IS NULL OR s.verification_state <> 'invalidated') ORDER BY a.created_at, a.id",
    [pid],
    pair(decode.string, decode.int),
  ))
  let from_combine =
    list.map(combine, fn(c) {
      case after(c.1) {
        True ->
          rules.change(rules.CombineVerifiedAdded, "combine", Some(c.0), c.1)
        False -> None
      }
    })

  // --- Box Cam: not one change per session. Only the first development evidence since the review, or a completed
  // coach-assigned block, is material.
  use sessions <- result.try(rows(
    read,
    "SELECT id, finalized_at FROM box_sessions WHERE player_id = ? AND verification_state IN ('verified', 'partially_verified') AND finalized_at IS NOT NULL ORDER BY rowid",
    [pid],
    pair(decode.string, decode.int),
  ))
  let fresh = list.filter(sessions, fn(s) { after(s.1) })
  let had_before = list.any(sessions, fn(s) { !after(s.1) })
  let first_development = case had_before {
    True -> []
    False ->
      case list.sort(fresh, fn(a, b) { int.compare(a.1, b.1) }) {
        [first, ..] -> [
          rules.change(
            rules.DevelopmentEvidenceStarted,
            "box_cam",
            Some(first.0),
            first.1,
          ),
        ]
        [] -> []
      }
  }
  use blocks <- result.try(rows(
    read,
    "SELECT id, updated_at FROM box_assignments WHERE player_id = ? AND org_id = ? AND state = 'completed' ORDER BY rowid",
    [pid, oid],
    pair(decode.string, decode.int),
  ))
  let from_blocks =
    list.map(blocks, fn(b) {
      case after(b.1) {
        True ->
          rules.change(
            rules.DevelopmentBlockCompleted,
            "box_cam",
            Some(b.0),
            b.1,
          )
        False -> None
      }
    })

  // --- trials, assessments, gap closure
  use trials <- result.try(rows(
    read,
    "SELECT t.id, r.filed_at FROM trials t JOIN trial_reports r ON r.trial_id = t.id WHERE t.org_id = ? AND t.player_id = ? AND t.status = 'reported' ORDER BY t.rowid",
    [oid, pid],
    pair(decode.string, decode.int),
  ))
  use assessments <- result.try(rows(
    read,
    "SELECT id, submitted_at FROM assessments WHERE org_id = ? AND player_id = ? AND submitted_at IS NOT NULL ORDER BY rowid",
    [oid, pid],
    pair(decode.string, decode.int),
  ))
  use gaps <- result.try(rows(
    read,
    "SELECT id, updated_at FROM evidence_suggestions WHERE org_id = ? AND player_id = ? AND status = 'supplied' ORDER BY rowid",
    [oid, pid],
    pair(decode.string, decode.int),
  ))
  let dated = fn(found: List(#(String, Int)), kind, system) {
    list.map(found, fn(f) {
      case after(f.1) {
        True -> rules.change(kind, system, Some(f.0), f.1)
        False -> None
      }
    })
  }

  // --- Combine integrity: fingerprinted on the session, so one invalidation stays one change however many
  // projections reflect it.
  use integrity <- result.try(
    rows(
      read,
      "SELECT e.session_id, e.type = 'invalidated', e.at FROM box_session_integrity_events e JOIN box_sessions s ON s.id = e.session_id WHERE s.player_id = ? AND EXISTS (SELECT 1 FROM combine_attempts a WHERE a.box_session_id = e.session_id AND a.combine_state = 'combine_verified' AND a.provider_id <> 'local_test') ORDER BY s.rowid, e.ord",
      [pid],
      {
        use session <- decode.field(0, decode.string)
        use invalidated <- decode.field(1, sqlight.decode_bool())
        use at <- decode.field(2, decode.int)
        decode.success(#(session, invalidated, at))
      },
    ),
  )
  let from_integrity =
    list.map(integrity, fn(ev) {
      let #(session, invalidated, at) = ev
      case after(at) {
        True ->
          rules.change(
            case invalidated {
              True -> rules.CombineVerifiedInvalidated
              False -> rules.CombineVerifiedRestored
            },
            "combine_integrity",
            Some(session),
            at,
          )
        False -> None
      }
    })

  // --- source changes with their own clocks: no other timestamp means the same thing.
  use positions <- result.try(
    rows(
      read,
      "SELECT source_system, source_id, occurred_at FROM source_changes WHERE player_id = ? AND type = 'position_changed' ORDER BY seq",
      [pid],
      {
        use system <- decode.field(0, decode.string)
        use source <- decode.field(1, decode.optional(decode.string))
        use at <- decode.field(2, decode.int)
        decode.success(#(system, source, at))
      },
    ),
  )
  let from_positions =
    list.map(positions, fn(c) {
      case after(c.2) {
        True -> rules.change(rules.PositionChanged, c.0, c.1, c.2)
        False -> None
      }
    })
  use signings <- result.try(rows(
    read,
    "SELECT id, ts FROM signings WHERE player_id = ? ORDER BY rowid",
    [pid],
    pair(decode.string, decode.int),
  ))
  // A club's shadow list confirms no club; its squad does, when the club is verified.
  use squads <- result.try(rows(
    read,
    "SELECT m.org_id || ':' || m.player_id, m.added_at FROM org_squad_members m JOIN orgs o ON o.id = m.org_id WHERE m.player_id = ? AND o.verified = 1 ORDER BY m.rowid",
    [pid],
    pair(decode.string, decode.int),
  ))

  [
    from_evidence,
    from_disputes,
    from_references,
    from_combine,
    first_development,
    from_blocks,
    dated(trials, rules.TrialCompleted, "trial"),
    dated(assessments, rules.AssessmentSubmitted, "assessment"),
    dated(gaps, rules.EvidenceGapClosed, "evidence_gap"),
    from_integrity,
    from_positions,
    dated(signings, rules.CurrentClubConfirmed, "signing"),
    dated(squads, rules.CurrentClubConfirmed, "squad_row"),
  ]
  |> list.flatten
  |> option.values
  |> rules.since(since, now)
  |> Ok
}

// ------------------------------------------------------------------------------------------------- projection

/// The head of the Room's decision chain, which last-by-timestamp would not reliably find.
fn latest_decision(
  read: Read,
  room_id: id.RecruitmentCaseId,
) -> Result(Option(room_records.Decision), Fail(e)) {
  use all <- result.map(room_records.decisions(read, room_id))
  list.find(all, fn(d) { d.row.superseded_by_id == None })
  |> option.from_result
}

fn decided(d: room_records.Decision) -> rules.Decided {
  rules.Decided(
    id: d.row.id,
    at: d.row.created_at,
    reason_codes: d.reason_codes,
  )
}

/// A snapshot's component levels, as it stored them.
fn snapshot_levels(
  d: room_records.Decision,
) -> Option(List(#(String, String))) {
  use s <- option.then(d.snapshot)
  use levels <- option.then(s.row.trust_component_levels_json)
  json.parse(levels, decode.dict(decode.string, decode.string))
  |> result.map(dict.to_list)
  |> option.from_result
}

fn current_levels(p: trust_rules.Profile) -> List(#(String, String)) {
  list.map(p.components, fn(c) { #(c.0, { { c.1 }.level }.0) })
}

/// A candidate with what its views also show.
pub type Projected {
  Projected(
    candidate: Candidate,
    room: Room,
    movement: List(rules.Movement),
    current_trust: Json,
  )
}

/// Derived live, so a block, suspension or removal takes effect on the next read. Only the most recent ended
/// Room per player projects a candidate, or one new full match would raise an alert per historical Room.
fn project(
  read: Read,
  org: Org,
  player_id: Option(id.PlayerId),
  now: Int,
) -> Result(List(Projected), Fail(e)) {
  use rooms <- result.try(cases.ended_rooms(read, org.id, player_id))
  use with_decisions <- result.try(
    list.try_map(rooms, fn(room) {
      latest_decision(read, room.row.id) |> result.map(fn(d) { #(room, d) })
    }),
  )
  // Same-millisecond ties fall back to the decision id, so the choice is stable. Players keep the order in which
  // their first Room appears.
  let newest =
    list.fold(with_decisions, [], fn(acc, entry) {
      case entry {
        #(room, Some(d)) -> {
          let key = room.row.player_id
          case list.key_find(acc, key) {
            Error(Nil) -> list.append(acc, [#(key, #(room, d))])
            Ok(#(_, prev)) ->
              case
                d.row.created_at > prev.row.created_at
                || d.row.created_at == prev.row.created_at
                && string.compare(
                  id.room_decision_to_string(d.row.id),
                  id.room_decision_to_string(prev.row.id),
                )
                == order_gt
              {
                True -> list.key_set(acc, key, #(room, d))
                False -> acc
              }
          }
        }
        #(_, None) -> acc
      }
    })
  list.try_map(newest, fn(entry) {
    let #(pid, #(room, decision)) = entry
    use found <- result.try(players.for_org(read, pid, org, now))
    // Gates run before anything is computed about the player.
    case found {
      Some(#(p, access)) if access.visible && !access.blocked -> {
        use changes <- result.try(collect_changes(
          read,
          pid,
          org.id,
          decision.row.created_at,
          now,
        ))
        case changes {
          [] -> Ok(None)
          _ -> {
            use profile <- result.map(trust.profile(read, p, now))
            rules.candidate(
              room.row.id,
              pid,
              room_status.to_string(room.status),
              True,
              decided(decision),
              changes,
              now,
            )
            |> option.map(fn(c) {
              Projected(
                candidate: c,
                room:,
                movement: rules.trust_level_changes(
                  snapshot_levels(decision),
                  Some(current_levels(profile)),
                ),
                current_trust: trust_rules.projection(
                  profile,
                  trust_rules.ProClubViewer,
                ),
              )
            })
          }
        }
      }
      _ -> Ok(None)
    }
  })
  |> result.map(option.values)
}

const order_gt = order.Gt

// ------------------------------------------------------------------------------------------------- reconcile

pub type Live {
  Live(item: Item, projected: Projected)
}

fn refresh_of(c: Candidate) -> items.Refresh {
  items.Refresh(
    fingerprints: c.fingerprints,
    direct_reason_codes: c.direct_reason_codes,
    trigger_type: c.kind,
    latest_change_at: c.latest_change_at,
  )
}

fn handled(i: Item) -> rules.Handled {
  rules.Handled(
    status: i.row.status,
    fingerprints: i.fingerprints,
    dismissed_at: i.row.dismissed_at,
    reviewed_at: i.row.reviewed_at,
    updated_at: i.row.updated_at,
  )
}

/// Brings the stored workflow up to date with the current facts when the queue is read (there is no scheduler).
/// Everything one read creates, resurfaces, updates or expires commits in the caller's unit.
fn reconcile(
  tx: Tx,
  org: Org,
  player_id: Option(id.PlayerId),
  now: Int,
) -> Result(List(Live), Fail(e)) {
  let read = store.reading(tx)
  use projected <- result.try(project(read, org, player_id, now))
  list.try_map(projected, fn(p) {
    let c = p.candidate
    use existing <- result.try(items.by_key(
      read,
      org.id,
      c.room_id,
      c.decision.id,
    ))
    let refresh = refresh_of(c)
    let lapsed = fn(status) {
      rules.expired(status, refresh.latest_change_at, now)
    }
    let changes =
      list.map(c.changes, fn(pair) {
        #({ pair.0 }.fingerprint, { pair.0 }.kind)
      })
    case rules.verdict(option.map(existing, handled), changes, now), existing {
      // Suppression means "do not resurface as open", not "forget": the item stays in its tab.
      rules.Suppress(_), Some(item) -> Ok(Some(Live(item, p)))
      rules.Suppress(_), None -> Ok(None)
      rules.Create, _ -> {
        use item <- result.try(items.create(
          tx,
          items.NewItem(
            org_id: org.id,
            player_id: c.player_id,
            room_id: c.room_id,
            decision_id: c.decision.id,
            policy_version: rules.policy_version,
            refresh:,
            at: now,
          ),
        ))
        use _ <- result.try(count(tx, "second_look_created"))
        use _ <- result.map(notify_owner(tx, org, p.room, item, now))
        Some(Live(item, p))
      }
      rules.Reopen(_), Some(item) -> {
        use item <- result.try(items.resurface(
          tx,
          item,
          refresh,
          now,
          lapsed(item_row.Open),
        ))
        use _ <- result.map(count(tx, "second_look_created"))
        Some(Live(item, p))
      }
      rules.Update(_), Some(item) ->
        items.refresh(tx, item, refresh, now, lapsed(item.row.status))
        |> result.map(fn(i) { Some(Live(i, p)) })
      rules.Unchanged, Some(item) ->
        case rules.expired(item.row.status, item.row.latest_change_at, now) {
          True ->
            items.expire(tx, item, now)
            |> result.map(fn(i) { Some(Live(i, p)) })
          False -> Ok(Some(Live(item, p)))
        }
      _, None -> Ok(None)
    }
  })
  |> result.map(option.values)
}

/// Names the player: it goes only to the scout who owned the Room, visibility is already established, and "a
/// player you archived" is useless to someone who has archived dozens.
fn notify_owner(
  tx: Tx,
  org: Org,
  room: Room,
  item: Item,
  now: Int,
) -> Result(Nil, Fail(e)) {
  use owner <- result.try(staff.by_id(store.reading(tx), room.row.owner_user_id))
  case owner {
    Some(u) if u.org_id == org.id && u.removed_at == None ->
      notifications.notify(
        tx,
        to: audience.OrgUser,
        id: id.org_user_to_string(u.id),
        type_: "second_look",
        text: "Second Look — "
          <> option.unwrap(room.row.player_name, "")
          <> ": new evidence since your organisation archived this Room.",
        ref_id: Some(id.second_look_item_to_string(item.row.id)),
        at: now,
      )
    _ -> Ok(Nil)
  }
}

// ------------------------------------------------------------------------------------------------------ views

fn change_json(pair: #(Change, List(String))) -> Json {
  let #(c, relates) = pair
  json.object([
    #("type", json.string(rules.change_type_to_string(c.kind))),
    #("text", json.string(rules.change_copy(c.kind))),
    #("relatesTo", json.array(relates, json.string)),
    #("negative", json.bool(rules.is_negative(c.kind))),
    #("occurredAt", json.int(c.occurred_at)),
    #("fingerprint", json.string(c.fingerprint)),
  ])
}

/// The item with what changed (itemView); the organisation id is never shown.
fn item_view(l: Live) -> Json {
  let c = l.projected.candidate
  let r = l.item.row
  rules.safe_projection([
    #("id", id.second_look_item_json(r.id)),
    #("playerId", id.player_json(r.player_id)),
    #(
      "playerName",
      json.nullable(l.projected.room.row.player_name, json.string),
    ),
    #("roomId", id.recruitment_case_json(r.room_id)),
    #("decisionId", id.room_decision_json(r.decision_id)),
    #("status", item_row.status_to_json(r.status)),
    #("policyVersion", json.int(r.policy_version)),
    #("kind", item_row.trigger_type_to_json(c.kind)),
    #("kindLabel", json.string(rules.kind_label(c.kind))),
    #(
      "strength",
      json.string(case c.direct {
        True -> "direct"
        False -> "general"
      }),
    ),
    #("archivedStatus", json.string(c.archived_status)),
    #("archiveReasonCodes", json.array(c.decision.reason_codes, json.string)),
    #("directReasonCodes", json.array(c.direct_reason_codes, json.string)),
    #(
      "unresolvedReasonCodes",
      json.array(c.unresolved_reason_codes, json.string),
    ),
    #("decisionAt", json.int(c.decision.at)),
    #("changes", json.array(c.changes, change_json)),
    #("changeCount", json.int(list.length(c.changes))),
    #("trustMovement", json.array(l.projected.movement, rules.movement_json)),
    #("currentTrust", l.projected.current_trust),
    #("summary", json.string(c.summary)),
    #("latestChangeAt", json.int(c.latest_change_at)),
    #("reviewedAt", json.nullable(r.reviewed_at, json.int)),
    #(
      "reviewedBy",
      items.person_json(r.reviewed_by_user_id, r.reviewed_by_name),
    ),
    #("dismissedAt", json.nullable(r.dismissed_at, json.int)),
    #(
      "dismissReason",
      json.nullable(r.dismiss_reason, item_row.dismiss_reason_to_json),
    ),
    #("reopenedAt", json.nullable(r.reopened_at, json.int)),
    #("disclaimer", json.string(rules.disclaimer)),
  ])
  |> json.object
}

// ------------------------------------------------------------------------------------------------------ routes

type ListQuery {
  ListQuery(status: Option(String), limit: Option(Int), offset: Option(Int))
}

const statuses = ["open", "reviewed", "dismissed", "reopened_room", "expired"]

fn answer(r: Result(Response, Fail(Response))) -> Response {
  case r {
    Ok(resp) -> resp
    Error(store.Refuse(resp)) -> resp
    Error(e) -> http.internal(e)
  }
}

fn unit_answer(r: Result(Response, store.UnitError(Response))) -> Response {
  room_routes.answer(r)
}

/// `GET /org/second-look`: the queue, reconciled with the current facts.
pub fn list(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  let tabs = list.append(statuses, ["all"])
  let shape = {
    use status <- input.field(
      "status",
      input.optional(input.one_of(list.map(tabs, fn(s) { #(s, s) }))),
    )
    use limit <- input.field(
      "limit",
      input.optional(input.whole_number_text(1, 100)),
    )
    use offset <- input.field(
      "offset",
      input.optional(input.whole_number_text(0, 9_007_199_254_740_991)),
    )
    input.done(ListQuery(status:, limit:, offset:))
  }
  use q <- http.query(req, shape, [#("limit", "PAGE_LIMIT_INVALID")])
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    use live <- result.map(reconcile(tx, a.org, None, now))
    let status = option.unwrap(q.status, "open")
    let shown = case status {
      "all" -> live
      s ->
        list.filter(live, fn(l) {
          item_row.status_to_string(l.item.row.status) == s
        })
    }
    let ordered =
      list.sort(shown, fn(x, y) {
        rules.compare_items(
          #(
            x.projected.candidate.kind,
            x.projected.candidate.latest_change_at,
            id.second_look_item_to_string(x.item.row.id),
          ),
          #(
            y.projected.candidate.kind,
            y.projected.candidate.latest_change_at,
            id.second_look_item_to_string(y.item.row.id),
          ),
        )
      })
    let limit = option.unwrap(q.limit, 25)
    let offset = option.unwrap(q.offset, 0)
    let tally = fn(s) {
      json.int(list.count(live, fn(l) { l.item.row.status == s }))
    }
    http.json(
      200,
      json.object([
        #(
          "items",
          json.array(
            ordered |> list.drop(offset) |> list.take(limit),
            item_view,
          ),
        ),
        #("total", json.int(list.length(ordered))),
        #("limit", json.int(limit)),
        #("offset", json.int(offset)),
        #(
          "counts",
          json.object([
            #("open", tally(item_row.Open)),
            #("reviewed", tally(item_row.Reviewed)),
            #("dismissed", tally(item_row.Dismissed)),
          ]),
        ),
        #("policyVersion", json.int(rules.policy_version)),
        #("disclaimer", json.string(rules.disclaimer)),
        #(
          "note",
          json.string(
            "Second Look reports what changed since your decision. It never judges that decision, and a room only reopens when you choose to reopen it.",
          ),
        ),
      ]),
    )
  })
  |> unit_answer
}

fn not_found() -> Response {
  http.error(404, "SECOND_LOOK_NOT_FOUND")
}

fn find_item(
  read: Read,
  a: OrgAccess,
  item_id: String,
) -> Result(Item, Fail(Response)) {
  use found <- result.try(
    items.for_org_by_id(read, id.second_look_item(item_id), a.org.id)
    |> room_routes.storage,
  )
  case found {
    Some(item) -> Ok(item)
    None -> store.refuse(not_found())
  }
}

fn visible_player(
  read: Read,
  a: OrgAccess,
  player_id: id.PlayerId,
  now: Int,
) -> Result(Option(Player), Fail(Response)) {
  use found <- result.map(
    players.for_org(read, player_id, a.org, now) |> room_routes.storage,
  )
  case found {
    Some(#(p, access)) if access.visible && !access.blocked -> Some(p)
    _ -> None
  }
}

/// `GET /org/second-look/:id`.
pub fn get(ctx: Ctx, a: OrgAccess, item_id: String) -> Response {
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use item <- result.try(find_item(read, a, item_id))
    use live <- result.try(
      reconcile(tx, a.org, Some(item.row.player_id), now)
      |> room_routes.storage,
    )
    let live = list.find(live, fn(l) { l.item.row.id == item.row.id })
    let current = case live {
      Ok(l) -> l.item
      Error(Nil) -> item
    }
    use room <- result.try(
      cases.room(read, item.row.room_id) |> room_routes.storage,
    )
    let room_name = option.then(room, fn(r) { r.row.player_name })
    use player <- result.map(visible_player(read, a, item.row.player_id, now))
    // The player may have become invisible since: the workflow record survives, the player projection does not.
    case player, live {
      None, _ ->
        http.json(
          200,
          json.object([
            #(
              "item",
              json.object(
                list.append(items.stored_view(current), [
                  #("playerName", json.null()),
                  #("playerAvailable", json.bool(False)),
                ]),
              ),
            ),
            #(
              "unavailableNote",
              json.string(
                "Player data is currently unavailable to your organisation under the standing rules. Your internal record remains.",
              ),
            ),
          ]),
        )
      Some(_), Error(Nil) ->
        http.json(
          200,
          json.object([
            #(
              "item",
              json.object(
                list.append(items.stored_view(current), [
                  #("playerName", json.nullable(room_name, json.string)),
                  #("playerAvailable", json.bool(True)),
                ]),
              ),
            ),
            #(
              "note",
              json.string("The changes behind this item are no longer current."),
            ),
          ]),
        )
      Some(_), Ok(l) -> http.json(200, json.object([#("item", item_view(l))]))
    }
  })
  |> unit_answer
}

fn recorded(d: room_records.Decision) -> Option(rules.Recorded) {
  use s <- option.map(d.snapshot)
  let refs = fn(kind) { Some(list.count(s.refs, fn(r) { r.kind == kind })) }
  rules.Recorded(
    at: Some(s.row.at),
    trust: case s.row.trust_score, s.row.trust_band, s.row.trust_hash {
      Some(score), Some(band), Some(_) -> Some(#(score, band))
      _, _, _ -> None
    },
    evidence: refs(snapshot_ref_evidence),
    combine: refs(snapshot_ref_combine),
    assessments: refs(snapshot_ref_assessment),
    trials: refs(snapshot_ref_trial),
  )
}

const snapshot_ref_evidence = ref_row.Evidence

const snapshot_ref_combine = ref_row.Combine

const snapshot_ref_assessment = ref_row.Assessment

const snapshot_ref_trial = ref_row.Trial

fn current_counts(
  read: Read,
  org_id: id.OrgId,
  player_id: id.PlayerId,
  profile: trust_rules.Profile,
) -> Result(rules.Current, Fail(e)) {
  let pid = id.player_sql(player_id)
  let oid = id.org_sql(org_id)
  let n = fn(sql, args) {
    store.one(read, sql, args, decode.at([0], decode.int))
    |> result.map(result.unwrap(_, 0))
  }
  use evidence <- result.try(
    n(
      "SELECT COUNT(*) FROM evidence WHERE player_id = ? AND superseded_by_id IS NULL",
      [pid],
    ),
  )
  use assessments <- result.try(
    n(
      "SELECT COUNT(*) FROM assessments WHERE org_id = ? AND player_id = ? AND state <> 'draft'",
      [oid, pid],
    ),
  )
  // The Combine projection's results: the best verified attempt of each protocol version.
  use combine <- result.try(
    n(
      "SELECT COUNT(DISTINCT a.protocol_id || '@' || a.protocol_version) FROM combine_attempts a LEFT JOIN box_sessions s ON s.id = a.box_session_id WHERE a.player_id = ? AND a.combine_state = 'combine_verified' AND a.provider_id <> 'local_test' AND (s.verification_state IS NULL OR s.verification_state <> 'invalidated')",
      [pid],
    ),
  )
  use trials <- result.try(
    n("SELECT COUNT(*) FROM trials WHERE org_id = ? AND player_id = ?", [
      oid,
      pid,
    ]),
  )
  use references <- result.map(
    n(
      "SELECT COUNT(*) FROM ver_references WHERE player_id = ? AND status = 'active'",
      [pid],
    ),
  )
  rules.Current(
    trust: Some(#(int.to_float(profile.score), profile.band.id)),
    evidence:,
    references:,
    references_at_decision: None,
    combine:,
    assessments:,
    trials:,
  )
}

/// `GET /org/second-look/:id/changes`: the decision-time snapshot beside the record now, row by row.
pub fn changes(ctx: Ctx, a: OrgAccess, item_id: String) -> Response {
  let now = clock.now_ms()
  store.read(ctx.store, fn(read) {
    use item <- result.try(find_item(read, a, item_id))
    use player <- result.try(visible_player(read, a, item.row.player_id, now))
    case player {
      None ->
        Ok(http.json(
          200,
          json.object([
            #("available", json.bool(False)),
            #(
              "unavailableNote",
              json.string(
                "Player data is currently unavailable to your organisation under the standing rules.",
              ),
            ),
          ]),
        ))
      Some(p) -> {
        use room <- result.try(
          cases.room(read, item.row.room_id) |> room_routes.storage,
        )
        use decision <- result.try(
          latest_decision(read, item.row.room_id) |> room_routes.storage,
        )
        use profile <- result.try(
          trust.profile(read, p, now) |> room_routes.storage,
        )
        use current <- result.try(
          current_counts(read, a.org.id, p.row.id, profile)
          |> room_routes.storage,
        )
        use found <- result.map(case decision {
          Some(d) ->
            collect_changes(read, p.row.id, a.org.id, d.row.created_at, now)
            |> room_routes.storage
          None -> Ok([])
        })
        let codes = case decision {
          Some(d) -> d.reason_codes
          None -> []
        }
        let snapshot = option.then(decision, recorded)
        http.json(
          200,
          json.object([
            #(
              "previous",
              json.object([
                #(
                  "at",
                  json.nullable(
                    option.map(decision, fn(d) { d.row.created_at }),
                    json.int,
                  ),
                ),
                #("reasonCodes", json.array(codes, json.string)),
                #(
                  "recommendation",
                  json.nullable(
                    option.map(decision, fn(d) { d.row.recommendation }),
                    decision_row.recommendation_to_json,
                  ),
                ),
                #("trust", case option.then(decision, fn(d) { d.snapshot }) {
                  Some(s) ->
                    case s.row.trust_hash {
                      Some(_) ->
                        json.object([
                          #(
                            "score",
                            json.nullable(s.row.trust_score, json_number),
                          ),
                          #(
                            "band",
                            json.nullable(s.row.trust_band, json.string),
                          ),
                          #(
                            "policyVersion",
                            json.nullable(s.row.trust_policy_version, json.int),
                          ),
                        ])
                      None -> json.null()
                    }
                  None -> json.null()
                }),
                #("note", case snapshot {
                  Some(_) -> json.null()
                  None -> json.string(rules.no_snapshot_note)
                }),
              ]),
            ),
            #(
              "current",
              json.object([
                #(
                  "trust",
                  trust_rules.projection(profile, trust_rules.ProClubViewer),
                ),
                #(
                  "playerName",
                  json.nullable(
                    option.then(room, fn(r) { r.row.player_name }),
                    json.string,
                  ),
                ),
              ]),
            ),
            #("comparison", rules.compare(snapshot, current)),
            #(
              "changes",
              json.array(found, fn(c) {
                json.object([
                  #("type", json.string(rules.change_type_to_string(c.kind))),
                  #("text", json.string(rules.change_copy(c.kind))),
                  #("occurredAt", json.int(c.occurred_at)),
                  #("negative", json.bool(rules.is_negative(c.kind))),
                ])
              }),
            ),
            #(
              "trustMovement",
              json.array(
                rules.trust_level_changes(
                  option.then(decision, snapshot_levels),
                  Some(current_levels(profile)),
                ),
                rules.movement_json,
              ),
            ),
            #(
              "unresolvedReasonCodes",
              json.array(list.filter(codes, rules.is_club_side), json.string),
            ),
            #(
              "reasonMap",
              json.object(
                list.map(codes, fn(code) {
                  #(
                    code,
                    json.array(rules.reason_changes(code), fn(t) {
                      json.string(rules.change_type_to_string(t))
                    }),
                  )
                }),
              ),
            ),
            #(
              "note",
              json.string(
                "Only changes relevant to this decision are shown. A Trust Score movement is context — the underlying facts are the reason this item exists.",
              ),
            ),
            #("disclaimer", json.string(rules.disclaimer)),
          ]),
        )
      }
    }
  })
  |> answer
}

fn json_number(f: Float) -> Json {
  json_text.number(f)
}

fn limited(ctx: Ctx, a: OrgAccess, next: fn() -> Response) -> Response {
  case
    limits.limited(
      ctx.limits,
      limits.SecondLookAction,
      id.org_to_string(a.org.id),
      clock.now_ms(),
    )
  {
    True ->
      http.json(
        429,
        json.object(
          list.map(limits.limited_body(limits.SecondLookAction), fn(f) {
            #(f.0, json.string(f.1))
          }),
        ),
      )
    False -> next()
  }
}

fn transition(item: Item, to: item_row.Status) -> Result(Nil, Fail(Response)) {
  case rules.can_transition(item.row.status, to) {
    True -> Ok(Nil)
    False ->
      store.refuse(http.json(
        409,
        json.object([
          #("error", json.string("SECOND_LOOK_TRANSITION_INVALID")),
          #("from", item_row.status_to_json(item.row.status)),
          #("to", item_row.status_to_json(to)),
        ]),
      ))
  }
}

fn by(a: OrgAccess) -> #(id.OrgUserId, String) {
  #(a.user.id, a.user.name)
}

/// Finds the item first, as the TypeScript route does, so another organisation's id is a 404 before any limit or
/// body is read.
fn with_item(
  ctx: Ctx,
  a: OrgAccess,
  item_id: String,
  next: fn() -> Response,
) -> Response {
  case store.read(ctx.store, find_item(_, a, item_id)) {
    Ok(_) -> next()
    Error(e) -> answer(Error(e))
  }
}

/// `POST /org/second-look/:id/review`.
pub fn review(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  item_id: String,
) -> Response {
  use <- with_item(ctx, a, item_id)
  use <- limited(ctx, a)
  use _ <- http.body(req, input.nothing(), [])
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    use item <- result.try(find_item(store.reading(tx), a, item_id))
    use _ <- result.try(transition(item, item_row.Reviewed))
    use stored <- result.try(
      items.review(tx, item, by(a), now) |> room_routes.storage,
    )
    use _ <- result.map(
      count(tx, "second_look_reviewed") |> room_routes.storage,
    )
    http.json(
      200,
      json.object([#("item", json.object(items.stored_view(stored)))]),
    )
  })
  |> unit_answer
}

/// `POST /org/second-look/:id/dismiss`: for this organisation only.
pub fn dismiss(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  item_id: String,
) -> Response {
  use <- with_item(ctx, a, item_id)
  use <- limited(ctx, a)
  let shape = {
    use reason <- input.field(
      "reason",
      input.nullish(input.one_of(item_row.dismiss_reason_pairs)),
    )
    input.done(reason)
  }
  use reason <- http.body(req, shape, [
    #("reason", "SECOND_LOOK_REASON_UNKNOWN"),
  ])
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    use item <- result.try(find_item(store.reading(tx), a, item_id))
    use _ <- result.try(transition(item, item_row.Dismissed))
    use stored <- result.try(
      items.dismiss(tx, item, by(a), now, reason) |> room_routes.storage,
    )
    use _ <- result.map(
      count(tx, "second_look_dismissed") |> room_routes.storage,
    )
    http.json(
      200,
      json.object([
        #("item", json.object(items.stored_view(stored))),
        #(
          "note",
          json.string(
            "Dismissed for your organisation only. Nothing about the player’s record changes.",
          ),
        ),
      ]),
    )
  })
  |> unit_answer
}

/// `POST /org/second-look/:id/reopen-room`: the only way a Second Look reaches the pipeline, through the Rooms'
/// own reopen path.
pub fn reopen_room(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  item_id: String,
) -> Response {
  use <- with_item(ctx, a, item_id)
  use <- limited(ctx, a)
  let shape = {
    use codes <- input.field(
      "reasonCodes",
      input.nullish(input.list_of(input.text(200), 20)),
    )
    input.done(codes)
  }
  use codes <- http.body(req, shape, [])
  let now = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    use item <- result.try(find_item(read, a, item_id))
    use found <- result.try(
      cases.room(read, item.row.room_id) |> room_routes.storage,
    )
    use room <- result.try(case found {
      Some(r) if r.row.org_id == a.org.id -> Ok(r)
      _ -> store.refuse(http.error(404, "ROOM_NOT_FOUND"))
    })
    use player <- result.try(visible_player(read, a, item.row.player_id, now))
    use _ <- result.try(case player {
      Some(_) -> Ok(Nil)
      None -> store.refuse(http.error(403, "NOT_VISIBLE"))
    })
    use view <- result.try(room_routes.reopen(
      tx,
      a,
      room,
      room_status.UnderReview,
      option.unwrap(codes, ["continue_monitoring"]),
      source_context.SecondLook,
      Some(#(id.second_look_item_to_string(item.row.id), None)),
      now,
    ))
    use stored <- result.try(
      items.mark_room_reopened(tx, item, by(a), now) |> room_routes.storage,
    )
    use _ <- result.map(
      count(tx, "second_look_room_reopened") |> room_routes.storage,
    )
    store.emit(
      tx,
      effect.Live(live_event.RoomReopenedFromSecondLook(
        org_id: id.org_to_string(a.org.id),
        room_id: id.recruitment_case_to_string(room.row.id),
        item_id: id.second_look_item_to_string(item.row.id),
      )),
    )
    http.json(
      200,
      json.object([
        #("item", json.object(items.stored_view(stored))),
        #("room", view),
        #(
          "note",
          json.string(
            "The archived decision remains in the room’s history. Reopening adds to it.",
          ),
        ),
      ]),
    )
  })
  |> unit_answer
}
