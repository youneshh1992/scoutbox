//// The Trust & Safety lane of the transaction workspaces (domains/agents/transactions/tsRoutes.mjs and audit.mjs):
//// read-only, states, ids and party roles. A reviewer checks the platform's rules were applied, not the parties'
//// papers.

import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import gleam/string
import scoutbox/agents/transaction_routes as shared
import scoutbox/agents/transaction_store.{type Transaction}
import scoutbox/app.{type Ctx}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/agent_transactions as tx_row
import scoutbox/rows/id
import scoutbox/rows/transaction_document_history as doc_event_row
import scoutbox/rows/transaction_documents as doc_row
import scoutbox/rows/transaction_history as event_row
import scoutbox/rows/transaction_representation_history as rep_event_row
import scoutbox/rows/ts_reviewers as reviewer_row
import scoutbox/vocab/compliance_actor_kind.{type ComplianceActorKind}
import scoutbox/vocab/context_outcome
import scoutbox/vocab/context_type
import scoutbox/vocab/declared_representation_status
import scoutbox/vocab/document_visibility
import scoutbox/vocab/party_role
import scoutbox/vocab/pending_reason
import scoutbox/vocab/staleness
import scoutbox/vocab/subject_kind
import scoutbox/vocab/transaction_status
import wisp.{type Request, type Response}

fn reviews_for_context(
  read: Read,
  context_id: id.ComplianceContextId,
) -> Result(List(Json), Fail(e)) {
  store.query(
    read,
    "SELECT id, kind, status, requested_at, decided_at, decision_outcome FROM regulatory_reviews WHERE subject_context_id = ? ORDER BY rowid",
    [id.compliance_context_sql(context_id)],
    {
      use rid <- decode.field(0, decode.string)
      use kind <- decode.field(1, decode.string)
      use status <- decode.field(2, decode.string)
      use requested <- decode.field(3, decode.int)
      use decided <- decode.field(4, decode.optional(decode.int))
      use outcome <- decode.field(5, decode.optional(decode.string))
      decode.success(
        json.object([
          #("id", json.string(rid)),
          #("kind", json.string(kind)),
          #("status", json.string(status)),
          #("requestedAt", json.int(requested)),
          #("decidedAt", json.nullable(decided, json.int)),
          #("outcome", json.nullable(outcome, json.string)),
        ]),
      )
    },
  )
}

/// States, ids and party roles only.
fn ts_view(read: Read, t: Transaction, now: Int) -> Result(Json, Fail(e)) {
  let r = t.row
  use reps <- result.try(transaction_store.representations(read, r.id))
  use docs <- result.try(transaction_store.documents(read, r.id))
  use view <- result.try(shared.compliance_of(read, t))
  use stale <- result.try(shared.staleness_of(read, t, view, now))
  use reviews <- result.map(reviews_for_context(read, r.context_id))
  json.object([
    #("id", id.transaction_json(r.id)),
    #("type", context_type.to_json(r.type_)),
    #("status", transaction_status.to_json(r.status)),
    #("jurisdictions", json.array(t.jurisdictions, json.string)),
    #("agencyOrgId", id.org_json(r.agency_org_id)),
    #("agentUserId", id.org_user_json(r.agent_user_id)),
    #(
      "parties",
      json.array(t.parties, fn(p) {
        json.object([
          #("partyRole", party_role.to_json(p.party_role)),
          #("subjectKind", subject_kind.to_json(p.subject_kind)),
          #("removed", json.bool(p.removed)),
          #("confirmed", json.bool(p.confirmed_at != None)),
        ])
      }),
    ),
    #(
      "representations",
      json.array(reps, fn(x) {
        json.object([
          #("partyRole", party_role.to_json(x.row.party_role)),
          #("status", declared_representation_status.to_json(x.row.status)),
          #("declaredOnly", json.bool(x.row.declared_only)),
          #(
            "reviewId",
            json.nullable(x.row.review_id, id.regulatory_review_json),
          ),
        ])
      }),
    ),
    #("compliance", case view {
      Some(v) -> {
        let s = v.state
        json.object([
          #("outcome", json.nullable(s.outcome, context_outcome.to_json)),
          #(
            "pendingReason",
            json.nullable(s.pending_reason, pending_reason.to_json),
          ),
          #("blocked", json.bool(s.blocked)),
          #("clear", json.bool(s.clear)),
          #("reasonCodes", json.array(s.reason_codes, json.string)),
          #("policyVersions", json.array(v.policy_versions, id.policy_json)),
          #("evaluatedAt", json.int(v.evaluated_at)),
          #("stale", json.nullable(stale, staleness.to_json)),
        ])
      }
      None -> json.null()
    }),
    #("reviews", json.preprocessed_array(reviews)),
    #("documentCount", json.int(list.length(docs))),
    #("noteCount", json.int(list.length(t.notes))),
    #("linkedThreadCount", json.int(list.length(t.threads))),
    #("createdAt", json.int(r.created_at)),
    #("updatedAt", json.int(r.updated_at)),
    #("rev", json.int(r.rev)),
  ])
}

