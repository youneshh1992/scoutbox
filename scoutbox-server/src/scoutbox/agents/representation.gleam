//// Representation agreements as other domains read them (agentClientBasis and soleActiveAgentFor in
//// domains/agents/integration): whether an agent acts for a client right now, and who a player's one active agent
//// is. Two active agents is ambiguity and fails closed: ScoutBox does not pick a player's representative.

import gleam/dynamic/decode
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/agents/agent_rules
import scoutbox/passport/trust
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/agreement_scopes as scope_row
import scoutbox/rows/id
import scoutbox/rows/representation_agreements as agreement_row
import sqlight

/// An agreement with its ordered scope.
pub type Agreement {
  Agreement(row: agreement_row.Row, scope: List(scope_row.Scope))
}

fn with_scope(read: Read, r: agreement_row.Row) -> Result(Agreement, Fail(e)) {
  use scope <- result.map(store.query(
    read,
    "SELECT scope FROM agreement_scopes WHERE agreement_id = ? ORDER BY ord",
    [id.agreement_sql(r.id)],
    decode.at([0], scope_row.scope_decoder()),
  ))
  Agreement(r, scope)
}

fn select(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(List(Agreement), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT "
      <> agreement_row.columns
      <> " FROM representation_agreements WHERE "
      <> where
      <> " ORDER BY rowid",
    args,
    agreement_row.decoder(),
  ))
  list.try_map(rows, with_scope(read, _))
}

pub fn for_client(
  read: Read,
  client_id: String,
) -> Result(List(Agreement), Fail(e)) {
  select(read, "client_id = ?", [sqlight.text(client_id)])
}

pub fn by_id(
  read: Read,
  agreement_id: id.AgreementId,
) -> Result(Option(Agreement), Fail(e)) {
  use found <- result.map(
    select(read, "id = ?", [id.agreement_sql(agreement_id)]),
  )
  list.first(found) |> option.from_result
}

/// The status as of `now`: an active agreement past its end reads `expired`.
pub fn effective_status(a: agreement_row.Row, now: Int) -> String {
  case a.status, a.end_at {
    agreement_row.Active, Some(end) if end <= now -> "expired"
    status, _ -> agreement_row.status_to_string(status)
  }
}

/// Private client access, for the agent named on an agreement in force.
pub fn grants_access(
  a: agreement_row.Row,
  agent: id.OrgUserId,
  now: Int,
) -> Bool {
  trust.agreement_in_force(a, now) && a.agent_user_id == agent
}

/// Whether an agent acts for a client now, and on which agreement.
pub type Basis {
  Basis(
    ok: Bool,
    agreement: Option(Agreement),
    scope: List(String),
    agency_org_id: Option(id.OrgId),
    status: Option(String),
  )
}

pub fn basis(
  read: Read,
  agent: id.OrgUserId,
  client_id: String,
  now: Int,
) -> Result(Basis, Fail(e)) {
  use agreements <- result.map(for_client(read, client_id))
  let mine = list.filter(agreements, fn(a) { a.row.agent_user_id == agent })
  case list.find(mine, fn(a) { grants_access(a.row, agent, now) }) {
    Ok(a) ->
      Basis(
        True,
        Some(a),
        list.map(agent_rules.scope_of(a.scope), scope_row.scope_to_string),
        Some(a.row.agency_org_id),
        Some("active"),
      )
    Error(Nil) -> {
      // A dispute outranks an expiry, which outranks anything else.
      let rank = fn(st) {
        case st {
          "disputed" -> 3
          "expired" -> 2
          _ -> 1
        }
      }
      let fallback =
        list.fold(mine, None, fn(best, a) {
          let st = effective_status(a.row, now)
          case best {
            Some(b) ->
              case rank(b) >= rank(st) {
                True -> best
                False -> Some(st)
              }
            None -> Some(st)
          }
        })
      Basis(False, None, [], None, fallback)
    }
  }
}

/// The client's one active agent, and whether there was more than one.
pub fn sole_active(
  read: Read,
  client_id: String,
  now: Int,
) -> Result(#(Option(Agreement), Bool), Fail(e)) {
  use agreements <- result.map(for_client(read, client_id))
  case
    list.filter(agreements, fn(a) {
      grants_access(a.row, a.row.agent_user_id, now)
    })
  {
    [only] -> #(Some(only), False)
    [] -> #(None, False)
    _ -> #(None, True)
  }
}
