//// The verification records as Trust & Safety reads them: each row in the TypeScript repository's field order
//// and names, a group (`verifiedBy`) null when its required member is, and `metadata` / `meta` sparse (only
//// the members that are set).

import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/identity/orgs
import scoutbox/identity/staff
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/ver_claims as claim_row
import scoutbox/rows/ver_events as event_row
import scoutbox/rows/ver_evidence as evidence_row
import scoutbox/verification/claims.{type Claim}
import scoutbox/verification/core
import scoutbox/verification/records.{type Evidence}
import scoutbox/vocab/actor_kind
import scoutbox/vocab/attribution
import scoutbox/vocab/claim_type
import scoutbox/vocab/identity_link
import scoutbox/vocab/ver_code
import scoutbox/vocab/ver_level
import scoutbox/vocab/ver_org_type
import scoutbox/vocab/verification_method
import sqlight

fn int(v: Option(Int)) -> Json {
  json.nullable(v, json.int)
}

fn text(v: Option(String)) -> Json {
  json.nullable(v, json.string)
}

/// Only the members that are set.
fn sparse(members: List(#(String, Option(Json)))) -> Json {
  members
  |> list.filter_map(fn(m) {
    case m.1 {
      Some(v) -> Ok(#(m.0, v))
      None -> Error(Nil)
    }
  })
  |> json.object
}

fn some_text(v: Option(String)) -> Option(Json) {
  option.map(v, json.string)
}

fn some_int(v: Option(Int)) -> Option(Json) {
  option.map(v, json.int)
}

fn by(kind: Option(actor_kind.ActorKind), id: Option(String)) -> Json {
  case kind {
    Some(k) ->
      json.object([
        #("kind", actor_kind.to_json(k)),
        #("id", text(id)),
      ])
    None -> json.null()
  }
}

/// A claim as the repository decodes it, with its codes and evidence.
pub fn claim_record(read: Read, c: Claim) -> Result(Json, Fail(e)) {
  use reasons <- result.try(records.codes(read, c.id, records.ReviewReasons))
  use flags <- result.try(records.codes(read, c.id, records.RiskFlags))
  use evidence_ids <- result.map(records.evidence_ids(read, c.id))
  let registry = case c.registry_provider, c.registry_checked_at {
    Some(provider), Some(at) ->
      Some(
        sparse([
          #("provider", Some(json.string(provider))),
          #(
            "state",
            option.map(c.registry_state, claim_row.registry_state_to_json),
          ),
          #(
            "result",
            option.map(c.registry_result, claim_row.registry_result_to_json),
          ),
          #("checkedAt", Some(json.int(at))),
          #("reference", some_text(c.registry_reference)),
        ]),
      )
    _, _ -> None
  }
  json.object([
    #("id", json.string(c.id)),
    #("subjectType", claim_row.subject_kind_to_json(c.subject_kind)),
    #("subjectId", json.string(c.subject_id)),
    #("claimType", claim_type.to_json(c.claim_type)),
    #("organisationId", text(c.organisation_id)),
    #("role", text(c.role)),
    #("status", claim_row.status_to_json(c.status)),
    #("validFrom", int(c.valid_from)),
    #("validUntil", int(c.valid_until)),
    #("current", json.bool(c.current)),
    #(
      "verificationMethod",
      json.nullable(c.verification_method, verification_method.to_json),
    ),
    #(
      "authorityType",
      json.nullable(c.authority_kind, claim_row.authority_kind_to_json),
    ),
    #("authorityId", text(c.authority_id)),
    #("createdAt", json.int(c.created_at)),
    #("updatedAt", json.int(c.updated_at)),
    #("verifiedAt", int(c.verified_at)),
    #("verifiedBy", by(c.verified_by_kind, c.verified_by_id)),
    #("revokedAt", int(c.revoked_at)),
    #("revokedBy", by(c.revoked_by_kind, c.revoked_by_id)),
    #("revocationReason", text(c.revocation_reason)),
    #("suspendedAt", int(c.suspended_at)),
    #("suspendReason", text(c.suspend_reason)),
    #("disputedAt", int(c.disputed_at)),
    #("expiredAt", int(c.expired_at)),
    #(
      "metadata",
      sparse([
        #("declaredName", some_text(c.declared_name)),
        #("pairId", some_text(c.pair_id)),
        #("requestedStart", some_int(c.requested_start)),
        #("workEmail", some_text(c.work_email)),
        #(
          "domainControl",
          option.map(c.domain_control, claim_row.domain_control_to_json),
        ),
        #("domainCoveredByOrg", option.map(c.domain_covered_by_org, json.bool)),
        #("domain", some_text(c.domain)),
        #("licenceType", some_text(c.licence_type)),
        #("issuer", some_text(c.issuer)),
        #("identifier", some_text(c.identifier)),
        #("holderName", some_text(c.holder_name)),
        #("display", some_text(c.display)),
        #("registry", registry),
        #("rootRequest", some_text(c.root_request_id)),
        #("orgType", option.map(c.org_type, ver_org_type.to_json)),
        #("website", some_text(c.website)),
        #("level", option.map(c.admin_level, ver_level.to_json)),
        #("identityLink", option.map(c.identity_link, identity_link.to_json)),
        #("appointedReason", some_text(c.appointed_reason)),
        #("via", some_text(c.via)),
        #("flaggedForReview", case c.flagged_at, c.flagged_reason {
          Some(at), Some(reason) ->
            Some(
              json.object([
                #("at", json.int(at)),
                #("reason", json.string(reason)),
              ]),
            )
          _, _ -> None
        }),
        #("migratedFrom", some_text(c.migrated_from)),
        #("note", some_text(c.note)),
        #("representationId", some_text(c.representation_id)),
        #("documentReviewed", some_text(c.document_reviewed)),
        #("assignedTo", some_text(c.assigned_to)),
        #("expiryWarned", some_int(c.expiry_warned_at)),
      ]),
    ),
    #("reviewReasons", codes(reasons)),
    #("riskFlags", codes(flags)),
    #("evidenceIds", json.array(evidence_ids, json.string)),
  ])
}