/// `GET /ts/transactions`.
pub fn list_all(
  ctx: Ctx,
  req: Request,
  _reviewer: reviewer_row.Row,
) -> Response {
  use q <- shared.query(req, shared.list_shape())
  let #(status, limit, cursor) = q
  use p <- shared.page(limit, cursor)
  let now = clock.now_ms()
  use #(items, next) <- shared.reading(ctx, fn(r) {
    use rows <- result.try(transaction_store.all_page(
      r,
      status,
      shared.after_of(p),
      p.limit,
    ))
    let #(items, next) = shared.paged(rows, p)
    use views <- result.map(list.try_map(items, ts_view(r, _, now)))
    #(views, next)
  })
  http.json(
    200,
    json.object([
      #("items", json.preprocessed_array(items)),
      #("nextCursor", json.nullable(next, json.string)),
      #("statuses", shared.codes_json(transaction_status.pairs)),
      #(
        "note",
        json.string(
          "States, ids and party roles only. Transaction documents, notes, messages and terms are the parties' and are not exposed here.",
        ),
      ),
    ]),
  )
}

fn median(xs: List(Int)) -> Json {
  let sorted = list.sort(xs, int.compare)
  case list.drop(sorted, list.length(sorted) / 2) {
    [m, ..] -> json.int(m)
    [] -> json.null()
  }
}

