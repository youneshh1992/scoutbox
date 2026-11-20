//// Assessment campaigns (domains/scouting/journeys.mjs): a club publishes drills to film, eligible players (a
//// guardian for a child) submit attempts, the server checks only the file, and a person at the club reviews the
//// football. The machine's verdict and the human's are kept apart: passing the file checks makes an attempt
//// "submitted", never "verified".
////
//// Not ported yet: the `campaigns` live event.

import gleam/dict
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import gleam/set
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/development/activity
import scoutbox/identity/access.{type OrgAccess, type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/orgs
import scoutbox/identity/players.{type Player}
import scoutbox/identity/staff
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/pages
import scoutbox/platform/paging.{IntKey, IntKind}
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/platform/temporal
import scoutbox/rows/campaign_attempt_issues as issue_row
import scoutbox/rows/campaign_attempts as attempt_row
import scoutbox/rows/campaign_drills as drill_row
import scoutbox/rows/campaign_rubric as rubric_row
import scoutbox/rows/campaign_submissions as submission_row
import scoutbox/rows/campaigns as row
import scoutbox/rows/id
import scoutbox/rows/opportunities as opportunity_row
import scoutbox/rows/orgs as org_row
import scoutbox/safety/audit
import scoutbox/safety/moderate
import scoutbox/scouting/evidence
import scoutbox/scouting/opportunities.{type Eligibility, Bad, Eligibility}
import scoutbox/vocab/audience
import scoutbox/vocab/party
import sqlight
import wisp.{type Request, type Response}

// OPPORTUNITIES_CAMPAIGNS_LIMITS (repositories/opportunitiesCampaigns.ts).
const title_max = 120

const drills_max = 6

const drill_name_max = 80

const instructions_max = 400

const recording_max = 120

const rubric_max = 8

const criterion_max = 100

const guidance_max = 200

const attempts_allowed_max = 5

const note_max = 300

const reasons_max = 400

const rubric_notes_max = 400

/// The most attempts one submission holds.
const attempts_max = 50

/// schemas.mjs `ID_MAX`.
const id_max = 80

pub type Campaign {
  Campaign(
    row: row.Row,
    drills: List(drill_row.Row),
    rubric: List(rubric_row.Row),
  )
}

pub type Attempt {
  Attempt(row: attempt_row.Row, issues: List(issue_row.Issue))
}

pub type Submission {
  Submission(row: submission_row.Row, attempts: List(Attempt))
}

type Actor {
  Actor(kind: party.Party, id: String, name: String)
}

// ------------------------------------------------------------------------------------------------- reads

fn ids_json(ids: List(String)) -> sqlight.Value {
  json.array(ids, json.string) |> json.to_string |> sqlight.text
}

fn campaigns_with_children(
  read: Read,
  rows: List(row.Row),
) -> Result(List(Campaign), Fail(e)) {
  let ids = ids_json(list.map(rows, fn(r) { id.campaign_to_string(r.id) }))
  use drills <- result.try(store.query(
    read,
    "SELECT "
      <> drill_row.columns
      <> " FROM campaign_drills WHERE campaign_id IN (SELECT value FROM json_each(?)) ORDER BY ordinal",
    [ids],
    drill_row.decoder(),
  ))
  use rubric <- result.map(store.query(
    read,
    "SELECT "
      <> rubric_row.columns
      <> " FROM campaign_rubric WHERE campaign_id IN (SELECT value FROM json_each(?)) ORDER BY ordinal",
    [ids],
    rubric_row.decoder(),
  ))
  // `list.group` prepends, so each group is in reverse of the query's order.
  let drills = list.group(drills, fn(d) { d.campaign_id })
  let rubric = list.group(rubric, fn(r) { r.campaign_id })
  list.map(rows, fn(r) {
    Campaign(
      row: r,
      drills: dict.get(drills, r.id) |> result.unwrap([]) |> list.reverse,
      rubric: dict.get(rubric, r.id) |> result.unwrap([]) |> list.reverse,
    )
  })
}

fn campaigns_where(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(List(Campaign), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT " <> row.columns <> " FROM campaigns " <> where,
    args,
    row.decoder(),
  ))
  campaigns_with_children(read, rows)
}

fn campaign_by_id(
  read: Read,
  cid: id.CampaignId,
) -> Result(Option(Campaign), Fail(e)) {
  use found <- result.map(
    campaigns_where(read, "WHERE id = ?", [id.campaign_sql(cid)]),
  )
  list.first(found) |> option.from_result
}

fn submissions_with_children(
  read: Read,
  rows: List(submission_row.Row),
) -> Result(List(Submission), Fail(e)) {
  let ids =
    ids_json(list.map(rows, fn(r) { id.campaign_submission_to_string(r.id) }))
  use attempts <- result.try(store.query(
    read,
    "SELECT "
      <> attempt_row.columns
      <> " FROM campaign_attempts WHERE submission_id IN (SELECT value FROM json_each(?)) ORDER BY ordinal",
    [ids],
    attempt_row.decoder(),
  ))
  use issues <- result.map(store.query(
    read,
    "SELECT "
      <> issue_row.qualified("i")
      <> " FROM campaign_attempt_issues i JOIN campaign_attempts a ON a.id = i.attempt_id WHERE a.submission_id IN (SELECT value FROM json_each(?)) ORDER BY i.ordinal",
    [ids],
    issue_row.decoder(),
  ))
  let issues = list.group(issues, fn(i) { i.attempt_id })
  let attempts =
    list.map(attempts, fn(a) {
      Attempt(
        row: a,
        issues: dict.get(issues, a.id)
          |> result.unwrap([])
          |> list.reverse
          |> list.map(fn(i) { i.issue }),
      )
    })
    |> list.group(fn(a) { a.row.submission_id })
  list.map(rows, fn(r) {
    Submission(
      row: r,
      attempts: dict.get(attempts, r.id) |> result.unwrap([]) |> list.reverse,
    )
  })
}

