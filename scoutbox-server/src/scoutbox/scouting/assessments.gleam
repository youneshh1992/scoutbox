//// Structured scouting assessments (domains/scouting/scouting.mjs, repositories/scoutingAssessments.ts): a scout
//// rates a player against the newest template of their position group (the report keeps the scale it was written
//// against), with a context, evidence references and a recommendation, then submits it. A submitted assessment is
//// immutable. Assessments are private recruitment records.
////
//// The blind rule: a scout sees other scouts' assessments of a player only after submitting their own; leads see
//// everything. An assessment may be written in the context of one of the club's trials (and one of its sessions),
//// fixed at creation, needing a role in its Recruitment Room.
////
//// A lead publishes a template's next version; the author or a lead publishes feedback from a submitted assessment,
//// once, which is the only way anything in an assessment reaches the player or their guardian.
////
//// Not ported yet: a lead's review (`POST /org/assessments/:id/review`).

import gleam/dynamic/decode
import gleam/float
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess, type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/players
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/effect
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/live_event
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/platform/temporal
import scoutbox/recruitment/cases
import scoutbox/recruitment/room_routes
import scoutbox/recruitment/room_view
import scoutbox/recruitment/trial_rules.{type Trial}
import scoutbox/recruitment/trials
import scoutbox/rows/assessment_rating_refs as ref_row
import scoutbox/rows/assessment_ratings as rating_row
import scoutbox/rows/assessment_template_attributes as attribute_row
import scoutbox/rows/assessment_templates as template_row
import scoutbox/rows/assessments as row
import scoutbox/rows/id
import scoutbox/rows/ledger as ledger_row
import scoutbox/safety/audit
import scoutbox/safety/ledger
import scoutbox/safety/moderate
import scoutbox/scouting/evidence
import scoutbox/vocab/audience
import scoutbox/vocab/case_outcome
import scoutbox/vocab/position
import sqlight
import wisp.{type Request, type Response}

// ---------------------------------------------------------------------------------------------------- records

pub type Rating {
  Rating(row: rating_row.Row, refs: List(ref_row.Row))
}

/// One stored assessment, with its template version's attributes and its ratings.
pub type Assessment {
  Assessment(
    row: row.Row,
    attributes: List(attribute_row.Row),
    ratings: List(Rating),
  )
}

fn attributes_of(
  read: Read,
  template_id: String,
  version: Int,
) -> Result(List(attribute_row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> attribute_row.columns
      <> " FROM assessment_template_attributes WHERE template_id = ? AND template_version = ? ORDER BY position",
    [sqlight.text(template_id), sqlight.int(version)],
    attribute_row.decoder(),
  )
}

fn assemble(read: Read, r: row.Row) -> Result(Assessment, Fail(e)) {
  use attributes <- result.try(attributes_of(
    read,
    r.template_id,
    r.template_version,
  ))
  use ratings <- result.try(store.query(
    read,
    "SELECT "
      <> rating_row.columns
      <> " FROM assessment_ratings WHERE assessment_id = ? ORDER BY position",
    [id.assessment_sql(r.id)],
    rating_row.decoder(),
  ))
  use ratings <- result.map(
    list.try_map(ratings, fn(x) {
      use refs <- result.map(store.query(
        read,
        "SELECT "
          <> ref_row.columns
          <> " FROM assessment_rating_refs WHERE assessment_id = ? AND rating_position = ? ORDER BY position",
        [id.assessment_sql(r.id), sqlight.int(x.position)],
        ref_row.decoder(),
      ))
      Rating(x, refs)
    }),
  )
  Assessment(row: r, attributes:, ratings:)
}

fn select(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(List(Assessment), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> row.columns
      <> " FROM assessments WHERE "
      <> where
      <> " ORDER BY rowid",
    args,
    row.decoder(),
  ))
  list.try_map(rows, assemble(read, _))
}

pub fn by_id(
  read: Read,
  aid: id.AssessmentId,
) -> Result(Option(Assessment), Fail(e)) {
  use found <- result.map(select(read, "id = ?", [id.assessment_sql(aid)]))
  list.first(found) |> option.from_result
}

fn for_org_player(
  read: Read,
  org_id: id.OrgId,
  player_id: id.PlayerId,
) -> Result(List(Assessment), Fail(e)) {
  select(read, "org_id = ? AND player_id = ?", [
    id.org_sql(org_id),
    id.player_sql(player_id),
  ])
}

/// The blind rule: a scout sees colleagues' assessments of a player only after submitting their own; leads see
/// everything.
fn access_list(
  read: Read,
  a: OrgAccess,
  player_id: id.PlayerId,
) -> Result(List(Assessment), Fail(e)) {
  use mine <- result.map(for_org_player(read, a.org.id, player_id))
  case access.is_lead(a.user) {
    True -> mine
    False -> {
      let submitted =
        list.any(mine, fn(x) {
          x.row.scout_user_id == a.user.id && x.row.state != row.Draft
        })
      list.filter(mine, fn(x) {
        x.row.scout_user_id == a.user.id
        || { submitted && x.row.state != row.Draft }
      })
    }
  }
}

// ------------------------------------------------------------------------------------------------------ views