fn zero_filled(
  pairs: List(#(String, a)),
  counts: List(#(String, Int)),
) -> Json {
  json.object(
    list.map(pairs, fn(p) {
      #(p.0, json.int(list.key_find(counts, p.0) |> result.unwrap(0)))
    }),
  )
}

fn counted(
  read: Read,
  column: String,
) -> Result(List(#(String, Int)), Fail(e)) {
  store.query(
    read,
    "SELECT "
      <> column
      <> ", COUNT(*) FROM agent_transactions WHERE "
      <> column
      <> " IS NOT NULL GROUP BY "
      <> column,
    [],
    {
      use k <- decode.field(0, decode.string)
      use n <- decode.field(1, decode.int)
      decode.success(#(k, n))
    },
  )
}

/// The spans each transaction spent in COMPLIANCE_PENDING, from its status moves.
fn pending_spans(read: Read) -> Result(List(Int), Fail(e)) {
  use moves <- result.map(
    store.query(
      read,
      "SELECT transaction_id, at, detail_from, detail_to FROM transaction_history WHERE action = 'transaction_status_changed' AND (detail_to = 'COMPLIANCE_PENDING' OR detail_from = 'COMPLIANCE_PENDING') ORDER BY transaction_id, ord",
      [],
      {
        use t <- decode.field(0, decode.string)
        use at <- decode.field(1, decode.int)
        use from <- decode.field(2, decode.optional(decode.string))
        use to <- decode.field(3, decode.optional(decode.string))
        decode.success(#(t, at, from, to))
      },
    ),
  )
  let #(_, _, spans) =
    list.fold(moves, #("", None, []), fn(acc, m) {
      let #(tx, since, spans) = acc
      let since = case m.0 == tx {
        True -> since
        False -> None
      }
      case m.3, since, m.2 {
        Some("COMPLIANCE_PENDING"), _, _ -> #(m.0, Some(m.1), spans)
        _, Some(from), Some("COMPLIANCE_PENDING") -> #(m.0, None, [
          m.1 - from,
          ..spans
        ])
        _, _, _ -> #(m.0, since, spans)
      }
    })
  list.reverse(spans)
}

/// `GET /ts/transactions/metrics`: durations and counts only; no agent or player is ranked.
pub fn metrics(ctx: Ctx, _reviewer: reviewer_row.Row) -> Response {
  let now = clock.now_ms()
  use m <- shared.reading(ctx, fn(r) {
    use by_status <- result.try(counted(r, "status"))
    use by_type <- result.try(counted(r, "type"))
    use cancels <- result.try(counted(r, "cancel_reason_code"))
    use holds <- result.try(counted(r, "hold_reason_code"))
    use durations <- result.try(store.query(
      r,
      "SELECT COALESCE(cancelled_at, closed_at, updated_at) - created_at FROM agent_transactions WHERE status IN ('CANCELLED','CLOSED','ARCHIVED')",
      [],
      decode.at([0], decode.int),
    ))
    use spans <- result.try(pending_spans(r))
    use waits <- result.try(store.query(
      r,
      "SELECT COALESCE(c.granted_at, c.declined_at) - c.requested_at FROM regulatory_consents c JOIN compliance_contexts x ON x.id = c.context_id WHERE x.origin = 'transaction' AND (c.granted_at IS NOT NULL OR c.declined_at IS NOT NULL)",
      [],
      decode.at([0], decode.int),
    ))
    use live <- result.try(transaction_store.live(r))
    use stale <- result.map(
      list.try_map(live, fn(t) {
        use view <- result.try(shared.compliance_of(r, t))
        shared.staleness_of(r, t, view, now)
      }),
    )
    #(by_status, by_type, cancels, holds, durations, spans, waits, stale)
  })
  let #(by_status, by_type, cancels, holds, durations, spans, waits, stale) = m
  http.json(
    200,
    json.object([
      #("byStatus", zero_filled(transaction_status.pairs, by_status)),
      #("byType", zero_filled(context_type.pairs, by_type)),
      #("medianDurationMs", median(durations)),
      #("medianCompliancePendingMs", median(spans)),
      #("medianConsentWaitMs", median(waits)),
      #(
        "cancellationReasons",
        zero_filled(tx_row.cancel_reason_code_pairs, cancels),
      ),
      #("holdReasons", zero_filled(tx_row.hold_reason_code_pairs, holds)),
      #("staleSnapshots", json.int(list.count(stale, fn(s) { s != None }))),
      #(
        "note",
        json.string(
          "Process metrics only. No agent, club or player is ranked, and no subscription or payment status enters any transaction outcome.",
        ),
      ),
    ]),
  )
}

// ------------------------------------------------------------------------------------------------- the audit

/// The actor as a role: a club never learns which named person at the agency acted, and vice versa.
fn actor_of(
  kind: ComplianceActorKind,
  by_id: Option(String),
  name: Option(String),
  org_id: Option(id.OrgId),
) -> Json {
  let text = json.nullable(_, json.string)
  case kind {
    compliance_actor_kind.Org ->
      json.object([
        #("role", json.string("representing_agent")),
        #("userId", text(by_id)),
        #("name", text(name)),
      ])
    compliance_actor_kind.ClubUser ->
      json.object([
        #("role", json.string("party_club_signatory")),
        #("userId", json.null()),
        #("name", json.string("Club signatory")),
        #("orgId", json.nullable(org_id, id.org_json)),
      ])
    compliance_actor_kind.Player ->
      json.object([
        #("role", json.string("party_individual")),
        #("userId", json.null()),
        #("name", json.string("Player")),
      ])
    compliance_actor_kind.TsReviewer ->
      json.object([
        #("role", json.string("trust_safety")),
        #("userId", json.null()),
        #("name", json.string("Trust & Safety (attributed)")),
        #("reviewerId", text(by_id)),
      ])
    compliance_actor_kind.System ->
      json.object([
        #("role", json.string("system")),
        #("userId", json.null()),
        #("name", json.string(option.unwrap(name, "system"))),
      ])
  }
}