fn submissions_where(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(List(Submission), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> submission_row.columns
      <> " FROM campaign_submissions "
      <> where,
    args,
    submission_row.decoder(),
  ))
  submissions_with_children(read, rows)
}

fn submission_of(
  read: Read,
  cid: id.CampaignId,
  pid: id.PlayerId,
) -> Result(Option(Submission), Fail(e)) {
  use found <- result.map(
    submissions_where(read, "WHERE campaign_id = ? AND player_id = ?", [
      id.campaign_sql(cid),
      id.player_sql(pid),
    ]),
  )
  list.first(found) |> option.from_result
}

fn submission_by_attempt(
  read: Read,
  aid: id.CampaignAttemptId,
) -> Result(Option(Submission), Fail(e)) {
  use found <- result.map(
    submissions_where(
      read,
      "WHERE id = (SELECT submission_id FROM campaign_attempts WHERE id = ?)",
      [id.campaign_attempt_sql(aid)],
    ),
  )
  list.first(found) |> option.from_result
}

// ------------------------------------------------------------------------------------------------- rules

/// Published and not past its deadline.
fn is_open(c: Campaign, today: String) -> Bool {
  c.row.status == row.Published
  && string.compare(c.row.deadline, today) != order.Lt
}

/// A campaign's eligibility has no category, so it reads as mixed.
fn eligibility(r: row.Row) -> Eligibility {
  let assert Ok(group) =
    opportunity_row.elig_position_group_from_string(
      row.elig_position_group_to_string(r.elig_position_group),
    )
  Eligibility(
    min_age: r.elig_min_age,
    max_age: r.elig_max_age,
    position_group: group,
    category: opportunity_row.EligCategoryMixed,
    max_level: r.elig_max_level,
    radius_km: r.elig_radius_km,
  )
}

/// FILE_CHECK_ISSUES (repositories/opportunitiesCampaigns.ts): what each failed check tells the player.
fn issue_text(issue: issue_row.Issue) -> String {
  case issue {
    issue_row.MediaMissing -> "attach the recorded video before submitting"
    issue_row.NotVideo -> "the attached file is not a video"
    issue_row.NotUploaded -> "the video file itself was never uploaded"
  }
}

/// File checks only (it exists, is a video, and its bytes were uploaded): they say nothing about the drill.
fn file_checks(p: Player, media_id: Option(String)) -> List(issue_row.Issue) {
  let media = case media_id {
    Some(m) ->
      list.find(p.media, fn(x) { id.media_to_string(x.clip.id) == m })
      |> option.from_result
    None -> None
  }
  case media {
    None -> [issue_row.MediaMissing]
    Some(m) ->
      list.flatten([
        case m.clip.kind {
          Some("video") -> []
          _ -> [issue_row.NotVideo]
        },
        case
          m.clip.url,
          string.starts_with(id.media_to_string(m.clip.id), "media-seed")
        {
          None, False -> [issue_row.NotUploaded]
          _, _ -> []
        },
      ])
  }
}

// ------------------------------------------------------------------------------------------------- views

fn campaign_fields(c: Campaign) -> List(#(String, Json)) {
  let r = c.row
  [
    #("id", id.campaign_json(r.id)),
    #("orgId", id.org_json(r.org_id)),
    #("orgName", json.string(r.org_name)),
    #("title", json.string(r.title)),
    #(
      "drills",
      json.array(c.drills, fn(d) {
        json.object([
          #("name", json.string(d.name)),
          #("instructions", json.string(d.instructions)),
          #(
            "recording",
            json.object([
              #("equipment", json.string(d.equipment)),
              #("distance", json.string(d.distance)),
              #("surface", json.string(d.surface)),
              #("camera", json.string(d.camera)),
            ]),
          ),
        ])
      }),
    ),
    #("deadline", json.string(r.deadline)),
    #("attemptsAllowed", json.int(r.attempts_allowed)),
    #("eligibility", opportunities.eligibility_view(eligibility(r), False)),
    #("rubric", rubric_json(c)),
    #("status", row.status_to_json(r.status)),
    #("createdBy", json.string(r.created_by_name)),
    #("createdAt", json.int(r.created_at)),
  ]
}

fn rubric_json(c: Campaign) -> Json {
  json.array(c.rubric, fn(r) {
    json.object([
      #("criterion", json.string(r.criterion)),
      #("guidance", json.string(r.guidance)),
    ])
  })
}

