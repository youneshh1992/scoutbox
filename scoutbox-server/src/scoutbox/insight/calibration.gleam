//// Calibration sessions (domains/insight/insight.mjs): a lead pins a template version and, optionally, reference
//// footage the club can see, and two or more of the club's scouts rate it blind. Until you submit (or a lead closes
//// the session) you see who has submitted, never what. The comparison is a conversation starter about the rubric,
//// not a measure of who is right.

import gleam/dynamic/decode
import gleam/float
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/players
import scoutbox/identity/staff
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/pages
import scoutbox/platform/paging.{IntKey, IntKind, TextKey, TextKind}
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/assessment_template_attributes as attribute_row
import scoutbox/rows/calibration_notes as note_row
import scoutbox/rows/calibration_participants as participant_row
import scoutbox/rows/calibration_ratings as rating_row
import scoutbox/rows/calibration_sessions as row
import scoutbox/rows/calibration_submissions as submission_row
import scoutbox/rows/id
import scoutbox/scouting/assessments
import scoutbox/vocab/audience
import sqlight
import wisp.{type Request, type Response}

const id_max = 80

const title_max = 120

const participants_max = 50

const ratings_max = 40

const attribute_id_max = 40

const note_max = 500

const notes_max = 500

const rating_min = 1

const rating_max = 5

/// A session with its participants, blind submissions (each with its ratings), notes and pinned rubric.
type Session {
  Session(
    row: row.Row,
    participants: List(id.OrgUserId),
    submissions: List(#(submission_row.Row, List(rating_row.Row))),
    notes: List(note_row.Row),
    attributes: List(attribute_row.Row),
  )
}

fn load(
  read: Read,
  org_id: id.OrgId,
  session_id: id.CalibrationSessionId,
) -> Result(Option(Session), Fail(e)) {
  use found <- result.try(store.one(
    read,
    "SELECT "
      <> row.columns
      <> " FROM calibration_sessions WHERE id = ? AND org_id = ?",
    [id.calibration_session_sql(session_id), id.org_sql(org_id)],
    row.decoder(),
  ))
  case found {
    Error(Nil) -> Ok(None)
    Ok(r) -> assemble(read, r) |> result.map(Some)
  }
}

fn assemble(read: Read, r: row.Row) -> Result(Session, Fail(e)) {
  let sid = [id.calibration_session_sql(r.id)]
  use participants <- result.try(store.query(
    read,
    "SELECT user_id FROM calibration_participants WHERE session_id = ? ORDER BY ord",
    sid,
    decode.at([0], id.org_user_decoder()),
  ))
  use submissions <- result.try(store.query(
    read,
    "SELECT "
      <> submission_row.columns
      <> " FROM calibration_submissions WHERE session_id = ? ORDER BY submitted_at, rowid",
    sid,
    submission_row.decoder(),
  ))
  use ratings <- result.try(store.query(
    read,
    "SELECT "
      <> rating_row.columns
      <> " FROM calibration_ratings WHERE session_id = ? ORDER BY ord",
    sid,
    rating_row.decoder(),
  ))
  use notes <- result.try(store.query(
    read,
    "SELECT "
      <> note_row.columns
      <> " FROM calibration_notes WHERE session_id = ? ORDER BY ord",
    sid,
    note_row.decoder(),
  ))
  use attributes <- result.map(assessments.template_attributes(
    read,
    r.template_id,
    r.template_version,
  ))
  Session(
    row: r,
    participants:,
    submissions: list.map(submissions, fn(s) {
      #(s, list.filter(ratings, fn(x) { x.user_id == s.user_id }))
    }),
    notes:,
    attributes:,
  )
}

fn submitted(s: Session, user_id: id.OrgUserId) -> Bool {
  list.any(s.submissions, fn(x) { { x.0 }.user_id == user_id })
}

/// Whether the club can see the player whose clip `media_id` is, now.
fn footage_accessible(
  read: Read,
  a: OrgAccess,
  media_id: id.MediaId,
  now: Int,
) -> Result(Bool, Fail(e)) {
  use owner <- result.try(store.one(
    read,
    "SELECT player_id FROM player_media WHERE id = ?",
    [id.media_sql(media_id)],
    decode.at([0], id.player_decoder()),
  ))
  case owner {
    Error(Nil) -> Ok(False)
    Ok(player_id) -> {
      use found <- result.map(players.for_org(read, player_id, a.org, now))
      case found {
        Some(#(_, access)) -> access.visible && !access.blocked
        None -> False
      }
    }
  }
}

fn view(
  read: Read,
  s: Session,
  a: OrgAccess,
  now: Int,
) -> Result(Json, Fail(e)) {
  let r = s.row
  let released = r.status == row.Closed || submitted(s, a.user.id)
  use accessible <- result.map(case r.media_id {
    Some(media_id) -> footage_accessible(read, a, media_id, now)
    None -> Ok(False)
  })
  json.object([
    #("id", id.calibration_session_json(r.id)),
    #("orgId", id.org_json(r.org_id)),
    #("title", json.string(r.title)),
    #("templateId", json.string(r.template_id)),
    #("templateVersion", json.int(r.template_version)),
    #(
      "attributesSnapshot",
      json.array(s.attributes, assessments.attribute_json),
    ),
    #("mediaId", json.nullable(r.media_id, id.media_json)),
    #("participants", json.array(s.participants, id.org_user_json)),
    #("notes", notes_json(s.notes)),
    #("status", row.status_to_json(r.status)),
    #("createdBy", id.org_user_json(r.created_by_user_id)),
    #("createdAt", json.int(r.created_at)),
    #("closedAt", json.nullable(r.closed_at, json.int)),
    #("mediaUrl", case r.media_id, accessible {
      Some(media_id), True ->
        json.string("/media/" <> id.media_to_string(media_id))
      _, _ -> json.null()
    }),
    #("footageNote", case r.media_id, accessible {
      Some(_), False ->
        json.string(
          "Reference footage is no longer accessible to your organisation.",
        )
      _, _ -> json.null()
    }),
    #(
      "submissions",
      json.array(s.submissions, fn(x) {
        let #(sub, ratings) = x
        json.object(case released {
          True -> [
            #("userId", id.org_user_json(sub.user_id)),
            #("userName", json.nullable(sub.user_name, json.string)),
            #("ratings", json.array(ratings, rating_json)),
            #("confidence", submission_row.confidence_to_json(sub.confidence)),
            #("submittedAt", json.int(sub.submitted_at)),
          ]
          False -> [
            #("userId", id.org_user_json(sub.user_id)),
            #("userName", json.nullable(sub.user_name, json.string)),
            #("submittedAt", json.int(sub.submitted_at)),
          ]
        })
      }),
    ),
    #("comparison", case released {
      True -> comparison(s)
      False -> json.null()
    }),
    #("blind", json.bool(!released)),
  ])
}

