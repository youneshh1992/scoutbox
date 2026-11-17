//// `GET /org/audit` (domains/platform/audit.mjs): the organisation audit feed, for leads only, a read-only merge of
//// other domains' histories. Entries say what happened and who did it, never content. Reason codes are the
//// organisation's own structured vocabulary, so they are shown; the free text beside them is not.
////
//// Not ported yet: the recruitment brief, dynamic watchlist and development plan sources, whose domains are not
//// ported. Every source here is read whole, not paged in SQL.

import gleam/bit_array
import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import gleam/string
import scoutbox/agents/agent_audit
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/orgs.{type Org}
import scoutbox/identity/players
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/json_text
import scoutbox/platform/paging
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/case_history as history_row
import scoutbox/rows/contact_history as contact_history_row
import scoutbox/rows/id
import scoutbox/rows/ledger as ledger_row
import scoutbox/rows/trial_history as trial_history_row
import scoutbox/vocab/org_type
import scoutbox/vocab/trial_actor_kind
import wisp.{type Request, type Response}

/// Room activity worth an administrator's attention. Chatter is not.
const room_actions = [
  "room_created", "room_status_changed", "room_reopened",
  "room_decision_recorded", "room_decision_drafted",
  "room_decision_draft_discarded", "room_decision_finalized",
  "room_decision_superseded", "room_owner_changed", "room_member_assigned",
  "room_priority_changed", "room_evidence_requested", "room_assessment_assigned",
]

/// An allowlist of structured, content-free detail keys, in the order they are copied.
const safe_keys = [
  "from", "to", "status", "priority", "recommendation", "version",
  "criteriaChanged", "sourceContext", "kind", "channel", "recipientType", "code",
  "sessionId", "trialSessionId", "state", "source", "revision", "sessionCount",
  "material", "requiresConfirmation", "phase", "cancelledBy", "attendedSessions",
  "slotId", "day", "hadReason", "outcome", "decisionId", "supersedes", "draftId",
]