fn attempt_fields(a: Attempt) -> List(#(String, Json)) {
  let r = a.row
  [
    #("id", id.campaign_attempt_json(r.id)),
    #("mediaId", json.nullable(r.media_id, id.media_json)),
    #("drillName", json.string(r.drill_name)),
    #("note", json.nullable(r.note, json.string)),
    #(
      "fileChecks",
      json.object([
        #("passed", json.bool(r.file_checks_passed)),
        #("issues", json.array(a.issues, fn(i) { json.string(issue_text(i)) })),
        #("checkedAt", json.int(r.file_checked_at)),
        #("kind", json.string("automated_file_check")),
      ]),
    ),
    #("status", attempt_row.status_to_json(r.status)),
    #("review", case r.reviewed_at, r.review_by_user_id {
      Some(at), Some(by) ->
        json.object([
          #("byUserId", id.org_user_json(by)),
          #("byName", json.nullable(r.review_by_name, json.string)),
          #("at", json.int(at)),
          #("kind", json.string("human_review")),
          #("reasons", json.nullable(r.review_reasons, json.string)),
          #("rubricNotes", json.nullable(r.review_rubric_notes, json.string)),
        ])
      _, _ -> json.null()
    }),
    #("submittedAt", json.int(r.submitted_at)),
  ]
}

fn submission_view(s: Submission) -> Json {
  let r = s.row
  json.object([
    #("id", id.campaign_submission_json(r.id)),
    #("campaignId", id.campaign_json(r.campaign_id)),
    #("orgId", id.org_json(r.org_id)),
    #("playerId", id.player_json(r.player_id)),
    #("playerName", json.nullable(r.player_name, json.string)),
    #(
      "submittedBy",
      json.object([
        #("kind", party.to_json(r.submitted_by_kind)),
        #("id", json.string(r.submitted_by_id)),
        #("name", json.nullable(r.submitted_by_name, json.string)),
      ]),
    ),
    #(
      "attempts",
      json.array(s.attempts, fn(a) { json.object(attempt_fields(a)) }),
    ),
    #("createdAt", json.int(r.created_at)),
  ])
}

// ------------------------------------------------------------------------------------------------- shared