fn notes_json(notes: List(note_row.Row)) -> Json {
  json.array(notes, fn(n) {
    json.object([
      #("at", json.int(n.at)),
      #("byUserId", id.org_user_json(n.by_user_id)),
      #("byName", json.nullable(n.by_name, json.string)),
      #("text", json.string(n.text)),
    ])
  })
}

fn rating_json(x: rating_row.Row) -> Json {
  case x.not_observed, x.value {
    False, Some(value) ->
      json.object([
        #("attrId", json.string(x.attr_id)),
        #("value", json.int(value)),
        #("notObserved", json.bool(False)),
      ])
    _, _ ->
      json.object([
        #("attrId", json.string(x.attr_id)),
        #("notObserved", json.bool(True)),
      ])
  }
}

fn comparison(s: Session) -> Json {
  let n = list.length(s.submissions)
  json.object([
    #(
      "rows",
      json.array(s.attributes, fn(attr) {
        let values =
          list.filter_map(s.submissions, fn(x) {
            list.find(x.1, fn(r) {
              r.attr_id == attr.attr_id && !r.not_observed
            })
            |> result.try(fn(r) { option.to_result(r.value, Nil) })
          })
        let spread = case
          list.reduce(values, int.max),
          list.reduce(values, int.min)
        {
          Ok(hi), Ok(lo) -> Some(hi - lo)
          _, _ -> None
        }
        json.object([
          #("attrId", json.string(attr.attr_id)),
          #("label", json.string(attr.label)),
          #("values", json.array(values, json.int)),
          #("notObserved", json.int(n - list.length(values))),
          #("range", json.nullable(spread, json.int)),
          #("mean", case values {
            [] -> json.null()
            _ -> tenths(int.sum(values), list.length(values))
          }),
          #(
            "disagreement",
            json.string(case list.length(values) >= 2, spread {
              True, Some(d) if d >= 2 -> "high"
              True, Some(1) -> "moderate"
              True, _ -> "aligned"
              False, _ -> "insufficient"
            }),
          ),
        ])
      }),
    ),
    #("sampleSize", json.int(n)),
    #(
      "confidenceNote",
      json.string(
        "Comparison of "
        <> int.to_string(n)
        <> " blind submissions on one reference clip — a conversation starter about the rubric, not a measure of who is “right”.",
      ),
    ),
  ])
}