fn ref_json(r: ref_row.Row) -> Json {
  json.object(
    list.flatten([
      case r.segment_id {
        Some(s) -> [#("segmentId", id.segment_json(s))]
        None -> []
      },
      case r.trial_session_id {
        Some(s) -> [#("trialSessionId", json.string(s))]
        None -> []
      },
      case r.box_session_id {
        Some(s) -> [#("boxSessionId", id.box_session_json(s))]
        None -> []
      },
      case r.t_s {
        Some(t) -> [#("t", number(t))]
        None -> []
      },
      case r.label {
        Some(l) -> [#("label", json.string(l))]
        None -> []
      },
    ]),
  )
}

fn number(f: Float) -> Json {
  case float.floor(f) == f {
    True -> json.int(float.truncate(f))
    False -> json.float(f)
  }
}

pub fn attribute_json(x: attribute_row.Row) -> Json {
  json.object([
    #("id", json.string(x.attr_id)),
    #("label", json.string(x.label)),
    #(
      "anchors",
      json.object(
        [
          #("1", x.anchor_1),
          #("2", x.anchor_2),
          #("3", x.anchor_3),
          #("4", x.anchor_4),
          #("5", x.anchor_5),
        ]
        |> list.filter_map(fn(p) {
          case p.1 {
            Some(t) -> Ok(#(p.0, json.string(t)))
            None -> Error(Nil)
          }
        }),
      ),
    ),
  ])
}

pub fn rating_json(r: Rating) -> Json {
  let x = r.row
  json.object([
    #("attrId", json.string(x.attr_id)),
    #("rating", json.nullable(x.rating, json.int)),
    #("notObserved", json.bool(x.not_observed)),
    #("confidence", rating_row.confidence_to_json(x.confidence)),
    #("note", json.nullable(x.note, json.string)),
    #("evidenceRefs", json.array(r.refs, ref_json)),
  ])
}

pub fn context_json(r: row.Row) -> Json {
  json.object([
    #("fixture", json.nullable(r.context_fixture, json.string)),
    #("date", json.nullable(r.context_date, json.string)),
    #("minutesWatched", json.nullable(r.context_minutes_watched, json.int)),
    #("viewing", json.nullable(r.context_viewing, row.context_viewing_to_json)),
    #("opponentLevel", json.nullable(r.context_opponent_level, json.string)),
    #("trialId", json.nullable(r.context_trial_id, json.string)),
    #("trialSessionId", json.nullable(r.context_trial_session_id, json.string)),
  ])
}

pub fn recommendation_json(r: row.Row) -> Json {
  case r.recommendation_verdict {
    Some(v) ->
      json.object([
        #("verdict", case_outcome.to_json(v)),
        #("reasons", json.string(option.unwrap(r.recommendation_reasons, ""))),
      ])
    None -> json.null()
  }
}

/// The stored record without its history.
pub fn view(a: Assessment) -> Json {
  let r = a.row
  json.object([
    #("id", id.assessment_json(r.id)),
    #("orgId", id.org_json(r.org_id)),
    #("playerId", id.player_json(r.player_id)),
    #("playerName", json.nullable(r.player_name, json.string)),
    #("scoutUserId", id.org_user_json(r.scout_user_id)),
    #("scoutName", json.string(r.scout_name)),
    #("templateId", json.string(r.template_id)),
    #("templateVersion", json.int(r.template_version)),
    #("attributesSnapshot", json.array(a.attributes, attribute_json)),
    #("context", context_json(r)),
    #("ratings", json.array(a.ratings, rating_json)),
    #("state", row.state_to_json(r.state)),
    #("recommendation", recommendation_json(r)),
    #(
      "secondOpinionOf",
      json.nullable(r.second_opinion_of_id, id.assessment_json),
    ),
    #("createdAt", json.int(r.created_at)),
    #("submittedAt", json.nullable(r.submitted_at, json.int)),
    #("reviewedAt", json.nullable(r.reviewed_at, json.int)),
    #("reviewNote", json.nullable(r.review_note, json.string)),
    #("publishedFeedback", case r.published_feedback_text {
      Some(text) ->
        json.object([
          #("text", json.string(text)),
          #(
            "byUserId",
            json.nullable(r.published_feedback_by_user_id, id.org_user_json),
          ),
          #("byName", json.nullable(r.published_feedback_by_name, json.string)),
          #("at", json.nullable(r.published_feedback_at, json.int)),
        ])
      None -> json.null()
    }),
  ])
}

fn one(status: Int, a: Assessment) -> Response {
  http.json(status, json.object([#("assessment", view(a))]))
}

// --------------------------------------------------------------------------------------------------- the list

type Query {
  Query(
    player_id: Option(String),
    trial_id: Option(String),
    limit: Option(Int),
    offset: Option(Int),
  )
}

/// `GET /org/assessments`: newest first. Narrowing by trial goes through the same access list, so the blind rule
/// holds.
pub fn list_for(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  let shape = {
    use player_id <- input.field("playerId", input.optional(input.id()))
    use trial_id <- input.field("trialId", input.optional(input.id()))
    use limit <- input.field(
      "limit",
      input.optional(input.whole_number_text(1, 200)),
    )
    use offset <- input.field(
      "offset",
      input.optional(input.whole_number_text(0, 9_007_199_254_740_991)),
    )
    input.done(Query(player_id:, trial_id:, limit:, offset:))
  }
  use q <- http.query(req, shape, [#("limit", "PAGE_LIMIT_INVALID")])
  {
    {
      let listed =
        store.read(ctx.store, fn(read) {
          use base <- result.try(case q.player_id, access.is_lead(a.user) {
            Some(pid), _ -> access_list(read, a, id.player(pid))
            None, True -> select(read, "org_id = ?", [id.org_sql(a.org.id)])
            None, False ->
              select(read, "org_id = ? AND scout_user_id = ?", [
                id.org_sql(a.org.id),
                id.org_user_sql(a.user.id),
              ])
          })
          case q.trial_id {
            None -> Ok(Ok(base))
            Some(tid) -> {
              use t <- result.try(trials.by_id(read, id.trial(tid)))
              case t {
                Some(t) if t.row.org_id == a.org.id -> {
                  use pool <- result.map(case q.player_id {
                    Some(_) -> Ok(base)
                    None -> access_list(read, a, t.row.player_id)
                  })
                  Ok(
                    list.filter(pool, fn(x) {
                      x.row.context_trial_id == Some(tid)
                    }),
                  )
                }
                _ -> Ok(Error(Nil))
              }
            }
          }
        })
      case listed {
        Error(e) -> http.internal(e)
        Ok(Error(Nil)) -> http.error(404, "TRIAL_NOT_FOUND")
        Ok(Ok(found)) -> {
          let sorted =
            list.sort(found, fn(x, y) {
              int.compare(y.row.created_at, x.row.created_at)
            })
          let limit = option.unwrap(q.limit, 50)
          let offset = option.unwrap(q.offset, 0)
          http.json(
            200,
            json.object([
              #("total", json.int(list.length(sorted))),
              #("limit", json.int(limit)),
              #("offset", json.int(offset)),
              #(
                "items",
                json.array(
                  sorted |> list.drop(offset) |> list.take(limit),
                  view,
                ),
              ),
            ]),
          )
        }
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------- creation

type ContextInput {
  ContextInput(
    fixture: Option(Option(String)),
    date: Option(Option(String)),
    minutes_watched: Option(Option(Int)),
    viewing: Option(Option(row.ContextViewing)),
    opponent_level: Option(Option(String)),
    /// Absent, null (`Some(None)`) or an id: an edit that names the trial or its session must name the one set
    /// at creation.
    trial_id: Option(Option(String)),
    trial_session_id: Option(Option(String)),
  )
}

fn context_shape() -> input.Shape(ContextInput) {
  use fixture <- input.field("fixture", input.clearable(input.text(120)))
  use date <- input.field(
    "date",
    input.clearable(input.day_or_blank())
      |> flatten2
      |> as_text(option.map(_, option.map(_, temporal.day_text))),
  )
  use minutes_watched <- input.field(
    "minutesWatched",
    input.clearable(input.whole_number(1, 300)),
  )
  use viewing <- input.field(
    "viewing",
    input.clearable(input.one_of(row.context_viewing_pairs)),
  )
  use opponent_level <- input.field(
    "opponentLevel",
    input.clearable(input.text(80)),
  )
  use trial_id <- input.field("trialId", input.clearable(input.id()))
  use trial_session_id <- input.field(
    "trialSessionId",
    input.clearable(input.id()),
  )
  input.done(ContextInput(
    fixture:,
    date:,
    minutes_watched:,
    viewing:,
    opponent_level:,
    trial_id:,
    trial_session_id:,
  ))
}

/// A field's value, recorded as the text its column holds.
fn as_text(rule: input.Rule(a), f: fn(a) -> b) -> input.Rule(b) {
  fn(v) { rule(v) |> result.map(f) }
}

fn flatten2(
  rule: input.Rule(Option(Option(Option(a)))),
) -> input.Rule(Option(Option(a))) {
  fn(v) { rule(v) |> result.map(option.map(_, option.flatten)) }
}

const context_codes = [
  #("context", "CONTEXT_INVALID"),
  #("context.trialId", "TRIAL_CONTEXT_INVALID"),
  #("context.trialSessionId", "TRIAL_CONTEXT_INVALID"),
]

type NewBody {
  NewBody(
    player_id: String,
    position_group: Option(template_row.PositionGroup),
    context: Option(ContextInput),
    second_opinion_of: Option(String),
  )
}

/// The position group a player's position belongs to; a player without one is assessed as a midfielder.
fn group_for(p: Option(position.Position)) -> template_row.PositionGroup {
  case option.map(p, position.to_string) {
    Some("GK") -> template_row.GK
    Some("CB") | Some("RB") | Some("LB") | Some("RWB") | Some("LWB") ->
      template_row.DEF
    Some("ST") | Some("CF") | Some("RW") | Some("LW") -> template_row.ATT
    _ -> template_row.MID
  }
}

fn current_template(
  read: Read,
  group: template_row.PositionGroup,
) -> Result(Option(template_row.Row), Fail(e)) {
  store.one(
    read,
    "SELECT "
      <> template_row.columns
      <> " FROM assessment_templates WHERE position_group = ? ORDER BY version DESC LIMIT 1",
    [sqlight.text(template_row.position_group_to_string(group))],
    template_row.decoder(),
  )
  |> result.map(option.from_result)
}

fn blank_to_none(s: Option(String)) -> Option(String) {
  case s {
    Some(t) ->
      case string.trim(t) {
        "" -> None
        _ -> s
      }
    None -> None
  }
}

/// The trial an assessment is written in the context of: one of the club's trials of this player, not of a
/// removed subject, with a role in its Room; and, when given, one of its sessions. Error: the refusal.
fn trial_context(
  read: Read,
  a: OrgAccess,
  c: Option(ContextInput),
  player_id: id.PlayerId,
) -> Result(Result(#(Option(String), Option(String)), Response), Fail(e)) {
  let raw_trial = option.then(c, fn(c) { option.flatten(c.trial_id) })
  let raw_session = option.then(c, fn(c) { option.flatten(c.trial_session_id) })
  case raw_trial, raw_session {
    None, None -> Ok(Ok(#(None, None)))
    None, Some(_) ->
      Ok(
        Error(http.json(
          400,
          json.object([
            #("error", json.string("TRIAL_CONTEXT_INVALID")),
            #(
              "message",
              json.string(
                "A trial session belongs to a trial; give the trialId too.",
              ),
            ),
            #("field", json.string("trialId")),
          ]),
        )),
      )
    Some(tid), _ -> {
      use t <- result.try(trials.by_id(read, id.trial(tid)))
      case t {
        Some(t) if t.row.org_id == a.org.id && t.row.player_id == player_id ->
          case t.row.subject_removed_at {
            Some(_) ->
              Ok(
                Error(http.error_message(
                  409,
                  "TRIAL_SUBJECT_REMOVED",
                  "This player removed their ScoutBox account; nothing new is written about a person who left.",
                )),
              )
            None -> {
              use room <- result.map(case t.row.case_id {
                Some(c) -> cases.room(read, c)
                None -> Ok(None)
              })
              let permitted = case room {
                Some(room) if room.row.org_id == a.org.id ->
                  trial_rules.role_allows(
                    room_view.role(a, room),
                    trial_rules.TrialAssess,
                  )
                _ -> True
              }
              case permitted, raw_session {
                False, _ ->
                  Error(http.error_message(
                    403,
                    "TRIAL_NOT_PERMITTED",
                    "Assessing this trial needs a role in its Recruitment Room.",
                  ))
                True, Some(sid) ->
                  case
                    list.any(t.sessions, fn(s) {
                      id.trial_session_to_string(s.row.id) == sid
                    })
                  {
                    True -> Ok(#(Some(tid), Some(sid)))
                    False -> Error(http.error(404, "TRIAL_SESSION_NOT_FOUND"))
                  }
                True, None -> Ok(#(Some(tid), None))
              }
            }
          }
        _ -> Ok(Error(http.error(404, "TRIAL_NOT_FOUND")))
      }
    }
  }
}

fn opt_text(s: Option(String)) -> sqlight.Value {
  case s {
    Some(v) -> sqlight.text(v)
    None -> sqlight.null()
  }
}

fn opt_int(n: Option(Int)) -> sqlight.Value {
  case n {
    Some(v) -> sqlight.int(v)
    None -> sqlight.null()
  }
}

fn history(
  tx: Tx,
  aid: id.AssessmentId,
  a: OrgAccess,
  action: String,
  at: Int,
) -> Result(Nil, Fail(e)) {
  use event <- result.try(id.next_assessment_event(tx))
  store.run(
    tx,
    "INSERT INTO assessment_history (id, assessment_id, position, at, by_kind, by_id, by_name, action, detail) SELECT ?, ?, COALESCE(MAX(position) + 1, 0), ?, 'org', ?, ?, ?, NULL FROM assessment_history WHERE assessment_id = ?",
    [
      id.assessment_event_sql(event),
      id.assessment_sql(aid),
      sqlight.int(at),
      id.org_user_sql(a.user.id),
      sqlight.text(a.user.name),
      sqlight.text(action),
      id.assessment_sql(aid),
    ],
  )
}

/// `POST /org/assessments`.
pub fn create(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  let shape = {
    use player_id <- input.field("playerId", input.required(input.id()))
    use position_group <- input.field(
      "positionGroup",
      input.nullish(input.one_of(template_row.position_group_pairs)),
    )
    use context <- input.field(
      "context",
      input.nullish(input.object(context_shape())),
    )
    use second_opinion_of <- input.field(
      "secondOpinionOf",
      input.nullish(input.id()),
    )
    input.done(NewBody(
      player_id:,
      position_group:,
      context:,
      second_opinion_of:,
    ))
  }
  use b <- http.body(req, shape, [
    #("positionGroup", "NO_TEMPLATE"),
    ..context_codes
  ])
  let now = clock.now_ms()
  let gathered =
    store.read(ctx.store, fn(read) {
      use found <- result.try(players.for_org(
        read,
        id.player(b.player_id),
        a.org,
        now,
      ))
      case found {
        None -> Ok(Error(http.error(404, "PLAYER_NOT_FOUND")))
        Some(#(_, seen)) if !seen.visible || seen.blocked ->
          Ok(Error(http.error(403, "NOT_VISIBLE")))
        Some(#(p, _)) -> {
          use tmpl <- result.try(current_template(
            read,
            option.unwrap(b.position_group, group_for(p.row.position)),
          ))
          case tmpl {
            None -> Ok(Error(http.error(400, "NO_TEMPLATE")))
            Some(tmpl) -> {
              use first <- result.try(case b.second_opinion_of {
                Some(sid) -> by_id(read, id.assessment(sid))
                None -> Ok(None)
              })
              let independence = case b.second_opinion_of, first {
                None, _ -> Ok(Nil)
                Some(_), Some(f) if f.row.org_id == a.org.id ->
                  case f.row.scout_user_id == a.user.id {
                    True ->
                      Error(http.error_message(
                        400,
                        "NOT_INDEPENDENT",
                        "A second opinion comes from a different scout.",
                      ))
                    False -> Ok(Nil)
                  }
                Some(_), _ -> Error(http.error(404, "FIRST_OPINION_NOT_FOUND"))
              }
              case independence {
                Error(r) -> Ok(Error(r))
                Ok(Nil) -> {
                  use ctx_ <- result.map(trial_context(
                    read,
                    a,
                    b.context,
                    p.row.id,
                  ))
                  case ctx_ {
                    Error(r) -> Error(r)
                    Ok(trial) -> Ok(#(p, tmpl, trial))
                  }
                }
              }
            }
          }
        }
      }
    })
  case gathered {
    Error(e) -> http.internal(e)
    Ok(Error(refused)) -> refused
    Ok(Ok(#(p, tmpl, #(trial_id, trial_session_id)))) -> {
      let c = b.context
      let field = fn(f: fn(ContextInput) -> Option(Option(x))) {
        option.then(c, fn(c) { option.flatten(f(c)) })
      }
      store.unit(ctx.store, fn(tx) {
        use aid <- result.try(id.next_assessment(tx) |> room_routes.storage)
        use _ <- result.try(
          store.run(
            tx,
            "INSERT INTO assessments (id, org_id, player_id, player_name, scout_user_id, scout_name, template_id, template_version, context_fixture, context_date, context_minutes_watched, context_viewing, context_opponent_level, context_trial_id, context_trial_session_id, state, recommendation_verdict, recommendation_reasons, second_opinion_of_id, created_at, submitted_at, reviewed_at, review_note, published_feedback_text, published_feedback_by_user_id, published_feedback_by_name, published_feedback_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL)",
            [
              id.assessment_sql(aid),
              id.org_sql(a.org.id),
              id.player_sql(p.row.id),
              sqlight.text(p.row.name),
              id.org_user_sql(a.user.id),
              sqlight.text(a.user.name),
              sqlight.text(tmpl.id),
              sqlight.int(tmpl.version),
              opt_text(blank_to_none(field(fn(c) { c.fixture }))),
              opt_text(blank_to_none(field(fn(c) { c.date }))),
              opt_int(field(fn(c) { c.minutes_watched })),
              opt_text(option.map(
                field(fn(c) { c.viewing }),
                row.context_viewing_to_string,
              )),
              opt_text(blank_to_none(field(fn(c) { c.opponent_level }))),
              opt_text(trial_id),
              opt_text(trial_session_id),
              opt_text(b.second_opinion_of),
              sqlight.int(clock.now_ms()),
            ],
          )
          |> room_routes.storage,
        )
        use _ <- result.try(
          history(tx, aid, a, "created", clock.now_ms()) |> room_routes.storage,
        )
        use stored <- result.map(
          by_id(store.reading(tx), aid)
          |> room_routes.storage,
        )
        let assert Some(stored) = stored as "a new assessment reads back"
        one(201, stored)
      })
      |> room_routes.answer
    }
  }
}

// ----------------------------------------------------------------------------------------------------- edits

type RefInput {
  RefInput(
    segment_id: Option(String),
    trial_session_id: Option(String),
    box_session_id: Option(String),
    t: Option(Float),
    label: Option(String),
  )
}

type RatingInput {
  RatingInput(
    attr_id: String,
    rating: Option(Int),
    not_observed: Option(Bool),
    confidence: Option(rating_row.Confidence),
    note: Option(String),
    refs: Option(List(RefInput)),
  )
}

type EditBody {
  EditBody(
    ratings: Option(List(RatingInput)),
    context: Option(ContextInput),
    recommendation: Option(#(case_outcome.CaseOutcome, Option(String))),
  )
}

fn ref_shape() -> input.Shape(RefInput) {
  let ref_id = input.nullish(input.id_of(80))
  use segment_id <- input.field("segmentId", ref_id)
  use trial_session_id <- input.field("trialSessionId", ref_id)
  use box_session_id <- input.field("boxSessionId", ref_id)
  use t <- input.field(
    "t",
    input.nullish(input.number(0, 9_007_199_254_740_991)),
  )
  use label <- input.field("label", input.nullish(input.text(80)))
  input.done(RefInput(
    segment_id:,
    trial_session_id:,
    box_session_id:,
    t:,
    label:,
  ))
}

fn rating_shape() -> input.Shape(RatingInput) {
  use attr_id <- input.field("attrId", input.required(input.id()))
  use rating <- input.field("rating", input.nullish(input.whole_number(1, 5)))
  use not_observed <- input.field("notObserved", input.nullish(input.boolean()))
  use confidence <- input.field(
    "confidence",
    input.nullish(input.one_of(rating_row.confidence_pairs)),
  )
  use note <- input.field("note", input.nullish(input.text(300)))
  use refs <- input.field(
    "evidenceRefs",
    input.nullish(input.items(input.object(ref_shape()), 6)),
  )
  input.done(RatingInput(
    attr_id:,
    rating:,
    not_observed:,
    confidence:,
    note:,
    refs:,
  ))
}

fn edit_shape() -> input.Shape(EditBody) {
  use ratings <- input.field(
    "ratings",
    input.nullish(input.items(input.object(rating_shape()), 1000)),
  )
  use context <- input.field(
    "context",
    input.nullish(input.object(context_shape())),
  )
  use recommendation <- input.field(
    "recommendation",
    input.nullish(
      input.object({
        use verdict <- input.field(
          "verdict",
          input.required(input.one_of(case_outcome.pairs)),
        )
        use reasons <- input.field("reasons", input.nullish(input.text(1000)))
        input.done(#(verdict, reasons))
      }),
    ),
  )
  input.done(EditBody(ratings:, context:, recommendation:))
}

fn own(
  ctx: Ctx,
  a: OrgAccess,
  aid: id.AssessmentId,
  next: fn(Assessment) -> Response,
) -> Response {
  case store.read(ctx.store, by_id(_, aid)) {
    Error(e) -> http.internal(e)
    Ok(Some(x)) if x.row.org_id == a.org.id -> next(x)
    Ok(_) -> http.error(404, "ASSESSMENT_NOT_FOUND")
  }
}

/// A rating's checked evidence references: one of the club's segments of this player, and a trial session or a
/// Box Cam session linked (and not unlinked) to the assessment's trial, by reference only. `segments` are the ids
/// of the club's segments of the player (segments are never edited, so they can be read before the unit).
fn check_refs(
  trial: Option(Trial),
  segments: List(String),
  refs: List(RefInput),
) -> Result(List(RefInput), Response) {
  list.try_map(refs, fn(r) {
    case r.segment_id {
      Some(s) ->
        case list.contains(segments, s) {
          True -> Ok(Nil)
          False ->
            Error(http.json(
              400,
              json.object([
                #("error", json.string("SEGMENT_INVALID")),
                #("segmentId", json.string(s)),
              ]),
            ))
        }
      None -> Ok(Nil)
    }
    |> result.try(fn(_) {
      case r.trial_session_id, r.box_session_id {
        None, None -> Ok(r)
        _, _ ->
          case trial {
            None ->
              Error(http.error_message(
                400,
                "TRIAL_EVIDENCE_REF_INVALID",
                "Trial evidence references need an assessment written in the context of a trial.",
              ))
            Some(t) -> {
              let session_ok = case r.trial_session_id {
                Some(sid) ->
                  list.any(t.sessions, fn(s) {
                    id.trial_session_to_string(s.row.id) == sid
                  })
                None -> True
              }
              let box_ok = case r.box_session_id {
                Some(bid) ->
                  list.any(t.sessions, fn(s) {
                    list.any(s.evidence, fn(e) {
                      id.box_session_to_string(e.box_session_id) == bid
                      && e.removed_at == None
                    })
                  })
                None -> True
              }
              case session_ok, box_ok {
                False, _ ->
                  Error(http.json(
                    400,
                    json.object([
                      #("error", json.string("TRIAL_EVIDENCE_REF_INVALID")),
                      #("field", json.string("trialSessionId")),
                    ]),
                  ))
                _, False ->
                  Error(http.json(
                    400,
                    json.object([
                      #("error", json.string("TRIAL_EVIDENCE_REF_INVALID")),
                      #("field", json.string("boxSessionId")),
                      #(
                        "message",
                        json.string(
                          "Only a Box Cam session linked to this trial can be cited.",
                        ),
                      ),
                    ]),
                  ))
                True, True -> Ok(r)
              }
            }
          }
      }
    })
  })
}

/// `PUT /org/assessments/:id`: a draft's ratings, context and recommendation. Every field is checked before
/// anything is written; the trial it belongs to is set when it is created.
pub fn edit(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  aid: id.AssessmentId,
) -> Response {
  use x <- own(ctx, a, aid)
  case x.row.scout_user_id == a.user.id, x.row.state {
    False, _ -> http.error(403, "NOT_YOUR_ASSESSMENT")
    True, row.Draft -> {
      use b <- http.body(req, edit_shape(), [
        #("ratings.attrId", "ATTR_UNKNOWN"),
        #("ratings.rating", "RATING_INVALID"),
        #("ratings.confidence", "CONFIDENCE_INVALID"),
        #("recommendation.verdict", "VERDICT_INVALID"),
        ..context_codes
      ])
      use trial <- with_trial(ctx, x)
      use segments <- segments_of(ctx, x)
      case checked_ratings(x, trial, segments, b.ratings) {
        Error(refused) -> refused
        Ok(ratings) -> {
          let immutable = case b.context {
            Some(c) ->
              {
                c.trial_id != None && c.trial_id != Some(x.row.context_trial_id)
              }
              || {
                c.trial_session_id != None
                && c.trial_session_id != Some(x.row.context_trial_session_id)
              }
            None -> False
          }
          case immutable {
            True ->
              http.error_message(
                409,
                "TRIAL_CONTEXT_IMMUTABLE",
                "The trial an assessment belongs to is set when it is created.",
              )
            False -> revise(ctx, x, ratings, b)
          }
        }
      }
    }
    True, _ ->
      http.error_message(
        409,
        "NOT_A_DRAFT",
        "Submitted assessments are immutable; commission a second opinion or a new viewing instead.",
      )
  }
}

fn with_trial(ctx: Ctx, x: Assessment, next: fn(Option(Trial)) -> Response) {
  case x.row.context_trial_id {
    None -> next(None)
    Some(tid) ->
      case store.read(ctx.store, trials.by_id(_, id.trial(tid))) {
        Ok(Some(t)) if t.row.org_id == x.row.org_id -> next(Some(t))
        Ok(_) -> next(None)
        Error(e) -> http.internal(e)
      }
  }
}

fn segments_of(ctx: Ctx, x: Assessment, next: fn(List(String)) -> Response) {
  let found =
    store.read(ctx.store, fn(read) {
      store.query(
        read,
        "SELECT id FROM video_segments WHERE org_id = ? AND player_id = ?",
        [id.org_sql(x.row.org_id), id.player_sql(x.row.player_id)],
        decode.at([0], decode.string),
      )
    })
  case found {
    Ok(ids) -> next(ids)
    Error(e) -> http.internal(e)
  }
}

fn checked_ratings(
  x: Assessment,
  trial: Option(Trial),
  segments: List(String),
  ratings: Option(List(RatingInput)),
) -> Result(Option(List(#(RatingInput, List(RefInput)))), Response) {
  case ratings {
    None -> Ok(None)
    Some(list_) ->
      list.try_fold(list_, [], fn(acc, r) {
        case list.any(x.attributes, fn(at) { at.attr_id == r.attr_id }) {
          False ->
            Error(http.json(
              400,
              json.object([
                #("error", json.string("ATTR_UNKNOWN")),
                #("attrId", json.string(r.attr_id)),
              ]),
            ))
          True ->
            case
              list.any(acc, fn(p: #(RatingInput, List(RefInput))) {
                { p.0 }.attr_id == r.attr_id
              })
            {
              True ->
                Error(http.json(
                  400,
                  json.object([
                    #("error", json.string("ATTR_DUPLICATE")),
                    #("attrId", json.string(r.attr_id)),
                    #("message", json.string("Each attribute is rated once.")),
                  ]),
                ))
              False ->
                case r.not_observed != Some(True) && r.rating == None {
                  True ->
                    Error(http.error_message(
                      400,
                      "RATING_INVALID",
                      "Each attribute is a whole number 1–5, or explicitly \"not observed\" — never a silent zero.",
                    ))
                  False -> {
                    use refs <- result.map(check_refs(
                      trial,
                      segments,
                      option.unwrap(r.refs, []),
                    ))
                    [#(r, refs), ..acc]
                  }
                }
            }
        }
      })
      |> result.map(fn(l) { Some(list.reverse(l)) })
  }
}

fn revise(
  ctx: Ctx,
  x: Assessment,
  ratings: Option(List(#(RatingInput, List(RefInput)))),
  b: EditBody,
) -> Response {
  let aid = id.assessment_sql(x.row.id)
  store.unit(ctx.store, fn(tx) {
    // The draft may have been submitted meanwhile.
    use still <- result.try(
      store.one(
        store.reading(tx),
        "SELECT state FROM assessments WHERE id = ?",
        [aid],
        decode.at([0], decode.string),
      )
      |> room_routes.storage,
    )
    use <-
      fn(next) {
        case still {
          Ok("draft") -> next()
          _ -> store.stale("the assessment was submitted meanwhile")
        }
      }
    use _ <- result.try(case b.context {
      None -> Ok(Nil)
      Some(c) -> {
        let keep = fn(
          given: Option(Option(v)),
          current: Option(v),
          to: fn(v) -> sqlight.Value,
        ) {
          case given {
            Some(Some(v)) -> to(v)
            Some(None) -> sqlight.null()
            None ->
              case current {
                Some(v) -> to(v)
                None -> sqlight.null()
              }
          }
        }
        let blank = fn(g: Option(Option(String))) {
          option.map(g, blank_to_none)
        }
        store.run(
          tx,
          "UPDATE assessments SET context_fixture = ?, context_date = ?, context_minutes_watched = ?, context_viewing = ?, context_opponent_level = ? WHERE id = ?",
          [
            keep(blank(c.fixture), x.row.context_fixture, sqlight.text),
            keep(blank(c.date), x.row.context_date, sqlight.text),
            keep(c.minutes_watched, x.row.context_minutes_watched, sqlight.int),
            keep(c.viewing, x.row.context_viewing, fn(v) {
              sqlight.text(row.context_viewing_to_string(v))
            }),
            keep(
              blank(c.opponent_level),
              x.row.context_opponent_level,
              sqlight.text,
            ),
            aid,
          ],
        )
        |> room_routes.storage
      }
    })
    use _ <- result.try(case b.recommendation {
      None -> Ok(Nil)
      Some(#(verdict, reasons)) ->
        store.run(
          tx,
          "UPDATE assessments SET recommendation_verdict = ?, recommendation_reasons = ? WHERE id = ?",
          [
            sqlight.text(case_outcome.to_string(verdict)),
            sqlight.text(option.unwrap(blank_to_none(reasons), "")),
            aid,
          ],
        )
        |> room_routes.storage
    })
    use _ <- result.try(case ratings {
      None -> Ok(Nil)
      Some(list_) -> {
        use _ <- result.try(
          store.run(
            tx,
            "DELETE FROM assessment_rating_refs WHERE assessment_id = ?",
            [aid],
          )
          |> room_routes.storage,
        )
        use _ <- result.try(
          store.run(
            tx,
            "DELETE FROM assessment_ratings WHERE assessment_id = ?",
            [
              aid,
            ],
          )
          |> room_routes.storage,
        )
        list.index_map(list_, fn(p, i) { #(i, p) })
        |> list.try_each(fn(p) {
          let #(i, #(r, refs)) = p
          let observed = r.not_observed != Some(True)
          use _ <- result.try(
            store.run(
              tx,
              "INSERT INTO assessment_ratings (assessment_id, position, attr_id, rating, not_observed, confidence, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
              [
                aid,
                sqlight.int(i),
                sqlight.text(r.attr_id),
                case observed {
                  True -> opt_int(r.rating)
                  False -> sqlight.null()
                },
                sqlight.bool(!observed),
                sqlight.text(
                  rating_row.confidence_to_string(option.unwrap(
                    r.confidence,
                    rating_row.Medium,
                  )),
                ),
                opt_text(blank_to_none(r.note)),
              ],
            ),
          )
          list.index_map(refs, fn(ref, j) { #(j, ref) })
          |> list.try_each(fn(q) {
            let #(j, ref) = q
            store.run(
              tx,
              "INSERT INTO assessment_rating_refs (assessment_id, rating_position, position, segment_id, trial_session_id, box_session_id, t_s, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
              [
                aid,
                sqlight.int(i),
                sqlight.int(j),
                opt_text(ref.segment_id),
                opt_text(ref.trial_session_id),
                opt_text(ref.box_session_id),
                case ref.t {
                  Some(t) -> sqlight.float(t)
                  None -> sqlight.null()
                },
                opt_text(blank_to_none(ref.label)),
              ],
            )
          })
        })
        |> room_routes.storage
      }
    })
    use stored <- result.map(
      by_id(store.reading(tx), x.row.id)
      |> room_routes.storage,
    )
    let assert Some(stored) = stored as "a revised assessment reads back"
    one(200, stored)
  })
  |> room_routes.answer
}

/// `POST /org/assessments/:id/submit`: every submitted assessment carries ratings and a recommendation.
pub fn submit(ctx: Ctx, a: OrgAccess, aid: id.AssessmentId) -> Response {
  use x <- own(ctx, a, aid)
  case
    x.row.scout_user_id == a.user.id,
    x.row.state,
    x.ratings,
    x.row.recommendation_verdict
  {
    False, _, _, _ -> http.error(403, "NOT_YOUR_ASSESSMENT")
    True, row.Draft, [], _ -> http.error(400, "RATINGS_REQUIRED")
    True, row.Draft, _, None ->
      http.error_message(
        400,
        "RECOMMENDATION_REQUIRED",
        "Every submitted assessment carries a final recommendation with reasons.",
      )
    True, row.Draft, _, Some(_) -> {
      let now = clock.now_ms()
      store.unit(ctx.store, fn(tx) {
        use touched <- result.try(
          store.write(
            tx,
            "UPDATE assessments SET state = 'submitted', submitted_at = ? WHERE id = ? AND state = 'draft' RETURNING id",
            [sqlight.int(now), id.assessment_sql(x.row.id)],
            decode.at([0], decode.string),
          )
          |> room_routes.storage,
        )
        use <-
          fn(next) {
            case touched {
              [_] -> next()
              _ -> store.stale("the assessment was submitted meanwhile")
            }
          }
        use _ <- result.try(
          history(tx, x.row.id, a, "submitted", now) |> room_routes.storage,
        )
        use _ <- result.try(
          ledger.append(
            tx,
            ledger.Entry(
              entry_type: ledger_row.AssessmentSubmitted,
              player_id: Some(x.row.player_id),
              org_id: Some(a.org.id),
              org_name: Some(a.org.name),
              user_id: Some(a.user.id),
              actor_name: Some(a.user.name),
            ),
            now,
          )
          |> room_routes.storage,
        )
        store.emit(
          tx,
          effect.Live(live_event.AssessmentSubmitted(
            id.org_to_string(a.org.id),
            id.assessment_to_string(x.row.id),
          )),
        )
        use stored <- result.map(
          by_id(store.reading(tx), x.row.id)
          |> room_routes.storage,
        )
        let assert Some(stored) = stored as "a submitted assessment reads back"
        one(200, stored)
      })
      |> room_routes.answer
    }
    True, _, _, _ -> http.error(409, "ALREADY_SUBMITTED")
  }
}

// --------------------------------------------------------------------------------------------------- compare

/// `GET /org/players/:id/assessment-compare`. "Not observed" never enters an average; observedCount is shown
/// instead. Different template versions are not comparable, and no combined average is shown for them.
pub fn compare(ctx: Ctx, a: OrgAccess, player_id: id.PlayerId) -> Response {
  case store.read(ctx.store, access_list(_, a, player_id)) {
    Error(e) -> http.internal(e)
    Ok(all) ->
      case list.filter(all, fn(x) { x.row.state != row.Draft }) {
        [] ->
          http.json(
            200,
            json.object([
              #("assessments", json.preprocessed_array([])),
              #("attributes", json.preprocessed_array([])),
              #(
                "note",
                json.string(
                  "No submitted assessments you can see yet — the blind rule hides colleagues’ reports until your own is submitted.",
                ),
              ),
            ]),
          )
        [first, ..] as listed -> {
          let same_scale =
            list.all(listed, fn(x) {
              x.row.template_id == first.row.template_id
              && x.row.template_version == first.row.template_version
            })
          let attr_ids =
            listed
            |> list.flat_map(fn(x) {
              list.map(x.attributes, fn(at) { at.attr_id })
            })
            |> list.unique
          let attributes =
            list.map(attr_ids, fn(attr_id) {
              let label =
                listed
                |> list.flat_map(fn(x) { x.attributes })
                |> list.find(fn(at) { at.attr_id == attr_id })
                |> result.map(fn(at) { at.label })
                |> result.unwrap(attr_id)
              let cells =
                list.map(listed, fn(x) {
                  let r =
                    list.find(x.ratings, fn(r) { r.row.attr_id == attr_id })
                    |> option.from_result
                  let rating = case r {
                    Some(r) if r.row.not_observed -> None
                    Some(r) -> r.row.rating
                    None -> None
                  }
                  #(x, r, rating)
                })
              let observed =
                list.filter_map(cells, fn(c) { option.to_result(c.2, Nil) })
              let average = case observed, same_scale {
                [], _ | _, False -> json.null()
                _, True -> {
                  let mean =
                    int.to_float(int.sum(observed))
                    /. int.to_float(list.length(observed))
                  number(int.to_float(float.round(mean *. 10.0)) /. 10.0)
                }
              }
              json.object([
                #("attrId", json.string(attr_id)),
                #("label", json.string(label)),
                #(
                  "cells",
                  json.array(cells, fn(c) {
                    let #(x, r, rating) = c
                    json.object([
                      #("assessmentId", id.assessment_json(x.row.id)),
                      #("scoutName", json.string(x.row.scout_name)),
                      #("rating", json.nullable(rating, json.int)),
                      #(
                        "notObserved",
                        json.bool(case r {
                          Some(r) -> r.row.not_observed
                          None -> True
                        }),
                      ),
                      #(
                        "confidence",
                        json.nullable(
                          option.map(r, fn(r) { r.row.confidence }),
                          rating_row.confidence_to_json,
                        ),
                      ),
                      #(
                        "evidenceRefs",
                        json.array(
                          case r {
                            Some(r) -> r.refs
                            None -> []
                          },
                          ref_json,
                        ),
                      ),
                    ])
                  }),
                ),
                #("observedCount", json.int(list.length(observed))),
                #("average", average),
              ])
            })
          http.json(
            200,
            json.object([
              #(
                "assessments",
                json.array(listed, fn(x) {
                  json.object([
                    #("id", id.assessment_json(x.row.id)),
                    #("scoutName", json.string(x.row.scout_name)),
                    #(
                      "submittedAt",
                      json.nullable(x.row.submitted_at, json.int),
                    ),
                    #("context", context_json(x.row)),
                    #("recommendation", recommendation_json(x.row)),
                    #("templateVersion", json.int(x.row.template_version)),
                    #(
                      "secondOpinionOf",
                      json.nullable(
                        x.row.second_opinion_of_id,
                        id.assessment_json,
                      ),
                    ),
                  ])
                }),
              ),
              #("attributes", json.preprocessed_array(attributes)),
              #("sameScale", json.bool(same_scale)),
              #(
                "note",
                json.string(case same_scale {
                  True ->
                    "\"Not observed\" is excluded from averages — observedCount says how many scouts actually saw each attribute."
                  False ->
                    "⚠️ These assessments use different template versions — attribute scales are NOT directly comparable and no combined average is shown."
                }),
              ),
            ]),
          )
        }
      }
  }
}

// ------------------------------------------------------------------------------------------------- templates

/// A template version's attributes, in rubric order: the rubric a calibration session pins.
pub fn template_attributes(
  read: Read,
  template_id: String,
  version: Int,
) -> Result(List(attribute_row.Row), Fail(e)) {
  attributes_of(read, template_id, version)
}

/// The newest version of template `template_id`.
pub fn current_template_by_id(
  read: Read,
  template_id: String,
) -> Result(Option(template_row.Row), Fail(e)) {
  store.one(
    read,
    "SELECT "
      <> template_row.columns
      <> " FROM assessment_templates WHERE id = ? ORDER BY version DESC LIMIT 1",
    [sqlight.text(template_id)],
    template_row.decoder(),
  )
  |> result.map(option.from_result)
}

/// `GET /org/assessment-templates`: every version of every template, in the order they were published.
pub fn templates(ctx: Ctx) -> Response {
  let found =
    store.read(ctx.store, fn(read) {
      use rows <- result.try(store.query(
        read,
        "SELECT "
          <> template_row.columns
          <> " FROM assessment_templates ORDER BY rowid",
        [],
        template_row.decoder(),
      ))
      list.try_map(rows, fn(t) {
        attributes_of(read, t.id, t.version) |> result.map(fn(xs) { #(t, xs) })
      })
    })
  case found {
    Error(e) -> http.internal(e)
    Ok(templates) ->
      http.json(
        200,
        json.object([
          #(
            "templates",
            json.array(templates, fn(x) { template_json(x.0, x.1) }),
          ),
          #(
            "note",
            json.string(
              "New versions never alter historical reports — every assessment snapshots its template at creation.",
            ),
          ),
        ]),
      )
  }
}

fn template_json(
  t: template_row.Row,
  attributes: List(attribute_row.Row),
) -> Json {
  json.object([
    #("id", json.string(t.id)),
    #("positionGroup", template_row.position_group_to_json(t.position_group)),
    #("version", json.int(t.version)),
    #("createdAt", json.int(t.created_at)),
    #("createdBy", json.string(t.created_by_name)),
    #("attributes", json.array(attributes, attribute_json)),
  ])
}

type NewAttribute {
  NewAttribute(
    attr_id: String,
    label: String,
    anchors: Option(List(#(String, String))),
  )
}

const anchor_levels = ["1", "2", "3", "4", "5"]

/// A whole map checked at once, so a refusal names the map rather than one of its keys.
fn anchors_check() -> input.Check(List(#(String, String))) {
  let check =
    input.record(input.text(1_000_000), input.anything())
    |> input.refine(
      fn(entries) {
        list.all(entries, fn(e) {
          list.contains(anchor_levels, e.0)
          && case decode.run(e.1, decode.string) {
            Ok(t) -> string.trim(t) != "" && input.utf16_length(t) <= 200
            Error(_) -> False
          }
        })
      },
      "must map the levels 1, 2, 3, 4, 5 to a descriptive sentence of at most 200 characters",
    )
  fn(v) {
    check(v)
    |> result.map(
      list.map(_, fn(e) {
        #(e.0, decode.run(e.1, decode.string) |> result.unwrap(""))
      }),
    )
  }
}

/// `POST /org/assessment-templates`: a lead publishes the next version of a position group's template. Historical
/// assessments keep the version they used.
pub fn publish_template(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use <- access.require_lead(a)
  let shape = {
    use group <- input.field(
      "positionGroup",
      input.required(input.one_of(template_row.position_group_pairs)),
    )
    use attributes <- input.field(
      "attributes",
      input.required(input.items_between(
        input.object({
          use attr_id <- input.field(
            "id",
            input.required(input.required_text(40)),
          )
          use label <- input.field(
            "label",
            input.required(input.required_text(80)),
          )
          use anchors <- input.field("anchors", input.nullish(anchors_check()))
          input.done(NewAttribute(attr_id:, label:, anchors:))
        }),
        2,
        20,
      )),
    )
    input.done(#(group, attributes))
  }
  use #(group, attributes) <- http.body(req, shape, [
    #("positionGroup", "POSITION_GROUP_INVALID"),
    #("attributes", "ATTRIBUTES_INVALID"),
    #("attributes.id", "ATTRIBUTES_INVALID"),
    #("attributes.label", "ATTRIBUTES_INVALID"),
  ])
  let attributes =
    list.map(attributes, fn(x) {
      NewAttribute(
        ..x,
        attr_id: string.trim(x.attr_id),
        label: string.trim(x.label),
      )
    })
  let ids = list.map(attributes, fn(x) { x.attr_id })
  case list.length(list.unique(ids)) == list.length(ids) {
    False ->
      http.error_message(
        400,
        "ATTRIBUTES_INVALID",
        "Each attribute id appears once.",
      )
    True -> {
      let template_id =
        "tpl-" <> string.lowercase(template_row.position_group_to_string(group))
      let now = clock.now_ms()
      store.unit(ctx.store, fn(tx) {
        use previous <- result.try(
          store.one(
            store.reading(tx),
            "SELECT COALESCE(MAX(version), 0) FROM assessment_templates WHERE position_group = ?",
            [sqlight.text(template_row.position_group_to_string(group))],
            decode.at([0], decode.int),
          )
          |> room_routes.storage,
        )
        let version = result.unwrap(previous, 0) + 1
        let t =
          template_row.Row(
            id: template_id,
            version:,
            position_group: group,
            created_at: now,
            created_by_name: evidence.stored_name(a.user.name),
          )
        use _ <- result.try(
          store.run(
            tx,
            "INSERT INTO assessment_templates (id, version, position_group, created_at, created_by_name) VALUES (?, ?, ?, ?, ?)",
            [
              sqlight.text(template_id),
              sqlight.int(version),
              sqlight.text(template_row.position_group_to_string(group)),
              sqlight.int(now),
              sqlight.text(t.created_by_name),
            ],
          )
          |> room_routes.storage,
        )
        use stored <- result.try(
          list.index_map(attributes, fn(x, i) {
            let anchor = fn(level) {
              option.unwrap(x.anchors, [])
              |> list.key_find(level)
              |> option.from_result
            }
            attribute_row.Row(
              template_id:,
              template_version: version,
              position: i,
              attr_id: x.attr_id,
              label: x.label,
              anchor_1: anchor("1"),
              anchor_2: anchor("2"),
              anchor_3: anchor("3"),
              anchor_4: anchor("4"),
              anchor_5: anchor("5"),
            )
          })
          |> list.try_map(fn(r) {
            store.run(
              tx,
              "INSERT INTO assessment_template_attributes (template_id, template_version, position, attr_id, label, anchor_1, anchor_2, anchor_3, anchor_4, anchor_5) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
              [
                sqlight.text(r.template_id),
                sqlight.int(r.template_version),
                sqlight.int(r.position),
                sqlight.text(r.attr_id),
                sqlight.text(r.label),
                opt_text(r.anchor_1),
                opt_text(r.anchor_2),
                opt_text(r.anchor_3),
                opt_text(r.anchor_4),
                opt_text(r.anchor_5),
              ],
            )
            |> result.replace(r)
          })
          |> room_routes.storage,
        )
        Ok(http.json(
          201,
          json.object([#("template", template_json(t, stored))]),
        ))
      })
      |> room_routes.answer
    }
  }
}

// -------------------------------------------------------------------------------------------------- feedback

/// `POST /org/assessments/:id/publish-feedback`: the only route from private recruitment records to the player
/// and guardian side. The author or a lead publishes it, once, from a submitted assessment.
pub fn publish_feedback(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  aid: id.AssessmentId,
) -> Response {
  use x <- own(ctx, a, aid)
  let author = x.row.scout_user_id == a.user.id
  case
    author || access.is_lead(a.user),
    x.row.state,
    x.row.published_feedback_at
  {
    False, _, _ -> http.error(403, "NOT_AUTHORISED")
    True, row.Draft, _ ->
      http.error_message(
        409,
        "NOT_SUBMITTED",
        "Submit the assessment before publishing feedback from it.",
      )
    True, _, Some(_) -> http.error(409, "ALREADY_PUBLISHED")
    True, _, None -> {
      let shape = {
        use text <- input.field("text", input.nullish(input.text(800)))
        input.done(text)
      }
      use text <- http.body(req, shape, [])
      case input.filled(text) {
        None -> http.error(400, "TEXT_REQUIRED")
        Some(text) -> {
          use <- moderate.or_refuse(
            ctx,
            text,
            audit.Context(
              kind: "published_feedback",
              player_id: Some(x.row.player_id),
              org_id: Some(a.org.id),
              user_id: None,
              channel_id: None,
              request_id: None,
            ),
          )
          publish(ctx, a, x, text)
        }
      }
    }
  }
}

fn publish(ctx: Ctx, a: OrgAccess, x: Assessment, text: String) -> Response {
  let now = clock.now_ms()
  let by_name = evidence.stored_name(a.user.name)
  store.unit(ctx.store, fn(tx) {
    use touched <- result.try(
      store.write(
        tx,
        "UPDATE assessments SET published_feedback_text = ?, published_feedback_by_user_id = ?, published_feedback_by_name = ?, published_feedback_at = ? WHERE id = ? AND state <> 'draft' AND published_feedback_at IS NULL RETURNING id",
        [
          sqlight.text(text),
          id.org_user_sql(a.user.id),
          sqlight.text(by_name),
          sqlight.int(now),
          id.assessment_sql(x.row.id),
        ],
        decode.at([0], decode.string),
      )
      |> room_routes.storage,
    )
    use <-
      fn(next) {
        case touched {
          [_] -> next()
          _ -> store.stale("the feedback was published meanwhile")
        }
      }
    use _ <- result.try(
      history(tx, x.row.id, a, "published_feedback", now)
      |> room_routes.storage,
    )
    use p <- result.try(
      players.by_id(store.reading(tx), x.row.player_id) |> room_routes.storage,
    )
    let ref_id = Some(id.assessment_to_string(x.row.id))
    let tell = fn(kind, to, text) {
      notifications.notify(
        tx,
        to: kind,
        id: to,
        type_: "feedback",
        text:,
        ref_id:,
        at: now,
      )
    }
    use _ <- result.try(
      case p {
        None -> Ok(Nil)
        Some(p) ->
          case players.is_adult(p, now), p.row.guardian_id {
            False, Some(g) -> {
              use _ <- result.try(tell(
                audience.Guardian,
                id.guardian_to_string(g),
                a.org.name
                  <> " published development feedback for "
                  <> p.row.name
                  <> ".",
              ))
              tell(
                audience.Player,
                id.player_to_string(p.row.id),
                a.org.name
                  <> " shared development feedback with your parent/guardian.",
              )
            }
            _, _ ->
              tell(
                audience.Player,
                id.player_to_string(p.row.id),
                "📋 " <> a.org.name <> " published development feedback for you.",
              )
          }
      }
      |> room_routes.storage,
    )
    store.emit(
      tx,
      effect.Live(live_event.Feedback(id.player_to_string(x.row.player_id))),
    )
    Ok(http.json(
      200,
      json.object([
        #(
          "published",
          json.object([
            #("text", json.string(text)),
            #("byUserId", id.org_user_json(a.user.id)),
            #("byName", json.string(by_name)),
            #("at", json.int(now)),
          ]),
        ),
      ]),
    ))
  })
  |> room_routes.answer
}

/// A player's published feedback, oldest first, with each club's name.
fn feedback_for(
  ctx: Ctx,
  player_id: id.PlayerId,
  next: fn(List(Json)) -> Response,
) -> Response {
  let found =
    store.read(ctx.store, fn(read) {
      store.query(
        read,
        "SELECT a.id, a.org_id, o.name, a.published_feedback_by_name, a.published_feedback_text, a.published_feedback_at FROM assessments a LEFT JOIN orgs o ON o.id = a.org_id WHERE a.player_id = ? AND a.published_feedback_at IS NOT NULL ORDER BY a.rowid",
        [id.player_sql(player_id)],
        {
          use aid <- decode.field(0, id.assessment_decoder())
          use org_id <- decode.field(1, id.org_decoder())
          use org_name <- decode.field(2, decode.optional(decode.string))
          use by_name <- decode.field(3, decode.optional(decode.string))
          use text <- decode.field(4, decode.optional(decode.string))
          use at <- decode.field(5, decode.optional(decode.int))
          decode.success(
            json.object([
              #("id", id.assessment_json(aid)),
              #("orgId", id.org_json(org_id)),
              #("orgName", json.string(option.unwrap(org_name, "Club"))),
              #("byName", json.nullable(by_name, json.string)),
              #("text", json.nullable(text, json.string)),
              #("at", json.nullable(at, json.int)),
            ]),
          )
        },
      )
    })
  case found {
    Error(e) -> http.internal(e)
    Ok(items) -> next(items)
  }
}

/// `GET /player/feedback`: a minor sees that feedback exists; its content lives with the guardian.
pub fn player_feedback(ctx: Ctx, p: PlayerAccess) -> Response {
  use items <- feedback_for(ctx, p.player.row.id)
  case players.is_adult(p.player, clock.now_ms()) {
    False ->
      http.json(
        200,
        json.object([
          #("guardianManaged", json.bool(True)),
          #("count", json.int(list.length(items))),
          #("items", json.preprocessed_array([])),
        ]),
      )
    True ->
      http.json(
        200,
        json.object([
          #("guardianManaged", json.bool(False)),
          #("items", json.preprocessed_array(items)),
        ]),
      )
  }
}

/// `GET /guardian/children/:id/feedback`.
pub fn child_feedback(
  ctx: Ctx,
  g: Guardian,
  child_id: id.PlayerId,
) -> Response {
  case list.contains(g.child_ids, child_id) {
    False -> http.error(403, "NOT_YOUR_CHILD")
    True -> {
      use items <- feedback_for(ctx, child_id)
      http.json(200, json.object([#("items", json.preprocessed_array(items))]))
    }
  }
}