fn safe_detail(detail_json: Option(String)) -> Json {
  let entries =
    option.to_result(detail_json, Nil)
    |> result.try(json_text.entries)
    |> result.unwrap([])
  let find = fn(k) { list.find(entries, fn(e) { e.0 == k }) }
  let kept =
    list.filter_map(safe_keys, fn(k) {
      find(k) |> result.map(fn(e) { #(k, e.1) })
    })
  let reasons = case find("reasonCodes") {
    Ok(#(_, _, raw)) ->
      case json.parse(raw, decode.list(decode.string)) {
        Ok(codes) -> [
          #("reasonCodes", json.array(list.take(codes, 10), json.string)),
        ]
        Error(_) -> []
      }
    Error(Nil) -> []
  }
  let note = case find("note") {
    Ok(#(_, _, "true")) -> [#("hadNote", json.bool(True))]
    Ok(#(_, _, "false")) -> [#("hadNote", json.bool(False))]
    _ -> []
  }
  case list.flatten([kept, reasons, note]) {
    [] -> json.null()
    fields -> json.object(fields)
  }
}

fn subject(
  read: Read,
  org: Org,
  player_id: id.PlayerId,
  now: Int,
) -> Result(List(#(String, Json)), Fail(e)) {
  use found <- result.map(players.for_org(read, player_id, org, now))
  case found {
    Some(#(p, access)) if access.visible && !access.blocked -> [
      #("playerId", id.player_json(p.row.id)),
      #("playerName", json.string(p.row.name)),
    ]
    _ -> [#("playerId", json.null()), #("playerName", json.null())]
  }
}

fn room_rows(
  read: Read,
  org: Org,
  now: Int,
) -> Result(List(agent_audit.Row), Fail(e)) {
  use rows <- result.try(
    store.query(
      read,
      "SELECT "
        <> history_row.qualified("h")
        <> ", c.player_id FROM case_history h JOIN recruitment_cases c ON c.id = h.case_id
       WHERE c.org_id = ? AND c.room_status IS NOT NULL ORDER BY h.at DESC, h.id DESC",
      [id.org_sql(org.id)],
      {
        use h <- decode.then(history_row.decoder())
        use player <- decode.field(history_row.width, id.player_decoder())
        decode.success(#(h, player))
      },
    ),
  )
  rows
  |> list.filter(fn(r) { list.contains(room_actions, { r.0 }.action) })
  |> list.try_map(fn(r) {
    let #(h, player) = r
    use who <- result.map(subject(read, org, player, now))
    agent_audit.Row(id.case_event_to_string(h.id), h.at, [
      #("id", id.case_event_json(h.id)),
      #("at", json.int(h.at)),
      #("action", json.string(h.action)),
      #("domain", json.string("recruitment_room")),
      #("actor", case h.by_kind {
        Some(history_row.Org) ->
          json.object([
            #("userId", json.nullable(h.by_id, json.string)),
            #("name", json.nullable(h.by_name, json.string)),
          ])
        _ -> json.null()
      }),
      #(
        "target",
        json.object([
          #("type", json.string("room")),
          #("id", id.recruitment_case_json(h.case_id)),
          ..who
        ]),
      ),
      #("detail", safe_detail(h.detail_json)),
    ])
  })
}

/// A trial's operational acts. Unlinking evidence is included; reads are not.
const trial_actions = [
  "trial_accepted", "trial_schedule_proposed", "trial_rescheduled",
  "trial_schedule_confirmed", "trial_schedule_declined",
  "trial_attendance_recorded", "trial_cancelled", "trial_completed",
  "trial_evidence_linked", "trial_evidence_unlinked",
]

fn trial_rows(
  read: Read,
  org: Org,
  now: Int,
) -> Result(List(agent_audit.Row), Fail(e)) {
  use rows <- result.try(
    store.query(
      read,
      "SELECT "
        <> trial_history_row.qualified("h")
        <> ", t.case_id, t.player_id FROM trial_history h JOIN trials t ON t.id = h.trial_id
       WHERE t.org_id = ? ORDER BY h.at DESC, h.id DESC",
      [id.org_sql(org.id)],
      {
        use h <- decode.then(trial_history_row.decoder())
        use case_id <- decode.field(
          trial_history_row.width,
          decode.optional(id.recruitment_case_decoder()),
        )
        use player <- decode.field(
          trial_history_row.width + 1,
          id.player_decoder(),
        )
        decode.success(#(h, case_id, player))
      },
    ),
  )
  rows
  |> list.filter(fn(r) { list.contains(trial_actions, { r.0 }.action) })
  |> list.try_map(fn(r) {
    let #(h, case_id, player) = r
    use who <- result.map(subject(read, org, player, now))
    agent_audit.Row(id.trial_event_to_string(h.id), h.at, [
      #("id", id.trial_event_json(h.id)),
      #("at", json.int(h.at)),
      #("action", json.string(h.action)),
      #("domain", json.string("recruitment_trial")),
      #("actor", case h.by_kind {
        Some(trial_actor_kind.Org) ->
          json.object([
            #("userId", json.nullable(h.by_user_id, json.string)),
            #("name", json.nullable(h.by_name, json.string)),
          ])
        _ -> json.null()
      }),
      #(
        "target",
        json.object([
          #("type", json.string("trial")),
          #("id", id.trial_json(h.trial_id)),
          #("roomId", json.nullable(case_id, id.recruitment_case_json)),
          ..who
        ]),
      ),
      #("detail", safe_detail(h.detail_json)),
    ])
  })
}

/// A contact's communications. A draft and its edits are not acts on anyone, so they are not shown.
const contact_actions = [
  "contact_sent", "contact_send_failed", "contact_external_recorded",
  "contact_responded", "contact_cancelled",
]

fn contact_rows(
  read: Read,
  org: Org,
  now: Int,
) -> Result(List(agent_audit.Row), Fail(e)) {
  use rows <- result.try(
    store.query(
      read,
      "SELECT "
        <> contact_history_row.qualified("h")
        <> ", c.case_id, c.player_id FROM contact_history h JOIN recruitment_contacts c ON c.id = h.contact_id
       WHERE c.org_id = ? ORDER BY h.at DESC, h.id DESC",
      [id.org_sql(org.id)],
      {
        use h <- decode.then(contact_history_row.decoder())
        use case_id <- decode.field(
          contact_history_row.width,
          id.recruitment_case_decoder(),
        )
        use player <- decode.field(
          contact_history_row.width + 1,
          id.player_decoder(),
        )
        decode.success(#(h, case_id, player))
      },
    ),
  )
  rows
  |> list.filter(fn(r) { list.contains(contact_actions, { r.0 }.action) })
  |> list.try_map(fn(r) {
    let #(h, case_id, player) = r
    use who <- result.map(subject(read, org, player, now))
    agent_audit.Row(id.contact_event_to_string(h.id), h.at, [
      #("id", id.contact_event_json(h.id)),
      #("at", json.int(h.at)),
      #("action", json.string(h.action)),
      #("domain", json.string("recruitment_contact")),
      #("actor", case h.by_kind {
        Some(contact_history_row.Org) ->
          json.object([
            #("userId", json.nullable(h.by_user_id, id.org_user_json)),
            #("name", json.nullable(h.by_name, json.string)),
          ])
        _ -> json.null()
      }),
      #(
        "target",
        json.object([
          #("type", json.string("contact")),
          #("id", id.contact_json(h.contact_id)),
          #("roomId", id.recruitment_case_json(case_id)),
          ..who
        ]),
      ),
      #("detail", safe_detail(h.detail_json)),
    ])
  })
}

fn ledger_rows(read: Read, org: Org) -> Result(List(agent_audit.Row), Fail(e)) {
  use rows <- result.map(store.query(
    read,
    "SELECT "
      <> ledger_row.columns
      <> " FROM ledger WHERE org_id = ? AND type IN ('staff_removed', 'signing', 'released_by_club') ORDER BY seq",
    [id.org_sql(org.id)],
    ledger_row.decoder(),
  ))
  list.map(rows, fn(l) {
    agent_audit.Row(id.ledger_entry_to_string(l.id), l.occurred_at, [
      #("id", id.ledger_entry_json(l.id)),
      #("at", json.int(l.occurred_at)),
      #("action", ledger_row.type_to_json(l.type_)),
      #("domain", json.string("organisation")),
      #("actor", case l.user_id {
        Some(u) ->
          json.object([
            #("userId", id.org_user_json(u)),
            #("name", json.nullable(l.actor_name, json.string)),
          ])
        None -> json.null()
      }),
      #("target", case l.player_id {
        Some(p) ->
          json.object([
            #("type", json.string("player")),
            #("id", id.player_json(p)),
          ])
        None ->
          json.object([
            #("type", json.string("organisation")),
            #("id", id.org_json(org.id)),
          ])
      }),
      #("detail", json.null()),
    ])
  })
}

