//// Coach references (domains/verification/claims/referenceRoutes.mjs): a structured reference from a coach with a
//// currently verified role, carrying a snapshot of that verification as it stood. Later changes never rewrite the
//// snapshot; a correction is a new version and a withdrawal an event, so the original stays in the record. A
//// verified role widens no player visibility.

import gleam/bool
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/orgs
import scoutbox/identity/players
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/id
import scoutbox/rows/ver_claims as claim_row
import scoutbox/rows/ver_events as event_row
import scoutbox/rows/ver_references as row
import scoutbox/verification/claims
import scoutbox/verification/core.{act, reply, stop}
import scoutbox/verification/invite_routes
import scoutbox/verification/records
import scoutbox/vocab/audience
import scoutbox/vocab/claim_type
import scoutbox/vocab/verification_method
import sqlight
import wisp.{type Request, type Response}

pub type Reference =
  row.Row

fn where(
  read: Read,
  sql: String,
  args: List(sqlight.Value),
) -> Result(List(Reference), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> row.columns
      <> " FROM ver_references WHERE "
      <> sql
      <> " ORDER BY rowid",
    args,
    row.decoder(),
  )
}

pub fn record(r: Reference) -> Json {
  json.object([
    #("id", id.reference_json(r.id)),
    #("version", json.int(r.version)),
    #("supersedesId", json.nullable(r.supersedes_id, id.reference_json)),
    #("playerId", id.player_json(r.player_id)),
    #("playerName", json.nullable(r.player_name, json.string)),
    #("coachUserId", id.org_user_json(r.coach_user_id)),
    #("coachName", json.nullable(r.coach_name, json.string)),
    #("orgId", id.org_json(r.org_id)),
    #("orgName", json.nullable(r.org_name, json.string)),
    #("roleAtTime", json.nullable(r.role_at_time, json.string)),
    #(
      "provenanceSnapshot",
      json.object([
        #("claimId", id.claim_json(r.provenance_claim_id)),
        #("claimType", claim_type.to_json(r.provenance_claim_type)),
        #("status", row.provenance_status_to_json(r.provenance_status)),
        #(
          "method",
          json.nullable(r.provenance_method, verification_method.to_json),
        ),
        #("verifiedAt", json.nullable(r.provenance_verified_at, json.int)),
        #("snapshotAt", json.int(r.provenance_snapshot_at)),
      ]),
    ),
    #("relationship", json.string(r.relationship)),
    #("capacity", json.string(r.capacity)),
    #("fromYear", json.nullable(r.from_year, json.int)),
    #("toYear", json.nullable(r.to_year, json.int)),
    #("structured", structured(r)),
    #("status", row.status_to_json(r.status)),
    #("withdrawnAt", json.nullable(r.withdrawn_at, json.int)),
    #("withdrawReason", json.nullable(r.withdraw_reason, json.string)),
    #("createdAt", json.int(r.created_at)),
  ])
}

fn structured(r: Reference) -> Json {
  json.object([
    #("strengths", json.string(r.strengths)),
    #("development", json.string(r.development)),
    #("summary", json.string(r.summary)),
  ])
}

type NewReference {
  NewReference(
    player_id: id.PlayerId,
    relationship: Option(String),
    capacity: Option(String),
    from_year: Option(Int),
    to_year: Option(Int),
    strengths: Option(String),
    development: Option(String),
    summary: Option(String),
  )
}