fn codes(cs: List(ver_code.VerCode)) -> Json {
  json.array(cs, ver_code.to_json)
}

/// An evidence record as the repository decodes it, with the claims it is linked to.
pub fn evidence_record(read: Read, e: Evidence) -> Result(Json, Fail(err)) {
  use claim_ids <- result.map(store.query(
    read,
    "SELECT claim_id FROM ver_claim_evidence WHERE evidence_id = ? ORDER BY rowid",
    [sqlight.text(e.id)],
    decode.at([0], decode.string),
  ))
  json.object(
    list.append(evidence_fields(e, include_media: True), [
      #("claimIds", json.array(claim_ids, json.string)),
    ]),
  )
}

/// The evidence record's own fields. Without the media id for an organisation's reviewer.
pub fn evidence_fields(
  e: Evidence,
  include_media include_media: Bool,
) -> List(#(String, Json)) {
  list.flatten([
    [
      #("id", json.string(e.id)),
      #("type", evidence_row.type_to_json(e.type_)),
      #("source", json.string(e.source)),
      #(
        "suppliedByKind",
        evidence_row.supplied_by_kind_to_json(e.supplied_by_kind),
      ),
      #("suppliedById", text(e.supplied_by_id)),
      #("orgId", text(e.org_id)),
      #("receivedAt", json.int(e.received_at)),
    ],
    case include_media {
      True -> [#("mediaId", text(e.media_id))]
      False -> []
    },
    [
      #("sha256", text(e.sha256)),
      #("mime", json.nullable(e.mime, evidence_row.mime_to_json)),
      #("bytes", int(e.bytes)),
      #("filename", text(e.filename)),
      #(
        "meta",
        sparse([
          #("note", some_text(e.note)),
          #("domain", some_text(e.domain)),
          #(
            "domainCoveredByOrg",
            option.map(e.domain_covered_by_org, json.bool),
          ),
          #("addressHash", some_text(e.address_hash)),
          #("rootRequest", some_text(e.root_request_id)),
          #("identifier", some_text(e.identifier)),
          #("licenceType", some_text(e.licence_type)),
          #("validUntil", some_text(e.registry_valid_until)),
          #("signingPackageId", some_text(e.signing_package_id)),
          #(
            "signingDocumentKind",
            option.map(
              e.signing_document_kind,
              evidence_row.signing_document_kind_to_json,
            ),
          ),
          #("label", some_text(e.label)),
        ]),
      ),
      #("checks", core.evidence_checks(e)),
      #("retention", evidence_row.retention_to_json(e.retention)),
      #("visibility", evidence_row.visibility_to_json(e.visibility)),
      #("expiresAt", int(e.expires_at)),
    ],
  ])
}

pub fn event_record(e: event_row.Row) -> Json {
  json.object([
    #("id", json.string(e.id)),
    #("ts", json.int(e.occurred_at)),
    #("type", event_row.type_to_json(e.type_)),
    #("actorKind", event_row.actor_kind_to_json(e.actor_kind)),
    #("actorId", text(e.actor_id)),
    #("actorName", text(e.actor_name)),
    #("actorOrgId", text(e.actor_org_id)),
    #("requestId", text(e.request_id)),
    #("attribution", json.nullable(e.attribution, attribution.to_json)),
    #("claimId", text(e.claim_id)),
    #("subjectId", text(e.subject_id)),
    #("orgId", text(e.org_id)),
    #("detail", text(e.detail)),
    #("reason", text(e.reason)),
  ])
}

/// A claim in Trust & Safety's queue.
pub fn admin_claim_row(read: Read, c: Claim) -> Result(Json, Fail(e)) {
  use org <- result.try(case c.organisation_id {
    Some(id) -> orgs.by_id(read, id)
    None -> Ok(None)
  })
  use org_status <- result.try(case org {
    Some(o) -> core.org_status(read, Some(o)) |> result.map(Some)
    None -> Ok(None)
  })
  use name <- result.try(case c.subject_kind {
    claim_row.User ->
      staff.by_id(read, c.subject_id)
      |> result.map(option.map(_, fn(u) { u.name }))
    claim_row.Org ->
      orgs.by_id(read, c.subject_id)
      |> result.map(option.map(_, fn(o) { o.name }))
  })
  use reasons <- result.try(records.codes(read, c.id, records.ReviewReasons))
  use flags <- result.map(records.codes(read, c.id, records.RiskFlags))
  json.object([
    #("id", json.string(c.id)),
    #("claimType", claim_type.to_json(c.claim_type)),
    #("status", claim_row.status_to_json(c.status)),
    #("role", text(c.role)),
    #(
      "subject",
      json.object([
        #("type", claim_row.subject_kind_to_json(c.subject_kind)),
        #("id", json.string(c.subject_id)),
        #("name", json.string(option.unwrap(name, "(unknown)"))),
      ]),
    ),
    #("organisation", case org, org_status {
      Some(o), Some(s) ->
        json.object([
          #("id", json.string(o.id)),
          #("name", json.string(o.name)),
          #("status", json.string(claims.org_status_code(s))),
        ])
      _, _ -> json.null()
    }),
    #("reviewReasons", codes(reasons)),
    #("riskFlags", codes(flags)),
    #("assignedTo", text(c.assigned_to)),
    #("createdAt", json.int(c.created_at)),
    #("updatedAt", json.int(c.updated_at)),
    #("disputedAt", int(c.disputed_at)),
  ])
}
