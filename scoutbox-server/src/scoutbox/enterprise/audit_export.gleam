//// The tenant audit export (domains/enterprise/enterprise.mjs `/audit/export`): an organisation's own records for
//// its auditors, for a lead only. The export is itself recorded.
////
//// Not ported yet: the access grants (groups), which keep no records on this server, so both lists are empty.

import gleam/json
import gleam/option.{Some}
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/enterprise/support
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/integrations/imports
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/store
import scoutbox/recruitment/case_workspace
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
      use import_histories <- result.try(imports.histories_json(
        store.reading(tx),
        org.org.id,
      ))
      use case_histories <- result.try(case_workspace.histories_json(
        store.reading(tx),
        org.org.id,
      ))
      use support_access <- result.try(support.grants_for_org_json(
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
        #("caseHistories", case_histories),
        #("importHistories", import_histories),
        #("grantsGiven", json.array([], json.string)),
        #("grantsReceived", json.array([], json.string)),
        #("supportAccess", support_access),
      ])
    })
  case exported {
    Ok(body) -> http.json(200, body)
    Error(failure) -> http.internal(failure)
  }
}