/// `Math.round(sum / n * 10) / 10` as JavaScript writes it: a whole number has no decimal point.
fn tenths(sum: Int, n: Int) -> Json {
  let t = float.round(int.to_float(sum) /. int.to_float(n) *. 10.0)
  case t % 10 {
    0 -> json.int(t / 10)
    _ -> json.float(int.to_float(t) /. 10.0)
  }
}

fn answer(r: Result(Response, store.UnitError(Response))) -> Response {
  case r {
    Ok(response) -> response
    Error(store.Refused(response)) -> response
    Error(store.Lost(what)) -> http.stale(what)
    Error(e) -> http.internal(e)
  }
}

fn field_invalid(field: String, message: String) -> Response {
  http.json(
    400,
    json.object([
      #("error", json.string("FIELD_INVALID")),
      #("field", json.string(field)),
      #("message", json.string(message)),
    ]),
  )
}

// ---------------------------------------------------------------------------------------------------- create

type CreateBody {
  CreateBody(
    template_id: Option(String),
    title: Option(String),
    media_id: Option(String),
    participants: List(String),
  )
}

fn create_shape() -> input.Shape(CreateBody) {
  use template_id <- input.field(
    "templateId",
    input.nullish(input.text(id_max)),
  )
  use title <- input.field("title", input.nullish(input.text(title_max)))
  use media_id <- input.field("mediaId", input.nullish(input.id()))
  use participants <- input.field(
    "participantUserIds",
    input.required(input.ids_once(participants_max, "scout")),
  )
  input.done(CreateBody(template_id:, title:, media_id:, participants:))
}

/// A current member of the club.
fn active_staff(
  read: Read,
  org_id: id.OrgId,
  user_id: id.OrgUserId,
) -> Result(Option(staff.Staff), Fail(e)) {
  use found <- result.map(staff.by_id(read, user_id))
  case found {
    Some(u) if u.org_id == org_id && u.removed_at == None -> Some(u)
    _ -> None
  }
}