type Query {
  Query(limit: Option(Int), cursor: Option(String))
}

fn query_shape() -> input.Shape(Query) {
  use limit <- input.field(
    "limit",
    input.optional(input.whole_number_text(1, 50)),
  )
  use cursor <- input.field("cursor", input.optional(input.text(512)))
  input.done(Query(limit:, cursor:))
}

fn read_cursor(raw: String) -> Result(#(Int, String), Nil) {
  use <- bool_guard(string.length(raw) <= 512)
  use bits <- result.try(bit_array.base64_url_decode(raw))
  use text <- result.try(bit_array.to_string(bits))
  json.parse(text, {
    use at <- decode.field(0, decode.int)
    use id <- decode.field(1, decode.string)
    decode.success(#(at, id))
  })
  |> result.replace_error(Nil)
}

fn bool_guard(ok: Bool, next: fn() -> Result(a, Nil)) -> Result(a, Nil) {
  case ok {
    True -> next()
    False -> Error(Nil)
  }
}

fn newest_first(a: agent_audit.Row, b: agent_audit.Row) -> order.Order {
  case int.compare(b.at, a.at) {
    order.Eq -> string.compare(b.id, a.id)
    o -> o
  }
}

fn invalid() -> Response {
  http.error_message(
    400,
    "AUDIT_CURSOR_INVALID",
    "That page no longer exists — start again from the first page.",
  )
}

pub fn feed(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use <- access.require_lead(a)
  use q <- http.query(req, query_shape(), [#("limit", "PAGE_LIMIT_INVALID")])
  let limit = option.unwrap(q.limit, 25)
  let after = case q.cursor {
    None | Some("") -> Ok(None)
    Some(raw) -> read_cursor(raw) |> result.map(Some)
  }
  case after {
    Error(Nil) -> invalid()
    Ok(after) -> {
      let now = clock.now_ms()
      case
        store.read(ctx.store, fn(r) {
          use rooms <- result.try(room_rows(r, a.org, now))
          use trials <- result.try(trial_rows(r, a.org, now))
          use contacts <- result.try(contact_rows(r, a.org, now))
          use ledger <- result.try(ledger_rows(r, a.org))
          use agency <- result.map(case a.org.type_ {
            org_type.Agency -> agent_audit.rows(r, a.org, now)
            _ -> Ok([])
          })
          list.flatten([rooms, contacts, trials, agency, ledger])
        })
      {
        Error(failure) -> http.internal(failure)
        Ok(pool) -> {
          let known = case after {
            Some(#(at, id)) ->
              list.any(pool, fn(r) { r.at == at && r.id == id })
            None -> True
          }
          case known {
            False -> invalid()
            True -> {
              let rest =
                pool
                |> list.filter(fn(r) {
                  case after {
                    Some(#(at, id)) ->
                      newest_first(r, agent_audit.Row(id, at, [])) == order.Gt
                    None -> True
                  }
                })
                |> list.sort(newest_first)
              let page = list.take(rest, limit)
              http.json(
                200,
                json.object([
                  #("items", json.array(page, agent_audit.view)),
                  #(
                    "nextCursor",
                    case list.length(rest) > limit, list.last(page) {
                      True, Ok(last) ->
                        json.string(
                          paging.encode_cursor([
                            paging.IntKey(last.at),
                            paging.TextKey(last.id),
                          ]),
                        )
                      _, _ -> json.null()
                    },
                  ),
                  #("total", json.int(list.length(pool))),
                  #(
                    "note",
                    json.string(
                      "Operational history only: what happened and who did it. Notes, comments, decision text and assessments are never shown here.",
                    ),
                  ),
                ]),
              )
            }
          }
        }
      }
    }
  }
}