fn finished(r: Result(Response, store.UnitError(Response))) -> Response {
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

/// `|| null`: empty text is no value.
fn or_none(s: Option(String)) -> Option(String) {
  case s {
    Some("") -> None
    other -> other
  }
}

fn moderated(
  ctx: Ctx,
  text: Option(String),
  kind: String,
  player_id: id.PlayerId,
  org_id: id.OrgId,
  next: fn() -> Response,
) -> Response {
  case text {
    None -> next()
    Some(text) ->
      moderate.or_refuse(
        ctx,
        text,
        audit.Context(
          kind:,
          player_id: Some(player_id),
          org_id: Some(org_id),
          user_id: None,
          channel_id: None,
          request_id: None,
        ),
        next,
      )
  }
}

fn child_of(
  ctx: Ctx,
  g: Guardian,
  child_id: id.PlayerId,
  next: fn(Player) -> Response,
) -> Response {
  case list.contains(g.child_ids, child_id) {
    False -> http.error(403, "NOT_YOUR_CHILD")
    True ->
      case store.read(ctx.store, players.by_id(_, child_id)) {
        Ok(Some(c)) -> next(c)
        Ok(None) -> http.error(404, "PLAYER_NOT_FOUND")
        Error(failure) -> http.internal(failure)
      }
  }
}

/// Stale unless `holds`.
fn guard(
  holds: Bool,
  what: String,
  next: fn() -> Result(a, Fail(e)),
) -> Result(a, Fail(e)) {
  case holds {
    True -> next()
    False -> store.stale(what)
  }
}

// ------------------------------------------------------------------------------------------------- publishing

type NewDrill {
  NewDrill(
    name: String,
    instructions: Option(String),
    recording: Option(Recording),
  )
}

type Recording {
  Recording(
    equipment: Option(String),
    distance: Option(String),
    surface: Option(String),
    camera: Option(String),
  )
}

type NewCriterion {
  NewCriterion(criterion: String, guidance: Option(String))
}

type NewCampaign {
  NewCampaign(
    title: Option(String),
    deadline: Option(temporal.Day),
    drills: Option(List(NewDrill)),
    attempts_allowed: Option(Int),
    rubric: Option(List(NewCriterion)),
    eligibility: Option(Dynamic),
  )
}

fn drill_shape() -> input.Check(NewDrill) {
  let recording_text = fn() { input.nullish(input.text(recording_max)) }
  input.object({
    use name <- input.field(
      "name",
      input.required(input.required_text(drill_name_max)),
    )
    use instructions <- input.field(
      "instructions",
      input.nullish(input.text(instructions_max)),
    )
    use recording <- input.field(
      "recording",
      input.nullish(
        input.object({
          use equipment <- input.field("equipment", recording_text())
          use distance <- input.field("distance", recording_text())
          use surface <- input.field("surface", recording_text())
          use camera <- input.field("camera", recording_text())
          input.done(Recording(equipment:, distance:, surface:, camera:))
        }),
      ),
    )
    input.done(NewDrill(name:, instructions:, recording:))
  })
}

/// `POST /org/campaigns`.
pub fn create(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  let shape = {
    use title <- input.field("title", input.nullish(input.text(title_max)))
    use deadline <- input.field(
      "deadline",
      input.optional(input.day_or_blank()),
    )
    use drills <- input.field(
      "drills",
      input.nullish(input.items_between(drill_shape(), 0, drills_max)),
    )
    use attempts_allowed <- input.field(
      "attemptsAllowed",
      input.nullish(input.whole_number(1, attempts_allowed_max)),
    )
    use rubric <- input.field(
      "rubric",
      input.nullish(input.items_between(
        input.object({
          use criterion <- input.field(
            "criterion",
            input.required(input.required_text(criterion_max)),
          )
          use guidance <- input.field(
            "guidance",
            input.nullish(input.text(guidance_max)),
          )
          input.done(NewCriterion(criterion:, guidance:))
        }),
        0,
        rubric_max,
      )),
    )
    use eligibility <- input.field(
      "eligibility",
      input.optional(input.anything()),
    )
    input.done(NewCampaign(
      title:,
      deadline: option.flatten(deadline),
      drills:,
      attempts_allowed:,
      rubric:,
      eligibility:,
    ))
  }
  use b <- http.body(req, shape, [])
  case input.filled(b.title), b.title, b.drills, b.deadline {
    None, _, _, _ | _, None, _, _ | _, _, None, _ | _, _, Some([]), _ ->
      http.error(400, "TITLE_AND_DRILLS_REQUIRED")
    _, _, _, None -> http.required("DEADLINE_REQUIRED", "deadline")
    Some(_), Some(title), Some(drills), Some(deadline) ->
      case repeated_drill(drills) {
        Some(#(i, name)) ->
          field_invalid(
            "drills[" <> string.inspect(i) <> "].name",
            "two drills are called \"" <> name <> "\".",
          )
        None -> {
          let grassroots = a.org.level == Some(org_row.LevelGrassroots)
          case opportunities.type_eligibility(b.eligibility, grassroots, None) {
            Error(Bad(field:, message:)) -> field_invalid(field, message)
            Ok(e) ->
              publish(ctx, a, b, title, temporal.day_text(deadline), drills, e)
          }
        }
      }
  }
}

/// The first drill whose name an earlier one has.
fn repeated_drill(drills: List(NewDrill)) -> Option(#(Int, String)) {
  list.index_fold(drills, #(set.new(), None), fn(acc, d, i) {
    case acc {
      #(_, Some(_)) -> acc
      #(seen, None) ->
        case set.contains(seen, d.name) {
          True -> #(seen, Some(#(i, d.name)))
          False -> #(set.insert(seen, d.name), None)
        }
    }
  }).1
}

fn publish(
  ctx: Ctx,
  a: OrgAccess,
  b: NewCampaign,
  title: String,
  deadline: String,
  drills: List(NewDrill),
  e: Eligibility,
) -> Response {
  let now = clock.now_ms()
  let assert Ok(group) =
    row.elig_position_group_from_string(
      opportunity_row.elig_position_group_to_string(e.position_group),
    )
  store.unit(ctx.store, fn(tx) {
    use cid <- result.try(id.next_campaign(tx))
    use _ <- result.try(row.insert(
      tx,
      row.Row(
        ..row.new(
          id: cid,
          org_id: a.org.id,
          org_name: evidence.stored_name(a.org.name),
          title:,
          deadline:,
          attempts_allowed: option.unwrap(b.attempts_allowed, 2),
          elig_position_group: group,
          status: row.Published,
          created_by_name: evidence.stored_name(a.user.name),
          created_at: now,
        ),
        elig_min_age: e.min_age,
        elig_max_age: e.max_age,
        elig_max_level: e.max_level,
        elig_radius_km: e.radius_km,
      ),
    ))
    use _ <- result.try(
      list.index_map(drills, fn(d, i) { #(i, d) })
      |> list.try_each(fn(entry) {
        let #(i, d) = entry
        let r = option.unwrap(d.recording, Recording(None, None, None, None))
        drill_row.insert(
          tx,
          drill_row.Row(
            campaign_id: cid,
            ordinal: i,
            name: d.name,
            instructions: option.unwrap(d.instructions, ""),
            equipment: option.unwrap(r.equipment, "Any phone camera"),
            distance: option.unwrap(r.distance, "Full area in frame"),
            surface: option.unwrap(r.surface, "Flat grass/turf"),
            camera: option.unwrap(r.camera, "Fixed, side-on"),
          ),
        )
      }),
    )
    use _ <- result.try(
      option.unwrap(b.rubric, [])
      |> list.index_map(fn(c, i) { #(i, c) })
      |> list.try_each(fn(entry) {
        let #(i, c) = entry
        rubric_row.insert(
          tx,
          rubric_row.Row(
            campaign_id: cid,
            ordinal: i,
            criterion: c.criterion,
            guidance: option.unwrap(c.guidance, ""),
          ),
        )
      }),
    )
    use found <- result.try(campaign_by_id(store.reading(tx), cid))
    case found {
      Some(c) ->
        Ok(http.json(
          201,
          json.object([#("campaign", json.object(campaign_fields(c)))]),
        ))
      None -> store.stale("campaign")
    }
  })
  |> finished
}

// ------------------------------------------------------------------------------------------------- the club's list

/// `GET /org/campaigns`: newest first, by cursor (the key is the rowid), with submission counts.
pub fn list_for_org(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use page <- pages.strict(req, [IntKind])
  let before = case page.after {
    Some([IntKey(rowid)]) -> sqlight.int(rowid)
    _ -> sqlight.null()
  }
  let read =
    store.read(ctx.store, fn(r) {
      use found <- result.try(
        store.query(
          r,
          "SELECT "
            <> row.columns
            <> ", rowid FROM campaigns WHERE org_id = ? AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?",
          [id.org_sql(a.org.id), before, before, sqlight.int(page.limit + 1)],
          {
            use c <- decode.then(row.decoder())
            use rowid <- decode.field(row.width, decode.int)
            decode.success(#(c, rowid))
          },
        ),
      )
      use campaigns <- result.try(campaigns_with_children(
        r,
        list.map(found, fn(f) { f.0 }),
      ))
      let #(items, next) =
        paging.page_of(
          list.zip(campaigns, list.map(found, fn(f) { f.1 })),
          page.limit,
          fn(f) { [IntKey(f.1)] },
        )
      use counts <- result.map(
        store.query(
          r,
          "SELECT s.campaign_id, COUNT(*), SUM(EXISTS (SELECT 1 FROM campaign_attempts a WHERE a.submission_id = s.id AND a.status = 'submitted')) FROM campaign_submissions s WHERE s.campaign_id IN (SELECT value FROM json_each(?)) GROUP BY s.campaign_id",
          [
            ids_json(
              list.map(items, fn(f) { id.campaign_to_string({ f.0 }.row.id) }),
            ),
          ],
          {
            use cid <- decode.field(0, id.campaign_decoder())
            use submissions <- decode.field(1, decode.int)
            use awaiting <- decode.field(2, decode.int)
            decode.success(#(cid, #(submissions, awaiting)))
          },
        ),
      )
      #(items, next, dict.from_list(counts))
    })
  case read {
    Error(failure) -> http.internal(failure)
    Ok(#(items, next, counts)) ->
      pages.respond(items, next, fn(f) {
        let c = f.0
        let #(submissions, awaiting) =
          dict.get(counts, c.row.id) |> result.unwrap(#(0, 0))
        json.object(
          list.append(campaign_fields(c), [
            #("submissions", json.int(submissions)),
            #("awaitingReview", json.int(awaiting)),
          ]),
        )
      })
  }
}

// ------------------------------------------------------------------------------------------------- the player's list

fn campaigns_for(read: Read, p: Player, now: Int) -> Result(Json, Fail(e)) {
  use open <- result.try(
    campaigns_where(
      read,
      "WHERE status = 'published' AND deadline >= ? ORDER BY rowid",
      [sqlight.text(clock.iso_day(now))],
    ),
  )
  use mine <- result.try(
    submissions_where(read, "WHERE player_id = ? ORDER BY rowid", [
      id.player_sql(p.row.id),
    ]),
  )
  let mine = dict.from_list(list.map(mine, fn(s) { #(s.row.campaign_id, s) }))
  use shown <- result.map(
    list.try_map(open, fn(c) {
      use org <- result.try(orgs.by_id(read, c.row.org_id))
      case org {
        Some(org) if !org.suspended -> {
          use seen <- result.try(players.for_org(read, p.row.id, org, now))
          case seen {
            Some(#(_, access)) if access.visible && !access.blocked -> {
              use km <- result.map(opportunities.km_from_club(
                read,
                c.row.org_id,
                p,
              ))
              case opportunities.reasons(eligibility(c.row), p, km, now) {
                [] -> [
                  json.object(
                    list.append(campaign_fields(c), [
                      #("mySubmission", case dict.get(mine, c.row.id) {
                        Ok(s) -> submission_view(s)
                        Error(Nil) -> json.null()
                      }),
                    ]),
                  ),
                ]
                _ -> []
              }
            }
            _ -> Ok([])
          }
        }
        _ -> Ok([])
      }
    }),
  )
  json.object([#("items", json.preprocessed_array(list.flatten(shown)))])
}

fn list_for(ctx: Ctx, p: Player) -> Response {
  let now = clock.now_ms()
  case store.read(ctx.store, campaigns_for(_, p, now)) {
    Ok(body) -> http.json(200, body)
    Error(failure) -> http.internal(failure)
  }
}

/// `GET /player/campaigns`.
pub fn player_list(ctx: Ctx, p: PlayerAccess) -> Response {
  list_for(ctx, p.player)
}

/// `GET /guardian/children/:id/campaigns`.
pub fn guardian_list(ctx: Ctx, g: Guardian, child_id: id.PlayerId) -> Response {
  use child <- child_of(ctx, g, child_id)
  list_for(ctx, child)
}

// ------------------------------------------------------------------------------------------------- submitting

/// `POST /player/campaigns/:id/submit`. Attempts are football activity, like drills, so an eligible minor may
/// upload one; the club's review conversation stays with the guardian.
pub fn player_submit(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  cid: id.CampaignId,
) -> Response {
  submit(
    ctx,
    req,
    p.player,
    Actor(party.Player, id.player_to_string(p.player.row.id), p.player.row.name),
    cid,
  )
}

/// `POST /guardian/children/:childId/campaigns/:id/submit`.
pub fn guardian_submit(
  ctx: Ctx,
  req: Request,
  g: Guardian,
  child_id: id.PlayerId,
  cid: id.CampaignId,
) -> Response {
  use child <- child_of(ctx, g, child_id)
  submit(
    ctx,
    req,
    child,
    Actor(party.Guardian, id.guardian_to_string(g.row.id), g.row.name),
    cid,
  )
}

type Gate {
  Open(Campaign, Option(Submission))
  Shut(Response)
}

fn gate(
  read: Read,
  p: Player,
  cid: id.CampaignId,
  now: Int,
) -> Result(Gate, Fail(e)) {
  use found <- result.try(campaign_by_id(read, cid))
  case found {
    None -> Ok(Shut(http.error(404, "CAMPAIGN_NOT_FOUND")))
    Some(c) ->
      case is_open(c, clock.iso_day(now)) {
        False -> Ok(Shut(http.error(409, "CAMPAIGN_CLOSED")))
        True -> {
          use org <- result.try(orgs.by_id(read, c.row.org_id))
          use seen <- result.try(case org {
            Some(org) -> players.for_org(read, p.row.id, org, now)
            None -> Ok(None)
          })
          use km <- result.try(opportunities.km_from_club(read, c.row.org_id, p))
          let reasons = opportunities.reasons(eligibility(c.row), p, km, now)
          case seen, reasons {
            Some(#(_, access)), [] if access.visible && !access.blocked -> {
              use existing <- result.map(submission_of(read, c.row.id, p.row.id))
              // Only attempts that reached review count against the policy: a failed file check never burns one.
              let active =
                option.map(existing, fn(s) {
                  list.count(s.attempts, fn(a) {
                    a.row.status == attempt_row.Submitted
                    || a.row.status == attempt_row.Accepted
                  })
                })
                |> option.unwrap(0)
              case active >= c.row.attempts_allowed {
                True ->
                  Shut(http.json(
                    409,
                    json.object([
                      #("error", json.string("ATTEMPTS_EXHAUSTED")),
                      #("allowed", json.int(c.row.attempts_allowed)),
                    ]),
                  ))
                False -> Open(c, existing)
              }
            }
            _, _ ->
              Ok(
                Shut(http.json(
                  403,
                  json.object([
                    #("error", json.string("NOT_ELIGIBLE")),
                    #("reasons", json.array(reasons, json.string)),
                  ]),
                )),
              )
          }
        }
      }
  }
}

type NewAttempt {
  NewAttempt(
    media_id: Option(String),
    drill_name: Option(String),
    note: Option(String),
  )
}

fn submit(
  ctx: Ctx,
  req: Request,
  p: Player,
  submitter: Actor,
  cid: id.CampaignId,
) -> Response {
  use req <- http.rerun_on_stale(req)
  let now = clock.now_ms()
  case store.read(ctx.store, gate(_, p, cid, now)) {
    Error(failure) -> http.internal(failure)
    Ok(Shut(answer)) -> answer
    Ok(Open(c, existing)) -> {
      let shape = {
        // An empty mediaId is an attempt with no clip: it fails the file checks rather than the request.
        use media_id <- input.field(
          "mediaId",
          input.nullish(input.text(id_max)),
        )
        use drill_name <- input.field(
          "drillName",
          input.nullish(input.text(9_007_199_254_740_991)),
        )
        use note <- input.field("note", input.nullish(input.text(note_max)))
        input.done(NewAttempt(media_id:, drill_name:, note:))
      }
      use b <- http.body(req, shape, [])
      let names = list.map(c.drills, fn(d) { d.name })
      let held =
        option.map(existing, fn(s) { list.length(s.attempts) })
        |> option.unwrap(0)
      let drill = case b.drill_name {
        Some(name) ->
          case list.contains(names, name) {
            True -> Ok(name)
            False ->
              Error(field_invalid(
                "drillName",
                "drillName is one of this campaign's drills: "
                  <> string.join(names, ", ")
                  <> ".",
              ))
          }
        None ->
          case names {
            [first, ..] -> Ok(first)
            [] -> Error(http.internal("a campaign with no drills"))
          }
      }
      case drill, held >= attempts_max {
        Error(answer), _ -> answer
        Ok(_), True ->
          http.json(
            409,
            json.object([
              #("error", json.string("ATTEMPTS_EXHAUSTED")),
              #("allowed", json.int(c.row.attempts_allowed)),
              #(
                "message",
                json.string("This submission holds as many attempts as it can."),
              ),
            ]),
          )
        Ok(drill_name), False -> {
          let note = or_none(b.note)
          use <- moderated(ctx, note, "campaign_note", p.row.id, c.row.org_id)
          record(ctx, p, submitter, c, existing, b, drill_name, note, now)
        }
      }
    }
  }
}

fn record(
  ctx: Ctx,
  p: Player,
  submitter: Actor,
  c: Campaign,
  existing: Option(Submission),
  b: NewAttempt,
  drill_name: String,
  note: Option(String),
  now: Int,
) -> Response {
  let media_id = or_none(b.media_id)
  let issues = file_checks(p, media_id)
  let passed = issues == []
  store.unit(ctx.store, fn(tx) {
    let read = store.reading(tx)
    // Another request for this player may have added an attempt, or the submission, since the gate.
    use now_held <- result.try(submission_of(read, c.row.id, p.row.id))
    let before = option.map(existing, fn(s) { list.length(s.attempts) })
    let after = option.map(now_held, fn(s) { list.length(s.attempts) })
    use <- guard(before == after, "the campaign submission")
    // The attempt's id is minted before a new submission's, as the TypeScript server mints them.
    use aid <- result.try(id.next_campaign_attempt(tx))
    use sid <- result.try(case existing {
      Some(s) -> Ok(s.row.id)
      None -> {
        use sid <- result.try(id.next_campaign_submission(tx))
        use _ <- result.map(submission_row.insert(
          tx,
          submission_row.Row(
            ..submission_row.new(
              id: sid,
              campaign_id: c.row.id,
              org_id: c.row.org_id,
              player_id: p.row.id,
              submitted_by_kind: submitter.kind,
              submitted_by_id: submitter.id,
              created_at: now,
            ),
            player_name: Some(evidence.stored_name(p.row.name)),
            submitted_by_name: Some(evidence.stored_name(submitter.name)),
          ),
        ))
        sid
      }
    })
    use _ <- result.try(attempt_row.insert(
      tx,
      attempt_row.Row(
        ..attempt_row.new(
          id: aid,
          submission_id: sid,
          ordinal: option.unwrap(before, 0),
          drill_name:,
          file_checks_passed: passed,
          file_checked_at: now,
          status: case passed {
            True -> attempt_row.Submitted
            False -> attempt_row.FailedChecks
          },
          submitted_at: now,
        ),
        media_id: option.map(media_id, id.media),
        note:,
      ),
    ))
    use _ <- result.try(
      list.index_map(issues, fn(issue, i) { #(i, issue) })
      |> list.try_each(fn(entry) {
        issue_row.insert(
          tx,
          issue_row.Row(attempt_id: aid, ordinal: entry.0, issue: entry.1),
        )
      }),
    )
    use _ <- result.try(case passed {
      False -> Ok(Nil)
      True -> {
        use first <- result.try(staff.first_active(read, c.row.org_id))
        notifications.notify(
          tx,
          to: audience.OrgUser,
          id: case first {
            Some(s) -> id.org_user_to_string(s.id)
            None -> ""
          },
          type_: "campaign",
          text: "🎬 "
            <> p.row.name
            <> " submitted an attempt to \""
            <> c.row.title
            <> "\" — human review needed.",
          ref_id: Some(id.campaign_submission_to_string(sid)),
          at: now,
        )
      }
    })
    use found <- result.try(submission_of(read, c.row.id, p.row.id))
    case found {
      Some(s) ->
        case list.find(s.attempts, fn(a) { a.row.id == aid }) {
          Ok(attempt) ->
            Ok(http.json(
              201,
              json.object([
                #("attempt", json.object(attempt_fields(attempt))),
                #("submission", submission_view(s)),
                #(
                  "note",
                  json.string(case passed {
                    True ->
                      "File checks passed. A coach still has to review the drill itself — that is a separate, human step."
                    False ->
                      "Automated file checks failed — fix the issues and resubmit."
                  }),
                ),
              ]),
            ))
          Error(Nil) -> store.stale("the new attempt")
        }
      None -> store.stale("the campaign submission")
    }
  })
  |> finished
}

// ------------------------------------------------------------------------------------------------- reviewing

/// `GET /org/campaigns/:id/review-queue`: the attempts waiting for a person, oldest submission first.
pub fn review_queue(ctx: Ctx, a: OrgAccess, cid: id.CampaignId) -> Response {
  let read =
    store.read(ctx.store, fn(r) {
      use c <- result.try(campaign_by_id(r, cid))
      case c {
        Some(c) if c.row.org_id == a.org.id -> {
          use subs <- result.map(
            submissions_where(r, "WHERE campaign_id = ? ORDER BY rowid", [
              id.campaign_sql(cid),
            ]),
          )
          Some(#(c, subs))
        }
        _ -> Ok(None)
      }
    })
  case read {
    Error(failure) -> http.internal(failure)
    Ok(None) -> http.error(404, "CAMPAIGN_NOT_FOUND")
    Ok(Some(#(c, subs))) -> {
      let queue =
        list.flat_map(subs, fn(s) {
          s.attempts
          |> list.filter(fn(x) { x.row.status == attempt_row.Submitted })
          |> list.map(fn(x) {
            json.object([
              #("submissionId", id.campaign_submission_json(s.row.id)),
              #("playerId", id.player_json(s.row.player_id)),
              #("playerName", json.nullable(s.row.player_name, json.string)),
              #(
                "attempt",
                json.object(
                  list.append(attempt_fields(x), [
                    #(
                      "mediaUrl",
                      json.nullable(x.row.media_id, fn(m) {
                        json.string("/media/" <> id.media_to_string(m))
                      }),
                    ),
                  ]),
                ),
              ),
            ])
          })
        })
      http.json(
        200,
        json.object([
          #(
            "campaign",
            json.object([
              #("id", id.campaign_json(c.row.id)),
              #("title", json.string(c.row.title)),
              #("rubric", rubric_json(c)),
            ]),
          ),
          #("queue", json.preprocessed_array(queue)),
        ]),
      )
    }
  }
}

type Review {
  Review(
    decision: attempt_row.Status,
    reasons: Option(String),
    rubric_notes: Option(String),
  )
}

/// `POST /org/campaign-attempts/:id/review`: a person reviews the football, once. A returned attempt says what to
/// fix, and frees its slot.
pub fn review(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  aid: id.CampaignAttemptId,
) -> Response {
  use req <- http.rerun_on_stale(req)
  case store.read(ctx.store, submission_by_attempt(_, aid)) {
    Error(failure) -> http.internal(failure)
    Ok(found) -> {
      let attempt = case found {
        Some(s) if s.row.org_id == a.org.id ->
          list.find(s.attempts, fn(x) { x.row.id == aid })
          |> result.map(fn(x) { #(s, x) })
          |> option.from_result
        _ -> None
      }
      case attempt {
        None -> http.error(404, "ATTEMPT_NOT_FOUND")
        Some(#(_, x)) if x.row.status != attempt_row.Submitted ->
          http.json(
            409,
            json.object([
              #("error", json.string("NOT_REVIEWABLE")),
              #("status", attempt_row.status_to_json(x.row.status)),
            ]),
          )
        Some(#(s, _)) -> decide(ctx, req, a, s, aid)
      }
    }
  }
}

fn decide(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  s: Submission,
  aid: id.CampaignAttemptId,
) -> Response {
  let shape = {
    use decision <- input.field(
      "decision",
      input.required(
        input.one_of_these(attempt_row.status_pairs, [
          attempt_row.Accepted,
          attempt_row.Returned,
        ]),
      ),
    )
    use reasons <- input.field(
      "reasons",
      input.nullish(input.text(reasons_max)),
    )
    use rubric_notes <- input.field(
      "rubricNotes",
      input.nullish(input.text(rubric_notes_max)),
    )
    input.done(Review(decision:, reasons:, rubric_notes:))
  }
  use b <- http.body(req, shape, [#("decision", "DECISION_INVALID")])
  case b.decision, input.filled(b.reasons) {
    attempt_row.Returned, None ->
      http.error_message(
        400,
        "REASONS_REQUIRED",
        "A returned attempt tells the player exactly what to fix and how to resubmit.",
      )
    _, _ -> {
      let reasons = or_none(b.reasons)
      use <- moderated(
        ctx,
        reasons,
        "campaign_review",
        s.row.player_id,
        a.org.id,
      )
      let now = clock.now_ms()
      store.unit(ctx.store, fn(tx) {
        let read = store.reading(tx)
        use changed <- result.try(store.write(
          tx,
          "UPDATE campaign_attempts SET status = ?, review_by_user_id = ?, review_by_name = ?, reviewed_at = ?, review_reasons = ?, review_rubric_notes = ? WHERE id = ? AND submission_id = ? AND status = 'submitted' RETURNING id",
          [
            sqlight.text(attempt_row.status_to_string(b.decision)),
            id.org_user_sql(a.user.id),
            sqlight.text(evidence.stored_name(a.user.name)),
            sqlight.int(now),
            sqlight.nullable(sqlight.text, reasons),
            sqlight.nullable(sqlight.text, or_none(b.rubric_notes)),
            id.campaign_attempt_sql(aid),
            id.campaign_submission_sql(s.row.id),
          ],
          decode.at([0], decode.string),
        ))
        use <- guard(changed != [], "an attempt waiting for review")
        use p <- result.try(players.by_id(read, s.row.player_id))
        use c <- result.try(campaign_by_id(read, s.row.campaign_id))
        // `undefined` when the campaign is gone, as the TypeScript server prints it.
        let title = case c {
          Some(c) -> c.row.title
          None -> "undefined"
        }
        let text = case b.decision {
          attempt_row.Accepted ->
            "✅ Your \""
            <> title
            <> "\" attempt was reviewed and accepted by "
            <> a.org.name
            <> "."
          _ ->
            "↩️ "
            <> a.org.name
            <> " returned your \""
            <> title
            <> "\" attempt: "
            <> option.unwrap(reasons, "null")
            <> " — you can resubmit."
        }
        let ref = Some(id.campaign_submission_to_string(s.row.id))
        use _ <- result.try(case p {
          None -> Ok(Nil)
          Some(p) -> {
            use _ <- result.try(
              case players.is_adult(p, now), p.row.guardian_id {
                False, Some(gid) ->
                  notifications.notify(
                    tx,
                    to: audience.Guardian,
                    id: id.guardian_to_string(gid),
                    type_: "campaign",
                    text: p.row.name <> ": " <> text,
                    ref_id: ref,
                    at: now,
                  )
                _, _ -> Ok(Nil)
              },
            )
            use _ <- result.try(notifications.notify(
              tx,
              to: audience.Player,
              id: id.player_to_string(p.row.id),
              type_: "campaign",
              text:,
              ref_id: ref,
              at: now,
            ))
            case b.decision {
              attempt_row.Accepted ->
                activity.record(tx, p.row.id, now) |> result.replace(Nil)
              _ -> Ok(Nil)
            }
          }
        })
        use fresh <- result.try(submission_by_attempt(read, aid))
        case
          option.to_result(fresh, Nil)
          |> result.try(fn(s) {
            list.find(s.attempts, fn(x) { x.row.id == aid })
          })
        {
          Ok(x) ->
            Ok(http.json(
              200,
              json.object([#("attempt", json.object(attempt_fields(x)))]),
            ))
          Error(Nil) -> store.stale("the reviewed attempt")
        }
      })
      |> finished
    }
  }
}
