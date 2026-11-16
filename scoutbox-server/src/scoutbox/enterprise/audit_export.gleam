//// The tenant audit export (domains/enterprise/enterprise.mjs `/audit/export`): an organisation's own records for
//// its auditors, for a lead only. The export is itself recorded.
////
//// Not ported yet: the case histories (recruitment), import histories (integrations), access grants (groups) and
//// support access (enterprise). Those domains keep no records on this server, so each is empty.

import gleam/json
import gleam/option.{Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/store
import scoutbox/rows/id
import scoutbox/rows/ops_events as ops_row
import scoutbox/safety/ledger
import wisp.{type Response}

/// `GET /org/audit/export`.
pub fn export(ctx: Ctx, org: OrgAccess) -> Response {
  use <- access.require_lead(org)
  let now = clock.now_ms()
  let exported =
    store.unit(ctx.store, fn(tx) {
      use entries <- result.try(ledger.all_for_org(
        store.reading(tx),
        org.org.id,
      ))
      use id <- result.try(id.next_ops_event(tx))
      use _ <- result.map(ops_row.insert(
        tx,
        ops_row.New(
          ..ops_row.new(id:, occurred_at: now, kind: ops_row.AuditExport),
          detail_org_id: Some(org.org.id),
          detail_by: Some(org.user.name),
        ),
      ))
      json.object([
        #("contract", json.string("audit-export.2026-09.v1")),
        #("orgId", id.org_json(org.org.id)),
        #("exportedAt", json.int(now)),
        #("exportedBy", json.string(org.user.name)),
        #("ledger", json.array(entries, ledger.view)),
        #("caseHistories", json.array([], json.string)),
        #("importHistories", json.array([], json.string)),
        #("grantsGiven", json.array([], json.string)),
        #("grantsReceived", json.array([], json.string)),
        #("supportAccess", json.array([], json.string)),
      ])
    })
  case exported {
    Ok(body) -> http.json(200, body)
    Error(failure) -> http.internal(failure)
  }
}