fn detail_json(fields: List(#(String, Option(Json)))) -> Json {
  case
    list.filter_map(fields, fn(f) {
      case f.1 {
        Some(v) -> Ok(#(f.0, v))
        None -> Error(Nil)
      }
    })
  {
    [] -> json.null()
    present -> json.object(present)
  }
}

/// One audit row, with the key it sorts by: newest first, then by id descending.
pub type AuditRow {
  AuditRow(at: Int, id: String, json: Json)
}

/// Codes, states and counts only: no note text, document content, fee or personal field. The transaction's own
/// entries carry its current snapshot.
pub fn audit_rows(
  read: Read,
  t: Transaction,
) -> Result(List(AuditRow), Fail(e)) {
  use view <- result.try(shared.compliance_of(read, t))
  use events <- result.try(transaction_store.events(read, t.row.id))
  use docs <- result.try(transaction_store.document_events(read, t.row.id))
  use reps <- result.map(transaction_store.representation_events(read, t.row.id))
  let tid = id.transaction_to_string(t.row.id)
  let snapshot = case view {
    Some(v) ->
      json.object([
        #("evaluationId", json.nullable(v.evaluation_id, json.string)),
        #("evaluatedAt", json.int(v.evaluated_at)),
        #("outcome", json.nullable(v.state.outcome, context_outcome.to_json)),
        #("policyVersions", json.array(v.policy_versions, id.policy_json)),
      ])
    None -> json.null()
  }
  let tx_rows =
    list.map(events, fn(e) {
      let h = e.row
      AuditRow(
        h.at,
        id.transaction_event_to_string(h.id),
        json.object([
          #("id", id.transaction_event_json(h.id)),
          #("at", json.int(h.at)),
          #("action", event_row.action_to_json(h.action)),
          #("domain", json.string("transaction")),
          #("actor", actor_of(h.by_kind, h.by_id, h.by_name, h.by_org_id)),
          #(
            "target",
            json.object([
              #("type", json.string("agent_transaction")),
              #("id", json.string(tid)),
              #("transactionType", context_type.to_json(t.row.type_)),
              #("status", transaction_status.to_json(t.row.status)),
            ]),
          ),
          #("complianceSnapshot", snapshot),
          #(
            "detail",
            detail_json([
              #("from", option.map(h.detail_from, transaction_status.to_json)),
              #("to", option.map(h.detail_to, transaction_status.to_json)),
              #(
                "partyRole",
                option.map(h.detail_party_role, party_role.to_json),
              ),
              #(
                "subjectKind",
                option.map(h.detail_subject_kind, subject_kind.to_json),
              ),
              #(
                "status",
                option.map(
                  h.detail_status,
                  declared_representation_status.to_json,
                ),
              ),
              #(
                "outcome",
                option.map(h.detail_outcome, context_outcome.to_json),
              ),
              #(
                "pendingReason",
                option.map(h.detail_pending_reason, pending_reason.to_json),
              ),
              #("reasonCodes", case h.has_reason_codes {
                True -> Some(json.array(e.reason_codes, json.string))
                False -> None
              }),
              #("policyVersions", case h.has_policy_versions {
                True -> Some(json.array(e.policy_versions, id.policy_json))
                False -> None
              }),
              #(
                "documentType",
                option.map(
                  h.detail_document_type,
                  event_row.detail_document_type_to_json,
                ),
              ),
              #(
                "visibility",
                option.map(h.detail_visibility, document_visibility.to_json),
              ),
              #(
                "holdReasonCode",
                option.map(
                  h.detail_reason_code,
                  event_row.detail_reason_code_to_json,
                ),
              ),
              #("version", option.map(h.detail_version, json.int)),
              #("count", option.map(h.detail_count, json.int)),
              #("staleness", option.map(h.detail_staleness, staleness.to_json)),
            ]),
          ),
        ]),
      )
    })
  let doc_rows =
    list.map(docs, fn(x) {
      let #(d, h) = x
      AuditRow(
        h.at,
        id.transaction_document_event_to_string(h.id),
        json.object([
          #("id", id.transaction_document_event_json(h.id)),
          #("at", json.int(h.at)),
          #("action", doc_event_row.action_to_json(h.action)),
          #("domain", json.string("transaction")),
          #("actor", actor_of(h.by_kind, h.by_id, h.by_name, h.by_org_id)),
          #(
            "target",
            json.object([
              #("type", json.string("transaction_document")),
              #("id", id.transaction_document_json(d.id)),
              #("transactionId", json.string(tid)),
              #("documentType", doc_row.document_type_to_json(d.document_type)),
            ]),
          ),
          #("complianceSnapshot", json.null()),
          // A document's entry repeats the document's own fields.
          #("detail", case h.action {
            doc_event_row.TransactionDocumentAdded ->
              json.object([
                #(
                  "documentType",
                  doc_row.document_type_to_json(d.document_type),
                ),
                #("visibility", document_visibility.to_json(d.visibility)),
                #("version", json.int(d.version)),
              ])
            doc_event_row.TransactionDocumentSuperseded ->
              json.object([#("version", json.int(d.version))])
          }),
        ]),
      )
    })
  let rep_rows =
    list.map(reps, fn(x) {
      let #(r, h, pvs) = x
      AuditRow(
        h.at,
        id.representation_event_to_string(h.id),
        json.object([
          #("id", id.representation_event_json(h.id)),
          #("at", json.int(h.at)),
          #("action", rep_event_row.action_to_json(h.action)),
          #("domain", json.string("transaction")),
          #("actor", actor_of(h.by_kind, h.by_id, h.by_name, h.by_org_id)),
          #(
            "target",
            json.object([
              #("type", json.string("transaction_representation")),
              #("id", id.representation_json(r.id)),
              #("transactionId", json.string(tid)),
              #("partyRole", party_role.to_json(r.party_role)),
            ]),
          ),
          #("complianceSnapshot", json.null()),
          #(
            "detail",
            detail_json([
              #(
                "partyRole",
                option.map(h.detail_party_role, party_role.to_json),
              ),
              #(
                "status",
                option.map(
                  h.detail_status,
                  declared_representation_status.to_json,
                ),
              ),
              #("policyVersions", case h.has_policy_versions {
                True -> Some(json.array(pvs, id.policy_json))
                False -> None
              }),
            ]),
          ),
        ]),
      )
    })
  list.flatten([tx_rows, doc_rows, rep_rows])
}

pub fn newest_first(rows: List(AuditRow)) -> List(AuditRow) {
  list.sort(rows, fn(a, b) {
    case int.compare(b.at, a.at) {
      order.Eq -> string.compare(b.id, a.id)
      other -> other
    }
  })
}

/// `GET /ts/transactions/:id`.
pub fn get_one(
  ctx: Ctx,
  _reviewer: reviewer_row.Row,
  transaction_id: String,
) -> Response {
  let now = clock.now_ms()
  use found <- shared.reading(ctx, transaction_store.by_id(
    _,
    id.transaction(transaction_id),
  ))
  case found {
    None -> shared.not_found()
    Some(t) -> {
      use #(view, audit) <- shared.reading(ctx, fn(r) {
        use view <- result.try(ts_view(r, t, now))
        use rows <- result.map(audit_rows(r, t))
        #(view, newest_first(rows) |> list.take(200))
      })
      http.json(
        200,
        json.object([
          #("transaction", view),
          #("audit", json.array(audit, fn(a) { a.json })),
        ]),
      )
    }
  }
}