/// `POST /org/verification/references`.
pub fn create(ctx: Ctx, req: Request, access: OrgAccess) -> Response {
  let year = input.nullish(input.whole_number(1900, 2100))
  let shape = {
    use player_id <- input.field("playerId", input.required(input.id()))
    use relationship <- input.field(
      "relationship",
      input.nullish(input.text(80)),
    )
    use capacity <- input.field("capacity", input.nullish(input.text(120)))
    use from_year <- input.field("fromYear", year)
    use to_year <- input.field("toYear", year)
    use strengths <- input.field("strengths", input.nullish(input.text(500)))
    use development <- input.field(
      "development",
      input.nullish(input.text(500)),
    )
    use summary <- input.field("summary", input.nullish(input.text(800)))
    input.done(NewReference(
      // From the request body.
      player_id: id.player(player_id),
      relationship:,
      capacity:,
      from_year:,
      to_year:,
      strengths:,
      development:,
      summary:,
    ))
  }
  let parsed = http.parse_body(req, shape, [])
  let now = clock.now_ms()
  use tx <- act(ctx)
  let read = store.reading(tx)
  use theirs <- result.try(records.claims_for(
    read,
    claim_row.User,
    id.org_user_to_string(access.user.id),
  ))
  let role_claim =
    list.find(theirs, fn(c) {
      let t = claim_type.to_string(c.claim_type)
      c.organisation_id == Some(access.org.id)
      && { string.contains(t, "ROLE") || string.contains(t, "AFFILIATION") }
      && claims.effective_status(
        c,
        org: Some(access.org),
        subject_removed: False,
        now:,
      ).current
    })
  case role_claim, parsed {
    Error(Nil), _ ->
      stop(http.error_message(
        403,
        "VERIFIED_ROLE_REQUIRED",
        "Structured references need a currently verified role at this organisation.",
      ))
    _, Error(response) -> stop(response)
    Ok(role_claim), Ok(body) -> {
      use found <- result.try(players.by_id(read, body.player_id))
      case found {
        None -> stop(http.error(404, "PLAYER_NOT_FOUND"))
        Some(p) -> {
          use reachable <- result.try(invite_routes.reachable(
            read,
            access.org,
            p.row.id,
            now,
          ))
          use <- bool.lazy_guard(!reachable, fn() {
            stop(http.error_message(
              403,
              "UNDER_18_WALL",
              "A verified role does not widen player visibility — the standing consent and safeguarding rules decide who you can reference.",
            ))
          })
          let relationship = input.filled(body.relationship)
          let summary = input.filled(body.summary)
          case relationship, summary {
            Some(relationship), Some(summary) -> {
              use id <- result.try(id.next_reference(tx))
              let r =
                row.Row(
                  id:,
                  version: 1,
                  supersedes_id: None,
                  player_id: p.row.id,
                  player_name: Some(input.utf16_take(p.row.name, 200)),
                  coach_user_id: access.user.id,
                  coach_name: Some(input.utf16_take(access.user.name, 200)),
                  org_id: access.org.id,
                  org_name: Some(input.utf16_take(access.org.name, 200)),
                  role_at_time: option.or(
                    role_claim.role,
                    Some(input.utf16_take(access.user.role, 200)),
                  ),
                  // A snapshot at submission: later changes never rewrite it.
                  provenance_claim_id: role_claim.id,
                  provenance_claim_type: role_claim.claim_type,
                  provenance_status: row.Verified,
                  provenance_method: role_claim.verification_method,
                  provenance_verified_at: role_claim.verified_at,
                  provenance_snapshot_at: now,
                  relationship:,
                  capacity: option.unwrap(body.capacity, ""),
                  from_year: body.from_year,
                  to_year: body.to_year,
                  strengths: option.unwrap(body.strengths, ""),
                  development: option.unwrap(body.development, ""),
                  summary:,
                  status: row.Active,
                  withdrawn_at: None,
                  withdraw_reason: None,
                  created_at: now,
                )
              use _ <- result.try(store.run(tx, row.insert_sql, row.values(r)))
              use _ <- result.try(core.event(
                tx,
                event_row.ClaimCreated,
                core.staff_actor(access, req),
                core.About(
                  ..core.nothing,
                  org_id: Some(access.org.id),
                  subject_id: Some(id.player_to_string(p.row.id)),
                  detail: records.detail([], [
                    #("reference", Some(id.reference_to_string(id))),
                    #("provenance", Some(id.claim_to_string(role_claim.id))),
                  ]),
                ),
                now,
              ))
              use _ <- result.try(
                case players.is_adult(p, now), p.row.guardian_id {
                  True, _ ->
                    notifications.notify(
                      tx,
                      to: audience.Player,
                      id: id.player_to_string(p.row.id),
                      type_: "verification",
                      text: access.user.name
                        <> " ("
                        <> access.org.name
                        <> ") added a structured reference to your profile.",
                      ref_id: Some(id.reference_to_string(id)),
                      at: now,
                    )
                  False, Some(guardian_id) ->
                    notifications.notify(
                      tx,
                      to: audience.Guardian,
                      id: id.guardian_to_string(guardian_id),
                      type_: "verification",
                      text: access.user.name
                        <> " (verified at "
                        <> access.org.name
                        <> ") added a structured reference for "
                        <> p.row.name
                        <> ". You can review it in the app.",
                      ref_id: Some(id.reference_to_string(id)),
                      at: now,
                    )
                  False, None -> Ok(Nil)
                },
              )
              reply(http.json(201, json.object([#("reference", record(r))])))
            }
            _, _ -> {
              let missing =
                list.flatten([
                  case relationship {
                    None -> ["relationship"]
                    Some(_) -> []
                  },
                  case summary {
                    None -> ["summary"]
                    Some(_) -> []
                  },
                ])
              stop(http.json(
                400,
                json.object([
                  #("error", json.string("FIELDS_REQUIRED")),
                  #("missing", json.array(missing, json.string)),
                  #("problem", json.string("required")),
                  #(
                    "message",
                    json.string("relationship and summary are required."),
                  ),
                ]),
              ))
            }
          }
        }
      }
    }
  }
}

/// `GET /org/verification/references`.
pub fn list_for_org(ctx: Ctx, access: OrgAccess) -> Response {
  use read <- core.look(ctx)
  use items <- result.map(
    where(read, "org_id = ?", [id.org_sql(access.org.id)]),
  )
  http.json(200, json.object([#("items", json.array(items, record))]))
}

fn own(
  read: Read,
  access: OrgAccess,
  reference_id: id.ReferenceId,
) -> Result(Option(Reference), Fail(e)) {
  use found <- result.map(
    where(read, "id = ?", [id.reference_sql(reference_id)]),
  )
  case found {
    [r] if r.org_id == access.org.id && r.coach_user_id == access.user.id ->
      Some(r)
    _ -> None
  }
}

/// `POST /org/verification/references/:id/withdraw`: an event; the original text and provenance stay.
pub fn withdraw(
  ctx: Ctx,
  req: Request,
  access: OrgAccess,
  reference_id: id.ReferenceId,
) -> Response {
  let shape = {
    use reason <- input.field("reason", input.nullish(input.text(300)))
    input.done(reason)
  }
  let parsed = http.parse_body(req, shape, [])
  let now = clock.now_ms()
  use tx <- act(ctx)
  use found <- result.try(own(store.reading(tx), access, reference_id))
  case found, parsed {
    None, _ -> stop(http.error(404, "REFERENCE_NOT_FOUND"))
    Some(r), _ if r.status != row.Active -> stop(http.error(409, "NOT_ACTIVE"))
    _, Error(response) -> stop(response)
    Some(r), Ok(reason) ->
      case input.filled(reason) {
        None -> stop(http.required("REASON_REQUIRED", "reason"))
        Some(reason) -> {
          let next =
            row.Row(
              ..r,
              status: row.Withdrawn,
              withdrawn_at: Some(now),
              withdraw_reason: Some(reason),
            )
          use _ <- result.try(
            store.run(
              tx,
              "UPDATE ver_references SET status = 'withdrawn', withdrawn_at = ?, withdraw_reason = ? WHERE id = ? AND status = 'active'",
              [sqlight.int(now), sqlight.text(reason), id.reference_sql(r.id)],
            ),
          )
          use _ <- result.try(core.event(
            tx,
            event_row.ClaimCorrected,
            core.staff_actor(access, req),
            core.About(
              ..core.nothing,
              org_id: Some(access.org.id),
              subject_id: Some(id.player_to_string(r.player_id)),
              detail: records.detail(
                [
                  #("reference", Some(id.reference_to_string(r.id))),
                  #("status", Some("active")),
                ],
                [#("status", Some("withdrawn"))],
              ),
              reason: Some(reason),
            ),
            now,
          ))
          reply(http.json(
            200,
            json.object([
              #("reference", record(next)),
              #(
                "note",
                json.string(
                  "Withdrawal is an event — the original text and its provenance remain in the record.",
                ),
              ),
            ]),
          ))
        }
      }
  }
}

/// `POST /org/verification/references/:id/correct`: a new version; the original is never silently edited.
pub fn correct(
  ctx: Ctx,
  req: Request,
  access: OrgAccess,
  reference_id: id.ReferenceId,
) -> Response {
  let shape = {
    use strengths <- input.field("strengths", input.nullish(input.text(500)))
    use development <- input.field(
      "development",
      input.nullish(input.text(500)),
    )
    use summary <- input.field("summary", input.nullish(input.text(800)))
    input.done(#(strengths, development, summary))
  }
  let parsed = http.parse_body(req, shape, [])
  let now = clock.now_ms()
  use tx <- act(ctx)
  use found <- result.try(own(store.reading(tx), access, reference_id))
  case found, parsed {
    None, _ -> stop(http.error(404, "REFERENCE_NOT_FOUND"))
    Some(old), _ if old.status != row.Active ->
      stop(http.error(409, "NOT_ACTIVE"))
    _, Error(response) -> stop(response)
    Some(old), Ok(#(strengths, development, summary)) ->
      case summary, input.filled(summary) {
        Some(_), None ->
          stop(http.json(
            400,
            json.object([
              #("error", json.string("FIELDS_REQUIRED")),
              #("missing", json.array(["summary"], json.string)),
              #("problem", json.string("required")),
              #("message", json.string("A reference keeps its summary.")),
            ]),
          ))
        _, kept -> {
          use _ <- result.try(
            store.run(
              tx,
              "UPDATE ver_references SET status = 'superseded' WHERE id = ? AND status = 'active'",
              [id.reference_sql(old.id)],
            ),
          )
          use next_id <- result.try(id.next_reference(tx))
          let next =
            row.Row(
              ..old,
              id: next_id,
              version: old.version + 1,
              supersedes_id: Some(old.id),
              strengths: option.unwrap(strengths, old.strengths),
              development: option.unwrap(development, old.development),
              summary: option.unwrap(kept, old.summary),
              created_at: now,
            )
          use _ <- result.try(store.run(tx, row.insert_sql, row.values(next)))
          use _ <- result.try(core.event(
            tx,
            event_row.ClaimCorrected,
            core.staff_actor(access, req),
            core.About(
              ..core.nothing,
              org_id: Some(access.org.id),
              subject_id: Some(id.player_to_string(old.player_id)),
              detail: records.detail(
                [#("reference", Some(id.reference_to_string(old.id)))],
                [
                  #("reference", Some(id.reference_to_string(next_id))),
                  #("version", Some(string.inspect(next.version))),
                ],
              ),
            ),
            now,
          ))
          reply(http.json(
            200,
            json.object([
              #("reference", record(next)),
              #("superseded", id.reference_json(old.id)),
              #(
                "note",
                json.string(
                  "Corrections create a new version — the original is never silently edited.",
                ),
              ),
            ]),
          ))
        }
      }
  }
}

fn player_view(read: Read, r: Reference, now: Int) -> Result(Json, Fail(e)) {
  use claim <- result.try(records.claim(read, r.provenance_claim_id))
  use org <- result.map(orgs.by_id(read, r.org_id))
  let current = case claim {
    Some(c) ->
      claims.effective_status(c, org:, subject_removed: False, now:).current
    None -> False
  }
  json.object([
    #("id", id.reference_json(r.id)),
    #("version", json.int(r.version)),
    #("coachName", json.nullable(r.coach_name, json.string)),
    #("orgName", json.nullable(r.org_name, json.string)),
    #("roleAtTime", json.nullable(r.role_at_time, json.string)),
    #("relationship", json.string(r.relationship)),
    #("capacity", json.string(r.capacity)),
    #("fromYear", json.nullable(r.from_year, json.int)),
    #("toYear", json.nullable(r.to_year, json.int)),
    #("structured", structured(r)),
    #("status", row.status_to_json(r.status)),
    #("createdAt", json.int(r.created_at)),
    #(
      "provenance",
      json.string(case current {
        True ->
          "Coach's "
          <> option.unwrap(r.org_name, "null")
          <> " affiliation is verified."
        False ->
          "Coach affiliation was verified when this reference was submitted."
      }),
    ),
  ])
}

fn for_player(ctx: Ctx, player_id: id.PlayerId) -> Response {
  let now = clock.now_ms()
  use read <- core.look(ctx)
  use refs <- result.try(
    where(read, "player_id = ? AND status <> 'superseded'", [
      id.player_sql(player_id),
    ]),
  )
  use items <- result.map(list.try_map(refs, player_view(read, _, now)))
  http.json(200, json.object([#("items", json.preprocessed_array(items))]))
}

/// `GET /player/references`.
pub fn mine(ctx: Ctx, p: access.PlayerAccess) -> Response {
  for_player(ctx, p.player.row.id)
}

/// `GET /guardian/children/:id/references`.
pub fn child(ctx: Ctx, g: Guardian, child_id: id.PlayerId) -> Response {
  case list.contains(g.child_ids, child_id) {
    True -> for_player(ctx, child_id)
    False -> http.error(404, "CHILD_NOT_FOUND")
  }
}