/// `POST /org/calibration`: lead-only.
pub fn create(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use <- access.require_lead(a)
  use b <- http.body(req, create_shape(), [])
  let now = clock.now_ms()
  let title = input.filled(b.title) |> option.unwrap("Calibration session")
  let participants = list.map(b.participants, id.org_user)
  answer(
    store.unit(ctx.store, fn(tx) {
      let read = store.reading(tx)
      use template <- result.try(case b.template_id {
        Some(t) -> assessments.current_template_by_id(read, t)
        None -> Ok(None)
      })
      use template <- require(template, http.error(404, "TEMPLATE_NOT_FOUND"))
      let media_id = option.map(b.media_id, id.media)
      use accessible <- result.try(case media_id {
        Some(m) -> footage_accessible(read, a, m, now)
        None -> Ok(True)
      })
      use <- refuse_unless(
        accessible,
        http.error_message(
          403,
          "FOOTAGE_NOT_ACCESSIBLE",
          "Calibration footage must be footage your organisation can legitimately access.",
        ),
      )
      use members <- result.try(
        list.try_map(participants, active_staff(read, a.org.id, _)),
      )
      use <- refuse_unless(
        list.all(members, option.is_some),
        field_invalid(
          "participantUserIds",
          "Every participant must be a current member of your organisation.",
        ),
      )
      use <- refuse_unless(
        list.length(participants) >= 2,
        http.error_message(
          400,
          "PARTICIPANTS_REQUIRED",
          "Calibration needs at least two participating scouts.",
        ),
      )
      use session_id <- result.try(id.next_calibration_session(tx))
      let session =
        row.Row(
          ..row.new(
            id: session_id,
            org_id: a.org.id,
            title:,
            template_id: template.id,
            template_version: template.version,
            status: row.Open,
            created_by_user_id: a.user.id,
            created_at: now,
          ),
          media_id:,
        )
      use _ <- result.try(row.insert(tx, session))
      use _ <- result.try(
        list.index_map(participants, fn(u, i) { #(u, i) })
        |> list.try_each(fn(p) {
          participant_row.insert(
            tx,
            participant_row.new(session_id:, ord: p.1, user_id: p.0),
          )
        }),
      )
      use _ <- result.try(
        list.try_each(participants, fn(u) {
          notifications.notify(
            tx,
            to: audience.OrgUser,
            id: id.org_user_to_string(u),
            type_: "calibration",
            text: "🎯 You were added to calibration “"
              <> title
              <> "”. Watch the reference footage and submit blind — you cannot see colleagues’ ratings until you do.",
            ref_id: Some(id.calibration_session_to_string(session_id)),
            at: now,
          )
        }),
      )
      respond_session(tx, a, session_id, now, 201, [])
    }),
  )
}

fn require(
  value: Option(a),
  otherwise: Response,
  next: fn(a) -> Result(Response, Fail(Response)),
) -> Result(Response, Fail(Response)) {
  case value {
    Some(v) -> next(v)
    None -> store.refuse(otherwise)
  }
}

fn refuse_unless(
  ok: Bool,
  otherwise: Response,
  next: fn() -> Result(Response, Fail(Response)),
) -> Result(Response, Fail(Response)) {
  case ok {
    True -> next()
    False -> store.refuse(otherwise)
  }
}

/// `{ session, ...extra }` with `status`, as the unit left the session.
fn respond_session(
  tx: Tx,
  a: OrgAccess,
  session_id: id.CalibrationSessionId,
  now: Int,
  status: Int,
  extra: List(#(String, Json)),
) -> Result(Response, Fail(e)) {
  let read = store.reading(tx)
  use found <- result.try(load(read, a.org.id, session_id))
  let assert Some(s) = found as "the unit just wrote the session"
  use body <- result.map(view(read, s, a, now))
  http.json(status, json.object([#("session", body), ..extra]))
}

// ------------------------------------------------------------------------------------------------- one, list

/// `GET /org/calibration/:id`: a participant or a lead.
pub fn get(
  ctx: Ctx,
  a: OrgAccess,
  session_id: id.CalibrationSessionId,
) -> Response {
  let now = clock.now_ms()
  let found =
    store.read(ctx.store, fn(read) {
      use found <- result.try(load(read, a.org.id, session_id))
      case found {
        None -> Ok(http.error(404, "SESSION_NOT_FOUND"))
        Some(s) ->
          case
            list.contains(s.participants, a.user.id) || access.is_lead(a.user)
          {
            False -> Ok(http.error(403, "NOT_A_PARTICIPANT"))
            True ->
              view(read, s, a, now)
              |> result.map(fn(body) {
                http.json(200, json.object([#("session", body)]))
              })
          }
      }
    })
  case found {
    Ok(response) -> response
    Error(e) -> http.internal(e)
  }
}

/// `GET /org/calibration`: newest first; a lead sees every session, anyone else those they take part in.
pub fn list_for(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use page <- pages.strict(req, [IntKind, TextKind])
  let viewer = case access.is_lead(a.user) {
    True -> sqlight.null()
    False -> id.org_user_sql(a.user.id)
  }
  let #(at, after) = case page.after {
    Some([IntKey(at), TextKey(sid)]) -> #(sqlight.int(at), sqlight.text(sid))
    _ -> #(sqlight.null(), sqlight.null())
  }
  let found =
    store.read(ctx.store, fn(read) {
      store.query(
        read,
        "SELECT s.id, s.title, s.status, s.created_at,
          (SELECT COUNT(*) FROM calibration_participants p WHERE p.session_id = s.id),
          (SELECT COUNT(*) FROM calibration_submissions b WHERE b.session_id = s.id)
        FROM calibration_sessions s WHERE s.org_id = ?
          AND (? IS NULL OR EXISTS (SELECT 1 FROM calibration_participants p WHERE p.session_id = s.id AND p.user_id = ?))
          AND (? IS NULL OR s.created_at < ? OR (s.created_at = ? AND s.id < ?))
        ORDER BY s.created_at DESC, s.id DESC LIMIT ?",
        [
          id.org_sql(a.org.id),
          viewer,
          viewer,
          at,
          at,
          at,
          after,
          sqlight.int(page.limit + 1),
        ],
        {
          use sid <- decode.field(0, id.calibration_session_decoder())
          use title <- decode.field(1, decode.string)
          use status <- decode.field(2, row.status_decoder())
          use created_at <- decode.field(3, decode.int)
          use participants <- decode.field(4, decode.int)
          use submitted <- decode.field(5, decode.int)
          decode.success(#(
            sid,
            title,
            status,
            created_at,
            participants,
            submitted,
          ))
        },
      )
    })
  case found {
    Error(e) -> http.internal(e)
    Ok(rows) -> {
      let #(items, next) =
        paging.page_of(rows, page.limit, fn(r) {
          [IntKey(r.3), TextKey(id.calibration_session_to_string(r.0))]
        })
      pages.respond(items, next, fn(r) {
        json.object([
          #("id", id.calibration_session_json(r.0)),
          #("title", json.string(r.1)),
          #("status", row.status_to_json(r.2)),
          #("participants", json.int(r.4)),
          #("submitted", json.int(r.5)),
          #("createdAt", json.int(r.3)),
        ])
      })
    }
  }
}

// ---------------------------------------------------------------------------------------------------- submit

type RatingInput {
  RatingInput(
    attr_id: String,
    value: Option(Option(Int)),
    not_observed: Option(Bool),
  )
}

type Submission {
  Submission(
    ratings: Option(List(RatingInput)),
    confidence: Option(submission_row.Confidence),
  )
}

fn rating_shape() -> input.Shape(RatingInput) {
  use attr_id <- input.field(
    "attrId",
    input.required(input.id_of(attribute_id_max)),
  )
  use value <- input.field(
    "value",
    input.clearable(input.whole_number(rating_min, rating_max)),
  )
  use not_observed <- input.field(
    "notObserved",
    input.optional(input.boolean()),
  )
  input.done(RatingInput(attr_id:, value:, not_observed:))
}

fn submission_shape() -> input.Shape(Submission) {
  use ratings <- input.field(
    "ratings",
    input.nullish(input.items_between(
      input.object(rating_shape()),
      0,
      ratings_max,
    )),
  )
  use confidence <- input.field(
    "confidence",
    input.nullish(input.one_of(submission_row.confidence_pairs)),
  )
  input.done(Submission(ratings:, confidence:))
}

/// A rating as stored: `None` is "not observed".
type Rated {
  Rated(attr_id: String, value: Option(Int))
}

/// repositories/insightCoverage.mjs `typeSubmission`, for what the shape lets through: a value beside "not
/// observed", a rating with neither, or an attribute rated twice. The reason reads as the TypeScript one does.
fn type_ratings(ratings: List(RatingInput)) -> Result(List(Rated), String) {
  list.index_map(ratings, fn(r, i) { #(r, i) })
  |> list.try_fold([], fn(acc, pair) {
    let #(r, i) = pair
    let at = "ratings[" <> int.to_string(i) <> "]"
    use rated <- result.try(case r.not_observed, r.value {
      Some(True), Some(Some(_)) ->
        Error(at <> ".value is absent when the attribute was not observed")
      Some(True), _ -> Ok(Rated(r.attr_id, None))
      _, Some(Some(v)) -> Ok(Rated(r.attr_id, Some(v)))
      _, value ->
        Error(
          at
          <> ".value must be a whole number from 1 to 5 (got "
          <> case value {
            None -> "nothing"
            _ -> "null"
          }
          <> ")",
        )
    })
    case list.any(acc, fn(x: Rated) { x.attr_id == rated.attr_id }) {
      True -> Error(at <> ".attrId rates an attribute twice")
      False -> Ok([rated, ..acc])
    }
  })
  |> result.map(list.reverse)
}

/// `POST /org/calibration/:id/submit`: a participant's one blind submission, while the session is open.
pub fn submit(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  session_id: id.CalibrationSessionId,
) -> Response {
  // Read before the unit; the session's own refusals come first, as the TypeScript route checks them first.
  let body = http.parse_body(req, submission_shape(), [])
  let now = clock.now_ms()
  answer(
    store.unit(ctx.store, fn(tx) {
      let read = store.reading(tx)
      use found <- result.try(load(read, a.org.id, session_id))
      use s <- require(found, http.error(404, "SESSION_NOT_FOUND"))
      use <- refuse_unless(
        s.row.status == row.Open,
        http.error(409, "SESSION_CLOSED"),
      )
      use <- refuse_unless(
        list.contains(s.participants, a.user.id),
        http.error(403, "NOT_A_PARTICIPANT"),
      )
      use <- refuse_unless(
        !submitted(s, a.user.id),
        http.error_message(
          409,
          "ALREADY_SUBMITTED",
          "Blind submissions are final — one per participant.",
        ),
      )
      use b <- result.try(body |> result.map_error(store.Refuse))
      use ratings <- result.try(case b.ratings {
        Some([_, ..] as ratings) -> Ok(ratings)
        _ ->
          store.refuse(http.json(
            400,
            json.object([
              #("error", json.string("RATINGS_REQUIRED")),
              #("field", json.string("ratings")),
            ]),
          ))
      })
      use rated <- result.try(
        type_ratings(ratings)
        |> result.map_error(fn(reason) {
          store.Refuse(field_invalid(
            "ratings",
            "Each rating is { attrId, value 1–5 } or { attrId, notObserved: true }, one per attribute ("
              <> reason
              <> ").",
          ))
        }),
      )
      let rubric = list.map(s.attributes, fn(x) { x.attr_id })
      use _ <- result.try(
        case list.find(rated, fn(r) { !list.contains(rubric, r.attr_id) }) {
          Ok(unknown) ->
            store.refuse(field_invalid(
              "ratings",
              "The pinned rubric has no attribute " <> unknown.attr_id <> ".",
            ))
          Error(Nil) -> Ok(Nil)
        },
      )
      use _ <- result.try(submission_row.insert(
        tx,
        submission_row.Row(
          ..submission_row.new(
            session_id:,
            user_id: a.user.id,
            confidence: option.unwrap(b.confidence, submission_row.Medium),
            submitted_at: now,
          ),
          user_name: Some(a.user.name),
        ),
      ))
      use _ <- result.try(
        list.index_map(rated, fn(r, i) { #(r, i) })
        |> list.try_each(fn(p) {
          let #(r, i) = p
          rating_row.insert(
            tx,
            rating_row.Row(
              ..rating_row.new(
                session_id:,
                user_id: a.user.id,
                ord: i,
                attr_id: r.attr_id,
                not_observed: r.value == None,
              ),
              value: r.value,
            ),
          )
        }),
      )
      respond_session(tx, a, session_id, now, 201, [
        #(
          "note",
          json.string("Submitted — the comparison is now visible to you."),
        ),
      ])
    }),
  )
}

// ----------------------------------------------------------------------------------------------- close, notes

/// `POST /org/calibration/:id/close`: lead-only; closing a closed session changes nothing.
pub fn close(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  session_id: id.CalibrationSessionId,
) -> Response {
  use <- access.require_lead(a)
  use _ <- http.body(req, input.nothing(), [])
  let now = clock.now_ms()
  answer(
    store.unit(ctx.store, fn(tx) {
      use found <- result.try(load(store.reading(tx), a.org.id, session_id))
      use _ <- require(found, http.error(404, "SESSION_NOT_FOUND"))
      use _ <- result.try(
        store.run(
          tx,
          "UPDATE calibration_sessions SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'",
          [sqlight.int(now), id.calibration_session_sql(session_id)],
        ),
      )
      respond_session(tx, a, session_id, now, 200, [])
    }),
  )
}

fn note_shape() -> input.Shape(Option(String)) {
  use text <- input.field("text", input.nullish(input.text(note_max)))
  input.done(text)
}

/// `POST /org/calibration/:id/notes`: discussion opens after your blind submission, or once the session closes.
pub fn add_note(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  session_id: id.CalibrationSessionId,
) -> Response {
  let body = http.parse_body(req, note_shape(), [])
  let now = clock.now_ms()
  answer(
    store.unit(ctx.store, fn(tx) {
      use found <- result.try(load(store.reading(tx), a.org.id, session_id))
      use s <- require(found, http.error(404, "SESSION_NOT_FOUND"))
      use <- refuse_unless(
        list.contains(s.participants, a.user.id) || access.is_lead(a.user),
        http.error(403, "NOT_A_PARTICIPANT"),
      )
      use <- refuse_unless(
        s.row.status == row.Closed || submitted(s, a.user.id),
        http.error_message(
          409,
          "SUBMIT_FIRST",
          "Discussion notes open after your blind submission.",
        ),
      )
      use text <- result.try(body |> result.map_error(store.Refuse))
      use text <- require(
        input.filled(text),
        http.required("FIELD_INVALID", "text"),
      )
      let count = list.length(s.notes)
      use <- refuse_unless(
        count < notes_max,
        http.error_message(
          409,
          "TOO_MANY_NOTES",
          "A session keeps at most " <> int.to_string(notes_max) <> " notes.",
        ),
      )
      let note =
        note_row.Row(
          ..note_row.new(
            session_id:,
            ord: count,
            at: now,
            by_user_id: a.user.id,
            text:,
          ),
          by_name: Some(a.user.name),
        )
      use _ <- result.map(note_row.insert(tx, note))
      http.json(
        201,
        json.object([#("notes", notes_json(list.append(s.notes, [note])))]),
      )
    }),
  )
}
