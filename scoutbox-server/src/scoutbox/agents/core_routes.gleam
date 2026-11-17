//// The agent core's routes (domains/agents/core/index.mjs and access.mjs): the agent's profile and verification
//// facets, the agency's team and settings, the agent's clients, the player's My Agent, and the shared key's
//// read-only oversight.
////
//// A licensed natural person is not an agency; agency membership is not a licence; a self-typed licence number is
//// not a verified licence; the client's confirmation, and only that, is the root of a relationship. The shared
//// Trust & Safety key adjudicates nothing: no `/admin` route here writes.
////
//// Not ported yet: the attributed reviewer lane (`/ts/…`) that decides a facet or a dispute, the integration layer
//// (opportunity shares, contact routing, handoffs) and the transaction workspace's rows in the agency audit.

import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import gleam/string
import scoutbox/agents/agent_audit
import scoutbox/agents/agent_rules.{
  type Affiliation, type Agreement, type Profile, Affiliation,
}
import scoutbox/agents/agent_store.{type Actor, Actor}
import scoutbox/agents/approach_policy
import scoutbox/agents/reviews
import scoutbox/agents/verification_provider
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess, type PlayerAccess}
import scoutbox/identity/orgs
import scoutbox/identity/players.{type Player}
import scoutbox/identity/sessions
import scoutbox/identity/staff
import scoutbox/messaging/notifications
import scoutbox/platform/canonical
import scoutbox/platform/clock
import scoutbox/platform/effect
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/limits
import scoutbox/platform/live_event
import scoutbox/platform/paging
import scoutbox/platform/rev
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/recruitment/domain_errors.{Contract}
import scoutbox/rows/agency_affiliations as affiliation_row
import scoutbox/rows/agent_profile_facets as facet_row
import scoutbox/rows/agent_profile_history as profile_event_row
import scoutbox/rows/agent_profiles as profile_row
import scoutbox/rows/agreement_history as event_row
import scoutbox/rows/agreement_scopes as scope_row
import scoutbox/rows/id
import scoutbox/rows/representation_agreements as agreement_row
import scoutbox/safety/audit
import scoutbox/safety/moderate
import scoutbox/scouting/opportunity_board
import scoutbox/vocab/agency_tier.{type AgencyTier}
import scoutbox/vocab/agent_actor_kind
import scoutbox/vocab/agent_facet.{type AgentFacet, FifaLicence}
import scoutbox/vocab/agreement_status
import scoutbox/vocab/audience
import scoutbox/vocab/compliance_actor_kind
import scoutbox/vocab/facet_state.{type FacetState}
import scoutbox/vocab/jurisdiction.{type Jurisdiction}
import scoutbox/vocab/org_type
import scoutbox/vocab/rule_status
import scoutbox/vocab/terminator
import sqlight
import wisp.{type Request, type Response}

// ------------------------------------------------------------------------------------------------- refusals

/// AGENT_CORE_ERROR_HTTP and PUBLIC_ERROR_FIELDS (domains/agents/core/errors.mjs). `test/scoutbox/spec_test.gleam`
/// proves the table equals the snapshot.
pub const statuses = [
  #("AGENT_INPUT_INVALID", 400),
  #("AGENT_CLIENT_KEY_INVALID", 400),
  #("EXPECTED_REV_INVALID", 400),
  #("AGENT_TIERS_INVALID", 400),
  #("AGENT_FACET_INVALID", 400),
  #("AGENT_SCOPE_INVALID", 400),
  #("AGENT_TERM_INVALID", 400),
  #("AGENT_JURISDICTION_INVALID", 400),
  #("REPRESENTATION_INPUT_INVALID", 400),
  #("AGENT_ACTION_NOT_PERMITTED", 403),
  #("AGENCY_MEMBERSHIP_REQUIRED", 403),
  #("AGENT_PROFILE_REQUIRED", 403),
  #("AGENT_VERIFICATION_REQUIRED", 403),
  #("SELF_PROMOTION_BLOCKED", 403),
  #("AGENT_VERIFICATION_STALE", 403),
  #("AGENT_LICENCE_INACTIVE", 403),
  #("AGENT_NATIONAL_REGISTRATION_REQUIRED", 403),
  #("AGENT_DOMESTIC_AUTHORISATION_REQUIRED", 403),
  #("PLAYER_NOT_FOUND", 404),
  #("REPRESENTATION_NOT_FOUND", 404),
  #("MEMBER_NOT_FOUND", 404),
  #("REPRESENTATION_ALREADY_EXISTS", 409),
  #("REPRESENTATION_NOT_ACTIVE", 409),
  #("REPRESENTATION_CONFIRMATION_REQUIRED", 409),
  #("REPRESENTATION_DISPUTED", 409),
  #("REPRESENTATION_VERSION_CONFLICT", 409),
  #("REPRESENTATION_IDEMPOTENCY_CONFLICT", 409),
  #("AFFILIATION_VERSION_CONFLICT", 409),
  #("AFFILIATION_IDEMPOTENCY_CONFLICT", 409),
  #("LAST_ADMIN", 409),
  #("MEMBER_ALREADY_AFFILIATED", 409),
  #("REGULATORY_REVIEW_REQUIRED", 422),
  #("JURISDICTION_UNSUPPORTED", 422),
  #("REPRESENTATION_COOLDOWN", 429),
  #("REGULATORY_PROVIDER_UNAVAILABLE", 503),
  #("AGENT_STORE_MISSING", 500),
  #("AGENT_STATE_UNKNOWN", 500),
]

pub const contract =
  Contract(
    statuses: statuses,
    public_fields: [
      "message", "allowed", "facet", "memberAssociation", "state", "expectedRev",
      "currentRev", "updatedBy", "updatedAt", "retryAt", "status", "agreementId",
      "field", "problem", "min", "max", "expected", "reasons", "policyVersions",
      "reviewId", "retryAfter",
    ],
    internal_message: "The Agent workspace cannot serve this request. This has been recorded.",
    unmapped: "AGENT_STATE_UNKNOWN",
  )

fn err(
  code: String,
  message: String,
  fields: List(#(String, Json)),
) -> Response {
  domain_errors.refuse(contract, code, message, fields)
}

fn refuse(code: String, fields: List(#(String, Json))) -> Response {
  domain_errors.send(contract, code, fields)
}

fn not_permitted(message: String) -> Response {
  err("AGENT_ACTION_NOT_PERMITTED", message, [])
}

fn read(ctx: Ctx, f: fn(Read) -> Result(a, Fail(e))) -> Result(a, Response) {
  store.read(ctx.store, f) |> result.map_error(http.internal)
}

/// Reads, then continues with the value or answers the storage failure.
fn reading(
  ctx: Ctx,
  f: fn(Read) -> Result(a, Fail(e)),
  next: fn(a) -> Response,
) -> Response {
  case read(ctx, f) {
    Ok(v) -> next(v)
    Error(response) -> response
  }
}

/// A unit whose refusals are responses.
fn act(
  ctx: Ctx,
  work: fn(Tx) -> Result(a, Fail(Response)),
  next: fn(a) -> Response,
) -> Response {
  case store.unit(ctx.store, work) {
    Ok(v) -> next(v)
    Error(store.Refused(response)) -> response
    Error(failure) -> http.internal(failure)
  }
}

fn storage(r: Result(a, Fail(e))) -> Result(a, Fail(Response)) {
  case r {
    Ok(v) -> Ok(v)
    Error(store.Storage(e)) -> Error(store.Storage(e))
    Error(store.Refuse(_)) -> panic as "a storage read refused"
    Error(store.Stale(what)) -> Error(store.Stale(what))
  }
}

fn rate_limited(action: limits.Action) -> Response {
  http.json(
    429,
    json.object(
      list.map(limits.limited_body(action), fn(p) { #(p.0, json.string(p.1)) }),
    ),
  )
}

fn limited(
  ctx: Ctx,
  action: limits.Action,
  owner: String,
  next: fn() -> Response,
) -> Response {
  case limits.limited(ctx.limits, action, owner, clock.now_ms()) {
    True -> rate_limited(action)
    False -> next()
  }
}

// ---------------------------------------------------------------------------------------------------- input

const field_codes = [
  #("tiers", "AGENT_TIERS_INVALID"),
  #("jurisdictions", "AGENT_JURISDICTION_INVALID"),
  #("jurisdiction", "AGENT_JURISDICTION_INVALID"),
  #("scope", "AGENT_SCOPE_INVALID"),
  #("termMonths", "AGENT_TERM_INVALID"),
  #("clientKey", "AGENT_CLIENT_KEY_INVALID"),
  #("expectedRev", "EXPECTED_REV_INVALID"),
  #("expectedVersion", "EXPECTED_REV_INVALID"),
]

fn parsed(
  shape: input.Shape(a),
  raw: Dynamic,
  root: String,
  default: String,
  next: fn(a) -> Response,
) -> Response {
  case input.parse_coded(shape, raw, root:, codes: field_codes, default:) {
    Ok(v) -> next(v)
    Error(r) -> refuse(r.error, input.refusal_fields(r))
  }
}

/// The body read with `shape`, refused under the agent contract's codes.
pub fn body(
  req: Request,
  shape: input.Shape(a),
  next: fn(a, Dynamic) -> Response,
) -> Response {
  use raw <- http.json_body(req)
  use v <- parsed(shape, raw, "body", "AGENT_INPUT_INVALID")
  next(v, raw)
}

fn query(
  req: Request,
  shape: input.Shape(a),
  next: fn(a) -> Response,
) -> Response {
  parsed(shape, http.query_input(req), "query", "AGENT_INPUT_INVALID", next)
}

/// The limits of AGENT_CORE_LIMITS this server reads.
const display_name_max = 80

const licence_number_max = 40

const reference_max = 60

const staff_name_max = 80

const staff_role_max = 60

const reason_code_max = 40

const description_max = 300

const dispute_reason_max = 300

const id_max = 80

const name_max = 200

/// A client key: absent, null or blank is none; anything else is at most 64 characters once trimmed.
fn client_key_field(
  next: fn(Option(String)) -> input.Shape(a),
) -> input.Shape(a) {
  use raw <- input.field("clientKey", input.nullish(input.text(1_000_000)))
  next(raw)
}

fn client_key(
  raw: Option(String),
  next: fn(Option(String)) -> Response,
) -> Response {
  case raw {
    None -> next(None)
    Some(text) ->
      case string.trim(text) {
        "" -> next(None)
        k ->
          case input.utf16_length(k) > 64 {
            True ->
              err(
                "AGENT_CLIENT_KEY_INVALID",
                "clientKey must be 1–64 characters.",
                [],
              )
            False -> next(Some(k))
          }
      }
  }
}

/// Text a shape has read: absent, blank (`Some(None)`), or trimmed text.
fn given(v: Option(Option(String))) -> Option(Option(String)) {
  case v {
    None -> None
    Some(t) -> Some(input.filled(t))
  }
}

fn jurisdictions_check() -> input.Check(List(Jurisdiction)) {
  input.distinct_list(input.one_of(jurisdiction.pairs), 0)
}

fn tiers_check() -> input.Check(List(AgencyTier)) {
  input.distinct_list(input.one_of(agency_tier.pairs), 1)
}

fn fingerprint(fields: List(#(String, canonical.Value))) -> String {
  canonical.to_string(canonical.Object(fields))
}

// -------------------------------------------------------------------------------------------------- actors

fn by_org(a: OrgAccess) -> Actor {
  Actor(
    agent_actor_kind.Org,
    Some(id.org_user_to_string(a.user.id)),
    Some(a.user.name),
  )
}

fn by_player(p: Player) -> Actor {
  Actor(
    agent_actor_kind.Player,
    Some(id.player_to_string(p.row.id)),
    Some(p.row.name),
  )
}

fn requested_by_org(a: OrgAccess) -> reviews.RequestedBy {
  reviews.RequestedBy(
    compliance_actor_kind.Org,
    Some(id.org_user_to_string(a.user.id)),
    Some(a.user.name),
  )
}

fn live(tx: Tx, event: live_event.Event) -> Nil {
  store.emit(tx, effect.Live(event))
}

fn notify_staff(
  tx: Tx,
  user: id.OrgUserId,
  type_: String,
  text: String,
  ref_id: String,
  now: Int,
) -> Result(Nil, Fail(e)) {
  notifications.notify(
    tx,
    to: audience.OrgUser,
    id: id.org_user_to_string(user),
    type_:,
    text:,
    ref_id: Some(ref_id),
    at: now,
  )
}

fn notify_player(
  tx: Tx,
  player_id: String,
  type_: String,
  text: String,
  ref_id: String,
  now: Int,
) -> Result(Nil, Fail(e)) {
  notifications.notify(
    tx,
    to: audience.Player,
    id: player_id,
    type_:,
    text:,
    ref_id: Some(ref_id),
    at: now,
  )
}

fn representation_event(
  change: live_event.RepresentationChange,
  a: agreement_row.Row,
) -> live_event.Event {
  live_event.Representation(
    change:,
    org_id: id.org_to_string(a.agency_org_id),
    agreement_id: id.agreement_to_string(a.id),
    agent_user_id: id.org_user_to_string(a.agent_user_id),
  )
}

// ---------------------------------------------------------------------------------------------- membership

/// A staff member of an agency, active in it, with their roles.
pub type Member {
  Member(access: OrgAccess, affiliation: Affiliation)
}

fn tiers(m: Member) -> List(AgencyTier) {
  m.affiliation.tiers
}

/// The caller's active membership of the agency they signed in to. The first person into an agency with no
/// members becomes its administrator.
pub fn membership(
  ctx: Ctx,
  a: OrgAccess,
  next: fn(Member) -> Response,
) -> Response {
  case a.org.type_ {
    org_type.Agency -> {
      let now = clock.now_ms()
      use found <- reading(ctx, fn(r) {
        agent_store.active_affiliation(r, a.user.id, a.org.id, now)
      })
      case found {
        Some(aff) -> next(Member(a, aff))
        None -> {
          use aff <- act(ctx, fn(tx) {
            let r = store.reading(tx)
            use existing <- result.try(
              agent_store.active_affiliation(r, a.user.id, a.org.id, now)
              |> storage,
            )
            use any <- result.try(
              agent_store.any_active_in(r, a.org.id, now) |> storage,
            )
            case existing, any {
              Some(aff), _ -> Ok(aff)
              None, True ->
                store.refuse(
                  err(
                    "AGENCY_MEMBERSHIP_REQUIRED",
                    "You are not an active member of this agency. Ask an agency administrator to add you.",
                    [],
                  ),
                )
              None, False -> bootstrap(tx, a, now) |> storage
            }
          })
          next(Member(a, aff))
        }
      }
    }
    _ -> not_permitted("The Agent workspace is for agency organisations.")
  }
}

fn bootstrap(tx: Tx, a: OrgAccess, now: Int) -> Result(Affiliation, Fail(e)) {
  use aff_id <- result.try(id.next_affiliation(tx))
  let row =
    affiliation_row.Row(
      ..affiliation_row.new(
        id: aff_id,
        agency_org_id: a.org.id,
        user_id: a.user.id,
        started_at: now,
        created_at: now,
        rev: 1,
      ),
      rev_at: Some(now),
    )
  let tiers = [agency_tier.AgencyAdmin]
  use _ <- result.map(agent_store.create_affiliation(
    tx,
    row,
    tiers,
    by_org(a),
    True,
  ))
  live(
    tx,
    live_event.AgencyAffiliationCreated(
      id.org_to_string(a.org.id),
      id.org_user_to_string(a.user.id),
    ),
  )
  Affiliation(row, tiers)
}

pub fn require(
  m: Member,
  capability: String,
  next: fn() -> Response,
) -> Response {
  case agent_rules.can(tiers(m), capability) {
    True -> next()
    False ->
      not_permitted(
        "Your agency role does not include \"" <> capability <> "\".",
      )
  }
}

/// The agreement of the caller's agency: their own, a summary shared with agency staff, or a concealing 404.
pub type Found {
  Own(Agreement)
  Summary(Agreement)
}

pub fn own_agreement(
  ctx: Ctx,
  m: Member,
  agreement_id: String,
  next: fn(Found) -> Response,
) -> Response {
  use found <- reading(ctx, fn(r) {
    agent_store.agreement_by_id(r, agreement_id)
  })
  case found {
    Some(a) if a.row.agency_org_id == m.access.org.id ->
      case
        a.row.agent_user_id == m.access.user.id
        && agent_rules.can(tiers(m), "clients.read.own"),
        agent_rules.can(tiers(m), "clients.read.shared_summary")
        && a.row.share_with_agency_staff
      {
        True, _ -> next(Own(a))
        False, True -> next(Summary(a))
        False, False -> refuse("REPRESENTATION_NOT_FOUND", [])
      }
    _ -> refuse("REPRESENTATION_NOT_FOUND", [])
  }
}

// ------------------------------------------------------------------------------------------------- views

fn opt_int(v: Option(Int)) -> Json {
  json.nullable(v, json.int)
}

fn opt_text(v: Option(String)) -> Json {
  json.nullable(v, json.string)
}

fn provenance(f: facet_row.Row) -> Json {
  case f.provenance_provider {
    None -> json.null()
    Some(provider) ->
      json.object([
        #("provider", facet_row.provenance_provider_to_json(provider)),
        #(
          "kind",
          json.nullable(f.provenance_kind, facet_row.provenance_kind_to_json),
        ),
        #("at", opt_int(f.provenance_at)),
        #("reviewerId", opt_text(f.provenance_reviewer_id)),
        #(
          "reviewId",
          json.nullable(f.provenance_review_id, id.regulatory_review_json),
        ),
      ])
  }
}

fn facet_ma(f: facet_row.Row) -> Option(Jurisdiction) {
  case f.facet {
    FifaLicence -> None
    _ -> Some(f.member_association)
  }
}

pub fn facet_view(f: facet_row.Row, now: Int) -> List(#(String, Json)) {
  [
    #(
      "state",
      facet_state.to_json(agent_rules.effective_facet_state(Some(f), now)),
    ),
    #("storedState", facet_state.to_json(f.state)),
    #("reference", opt_text(f.reference)),
    #("memberAssociation", json.nullable(facet_ma(f), jurisdiction.to_json)),
    #("provenance", provenance(f)),
    #("submittedAt", opt_int(f.submitted_at)),
    #("verifiedAt", opt_int(f.verified_at)),
    #("recheckAt", opt_int(f.recheck_at)),
    #("note", opt_text(f.note)),
  ]
}

fn facets_object(
  p: Profile,
  facet: AgentFacet,
  view: fn(facet_row.Row) -> Json,
) -> Json {
  json.object(
    agent_rules.facets_by_association(p, facet)
    |> list.map(fn(pair) { #(jurisdiction.to_string(pair.0), view(pair.1)) }),
  )
}

fn state_of(
  p: Profile,
  facet: AgentFacet,
  ma: Option(Jurisdiction),
  now: Int,
) -> FacetState {
  agent_rules.effective_facet_state(agent_rules.facet_of(p, facet, ma), now)
}

fn regulatory_jurisdictions(p: Profile, now: Int) -> Json {
  json.array(p.jurisdictions, fn(ma) {
    json.object([
      #("memberAssociation", jurisdiction.to_json(ma)),
      #(
        "nationalRegistration",
        facet_state.to_json(state_of(
          p,
          agent_facet.NationalRegistration,
          Some(ma),
          now,
        )),
      ),
      #(
        "domesticAuthorisation",
        facet_state.to_json(state_of(
          p,
          agent_facet.DomesticAuthorisation,
          Some(ma),
          now,
        )),
      ),
      #(
        "minorsAuthorisation",
        facet_state.to_json(state_of(
          p,
          agent_facet.MinorsAuthorisation,
          Some(ma),
          now,
        )),
      ),
      #(
        "regulatedActionsPermitted",
        json.bool(agent_rules.verification_gap(Some(p), ma, now) == None),
      ),
    ])
  })
}

fn regulatory_state(p: Profile, now: Int) -> Json {
  json.object([
    #("fifaLicence", facet_state.to_json(state_of(p, FifaLicence, None, now))),
    #("jurisdictions", regulatory_jurisdictions(p, now)),
  ])
}

fn profile_rev(p: Profile) -> rev.Rev {
  rev.Rev(p.row.rev, p.row.rev_at, p.row.rev_by_name)
}

fn profile_event_detail(h: profile_event_row.Row) -> Json {
  case h.action {
    profile_event_row.AgentProfileCreated -> json.null()
    profile_event_row.AgentProfileUpdated ->
      json.object([
        #(
          "fields",
          json.array(
            list.filter_map(
              [
                #("displayName", h.detail_display_name),
                #("jurisdictions", h.detail_jurisdictions),
                #("fifaLicenceNumber", h.detail_licence_number),
              ],
              fn(f) {
                case f.1 {
                  Some(True) -> Ok(f.0)
                  _ -> Error(Nil)
                }
              },
            ),
            json.string,
          ),
        ),
      ])
    _ ->
      json.object(
        list.flatten([
          [
            #("facet", json.nullable(h.detail_facet, agent_facet.to_json)),
            #(
              "memberAssociation",
              json.nullable(h.detail_ma, jurisdiction.to_json),
            ),
          ],
          case h.detail_to {
            Some(to) -> [
              #("from", json.nullable(h.detail_from, facet_state.to_json)),
              #("to", facet_state.to_json(to)),
            ]
            None -> []
          },
          case h.action {
            profile_event_row.AgentVerificationStateChanged ->
              list.flatten([
                [#("state", json.nullable(h.detail_state, facet_state.to_json))],
                case h.detail_review_id {
                  Some(r) -> [#("reviewId", id.regulatory_review_json(r))]
                  None -> []
                },
              ])
            _ -> []
          },
        ]),
      )
  }
}

pub fn profile_view(p: Profile, now: Int) -> Json {
  let r = p.row
  json.object(
    list.flatten([
      [
        #("id", id.agent_profile_json(r.id)),
        #("userId", id.org_user_json(r.user_id)),
        #("agencyOrgId", id.org_json(r.agency_org_id)),
        #("displayName", json.string(r.display_name)),
        #(
          "declared",
          json.object([
            #("fifaLicenceNumber", opt_text(r.declared_fifa_licence_number)),
            #(
              "jurisdictions",
              json.array(p.jurisdictions, jurisdiction.to_json),
            ),
          ]),
        ),
        #(
          "facets",
          json.object([
            #("fifa_licence", case agent_rules.facet_of(p, FifaLicence, None) {
              Some(f) -> json.object(facet_view(f, now))
              None -> json.null()
            }),
            #(
              "national_registration",
              facets_object(p, agent_facet.NationalRegistration, fn(f) {
                json.object(facet_view(f, now))
              }),
            ),
            #(
              "domestic_authorisation",
              facets_object(p, agent_facet.DomesticAuthorisation, fn(f) {
                json.object(facet_view(f, now))
              }),
            ),
            #(
              "minors_authorisation",
              facets_object(p, agent_facet.MinorsAuthorisation, fn(f) {
                json.object(facet_view(f, now))
              }),
            ),
          ]),
        ),
        #("regulatoryState", regulatory_state(p, now)),
        #("policyVersion", json.int(agent_rules.policy_version)),
        #("createdAt", json.int(r.created_at)),
        #("updatedAt", json.int(r.updated_at)),
      ],
      rev.meta(profile_rev(p)),
      [
        #(
          "history",
          json.array(p.history, fn(h) {
            json.object([
              #("id", id.profile_event_json(h.id)),
              #("at", json.int(h.at)),
              #("action", profile_event_row.action_to_json(h.action)),
              #("detail", profile_event_detail(h)),
            ])
          }),
        ),
        #(
          "honest",
          json.string(
            "Verification states are derived from recorded provenance. A licence number you typed is a declaration, not a verified licence. No FIFA, FA or U.S. Soccer register integration exists in this build.",
          ),
        ),
      ],
    ]),
  )
}

fn optional_profile_view(p: Option(Profile), now: Int) -> Json {
  case p {
    Some(p) -> profile_view(p, now)
    None -> json.null()
  }
}

fn affiliation_rev(a: Affiliation) -> rev.Rev {
  rev.Rev(a.row.rev, a.row.rev_at, a.row.rev_by_name)
}

fn agreement_rev(a: agreement_row.Row) -> rev.Rev {
  rev.Rev(a.rev, a.rev_at, a.rev_by_name)
}

fn tiers_json(t: List(AgencyTier)) -> Json {
  json.array(t, agency_tier.to_json)
}

/// The team page's rows: active members first, each group by start.
fn member_rows(
  r: Read,
  org: id.OrgId,
  now: Int,
) -> Result(List(#(Affiliation, List(#(String, Json)))), Fail(e)) {
  use affiliations <- result.try(agent_store.affiliations_for_agency(r, org))
  use rows <- result.map(
    list.try_map(affiliations, fn(a) {
      use user <- result.try(staff.by_id(r, a.row.user_id))
      use p <- result.map(agent_store.profile_for_user(r, a.row.user_id))
      let active = agent_rules.active(a, now)
      #(
        a,
        list.flatten([
          [
            #("affiliationId", id.affiliation_json(a.row.id)),
            #("userId", id.org_user_json(a.row.user_id)),
            #(
              "name",
              json.nullable(option.map(user, fn(u) { u.name }), json.string),
            ),
            #(
              "role",
              json.nullable(option.map(user, fn(u) { u.role }), json.string),
            ),
            #("tiers", tiers_json(a.tiers)),
            #("active", json.bool(active)),
            #("startedAt", json.int(a.row.started_at)),
            #("endedAt", opt_int(a.row.ended_at)),
            #("endedReason", opt_text(a.row.ended_reason)),
            #("licensed", json.bool(option.is_some(p))),
            #(
              "fifaLicence",
              json.nullable(
                option.map(p, fn(p) { state_of(p, FifaLicence, None, now) }),
                facet_state.to_json,
              ),
            ),
          ],
          rev.meta(affiliation_rev(a)),
        ]),
      )
    }),
  )
  list.sort(rows, fn(x, y) {
    let xa = agent_rules.active(x.0, now)
    let ya = agent_rules.active(y.0, now)
    case xa, ya {
      True, False -> order.Lt
      False, True -> order.Gt
      _, _ -> int.compare(x.0.row.started_at, y.0.row.started_at)
    }
  })
}

fn member_row(
  ctx: Ctx,
  org: id.OrgId,
  affiliation_id: id.AffiliationId,
  next: fn(Json) -> Response,
) -> Response {
  let now = clock.now_ms()
  use rows <- reading(ctx, fn(r) { member_rows(r, org, now) })
  case list.find(rows, fn(m) { { m.0 }.row.id == affiliation_id }) {
    Ok(m) -> next(json.object(m.1))
    Error(Nil) -> next(json.null())
  }
}

// ---------------------------------------------------------------------------------------- client identity

/// A player's view fields as this organisation sees them, if it may.
fn visible_player(
  r: Read,
  org: orgs.Org,
  player_id: String,
  now: Int,
) -> Result(Option(#(Player, Bool, List(#(String, Json)))), Fail(e)) {
  use found <- result.map(players.for_org(r, id.player(player_id), org, now))
  option.map(found, fn(pair) {
    let #(p, access) = pair
    let visible = access.visible && !access.blocked
    #(p, visible, case visible {
      True -> players.org_fields(p, org, access, now)
      False -> []
    })
  })
}

fn view_field(view: List(#(String, Json)), key: String) -> Json {
  list.key_find(view, key) |> result.unwrap(json.null())
}

fn minimal(p: Player, view: List(#(String, Json))) -> List(#(String, Json)) {
  [
    #("id", id.player_json(p.row.id)),
    #("name", json.string(p.row.name)),
    #("position", view_field(view, "position")),
    #("age", view_field(view, "age")),
    #("club", view_field(view, "club")),
    #("country", view_field(view, "country")),
  ]
}

/// What the agent may see of a client, by relationship state.
fn client_identity(
  r: Read,
  a: agreement_row.Row,
  m: Member,
  now: Int,
) -> Result(Json, Fail(e)) {
  use found <- result.map(visible_player(r, m.access.org, a.client_id, now))
  case found {
    None ->
      json.object([
        #("id", json.string(a.client_id)),
        #("name", json.null()),
        #("removed", json.bool(True)),
      ])
    Some(#(p, False, _)) ->
      json.object([
        #("id", id.player_json(p.row.id)),
        #("name", json.null()),
        #("unavailable", json.bool(True)),
      ])
    Some(#(p, True, view)) ->
      case agent_rules.grants_access(a, m.access.user.id, now) {
        True ->
          json.object(
            list.append(view, [
              #("accessBasis", json.string("active_confirmed_relationship")),
            ]),
          )
        False ->
          json.object(
            list.append(minimal(p, view), [
              #(
                "accessBasis",
                json.string(case agent_rules.effective_status(a, now) {
                  agreement_status.Proposed -> "pending_request"
                  _ -> "none"
                }),
              ),
            ]),
          )
      }
  }
}

fn relationship_for_agent(
  r: Read,
  a: Agreement,
  m: Member,
  now: Int,
) -> Result(Json, Fail(e)) {
  use client <- result.map(client_identity(r, a.row, m, now))
  json.object(
    list.append(agent_rules.agreement_for_agent(a, now), [#("client", client)]),
  )
}

fn summary_row(
  r: Read,
  a: Agreement,
  m: Member,
  now: Int,
) -> Result(Json, Fail(e)) {
  use found <- result.map(visible_player(r, m.access.org, a.row.client_id, now))
  let name = case found {
    Some(#(p, True, _)) -> json.string(p.row.name)
    _ -> json.null()
  }
  json.object(
    list.append(agent_rules.summary_for_staff(a.row, now), [
      #(
        "client",
        json.object([#("id", json.string(a.row.client_id)), #("name", name)]),
      ),
    ]),
  )
}

fn own_row(
  r: Read,
  a: Agreement,
  m: Member,
  now: Int,
) -> Result(Json, Fail(e)) {
  use client <- result.map(client_identity(r, a.row, m, now))
  json.object(
    list.flatten([
      agent_rules.agreement_for_agent(a, now),
      [#("client", client), #("mode", json.string("own"))],
    ]),
  )
}

/// The agent's identity as their client sees it.
fn agent_identity(
  r: Read,
  a: agreement_row.Row,
  now: Int,
) -> Result(Json, Fail(e)) {
  use user <- result.try(staff.by_id(r, a.agent_user_id))
  use p <- result.try(agent_store.profile_for_user(r, a.agent_user_id))
  use org <- result.map(orgs.by_id(r, a.agency_org_id))
  let fifa = option.map(p, fn(p) { state_of(p, FifaLicence, None, now) })
  json.object([
    #("userId", id.org_user_json(a.agent_user_id)),
    #(
      "displayName",
      json.nullable(
        case p, user {
          Some(p), _ -> Some(p.row.display_name)
          None, Some(u) -> Some(u.name)
          None, None -> None
        },
        json.string,
      ),
    ),
    #(
      "agency",
      json.nullable(org, fn(o) {
        json.object([#("id", id.org_json(o.id)), #("name", json.string(o.name))])
      }),
    ),
    #(
      "verification",
      json.nullable(p, fn(p) {
        json.object([
          #(
            "fifaLicence",
            facet_state.to_json(state_of(p, FifaLicence, None, now)),
          ),
          #(
            "jurisdictions",
            json.array(p.jurisdictions, fn(ma) {
              json.object([
                #("memberAssociation", jurisdiction.to_json(ma)),
                #(
                  "nationalRegistration",
                  facet_state.to_json(state_of(
                    p,
                    agent_facet.NationalRegistration,
                    Some(ma),
                    now,
                  )),
                ),
              ])
            }),
          ),
        ])
      }),
    ),
    #(
      "honest",
      json.string(case fifa {
        Some(facet_state.Verified) ->
          "Verified against recorded provenance; check the provenance before relying on it."
        _ -> "This agent's licence is NOT verified in ScoutBox."
      }),
    ),
  ])
}

fn relationship_for_client(
  r: Read,
  a: Agreement,
  now: Int,
) -> Result(Json, Fail(e)) {
  use agent <- result.map(agent_identity(r, a.row, now))
  json.object(
    list.append(agent_rules.agreement_for_client(a, now), [#("agent", agent)]),
  )
}

// ================================================================================================ ORG: me

/// `GET /org/agent/me`.
pub fn me(ctx: Ctx, a: OrgAccess) -> Response {
  use m <- membership(ctx, a)
  let now = clock.now_ms()
  use p <- reading(ctx, fn(r) { agent_store.profile_for_user(r, a.user.id) })
  http.json(
    200,
    json.object([
      #(
        "user",
        json.object([
          #("id", id.org_user_json(a.user.id)),
          #("name", json.string(a.user.name)),
          #("role", json.string(a.user.role)),
        ]),
      ),
      #("org", json.object(orgs.view(a.org))),
      #(
        "affiliation",
        json.object(list.append(
          [
            #("id", id.affiliation_json(m.affiliation.row.id)),
            #("tiers", tiers_json(tiers(m))),
            #("startedAt", json.int(m.affiliation.row.started_at)),
          ],
          rev.meta(affiliation_rev(m.affiliation)),
        )),
      ),
      #(
        "capabilities",
        json.array(agent_rules.capabilities_of(tiers(m)), json.string),
      ),
      #("profile", optional_profile_view(p, now)),
      #(
        "platform",
        json.object([
          #(
            "testVerificationProvider",
            json.bool(ctx.config.agent_verification_test),
          ),
        ]),
      ),
      #("policyVersion", json.int(agent_rules.policy_version)),
    ]),
  )
}

fn unread_count(r: Read, user: id.OrgUserId) -> Result(Int, Fail(e)) {
  store.one(
    r,
    "SELECT COUNT(*) FROM notifications WHERE audience_kind = 'org_user' AND audience_id = ? AND read = 0",
    [id.org_user_sql(user)],
    decode.at([0], decode.int),
  )
  |> result.map(result.unwrap(_, 0))
}

/// `GET /org/agent/home`.
pub fn home(ctx: Ctx, a: OrgAccess) -> Response {
  use m <- membership(ctx, a)
  let now = clock.now_ms()
  use #(p, mine, unread) <- reading(ctx, fn(r) {
    use p <- result.try(agent_store.profile_for_user(r, a.user.id))
    use all <- result.try(agent_store.agreements_for_agency(r, a.org.id))
    use unread <- result.map(unread_count(r, a.user.id))
    #(p, list.filter(all, fn(x) { x.row.agent_user_id == a.user.id }), unread)
  })
  let #(counts, alerts) =
    list.fold(mine, #(#(0, 0, 0, 0, 0), []), fn(acc, x) {
      let #(#(active, pending, soon, disputed, expired), alerts) = acc
      case agent_rules.effective_status(x.row, now) {
        agreement_status.Active ->
          case x.row.end_at {
            Some(end) if end - now <= agent_rules.expiry_alert_ms -> #(
              #(active + 1, pending, soon + 1, disputed, expired),
              [
                json.object([
                  #("kind", json.string("expiring")),
                  #("agreementId", id.agreement_json(x.row.id)),
                  #("endAt", json.int(end)),
                ]),
                ..alerts
              ],
            )
            _ -> #(#(active + 1, pending, soon, disputed, expired), alerts)
          }
        agreement_status.Proposed -> #(
          #(active, pending + 1, soon, disputed, expired),
          alerts,
        )
        agreement_status.Disputed -> #(
          #(active, pending, soon, disputed + 1, expired),
          [
            json.object([
              #("kind", json.string("disputed")),
              #("agreementId", id.agreement_json(x.row.id)),
            ]),
            ..alerts
          ],
        )
        agreement_status.Expired -> #(
          #(active, pending, soon, disputed, expired + 1),
          alerts,
        )
        _ -> acc
      }
    })
  let alerts = list.reverse(alerts)
  let fifa = case p {
    Some(p) -> state_of(p, FifaLicence, None, now)
    None -> facet_state.Unverified
  }
  let alerts = case fifa {
    facet_state.Verified -> alerts
    _ ->
      list.append(alerts, [
        json.object([
          #("kind", json.string("verification")),
          #("facet", json.string("fifa_licence")),
          #("state", facet_state.to_json(fifa)),
        ]),
      ])
  }
  let alerts = case p {
    None -> alerts
    Some(p) ->
      list.append(
        alerts,
        list.filter_map(p.jurisdictions, fn(ma) {
          case agent_rules.verification_gap(Some(p), ma, now) {
            Some(agent_rules.VerificationRequired(facet:, state:, ..)) ->
              Ok(
                json.object([
                  #("kind", json.string("jurisdiction")),
                  #("memberAssociation", jurisdiction.to_json(ma)),
                  #("facet", agent_facet.to_json(facet)),
                  #("state", facet_state.to_json(state)),
                ]),
              )
            _ -> Error(Nil)
          }
        }),
      )
  }
  let #(active, pending, soon, disputed, expired) = counts
  http.json(
    200,
    json.object([
      #("profileState", facet_state.to_json(fifa)),
      #("hasProfile", json.bool(option.is_some(p))),
      #("tiers", tiers_json(tiers(m))),
      #(
        "counts",
        json.object([
          #("active", json.int(active)),
          #("pending", json.int(pending)),
          #("expiringSoon", json.int(soon)),
          #("disputed", json.int(disputed)),
          #("expired", json.int(expired)),
        ]),
      ),
      #("alerts", json.preprocessed_array(alerts)),
      #("unreadNotifications", json.int(unread)),
      #(
        "regulatoryNotice",
        json.string(
          "ScoutBox is infrastructure. It performs no football-agent services, adjudicates no conflicts and confirms no regulatory status. Relationship records here are confirmed by the client, not by ScoutBox.",
        ),
      ),
    ]),
  )
}

// =========================================================================================== ORG: profile

/// `GET /org/agent/profile`.
pub fn profile(ctx: Ctx, a: OrgAccess) -> Response {
  use _ <- membership(ctx, a)
  let now = clock.now_ms()
  use p <- reading(ctx, fn(r) { agent_store.profile_for_user(r, a.user.id) })
  http.json(
    200,
    json.object([
      #("profile", optional_profile_view(p, now)),
      #("states", json.array(facet_state.pairs, fn(x) { json.string(x.0) })),
      #("facets", json.array(agent_facet.pairs, fn(x) { json.string(x.0) })),
      #(
        "jurisdictions",
        json.array(jurisdiction.pairs, fn(x) { json.string(x.0) }),
      ),
    ]),
  )
}

type ProfileInput {
  ProfileInput(
    display_name: Option(Option(String)),
    licence_number: Option(Option(String)),
    jurisdictions: Option(List(Jurisdiction)),
  )
}

fn profile_shape() -> input.Shape(ProfileInput) {
  use display_name <- input.field(
    "displayName",
    input.clearable(input.text(display_name_max)),
  )
  use licence_number <- input.field(
    "fifaLicenceNumber",
    input.clearable(input.text(licence_number_max)),
  )
  use jurisdictions <- input.field(
    "jurisdictions",
    input.optional(jurisdictions_check()),
  )
  use <- rev.fields
  input.done(ProfileInput(display_name:, licence_number:, jurisdictions:))
}

/// `POST /org/agent/profile`: creates the agent's profile, or changes what they declared.
pub fn save_profile(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use m <- membership(ctx, a)
  use <- require(m, "profile.write.own")
  use <- limited(
    ctx,
    limits.AgentProfileWrite,
    id.org_user_to_string(a.user.id),
  )
  use b, raw <- body(req, profile_shape())
  let display_name = given(b.display_name)
  case display_name {
    Some(None) ->
      err("AGENT_INPUT_INVALID", "displayName must not be empty.", [
        #("field", json.string("displayName")),
        #("problem", json.string("blank")),
      ])
    _ -> {
      let licence = given(b.licence_number)
      let now = clock.now_ms()
      use existing <- reading(ctx, fn(r) {
        agent_store.profile_for_user(r, a.user.id)
      })
      case existing {
        None -> {
          use created <- act(ctx, fn(tx) {
            use profile_id <- result.try(id.next_agent_profile(tx))
            let name = case display_name {
              Some(Some(n)) -> n
              _ -> input.utf16_take(a.user.name, display_name_max)
            }
            let row =
              profile_row.Row(
                ..profile_row.new(
                  id: profile_id,
                  user_id: a.user.id,
                  agency_org_id: a.org.id,
                  display_name: name,
                  created_at: now,
                  updated_at: now,
                  rev: 1,
                ),
                rev_at: Some(now),
                declared_fifa_licence_number: option.flatten(licence),
              )
            use _ <- result.try(
              agent_store.create_profile(
                tx,
                row,
                option.unwrap(b.jurisdictions, []),
                by_org(a),
              )
              |> storage,
            )
            live(
              tx,
              live_event.AgentProfileCreated(
                id.org_to_string(a.org.id),
                id.org_user_to_string(a.user.id),
              ),
            )
            agent_store.profile_by_id(store.reading(tx), profile_id) |> storage
          })
          http.json(
            201,
            json.object([#("profile", optional_profile_view(created, now))]),
          )
        }
        Some(p) -> {
          use expected <- rev_expected(raw)
          use <- rev.guard(
            expected,
            profile_rev(p),
            "REPRESENTATION_VERSION_CONFLICT",
            [],
          )
          update_profile(
            ctx,
            a,
            m,
            p,
            display_name,
            licence,
            b.jurisdictions,
            now,
          )
        }
      }
    }
  }
}

fn rev_expected(raw: Dynamic, next: fn(rev.Expected) -> Response) -> Response {
  case rev.expected(raw) {
    Ok(e) -> next(e)
    Error(response) -> response
  }
}

fn update_profile(
  ctx: Ctx,
  a: OrgAccess,
  _m: Member,
  p: Profile,
  display_name: Option(Option(String)),
  licence: Option(Option(String)),
  jurisdictions: Option(List(Jurisdiction)),
  now: Int,
) -> Response {
  let name_change = case display_name {
    Some(Some(n)) if n != p.row.display_name -> Some(n)
    _ -> None
  }
  let licence_change = case licence {
    Some(n) if n != p.row.declared_fifa_licence_number -> Some(n)
    _ -> None
  }
  use updated <- act(ctx, fn(tx) {
    use _ <- result.try(
      case licence_change, agent_rules.facet_of(p, FifaLicence, None) {
        Some(n), Some(f)
          if f.state == facet_state.Verified && f.reference != n
        -> {
          use _ <- result.try(
            agent_store.set_facet(
              tx,
              facet_row.Row(
                ..f,
                state: facet_state.Unverified,
                note: Some(
                  "The declared licence number changed; re-submit for verification.",
                ),
              ),
            )
            |> storage,
          )
          use _ <- result.map(
            agent_store.profile_event(
              tx,
              p.row.id,
              now,
              by_org(a),
              agent_store.FacetStateChanged(
                FifaLicence,
                None,
                facet_state.Verified,
                facet_state.Unverified,
              ),
            )
            |> storage,
          )
          live(
            tx,
            live_event.AgentVerificationStateChanged(
              id.org_to_string(a.org.id),
              id.org_user_to_string(p.row.user_id),
              "fifa_licence",
              "UNVERIFIED",
            ),
          )
        }
        _, _ -> Ok(Nil)
      },
    )
    use _ <- result.try(
      agent_store.update_declared(
        tx,
        p.row.id,
        name_change,
        jurisdictions,
        licence_change,
      )
      |> storage,
    )
    use _ <- result.try(
      agent_store.bump_profile(
        tx,
        p.row.id,
        agent_store.bump_by(now, by_org(a)),
        True,
      )
      |> storage,
    )
    use _ <- result.try(
      agent_store.profile_event(
        tx,
        p.row.id,
        now,
        by_org(a),
        agent_store.ProfileUpdated(
          display_name: option.is_some(name_change),
          jurisdictions: option.is_some(jurisdictions),
          licence_number: option.is_some(licence_change),
        ),
      )
      |> storage,
    )
    agent_store.profile_by_id(store.reading(tx), p.row.id) |> storage
  })
  http.json(
    200,
    json.object([#("profile", optional_profile_view(updated, now))]),
  )
}

type FacetInput {
  FacetInput(reference: Option(String), member_association: Option(String))
}

fn facet_shape() -> input.Shape(FacetInput) {
  use reference <- input.field(
    "reference",
    input.nullish(input.text(reference_max)),
  )
  use member_association <- input.field(
    "memberAssociation",
    input.nullish(input.text(3)),
  )
  input.done(FacetInput(reference:, member_association:))
}

/// `POST /org/agent/profile/facets/:facet/submit`: with no register provider in production, a submission goes to
/// attributed Trust & Safety review.
pub fn submit_facet(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  facet_name: String,
) -> Response {
  use m <- membership(ctx, a)
  use <- require(m, "verification.submit")
  use <- limited(
    ctx,
    limits.AgentProfileWrite,
    id.org_user_to_string(a.user.id),
  )
  case agent_facet.from_string(facet_name) {
    Error(Nil) ->
      refuse("AGENT_FACET_INVALID", [
        #("allowed", json.array(agent_facet.pairs, fn(x) { json.string(x.0) })),
      ])
    Ok(facet) -> {
      use found <- reading(ctx, fn(r) {
        agent_store.profile_for_user(r, a.user.id)
      })
      case found {
        None ->
          err("AGENT_PROFILE_REQUIRED", "Create your agent profile first.", [])
        Some(p) -> {
          use b, _ <- body(req, facet_shape())
          case input.filled(b.reference) {
            None ->
              err("AGENT_INPUT_INVALID", "A reference is required.", [
                #("field", json.string("reference")),
                #("problem", json.string("required")),
              ])
            Some(reference) -> {
              let ma = case facet {
                FifaLicence -> Ok(None)
                _ ->
                  case
                    input.filled(b.member_association)
                    |> option.map(string.uppercase)
                    |> option.unwrap("")
                    |> jurisdiction.from_string
                  {
                    Ok(jurisdiction.INT) | Error(Nil) -> Error(Nil)
                    Ok(j) -> Ok(Some(j))
                  }
              }
              case ma {
                Error(Nil) ->
                  refuse("AGENT_JURISDICTION_INVALID", [
                    #(
                      "allowed",
                      json.array(
                        list.filter(jurisdiction.pairs, fn(x) {
                          x.1 != jurisdiction.INT
                        }),
                        fn(x) { json.string(x.0) },
                      ),
                    ),
                  ])
                Ok(ma) -> submit(ctx, a, p, facet, ma, reference)
              }
            }
          }
        }
      }
    }
  }
}

fn submit(
  ctx: Ctx,
  a: OrgAccess,
  p: Profile,
  facet: AgentFacet,
  ma: Option(Jurisdiction),
  reference: String,
) -> Response {
  let now = clock.now_ms()
  let answer =
    verification_provider.answer(
      ctx.config.agent_verification_test,
      facet,
      reference,
      now,
    )
  case
    verification_provider.facet_record(
      answer,
      p.row.id,
      facet,
      ma,
      reference,
      now,
    )
  {
    None ->
      err(
        "REGULATORY_PROVIDER_UNAVAILABLE",
        "The verification source is unavailable. Nothing was recorded; try again later or the reference will be queued for attributed review when the source answers.",
        [#("retryAfter", json.int(300))],
      )
    Some(next) -> {
      let prev =
        agent_rules.facet_of(p, facet, ma)
        |> option.map(fn(f) { f.state })
        |> option.unwrap(facet_state.Unverified)
      let changed = prev != next.state
      use updated <- act(ctx, fn(tx) {
        use _ <- result.try(agent_store.set_facet(tx, next) |> storage)
        use _ <- result.try(
          agent_store.bump_profile(
            tx,
            p.row.id,
            agent_store.bump_by(now, by_org(a)),
            True,
          )
          |> storage,
        )
        use _ <- result.try(
          agent_store.profile_event(
            tx,
            p.row.id,
            now,
            by_org(a),
            agent_store.FacetSubmitted(facet, ma),
          )
          |> storage,
        )
        use _ <- result.try(case changed {
          True ->
            agent_store.profile_event(
              tx,
              p.row.id,
              now,
              by_org(a),
              agent_store.FacetStateChanged(facet, ma, prev, next.state),
            )
            |> storage
          False -> Ok(Nil)
        })
        use _ <- result.try(case next.state {
          facet_state.ManualReviewRequired ->
            facet_needs_review(tx, a, p, facet, ma, now) |> storage
          _ -> Ok(Nil)
        })
        use _ <- result.try(case changed {
          False -> Ok(Nil)
          True -> {
            live(
              tx,
              live_event.AgentVerificationStateChanged(
                id.org_to_string(a.org.id),
                id.org_user_to_string(p.row.user_id),
                agent_facet.to_string(facet),
                facet_state.to_string(next.state),
              ),
            )
            case next.state {
              facet_state.Verified
              | facet_state.Inactive
              | facet_state.ManualReviewRequired ->
                notify_staff(
                  tx,
                  p.row.user_id,
                  "agent_verification",
                  "Verification facet "
                    <> agent_facet.to_string(facet)
                    <> case ma {
                    Some(j) -> " (" <> jurisdiction.to_string(j) <> ")"
                    None -> ""
                  }
                    <> " is now "
                    <> facet_state.to_string(next.state)
                  |> string.replace("_", " ")
                  |> string.lowercase
                    <> ".",
                  id.agent_profile_to_string(p.row.id),
                  now,
                )
                |> storage
              _ -> Ok(Nil)
            }
          }
        })
        agent_store.profile_by_id(store.reading(tx), p.row.id) |> storage
      })
      http.json(
        200,
        json.object([
          #("profile", optional_profile_view(updated, now)),
          #("facet", json.object(facet_view(next, now))),
          #(
            "provider",
            json.string(case ctx.config.agent_verification_test {
              True -> "local-synthetic-test-provider"
              False -> "none"
            }),
          ),
        ]),
      )
    }
  }
}

/// Opens a review for a facet submission no register can answer, once per facet.
fn facet_needs_review(
  tx: Tx,
  a: OrgAccess,
  p: Profile,
  facet: AgentFacet,
  ma: Option(Jurisdiction),
  now: Int,
) -> Result(Nil, Fail(e)) {
  let r = store.reading(tx)
  use open <- result.try(reviews.open_for_facet(r, p.row.id, facet, ma))
  case open {
    True -> Ok(Nil)
    False -> {
      use policies <- result.try(approach_policy.published(r))
      let set =
        approach_policy.applicable(
          policies,
          list.map(option.values([ma]), jurisdiction.to_string),
          now,
        )
      reviews.create(
        tx,
        p.row.agency_org_id,
        Some(p.row.user_id),
        reviews.FacetSubject(p.row.id, p.row.user_id, facet, ma),
        [no_rule_reason("NO_PROVIDER")],
        list.map(set.policies, fn(x) { x.row.id }),
        requested_by_org(a),
        now,
      )
      |> result.replace(Nil)
    }
  }
}

fn no_rule_reason(code: String) -> approach_policy.Reason {
  approach_policy.Reason(
    code:,
    rule_id: None,
    rule_status: rule_status.Unknown,
    regulator: None,
    jurisdiction: None,
    policy_version: None,
    facet: None,
    member_association: None,
    state: None,
  )
}

// ============================================================================================= ORG: agency

/// `GET /org/agent/agency`.
pub fn agency(ctx: Ctx, a: OrgAccess) -> Response {
  use _ <- membership(ctx, a)
  let now = clock.now_ms()
  use #(members, settings, agreements) <- reading(ctx, fn(r) {
    use members <- result.try(agent_store.affiliations_for_agency(r, a.org.id))
    use settings <- result.try(agent_store.settings(r, a.org.id))
    use agreements <- result.map(agent_store.agreements_for_agency(r, a.org.id))
    #(members, settings, agreements)
  })
  let active = list.filter(members, agent_rules.active(_, now))
  let with = fn(t) { list.count(active, fn(m) { list.contains(m.tiers, t) }) }
  let rels = fn(st) {
    list.count(agreements, fn(x) {
      agent_rules.effective_status(x.row, now) == st
    })
  }
  http.json(
    200,
    json.object([
      #("org", json.object(orgs.view(a.org))),
      #("settings", settings_json(settings)),
      #(
        "members",
        json.object([
          #("active", json.int(list.length(active))),
          #("admins", json.int(with(agency_tier.AgencyAdmin))),
          #("licensedAgents", json.int(with(agency_tier.LicensedAgent))),
        ]),
      ),
      #(
        "relationships",
        json.object([
          #("active", json.int(rels(agreement_status.Active))),
          #("pending", json.int(rels(agreement_status.Proposed))),
        ]),
      ),
      #("tiers", tiers_json(agent_rules.tiers)),
      #(
        "permissions",
        json.object(
          list.map(agent_rules.permissions(), fn(p) { #(p.0, tiers_json(p.1)) }),
        ),
      ),
      #(
        "honest",
        json.string(
          "An agency organisation holds no football-agent licence. Roles here decide what a member may do in ScoutBox, never whether they may perform football-agent services.",
        ),
      ),
    ]),
  )
}

fn settings_json(s: #(List(Jurisdiction), String)) -> Json {
  json.object([
    #("jurisdictions", json.array(s.0, jurisdiction.to_json)),
    #("description", json.string(s.1)),
  ])
}

/// `GET /org/agent/agency/team`.
pub fn team(ctx: Ctx, a: OrgAccess) -> Response {
  use m <- membership(ctx, a)
  use <- require(m, "agency.team.read")
  let now = clock.now_ms()
  use rows <- reading(ctx, fn(r) { member_rows(r, a.org.id, now) })
  http.json(
    200,
    json.object([
      #("members", json.array(rows, fn(m) { json.object(m.1) })),
      #("tiers", tiers_json(agent_rules.tiers)),
    ]),
  )
}

type NewMember {
  NewMember(
    name: Option(String),
    role: Option(Option(String)),
    tiers: List(AgencyTier),
    client_key: Option(String),
  )
}

fn new_member_shape() -> input.Shape(NewMember) {
  use name <- input.field("name", input.nullish(input.text(staff_name_max)))
  use role <- input.field("role", input.clearable(input.text(staff_role_max)))
  use tiers <- input.field("tiers", input.required(tiers_check()))
  use client_key <- client_key_field
  input.done(NewMember(name:, role:, tiers:, client_key:))
}

/// `POST /org/agent/agency/team`: an administrator adds a member, by name.
pub fn add_member(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use m <- membership(ctx, a)
  use <- require(m, "agency.team.write")
  use <- limited(ctx, limits.AgentAffiliationWrite, id.org_to_string(a.org.id))
  use b, _ <- body(req, new_member_shape())
  case input.filled(b.name) {
    None ->
      err("AGENT_INPUT_INVALID", "A name is required.", [
        #("field", json.string("name")),
        #("problem", json.string("required")),
      ])
    Some(name) -> {
      let role = option.flatten(given(b.role))
      use key <- client_key(b.client_key)
      let fp =
        fingerprint([
          #("name", canonical.Str(string.lowercase(name))),
          #(
            "tiers",
            canonical.strings(list.map(b.tiers, agency_tier.to_string)),
          ),
        ])
      let now = clock.now_ms()
      use hit <- reading(ctx, fn(r) {
        case key {
          Some(k) -> agent_store.affiliation_by_create_key(r, a.org.id, k)
          None -> Ok(None)
        }
      })
      case hit {
        Some(hit) ->
          case hit.row.create_fp == Some(fp) {
            True -> {
              use member <- member_row(ctx, a.org.id, hit.row.id)
              http.json(
                200,
                json.object([
                  #("member", member),
                  #("idempotent", json.bool(True)),
                ]),
              )
            }
            False -> refuse("AFFILIATION_IDEMPOTENCY_CONFLICT", [])
          }
        None -> {
          use #(user, affiliated) <- reading(ctx, fn(r) {
            use user <- result.try(staff.by_org_and_name(r, a.org.id, name))
            case user {
              Some(u) ->
                agent_store.active_affiliation(r, u.id, a.org.id, now)
                |> result.map(fn(x) { #(user, option.is_some(x)) })
              None -> Ok(#(None, False))
            }
          })
          case user, affiliated {
            Some(u), _ if u.removed_at != None ->
              not_permitted(
                "This person's access was removed; removal is not undone from the team page.",
              )
            Some(_), True -> refuse("MEMBER_ALREADY_AFFILIATED", [])
            _, _ -> {
              use aff_id <- act(ctx, fn(tx) {
                use member_id <- result.try(case user {
                  Some(u) -> Ok(u.id)
                  None ->
                    staff.create(
                      tx,
                      staff.NewStaff(
                        org_id: a.org.id,
                        name:,
                        role: option.unwrap(role, "Agency staff"),
                        email: None,
                        provenance: None,
                        created_at: now,
                      ),
                    )
                    |> result.map(fn(s) { s.id })
                    |> result.map_error(fn(e) {
                      case e {
                        store.Storage(e) -> store.Storage(e)
                        store.Stale(what) -> store.Stale(what)
                        store.Refuse(_) ->
                          store.Refuse(refuse("MEMBER_ALREADY_AFFILIATED", []))
                      }
                    })
                })
                use aff_id <- result.try(id.next_affiliation(tx) |> storage)
                let row =
                  affiliation_row.Row(
                    ..affiliation_row.new(
                      id: aff_id,
                      agency_org_id: a.org.id,
                      user_id: member_id,
                      started_at: now,
                      created_at: now,
                      rev: 1,
                    ),
                    rev_at: Some(now),
                    create_key: key,
                    create_fp: option.map(key, fn(_) { fp }),
                  )
                use _ <- result.try(
                  agent_store.create_affiliation(
                    tx,
                    row,
                    b.tiers,
                    by_org(a),
                    False,
                  )
                  |> storage,
                )
                live(
                  tx,
                  live_event.AgencyAffiliationCreated(
                    id.org_to_string(a.org.id),
                    id.org_user_to_string(member_id),
                  ),
                )
                use _ <- result.map(
                  notify_staff(
                    tx,
                    member_id,
                    "agency_membership",
                    "You were added to "
                      <> a.org.name
                      <> " ("
                      <> string.join(
                      list.map(b.tiers, agency_tier.to_string),
                      ", ",
                    )
                      <> ").",
                    id.affiliation_to_string(aff_id),
                    now,
                  )
                  |> storage,
                )
                aff_id
              })
              use member <- member_row(ctx, a.org.id, aff_id)
              http.json(201, json.object([#("member", member)]))
            }
          }
        }
      }
    }
  }
}

fn active_member(
  ctx: Ctx,
  a: OrgAccess,
  user_id: String,
  next: fn(Affiliation) -> Response,
) -> Response {
  use found <- reading(ctx, fn(r) {
    agent_store.active_affiliation(
      r,
      id.org_user(user_id),
      a.org.id,
      clock.now_ms(),
    )
  })
  case found {
    Some(aff) -> next(aff)
    None -> refuse("MEMBER_NOT_FOUND", [])
  }
}

fn change_problem(
  ctx: Ctx,
  a: OrgAccess,
  target: Affiliation,
  next_tiers: List(AgencyTier),
  ending: Bool,
  next: fn() -> Response,
) -> Response {
  use all <- reading(ctx, fn(r) {
    agent_store.affiliations_for_agency(r, a.org.id)
  })
  case
    agent_rules.affiliation_change_problem(
      all,
      target,
      a.user.id,
      next_tiers,
      ending,
      clock.now_ms(),
    )
  {
    None -> next()
    Some(problem) ->
      err(
        agent_rules.change_problem_code(problem),
        case problem, ending {
          agent_rules.SelfPromotionBlocked, _ ->
            "You cannot grant yourself the administrator role."
          _, _ -> "An agency must keep at least one administrator."
        },
        [],
      )
  }
}

type MemberTiers {
  MemberTiers(tiers: List(AgencyTier))
}

fn member_tiers_shape() -> input.Shape(MemberTiers) {
  use tiers <- input.field("tiers", input.required(tiers_check()))
  use <- rev.fields
  input.done(MemberTiers(tiers:))
}

/// `PATCH /org/agent/agency/team/:userId`: a member's roles.
pub fn set_member_tiers(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  user_id: String,
) -> Response {
  use m <- membership(ctx, a)
  use <- require(m, "agency.team.write")
  use <- limited(ctx, limits.AgentAffiliationWrite, id.org_to_string(a.org.id))
  use aff <- active_member(ctx, a, user_id)
  use b, raw <- body(req, member_tiers_shape())
  use <- change_problem(ctx, a, aff, b.tiers, False)
  use expected <- rev_expected(raw)
  use <- rev.guard(
    expected,
    affiliation_rev(aff),
    "AFFILIATION_VERSION_CONFLICT",
    [
      #("tiers", tiers_json(aff.tiers)),
    ],
  )
  let now = clock.now_ms()
  use _ <- act(ctx, fn(tx) {
    use _ <- result.try(
      agent_store.set_tiers(tx, aff.row.id, b.tiers) |> storage,
    )
    use _ <- result.try(
      agent_store.bump_affiliation(
        tx,
        aff.row.id,
        agent_store.bump_by(now, by_org(a)),
      )
      |> storage,
    )
    agent_store.affiliation_event(
      tx,
      aff.row.id,
      now,
      by_org(a),
      agent_store.AffiliationUpdated(aff.tiers, b.tiers),
    )
    |> storage
  })
  use member <- member_row(ctx, a.org.id, aff.row.id)
  http.json(200, json.object([#("member", member)]))
}

type MemberEnd {
  MemberEnd(reason: Option(Option(String)))
}

fn member_end_shape() -> input.Shape(MemberEnd) {
  use reason <- input.field(
    "reason",
    input.clearable(input.text(reason_code_max)),
  )
  use <- rev.fields
  input.done(MemberEnd(reason:))
}

/// `POST /org/agent/agency/team/:userId/end`: the membership ends, and with it the person's access.
pub fn end_member(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  user_id: String,
) -> Response {
  use m <- membership(ctx, a)
  use <- require(m, "agency.team.write")
  use <- limited(ctx, limits.AgentAffiliationWrite, id.org_to_string(a.org.id))
  use aff <- active_member(ctx, a, user_id)
  use b, raw <- body(req, member_end_shape())
  let reason = given(b.reason) |> option.flatten |> option.unwrap("left")
  use <- change_problem(ctx, a, aff, [], True)
  use expected <- rev_expected(raw)
  use <- rev.guard(
    expected,
    affiliation_rev(aff),
    "AFFILIATION_VERSION_CONFLICT",
    [],
  )
  let now = clock.now_ms()
  use _ <- act(ctx, fn(tx) {
    use _ <- result.try(
      agent_store.end_affiliation(tx, aff.row.id, now, reason) |> storage,
    )
    use _ <- result.try(
      agent_store.bump_affiliation(
        tx,
        aff.row.id,
        agent_store.bump_by(now, by_org(a)),
      )
      |> storage,
    )
    use _ <- result.try(
      agent_store.affiliation_event(
        tx,
        aff.row.id,
        now,
        by_org(a),
        agent_store.AffiliationEnded(reason),
      )
      |> storage,
    )
    live(
      tx,
      live_event.AgencyAffiliationEnded(
        id.org_to_string(a.org.id),
        id.org_user_to_string(aff.row.user_id),
      ),
    )
    // The person's agent profile and historical attributions stay as they are.
    use user <- result.try(
      staff.by_id(store.reading(tx), aff.row.user_id) |> storage,
    )
    use _ <- result.try(case user {
      Some(u) if u.removed_at == None ->
        staff.remove(tx, u.id, at: now, by: a.user.id)
        |> result.replace(Nil)
        |> result.map_error(fn(e) {
          case e {
            store.Storage(e) -> store.Storage(e)
            store.Stale(what) -> store.Stale(what)
            store.Refuse(_) ->
              store.Refuse(http.internal("staff removal refused"))
          }
        })
      _ -> Ok(Nil)
    })
    sessions.revoke_org_user(tx, aff.row.user_id) |> storage
  })
  use member <- member_row(ctx, a.org.id, aff.row.id)
  http.json(200, json.object([#("member", member)]))
}

type SettingsInput {
  SettingsInput(
    jurisdictions: Option(List(Jurisdiction)),
    description: Option(Option(String)),
  )
}

fn settings_shape() -> input.Shape(SettingsInput) {
  use jurisdictions <- input.field(
    "jurisdictions",
    input.optional(jurisdictions_check()),
  )
  use description <- input.field(
    "description",
    input.clearable(input.text(description_max)),
  )
  input.done(SettingsInput(jurisdictions:, description:))
}

/// `PATCH /org/agent/agency/settings`.
pub fn save_settings(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use m <- membership(ctx, a)
  use <- require(m, "agency.settings.write")
  use <- limited(ctx, limits.AgentAffiliationWrite, id.org_to_string(a.org.id))
  use b, _ <- body(req, settings_shape())
  use current <- reading(ctx, fn(r) { agent_store.settings(r, a.org.id) })
  let jurisdictions = option.unwrap(b.jurisdictions, current.0)
  let save = fn(description) {
    let now = clock.now_ms()
    use saved <- act(ctx, fn(tx) {
      use _ <- result.try(
        agent_store.save_settings(tx, a.org.id, jurisdictions, description, now)
        |> storage,
      )
      agent_store.settings(store.reading(tx), a.org.id) |> storage
    })
    http.json(200, json.object([#("settings", settings_json(saved))]))
  }
  case b.description {
    None -> save(current.1)
    Some(d) -> {
      let d = option.unwrap(d, "")
      case d {
        "" -> save(d)
        _ -> {
          use <- moderate.or_refuse(
            ctx,
            d,
            audit.Context(
              kind: "agency_settings",
              player_id: None,
              org_id: Some(a.org.id),
              user_id: None,
              channel_id: None,
              request_id: None,
            ),
          )
          save(d)
        }
      }
    }
  }
}

/// `GET /org/agent/agency/compliance`: informational only.
pub fn compliance(ctx: Ctx, a: OrgAccess) -> Response {
  use m <- membership(ctx, a)
  use <- require(m, "agency.compliance.read")
  let now = clock.now_ms()
  use rows <- reading(ctx, fn(r) {
    use members <- result.try(member_rows(r, a.org.id, now))
    members
    |> list.filter(fn(x) {
      agent_rules.active(x.0, now)
      && list.contains({ x.0 }.tiers, agency_tier.LicensedAgent)
    })
    |> list.try_map(fn(x) {
      let aff = x.0
      use user <- result.try(staff.by_id(r, aff.row.user_id))
      use p <- result.map(agent_store.profile_for_user(r, aff.row.user_id))
      json.object([
        #("userId", id.org_user_json(aff.row.user_id)),
        #(
          "name",
          json.nullable(option.map(user, fn(u) { u.name }), json.string),
        ),
        #("hasProfile", json.bool(option.is_some(p))),
        #(
          "fifaLicence",
          facet_state.to_json(case p {
            Some(p) -> state_of(p, FifaLicence, None, now)
            None -> facet_state.Unverified
          }),
        ),
        #("jurisdictions", case p {
          Some(p) -> regulatory_jurisdictions(p, now)
          None -> json.preprocessed_array([])
        }),
      ])
    })
  })
  http.json(
    200,
    json.object([
      #("agents", json.preprocessed_array(rows)),
      #("informational", json.bool(True)),
      #(
        "honest",
        json.string(
          "Informational only. Nothing here verifies, approves or overrides a regulatory state; attributed Trust & Safety review of agent licences is not available yet (G-C0).",
        ),
      ),
    ]),
  )
}

type AuditQuery {
  AuditQuery(limit: Option(Int), cursor: Option(String))
}

fn audit_query_shape() -> input.Shape(AuditQuery) {
  use limit <- input.field(
    "limit",
    input.optional(input.whole_number_text(1, 50)),
  )
  use cursor <- input.field("cursor", input.optional(input.text(id_max)))
  input.done(AuditQuery(limit:, cursor:))
}

/// `GET /org/agent/agency/audit`: the agency's agent, membership, representation and compliance rows, newest first.
pub fn agency_audit(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use m <- membership(ctx, a)
  use <- require(m, "agency.audit.read")
  use q <- query(req, audit_query_shape())
  let now = clock.now_ms()
  use all <- reading(ctx, fn(r) { agent_audit.rows(r, a.org, now) })
  let limit = option.unwrap(q.limit, 25)
  let start = case q.cursor {
    None -> Ok(0)
    Some(c) ->
      case
        list.index_map(all, fn(row, i) { #(row, i) })
        |> list.find(fn(x) { { x.0 }.id == c })
      {
        Ok(x) -> Ok(x.1 + 1)
        Error(Nil) -> Error(Nil)
      }
  }
  case start {
    Error(Nil) -> http.error(400, "AUDIT_CURSOR_INVALID")
    Ok(start) -> {
      let page = all |> list.drop(start) |> list.take(limit)
      http.json(
        200,
        json.object([
          #("items", json.array(page, agent_audit.view)),
          #(
            "nextCursor",
            case start + limit < list.length(all), list.last(page) {
              True, Ok(last) -> json.string(last.id)
              _, _ -> json.null()
            },
          ),
          #("total", json.int(list.length(all))),
        ]),
      )
    }
  }
}

// ======================================================================================= ORG: players lookup

type Lookup {
  Lookup(q: Option(String))
}

fn lookup_shape() -> input.Shape(Lookup) {
  use q <- input.field("q", input.optional(input.text(name_max)))
  input.done(Lookup(q:))
}

/// `GET /org/agent/players?q=`: adults only, visible and unblocked, by name, at most twenty.
pub fn players_lookup(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use m <- membership(ctx, a)
  use <- require(m, "players.lookup")
  use l <- query(req, lookup_shape())
  use <- limited(
    ctx,
    limits.AgentPlayerLookup,
    id.org_user_to_string(a.user.id),
  )
  let q = option.unwrap(l.q, "") |> string.trim |> string.lowercase
  case string.length(q) < 2 {
    True ->
      http.json(
        200,
        json.object([
          #("items", json.preprocessed_array([])),
          #("note", json.string("Type at least two characters.")),
        ]),
      )
    False -> {
      let now = clock.now_ms()
      use items <- reading(ctx, fn(r) {
        use ids <- result.try(store.query(
          r,
          "SELECT id FROM players WHERE deleted_at IS NULL ORDER BY rowid",
          [],
          decode.at([0], id.player_decoder()),
        ))
        use found <- result.map(players.for_org_many(r, ids, a.org, now))
        found
        |> list.filter(fn(x) {
          let #(p, access) = x
          players.is_adult(p, now)
          && access.visible
          && !access.blocked
          && string.contains(string.lowercase(p.row.name), q)
        })
        |> list.take(20)
        |> list.map(fn(x) {
          let #(p, access) = x
          json.object(minimal(p, players.org_fields(p, a.org, access, now)))
        })
      })
      http.json(
        200,
        json.object([
          #("items", json.preprocessed_array(items)),
          #("adultsOnly", json.bool(True)),
        ]),
      )
    }
  }
}

// ============================================================================================= ORG: clients

fn visible_agreements(
  r: Read,
  m: Member,
) -> Result(List(#(Agreement, Bool)), Fail(e)) {
  use all <- result.map(agent_store.agreements_for_agency(r, m.access.org.id))
  list.filter_map(all, fn(x) {
    case
      x.row.agent_user_id == m.access.user.id
      && agent_rules.can(tiers(m), "clients.read.own"),
      agent_rules.can(tiers(m), "clients.read.shared_summary")
      && x.row.share_with_agency_staff
    {
      True, _ -> Ok(#(x, True))
      False, True -> Ok(#(x, False))
      False, False -> Error(Nil)
    }
  })
}

/// `GET /org/agent/clients`.
pub fn clients(ctx: Ctx, a: OrgAccess) -> Response {
  use m <- membership(ctx, a)
  let now = clock.now_ms()
  use items <- reading(ctx, fn(r) {
    use rows <- result.try(visible_agreements(r, m))
    let sorted =
      list.sort(rows, fn(x, y) {
        let key = fn(a: Agreement) { a.row.proposed_at }
        int.compare(key(y.0), key(x.0))
      })
    list.try_map(sorted, fn(x) {
      case x.1 {
        True -> own_row(r, x.0, m, now)
        False -> summary_row(r, x.0, m, now)
      }
    })
  })
  http.json(
    200,
    json.object([
      #("items", json.preprocessed_array(items)),
      #("scopes", json.array(scope_row.scope_pairs, fn(x) { json.string(x.0) })),
      #("maxTermMonths", json.int(agent_rules.max_term_months)),
      #(
        "jurisdictions",
        json.array(jurisdiction.pairs, fn(x) { json.string(x.0) }),
      ),
    ]),
  )
}

type ClientRequest {
  ClientRequest(
    player_id: Option(String),
    scope: Option(List(scope_row.Scope)),
    term_months: Option(Int),
    jurisdiction: Option(String),
    exclusive: Option(Bool),
    client_key: Option(String),
  )
}

fn client_request_shape() -> input.Shape(ClientRequest) {
  use player_id <- input.field("playerId", input.optional(input.text(id_max)))
  use scope <- input.field(
    "scope",
    input.optional(input.distinct_list(input.one_of(scope_row.scope_pairs), 1)),
  )
  use term_months <- input.field(
    "termMonths",
    input.nullish(input.whole_number(1, agent_rules.max_term_months)),
  )
  use jurisdiction <- input.field("jurisdiction", input.nullish(input.text(3)))
  use exclusive <- input.field("exclusive", input.optional(input.boolean()))
  use client_key <- client_key_field
  input.done(ClientRequest(
    player_id:,
    scope:,
    term_months:,
    jurisdiction:,
    exclusive:,
    client_key:,
  ))
}

fn gap_message(facet: AgentFacet, ma: Option(Jurisdiction), state: FacetState) {
  "A regulated action needs a VERIFIED "
  <> agent_facet.to_string(facet)
  <> case ma {
    Some(j) -> " (" <> jurisdiction.to_string(j) <> ")"
    None -> ""
  }
  <> "; it is "
  <> facet_state.to_string(state)
  <> "."
}

fn reasons_json(reasons: List(approach_policy.Reason)) -> Json {
  reasons
  |> list.filter(fn(r) { r.code != "FACET_VERIFIED" })
  |> json.array(fn(r) { json.object(approach_policy.reason_fields(r)) })
}

/// `POST /org/agent/clients/request`: an approach is a regulated act, so the agent's required facets must be
/// VERIFIED; then a missing, minor, blocked and invisible player answer alike; then the policy layer decides.
pub fn request(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use m <- membership(ctx, a)
  use <- require(m, "clients.request")
  use b, _ <- body(req, client_request_shape())
  use key <- client_key(b.client_key)
  let scope = option.unwrap(b.scope, [scope_row.Employment])
  let term = option.unwrap(b.term_months, agent_rules.default_term_months)
  let j_text =
    input.filled(b.jurisdiction) |> option.unwrap("INT") |> string.uppercase
  case jurisdiction.from_string(j_text) {
    Error(Nil) ->
      refuse("AGENT_JURISDICTION_INVALID", [
        #("field", json.string("jurisdiction")),
        #("problem", json.string("not_allowed")),
        #("allowed", json.array(jurisdiction.pairs, fn(x) { json.string(x.0) })),
      ])
    Ok(j) -> {
      let exclusive = b.exclusive == Some(True)
      let player_id = option.unwrap(b.player_id, "")
      let fp =
        fingerprint([
          #("playerId", canonical.Str(player_id)),
          #(
            "scope",
            canonical.strings(list.map(scope, scope_row.scope_to_string)),
          ),
          #("termMonths", canonical.Int(term)),
          #("jurisdiction", canonical.Str(jurisdiction.to_string(j))),
          #("exclusive", canonical.Bool(exclusive)),
        ])
      let now = clock.now_ms()
      use hit <- reading(ctx, fn(r) {
        case key {
          Some(k) ->
            agent_store.agreement_by_request_key(r, a.org.id, a.user.id, k)
          None -> Ok(None)
        }
      })
      case hit {
        Some(hit) -> replay_request(ctx, m, hit, fp, now)
        None -> {
          use p <- reading(ctx, fn(r) {
            agent_store.profile_for_user(r, a.user.id)
          })
          case agent_rules.verification_gap(p, j, now) {
            Some(agent_rules.ProfileRequired) ->
              err(
                "AGENT_PROFILE_REQUIRED",
                "Create your agent profile first.",
                [],
              )
            Some(agent_rules.VerificationRequired(
              facet:,
              member_association:,
              state:,
            )) ->
              err(
                "AGENT_VERIFICATION_REQUIRED",
                gap_message(facet, member_association, state),
                [
                  #("facet", agent_facet.to_json(facet)),
                  #(
                    "memberAssociation",
                    json.nullable(member_association, jurisdiction.to_json),
                  ),
                  #("state", facet_state.to_json(state)),
                ],
              )
            None -> {
              let assert Some(p) = p
              // The quota counts attempts that reach a subject, not the agent's own refusals.
              use <- limited(
                ctx,
                limits.AgentRepresentationRequest,
                id.org_user_to_string(a.user.id),
              )
              propose(
                ctx,
                m,
                p,
                player_id,
                scope,
                term,
                j,
                exclusive,
                key,
                fp,
                now,
              )
            }
          }
        }
      }
    }
  }
}

fn replay_request(
  ctx: Ctx,
  m: Member,
  hit: Agreement,
  fp: String,
  now: Int,
) -> Response {
  case hit.row.request_fp == Some(fp) {
    False -> refuse("REPRESENTATION_IDEMPOTENCY_CONFLICT", [])
    True -> {
      use relationship <- reading(ctx, fn(r) {
        relationship_for_agent(r, hit, m, now)
      })
      http.json(
        200,
        json.object([
          #("relationship", relationship),
          #("idempotent", json.bool(True)),
        ]),
      )
    }
  }
}

fn conflict_response(c: agent_rules.Conflict) -> Response {
  case c {
    agent_rules.AlreadyExists(agreement_id:, status:) ->
      err(
        "REPRESENTATION_ALREADY_EXISTS",
        "A relationship with this player already exists or is pending.",
        [
          #("agreementId", id.agreement_json(agreement_id)),
          #("status", agreement_status.to_json(status)),
        ],
      )
    agent_rules.Cooldown(retry_at:) ->
      err(
        "REPRESENTATION_COOLDOWN",
        "A recent request to this player was declined or ended; wait before asking again.",
        [#("retryAt", json.int(retry_at))],
      )
  }
}

fn propose(
  ctx: Ctx,
  m: Member,
  p: Profile,
  player_id: String,
  scope: List(scope_row.Scope),
  term: Int,
  j: Jurisdiction,
  exclusive: Bool,
  key: Option(String),
  fp: String,
  now: Int,
) -> Response {
  let a = m.access
  use subject <- reading(ctx, fn(r) { visible_player(r, a.org, player_id, now) })
  case subject {
    Some(#(player, True, _)) ->
      case players.is_adult(player, now) {
        False -> refuse("PLAYER_NOT_FOUND", [])
        True -> {
          use #(conflict, decision, set) <- reading(ctx, fn(r) {
            use mine <- result.try(agent_store.agreements_for_agent_client(
              r,
              a.user.id,
              player_id,
            ))
            use theirs <- result.try(agent_store.agreements_for_client(
              r,
              player_id,
            ))
            use policies <- result.map(approach_policy.published(r))
            let set =
              approach_policy.applicable(
                policies,
                [jurisdiction.to_string(j)],
                now,
              )
            let others =
              theirs
              |> list.filter(fn(x) {
                x.row.agent_user_id != a.user.id
                && x.row.exclusive
                && agent_rules.effective_status(x.row, now)
                == agreement_status.Active
                && option.is_some(x.row.confirmed_at)
              })
              |> list.map(fn(x) { x.row.end_at })
            #(
              agent_rules.request_conflict(
                list.map(mine, fn(x) { x.row }),
                a.user.id,
                player_id,
                now,
              ),
              approach_policy.approach_adult(
                set,
                [jurisdiction.to_string(j)],
                fn(facet, ma) { state_of(p, facet, ma, now) },
                others,
                now,
              ),
              set,
            )
          })
          let policy_versions =
            list.map(set.policies, approach_policy.policy_id)
          case conflict, decision.facet_gaps {
            Some(c), _ -> conflict_response(c)
            None, [g, ..] ->
              err(g.code, gap_message(g.facet, g.member_association, g.state), [
                #("facet", agent_facet.to_json(g.facet)),
                #(
                  "memberAssociation",
                  json.nullable(g.member_association, jurisdiction.to_json),
                ),
                #("state", facet_state.to_json(g.state)),
              ])
            None, [] ->
              case decision.blocked, decision.requires_manual_review {
                True, _ ->
                  err(
                    "AGENT_ACTION_NOT_PERMITTED",
                    "An ACTIVE encoded rule does not permit this approach.",
                    [
                      #("reasons", reasons_json(decision.reasons)),
                      #(
                        "policyVersions",
                        json.array(policy_versions, json.string),
                      ),
                    ],
                  )
                False, True ->
                  approach_review(ctx, a, decision, player, j, set, now)
                False, False ->
                  create_request(
                    ctx,
                    m,
                    p,
                    player,
                    scope,
                    term,
                    j,
                    exclusive,
                    key,
                    fp,
                    policy_versions,
                    now,
                  )
              }
          }
        }
      }
    _ -> refuse("PLAYER_NOT_FOUND", [])
  }
}

/// The deciding rule is uncertain: the request is not sent, and a review item records the question.
fn approach_review(
  ctx: Ctx,
  a: OrgAccess,
  decision: approach_policy.Decision,
  player: Player,
  j: Jurisdiction,
  set: approach_policy.PolicySet,
  now: Int,
) -> Response {
  let unsupported =
    list.any(decision.reasons, fn(r) { r.code == "POLICY_NOT_ENCODED" })
  let reasons =
    list.filter(decision.reasons, fn(r) { r.code != "FACET_VERIFIED" })
  let versions = list.map(set.policies, fn(x) { x.row.id })
  use review_id <- act(ctx, fn(tx) {
    reviews.create(
      tx,
      a.org.id,
      Some(a.user.id),
      reviews.ApproachSubject(player.row.id, j),
      reasons,
      versions,
      requested_by_org(a),
      now,
    )
    |> storage
  })
  case unsupported {
    True ->
      err(
        "JURISDICTION_UNSUPPORTED",
        "No encoded policy covers this jurisdiction; the request cannot proceed.",
        [
          #("reasons", reasons_json(reasons)),
          #(
            "policyVersions",
            json.array(
              list.map(set.policies, approach_policy.policy_id),
              json.string,
            ),
          ),
          #("reviewId", id.regulatory_review_json(review_id)),
        ],
      )
    False ->
      err(
        "REGULATORY_REVIEW_REQUIRED",
        "The deciding rule's operative status is uncertain. The request was not sent; an attributed Trust & Safety review item records the question.",
        [
          #("reasons", reasons_json(reasons)),
          #(
            "policyVersions",
            json.array(
              list.map(set.policies, approach_policy.policy_id),
              json.string,
            ),
          ),
          #("reviewId", id.regulatory_review_json(review_id)),
        ],
      )
  }
}

fn create_request(
  ctx: Ctx,
  m: Member,
  p: Profile,
  player: Player,
  scope: List(scope_row.Scope),
  term: Int,
  j: Jurisdiction,
  exclusive: Bool,
  key: Option(String),
  fp: String,
  policy_versions: List(String),
  now: Int,
) -> Response {
  let a = m.access
  let player_id = id.player_to_string(player.row.id)
  use agreement <- act(ctx, fn(tx) {
    let r = store.reading(tx)
    // Parallel requests: whatever another unit committed since the checks above decides.
    use mine <- result.try(
      agent_store.agreements_for_agent_client(r, a.user.id, player_id)
      |> storage,
    )
    use _ <- result.try(
      case
        agent_rules.request_conflict(
          list.map(mine, fn(x) { x.row }),
          a.user.id,
          player_id,
          now,
        )
      {
        Some(c) -> store.refuse(conflict_response(c))
        None -> Ok(Nil)
      },
    )
    use replayed <- result.try(case key {
      Some(k) ->
        agent_store.agreement_by_request_key(r, a.org.id, a.user.id, k)
        |> storage
      None -> Ok(None)
    })
    use _ <- result.try(case replayed {
      Some(hit) -> store.refuse(replay_request(ctx, m, hit, fp, now))
      None -> Ok(Nil)
    })
    use agreement_id <- result.try(id.next_agreement(tx) |> storage)
    let row =
      agreement_row.Row(
        ..agreement_row.new(
          id: agreement_id,
          agent_user_id: a.user.id,
          agency_org_id: a.org.id,
          client_kind: agreement_row.Player,
          client_id: player_id,
          jurisdiction: j,
          exclusive:,
          term_months: term,
          status: agreement_row.Proposed,
          proposed_at: now,
          share_with_agency_staff: False,
          disclosure_club_presence: False,
          disclosure_contact_routing: False,
          disclosure_trial_visibility: False,
          created_at: now,
          rev: 1,
        ),
        rev_at: Some(now),
        request_key: key,
        request_fp: option.map(key, fn(_) { fp }),
      )
    use _ <- result.try(
      agent_store.create_agreement(tx, row, scope, policy_versions, by_org(a))
      |> storage,
    )
    live(tx, representation_event(live_event.RepresentationRequested, row))
    use _ <- result.try(
      notify_player(
        tx,
        player_id,
        "representation_request",
        p.row.display_name
          <> " ("
          <> a.org.name
          <> ") asks to represent you ("
          <> string.join(list.map(scope, scope_row.scope_to_string), ", ")
          <> ", "
          <> int.to_string(term)
          <> " months). Nothing is active until YOU confirm it in My Agent.",
        id.agreement_to_string(agreement_id),
        now,
      )
      |> storage,
    )
    agent_store.agreement_by_id(r, id.agreement_to_string(agreement_id))
    |> storage
  })
  let assert Some(agreement) = agreement
  use relationship <- reading(ctx, fn(r) {
    relationship_for_agent(r, agreement, m, now)
  })
  http.json(201, json.object([#("relationship", relationship)]))
}

/// `GET /org/agent/clients/:id`.
pub fn client(ctx: Ctx, a: OrgAccess, agreement_id: String) -> Response {
  use m <- membership(ctx, a)
  use found <- own_agreement(ctx, m, agreement_id)
  let now = clock.now_ms()
  case found {
    Summary(x) -> {
      use row <- reading(ctx, fn(r) { summary_row(r, x, m, now) })
      http.json(
        200,
        json.object([#("relationship", row), #("mode", json.string("summary"))]),
      )
    }
    Own(x) -> {
      use #(client, visible) <- reading(ctx, fn(r) {
        use client <- result.try(client_identity(r, x.row, m, now))
        use found <- result.map(visible_player(r, a.org, x.row.client_id, now))
        #(client, case found {
          Some(#(_, v, _)) -> v
          None -> False
        })
      })
      http.json(
        200,
        json.object([
          #(
            "relationship",
            json.object(agent_rules.agreement_for_agent(x, now)),
          ),
          #("client", client),
          #(
            "access",
            json.bool(
              agent_rules.grants_access(x.row, a.user.id, now) && visible,
            ),
          ),
          #("mode", json.string("own")),
        ]),
      )
    }
  }
}

type AgentTermination {
  AgentTermination(
    reason_code: Option(Option(String)),
    client_key: Option(String),
  )
}

fn agent_termination_shape() -> input.Shape(AgentTermination) {
  use reason_code <- input.field(
    "reasonCode",
    input.clearable(input.text(reason_code_max)),
  )
  use client_key <- client_key_field
  use <- rev.fields
  input.done(AgentTermination(reason_code:, client_key:))
}

/// `POST /org/agent/clients/:id/terminate`: the agent withdraws a request or ends the relationship.
pub fn terminate(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  agreement_id: String,
) -> Response {
  use m <- membership(ctx, a)
  use <- require(m, "clients.terminate")
  use found <- own_agreement(ctx, m, agreement_id)
  case found {
    Summary(_) -> not_permitted("")
    Own(_) -> {
      use b, raw <- body(req, agent_termination_shape())
      use key <- client_key(b.client_key)
      use expected <- rev_expected(raw)
      let reason =
        given(b.reason_code) |> option.flatten |> option.unwrap("agent_ended")
      let fp = fingerprint([#("reasonCode", canonical.Str(reason))])
      let now = clock.now_ms()
      use updated <- act(ctx, fn(tx) {
        let r = store.reading(tx)
        use current <- result.try(
          agent_store.agreement_by_id(r, agreement_id) |> storage,
        )
        let assert Some(x) = current
        case key, x.row.agent_terminate_key {
          Some(k), Some(stored) if k == stored ->
            case x.row.agent_terminate_fp == Some(fp) {
              True ->
                store.refuse(http.json(
                  200,
                  json.object([
                    #(
                      "relationship",
                      json.object(agent_rules.agreement_for_agent(x, now)),
                    ),
                    #("idempotent", json.bool(True)),
                  ]),
                ))
              False ->
                store.refuse(refuse("REPRESENTATION_IDEMPOTENCY_CONFLICT", []))
            }
          _, _ -> {
            let phase = agent_rules.effective_status(x.row, now)
            use _ <- result.try(
              case
                agent_rules.agent_transition_allowed(
                  x.row,
                  agreement_status.TerminatedByAgent,
                  now,
                )
              {
                True -> Ok(Nil)
                False ->
                  store.refuse(
                    refuse("REPRESENTATION_NOT_ACTIVE", [
                      #("status", agreement_status.to_json(phase)),
                    ]),
                  )
              },
            )
            use _ <- result.try(
              rev.check(
                expected,
                agreement_rev(x.row),
                "REPRESENTATION_VERSION_CONFLICT",
                [
                  #("status", agreement_status.to_json(phase)),
                ],
              )
              |> result.map_error(store.Refuse),
            )
            use _ <- result.try(
              agent_store.move_agreement(
                tx,
                x.row.id,
                ["proposed", "active"],
                [
                  #("status", sqlight.text("terminated_by_agent")),
                  #("terminated_at", sqlight.int(now)),
                  #("terminated_by", sqlight.text("agent")),
                  #("termination_reason_code", sqlight.text(reason)),
                  #("agent_terminate_key", sqlight.nullable(sqlight.text, key)),
                  #(
                    "agent_terminate_fp",
                    sqlight.nullable(
                      sqlight.text,
                      option.map(key, fn(_) { fp }),
                    ),
                  ),
                ],
                "the agent cannot end it from where it is",
              )
              |> storage,
            )
            use _ <- result.try(
              agent_store.bump_agreement(
                tx,
                x.row.id,
                agent_store.bump_by(now, by_org(a)),
              )
              |> storage,
            )
            use _ <- result.try(
              agent_store.agreement_event(
                tx,
                x.row.id,
                now,
                by_org(a),
                fn(h) {
                  event_row.Row(
                    ..h,
                    detail_by: Some(terminator.Agent),
                    detail_phase: Some(phase),
                    detail_reason_code: Some(reason),
                  )
                },
                event_row.RepresentationTerminated,
              )
              |> storage,
            )
            live(
              tx,
              representation_event(live_event.RepresentationTerminated, x.row),
            )
            use _ <- result.try(
              notify_player(
                tx,
                x.row.client_id,
                "representation_terminated",
                case phase {
                  agreement_status.Proposed ->
                    "An agent withdrew their representation request."
                  _ ->
                    "Your agent ended the representation relationship. The record stays in your history."
                },
                id.agreement_to_string(x.row.id),
                now,
              )
              |> storage,
            )
            agent_store.agreement_by_id(r, agreement_id) |> storage
          }
        }
      })
      let assert Some(updated) = updated
      http.json(
        200,
        json.object([
          #(
            "relationship",
            json.object(agent_rules.agreement_for_agent(updated, now)),
          ),
        ]),
      )
    }
  }
}

/// `GET /org/agent/clients/:id/opportunities`: the client's own board, read through the rules the player sees.
pub fn client_opportunities(
  ctx: Ctx,
  a: OrgAccess,
  agreement_id: String,
) -> Response {
  use m <- membership(ctx, a)
  use <- require(m, "clients.opportunities.read")
  use found <- own_agreement(ctx, m, agreement_id)
  case found {
    Summary(_) -> not_permitted("")
    Own(x) -> {
      let now = clock.now_ms()
      use subject <- reading(ctx, fn(r) {
        visible_player(r, a.org, x.row.client_id, now)
      })
      case agent_rules.grants_access(x.row, a.user.id, now), subject {
        True, Some(#(player, True, _)) -> {
          use items <- reading(ctx, fn(r) {
            opportunity_board.for_player(r, player, now)
          })
          http.json(
            200,
            json.object([
              #(
                "items",
                json.array(items, fn(o) {
                  json.object(opportunity_board.agent_fields(o, True))
                }),
              ),
              #("clientId", id.player_json(player.row.id)),
              #(
                "note",
                json.string(
                  "The client's own board, read through the same mutual-visibility and eligibility rules the player sees. Applying is the player's act.",
                ),
              ),
            ]),
          )
        }
        _, _ ->
          refuse("REPRESENTATION_NOT_ACTIVE", [
            #(
              "status",
              agreement_status.to_json(agent_rules.effective_status(x.row, now)),
            ),
          ])
      }
    }
  }
}

/// `GET /org/agent/opportunities`: every confirmed client's board, by deadline.
pub fn opportunities(ctx: Ctx, a: OrgAccess) -> Response {
  use m <- membership(ctx, a)
  use <- require(m, "clients.opportunities.read")
  let now = clock.now_ms()
  use items <- reading(ctx, fn(r) {
    use all <- result.try(agent_store.agreements_for_agency(r, a.org.id))
    all
    |> list.filter(fn(x) { agent_rules.grants_access(x.row, a.user.id, now) })
    |> list.try_map(fn(x) {
      use subject <- result.try(visible_player(r, a.org, x.row.client_id, now))
      case subject {
        Some(#(player, True, _)) -> {
          use board <- result.map(opportunity_board.for_player(r, player, now))
          list.map(board, fn(o) {
            #(
              o,
              list.append(opportunity_board.agent_fields(o, False), [
                #("clientId", id.player_json(player.row.id)),
                #("clientName", json.string(player.row.name)),
                #("agreementId", id.agreement_json(x.row.id)),
              ]),
            )
          })
        }
        _ -> Ok([])
      }
    })
  })
  let items =
    items
    |> list.flatten
    |> list.sort(fn(x, y) {
      string.compare(
        opportunity_board.deadline(x.0),
        opportunity_board.deadline(y.0),
      )
    })
  http.json(
    200,
    json.object([
      #("items", json.array(items, fn(x) { json.object(x.1) })),
      #(
        "note",
        json.string(
          "Only opportunities legitimately visible to a confirmed client appear here. Club-private recruitment cases never do.",
        ),
      ),
    ]),
  )
}

/// `GET /org/agent/inbox`.
pub fn inbox(ctx: Ctx, a: OrgAccess) -> Response {
  use m <- membership(ctx, a)
  use <- require(m, "inbox.read")
  let now = clock.now_ms()
  use #(feed, pending) <- reading(ctx, fn(r) {
    use feed <- result.try(notifications.for_audience(
      r,
      audience.OrgUser,
      id.org_user_to_string(a.user.id),
    ))
    use all <- result.try(agent_store.agreements_for_agency(r, a.org.id))
    use pending <- result.map(
      all
      |> list.filter(fn(x) {
        x.row.agent_user_id == a.user.id
        && agent_rules.effective_status(x.row, now) == agreement_status.Proposed
      })
      |> list.try_map(relationship_for_agent(r, _, m, now)),
    )
    #(list.take(feed, 100), pending)
  })
  http.json(
    200,
    json.object([
      #("notifications", json.array(feed, notifications.row_view)),
      #("pending", json.preprocessed_array(pending)),
      #(
        "note",
        json.string(
          "Operational messages only. Negotiation and offers are not part of this workspace.",
        ),
      ),
    ]),
  )
}

// =========================================================================================== PLAYER: My Agent

/// `GET /player/agent/relationships`.
pub fn my_agent(ctx: Ctx, p: PlayerAccess) -> Response {
  case p.minor {
    True ->
      http.json(
        200,
        json.object([
          #("items", json.preprocessed_array([])),
          #("minor", json.bool(True)),
          #(
            "note",
            json.string(
              "Agent representation is not available for under-18 accounts in ScoutBox.",
            ),
          ),
        ]),
      )
    False -> {
      let now = clock.now_ms()
      use items <- reading(ctx, fn(r) {
        use all <- result.try(agent_store.agreements_for_client(
          r,
          id.player_to_string(p.player.row.id),
        ))
        all
        |> list.sort(fn(x, y) {
          int.compare(y.row.proposed_at, x.row.proposed_at)
        })
        |> list.try_map(relationship_for_client(r, _, now))
      })
      http.json(
        200,
        json.object([
          #("items", json.preprocessed_array(items)),
          #(
            "note",
            json.string(
              "Nothing is active until you confirm it. You can end an active relationship at any time; the record stays in your history.",
            ),
          ),
        ]),
      )
    }
  }
}

pub type Answer {
  Confirm
  Decline
  End
  Dispute
}

type PlayerAnswer {
  PlayerAnswer(client_key: Option(String), reason: Option(Option(String)))
}

fn player_answer_shape(with_reason: Bool) -> input.Shape(PlayerAnswer) {
  use client_key <- client_key_field
  use <- rev.fields
  case with_reason {
    True -> {
      use reason <- input.field(
        "reason",
        input.clearable(input.text(dispute_reason_max)),
      )
      input.done(PlayerAnswer(client_key:, reason:))
    }
    False -> input.done(PlayerAnswer(client_key:, reason: None))
  }
}

/// The player's own agreement, or the concealing 404.
fn players_agreement(
  ctx: Ctx,
  p: PlayerAccess,
  agreement_id: String,
  action: String,
  next: fn(Agreement) -> Response,
) -> Response {
  use found <- reading(ctx, fn(r) {
    agent_store.agreement_by_id(r, agreement_id)
  })
  let me = id.player_to_string(p.player.row.id)
  case found {
    Some(x) if x.row.client_id == me -> next(x)
    _ -> {
      let _ = action
      refuse("REPRESENTATION_NOT_FOUND", [])
    }
  }
}

/// `POST /player/agent/relationships/:id/{confirm,decline,terminate,dispute}`: the client's answer.
pub fn answer(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  agreement_id: String,
  answer: Answer,
) -> Response {
  let #(slot, to, change, notify_type, notify_text) = case answer {
    Confirm -> #(
      "confirm",
      agreement_status.Active,
      live_event.RepresentationConfirmed,
      "representation_confirmed",
      "A client confirmed your representation relationship. It is active from now until its end date.",
    )
    Decline -> #(
      "decline",
      agreement_status.Declined,
      live_event.RepresentationRejected,
      "representation_rejected",
      "A player declined your representation request. You cannot ask again for 30 days.",
    )
    End -> #(
      "client_terminate",
      agreement_status.TerminatedByClient,
      live_event.RepresentationTerminated,
      "representation_terminated",
      "A client ended the representation relationship. Your access to their client workspace has ended; the record stays.",
    )
    Dispute -> #(
      "dispute",
      agreement_status.Disputed,
      live_event.RepresentationDisputed,
      "representation_disputed",
      "A client disputed the representation relationship. Private access is suspended pending attributed Trust & Safety review, which is not yet available in this build.",
    )
  }
  case p.minor {
    True ->
      not_permitted(
        "Guardian-managed accounts cannot hold agent relationships in ScoutBox.",
      )
    False -> {
      use <- limited(
        ctx,
        limits.AgentClientResponse,
        id.player_to_string(p.player.row.id),
      )
      use x <- players_agreement(ctx, p, agreement_id, slot)
      use b, raw <- body(req, player_answer_shape(answer == Dispute))
      use key <- client_key(b.client_key)
      let reason = given(b.reason) |> option.flatten
      use <- moderated_reason(ctx, p, x, reason)
      use expected <- rev_expected(raw)
      let fp =
        fingerprint([
          #("to", canonical.Str(agreement_status.to_string(to))),
          #("reason", canonical.text(reason)),
        ])
      let now = clock.now_ms()
      use #(updated, replayed) <- act(ctx, fn(tx) {
        let r = store.reading(tx)
        use current <- result.try(
          agent_store.agreement_by_id(r, agreement_id) |> storage,
        )
        let assert Some(x) = current
        let #(stored_key, stored_fp) = slot_of(x.row, answer)
        case key, stored_key {
          Some(k), Some(s) if k == s ->
            case stored_fp == Some(fp) {
              True -> Ok(#(x, True))
              False ->
                store.refuse(refuse("REPRESENTATION_IDEMPOTENCY_CONFLICT", []))
            }
          _, _ -> {
            let st = agent_rules.effective_status(x.row, now)
            use _ <- result.try(
              case agent_rules.client_transition_allowed(x.row, to, now) {
                True -> Ok(Nil)
                False -> {
                  let code = case to, st {
                    agreement_status.Active, _ -> "REPRESENTATION_NOT_ACTIVE"
                    _, agreement_status.Disputed -> "REPRESENTATION_DISPUTED"
                    _, _ -> "REPRESENTATION_NOT_ACTIVE"
                  }
                  store.refuse(
                    err(
                      code,
                      case to {
                        agreement_status.Active ->
                          "This request is no longer open — the agent may have withdrawn it."
                        _ ->
                          "This relationship is not in a state that allows that."
                      },
                      [#("status", agreement_status.to_json(st))],
                    ),
                  )
                }
              },
            )
            // A block against the agency ends solicitation, so confirming through it is refused.
            use blocked <- result.try(
              audit.is_blocked(r, p.player.row.id, x.row.agency_org_id)
              |> storage,
            )
            use _ <- result.try(case to, blocked {
              agreement_status.Active, True ->
                store.refuse(
                  err(
                    "REPRESENTATION_NOT_ACTIVE",
                    "You have blocked this agency. Lift the block first if you want to confirm.",
                    [#("status", agreement_status.to_json(st))],
                  ),
                )
              _, _ -> Ok(Nil)
            })
            use _ <- result.try(
              rev.check(
                expected,
                agreement_rev(x.row),
                "REPRESENTATION_VERSION_CONFLICT",
                [
                  #("status", agreement_status.to_json(st)),
                ],
              )
              |> result.map_error(store.Refuse),
            )
            let key_columns = [
              #(slot <> "_key", sqlight.nullable(sqlight.text, key)),
              #(
                slot <> "_fp",
                sqlight.nullable(sqlight.text, option.map(key, fn(_) { fp })),
              ),
            ]
            let #(from, columns) = case answer {
              Confirm -> #(["proposed"], [
                #("status", sqlight.text("active")),
                #("confirmed_at", sqlight.int(now)),
                #("confirmed_by_player_id", id.player_sql(p.player.row.id)),
                #("start_at", sqlight.int(now)),
                #(
                  "end_at",
                  sqlight.int(agent_rules.term_end_at(now, x.row.term_months)),
                ),
              ])
              Decline -> #(["proposed"], [
                #("status", sqlight.text("declined")),
                #("declined_at", sqlight.int(now)),
              ])
              End -> #(["active"], [
                #("status", sqlight.text("terminated_by_client")),
                #("terminated_at", sqlight.int(now)),
                #("terminated_by", sqlight.text("client")),
                #("termination_reason_code", sqlight.text("client_ended")),
              ])
              Dispute -> #(["proposed", "active"], [
                #("status", sqlight.text("disputed")),
                #("disputed_at", sqlight.int(now)),
                #("dispute_reason", sqlight.nullable(sqlight.text, reason)),
              ])
            }
            use _ <- result.try(
              agent_store.move_agreement(
                tx,
                x.row.id,
                from,
                list.append(columns, key_columns),
                "the client cannot move it from where it is",
              )
              |> storage,
            )
            use _ <- result.try(
              agent_store.bump_agreement(
                tx,
                x.row.id,
                agent_store.bump_by(now, by_player(p.player)),
              )
              |> storage,
            )
            use _ <- result.try(
              agent_store.agreement_event(
                tx,
                x.row.id,
                now,
                by_player(p.player),
                fn(h) {
                  event_row.Row(
                    ..h,
                    detail_by: Some(terminator.Client),
                    detail_from: Some(st),
                    detail_to: Some(to),
                    detail_had_reason: Some(option.is_some(reason)),
                  )
                },
                case answer {
                  Confirm -> event_row.RepresentationConfirmed
                  Decline -> event_row.RepresentationRejected
                  End -> event_row.RepresentationTerminated
                  Dispute -> event_row.RepresentationDisputed
                },
              )
              |> storage,
            )
            live(tx, representation_event(change, x.row))
            use _ <- result.try(
              notify_staff(
                tx,
                x.row.agent_user_id,
                notify_type,
                notify_text,
                id.agreement_to_string(x.row.id),
                now,
              )
              |> storage,
            )
            // The reason stays with the client; the reviewer sees only that one exists.
            use _ <- result.try(case answer {
              Dispute ->
                representation_disputed(tx, x.row, p.player, now) |> storage
              _ -> Ok(Nil)
            })
            use updated <- result.map(
              agent_store.agreement_by_id(r, agreement_id) |> storage,
            )
            let assert Some(updated) = updated
            #(updated, False)
          }
        }
      })
      use relationship <- reading(ctx, fn(r) {
        relationship_for_client(r, updated, now)
      })
      http.json(
        200,
        json.object(case replayed {
          True -> [
            #("relationship", relationship),
            #("idempotent", json.bool(True)),
          ]
          False -> [#("relationship", relationship)]
        }),
      )
    }
  }
}

fn slot_of(
  a: agreement_row.Row,
  answer: Answer,
) -> #(Option(String), Option(String)) {
  case answer {
    Confirm -> #(a.confirm_key, a.confirm_fp)
    Decline -> #(a.decline_key, a.decline_fp)
    End -> #(a.client_terminate_key, a.client_terminate_fp)
    Dispute -> #(a.dispute_key, a.dispute_fp)
  }
}

fn moderated_reason(
  ctx: Ctx,
  p: PlayerAccess,
  x: Agreement,
  reason: Option(String),
  next: fn() -> Response,
) -> Response {
  case reason {
    None -> next()
    Some(text) ->
      moderate.or_refuse(
        ctx,
        text,
        audit.Context(
          kind: "representation",
          player_id: Some(p.player.row.id),
          org_id: Some(x.row.agency_org_id),
          user_id: None,
          channel_id: None,
          request_id: None,
        ),
        next,
      )
  }
}

/// Opens a review for a disputed relationship, once.
fn representation_disputed(
  tx: Tx,
  a: agreement_row.Row,
  player: Player,
  now: Int,
) -> Result(Nil, Fail(e)) {
  let r = store.reading(tx)
  use open <- result.try(reviews.open_for_agreement(r, a.id))
  case open {
    True -> Ok(Nil)
    False -> {
      use policies <- result.try(approach_policy.published(r))
      let set =
        approach_policy.applicable(
          policies,
          [jurisdiction.to_string(a.jurisdiction)],
          now,
        )
      reviews.create(
        tx,
        a.agency_org_id,
        Some(a.agent_user_id),
        reviews.DisputeSubject(a.id),
        [no_rule_reason("CLIENT_DISPUTE")],
        list.map(set.policies, fn(x) { x.row.id }),
        reviews.RequestedBy(
          compliance_actor_kind.Player,
          Some(id.player_to_string(player.row.id)),
          Some(player.row.name),
        ),
        now,
      )
      |> result.replace(Nil)
    }
  }
}

type Sharing {
  Sharing(share_with_agency_staff: Option(Bool), disclosure: Option(Disclosure))
}

type Disclosure {
  Disclosure(
    club_presence: Option(Bool),
    contact_routing: Option(Bool),
    trial_visibility: Option(Bool),
  )
}

fn sharing_shape() -> input.Shape(Sharing) {
  use share_with_agency_staff <- input.field(
    "shareWithAgencyStaff",
    input.optional(input.boolean()),
  )
  use disclosure <- input.field(
    "disclosure",
    input.optional(
      input.object({
        use club_presence <- input.field(
          "clubPresence",
          input.optional(input.boolean()),
        )
        use contact_routing <- input.field(
          "contactRouting",
          input.optional(input.boolean()),
        )
        use trial_visibility <- input.field(
          "trialVisibility",
          input.optional(input.boolean()),
        )
        input.done(Disclosure(
          club_presence:,
          contact_routing:,
          trial_visibility:,
        ))
      }),
    ),
  )
  use <- rev.fields
  input.done(Sharing(share_with_agency_staff:, disclosure:))
}

/// `PATCH /player/agent/relationships/:id/sharing`: the staff summary and the three disclosure choices, each read
/// only when the body carries it.
pub fn sharing(
  ctx: Ctx,
  req: Request,
  p: PlayerAccess,
  agreement_id: String,
) -> Response {
  case p.minor {
    True -> refuse("AGENT_ACTION_NOT_PERMITTED", [])
    False -> {
      use x <- players_agreement(ctx, p, agreement_id, "sharing")
      use raw <- http.json_body(req)
      use b <- parsed(
        sharing_shape(),
        raw,
        "body",
        "REPRESENTATION_INPUT_INVALID",
      )
      use expected <- rev_expected(raw)
      use <- rev.guard(
        expected,
        agreement_rev(x.row),
        "REPRESENTATION_VERSION_CONFLICT",
        [],
      )
      let changed = fn(v: Option(Bool), current: Bool) {
        case v {
          Some(b) if b != current -> Some(b)
          _ -> None
        }
      }
      let d = option.unwrap(b.disclosure, Disclosure(None, None, None))
      let share =
        changed(b.share_with_agency_staff, x.row.share_with_agency_staff)
      let club = changed(d.club_presence, x.row.disclosure_club_presence)
      let routing = changed(d.contact_routing, x.row.disclosure_contact_routing)
      let trial = changed(d.trial_visibility, x.row.disclosure_trial_visibility)
      let now = clock.now_ms()
      let respond = fn(rel: Agreement) {
        use relationship <- reading(ctx, fn(r) {
          relationship_for_client(r, rel, now)
        })
        http.json(
          200,
          json.object([
            #("relationship", relationship),
            #(
              "disclosureKeys",
              json.array(
                ["clubPresence", "contactRouting", "trialVisibility"],
                json.string,
              ),
            ),
            #(
              "note",
              json.string(
                "Each of these is a separate choice, each starts off, and each can be turned off again at any time. Confirming a relationship does not turn any of them on.",
              ),
            ),
          ]),
        )
      }
      case share, club, routing, trial {
        None, None, None, None -> respond(x)
        _, _, _, _ -> {
          let column = fn(name, v: Option(Bool)) {
            option.map(v, fn(b) { #(name, sqlight.bool(b)) })
          }
          use updated <- act(ctx, fn(tx) {
            use _ <- result.try(
              agent_store.set_agreement(
                tx,
                x.row.id,
                option.values([
                  column("share_with_agency_staff", share),
                  column("disclosure_club_presence", club),
                  column("disclosure_contact_routing", routing),
                  column("disclosure_trial_visibility", trial),
                ]),
              )
              |> storage,
            )
            use _ <- result.try(
              agent_store.bump_agreement(
                tx,
                x.row.id,
                agent_store.bump_by(now, by_player(p.player)),
              )
              |> storage,
            )
            use _ <- result.try(
              agent_store.agreement_event(
                tx,
                x.row.id,
                now,
                by_player(p.player),
                fn(h) {
                  event_row.Row(
                    ..h,
                    detail_share_with_agency_staff: share,
                    detail_club_presence: club,
                    detail_contact_routing: routing,
                    detail_trial_visibility: trial,
                  )
                },
                event_row.RepresentationSharingChanged,
              )
              |> storage,
            )
            live(
              tx,
              representation_event(
                live_event.RepresentationDisclosureChanged,
                x.row,
              ),
            )
            use _ <- result.try(
              notify_staff(
                tx,
                x.row.agent_user_id,
                "representation_disclosure",
                "A client changed what they share with you. Open the relationship to see which parts of their record and process you can currently see.",
                id.agreement_to_string(x.row.id),
                now,
              )
              |> storage,
            )
            agent_store.agreement_by_id(store.reading(tx), agreement_id)
            |> storage
          })
          let assert Some(updated) = updated
          respond(updated)
        }
      }
    }
  }
}

// ============================================================================================ ADMIN: read only

fn page(req: Request, next: fn(paging.Page) -> Response) -> Response {
  use q <- query(req, paging.query_shape())
  case paging.read(q, [paging.IntKind]) {
    Ok(page) -> next(page)
    Error(e) -> {
      let #(code, message) = paging.error_body(e)
      http.error_message(400, code, message)
    }
  }
}

fn after_of(page: paging.Page) -> Option(Int) {
  case page.after {
    Some([paging.IntKey(n)]) -> Some(n)
    _ -> None
  }
}

/// `GET /admin/agent/relationships`: the shared key may only look.
pub fn admin_relationships(ctx: Ctx, req: Request) -> Response {
  use page <- page(req)
  let now = clock.now_ms()
  use rows <- reading(ctx, fn(r) {
    agent_store.agreement_page(r, after_of(page), page.limit)
  })
  let #(items, next) =
    paging.page_of(rows, page.limit, fn(x) { [paging.IntKey(x.0)] })
  http.json(
    200,
    json.object([
      #(
        "items",
        json.array(items, fn(x) {
          json.object(agent_rules.agreement_for_oversight(x.1, now))
        }),
      ),
      #("nextCursor", json.nullable(next, json.string)),
      #("readOnly", json.bool(True)),
      #(
        "note",
        json.string(
          "Read-only. No Trust & Safety action on agent relationships or licences exists in this build (gate G-C0).",
        ),
      ),
    ]),
  )
}

/// States and provenance only: the shared key is not an attributed reviewer, so numbers and references are withheld.
fn oversight_facet(f: facet_row.Row, now: Int) -> Json {
  let v = facet_view(f, now)
  json.object(
    list.filter(v, fn(x) {
      list.contains(
        [
          "state",
          "storedState",
          "provenance",
          "submittedAt",
          "verifiedAt",
          "recheckAt",
        ],
        x.0,
      )
    }),
  )
}

/// `GET /admin/agent/profiles`.
pub fn admin_profiles(ctx: Ctx, req: Request) -> Response {
  use page <- page(req)
  let now = clock.now_ms()
  use rows <- reading(ctx, fn(r) {
    agent_store.profile_page(r, after_of(page), page.limit)
  })
  let #(items, next) =
    paging.page_of(rows, page.limit, fn(x) { [paging.IntKey(x.0)] })
  http.json(
    200,
    json.object([
      #(
        "items",
        json.array(items, fn(x) {
          let p = x.1
          json.object([
            #("id", id.agent_profile_json(p.row.id)),
            #("userId", id.org_user_json(p.row.user_id)),
            #("agencyOrgId", id.org_json(p.row.agency_org_id)),
            #("displayName", json.string(p.row.display_name)),
            #(
              "declaredJurisdictions",
              json.array(p.jurisdictions, jurisdiction.to_json),
            ),
            #(
              "facets",
              json.object([
                #(
                  "fifa_licence",
                  case agent_rules.facet_of(p, FifaLicence, None) {
                    Some(f) -> oversight_facet(f, now)
                    None -> json.null()
                  },
                ),
                #(
                  "national_registration",
                  facets_object(
                    p,
                    agent_facet.NationalRegistration,
                    oversight_facet(_, now),
                  ),
                ),
                #(
                  "minors_authorisation",
                  facets_object(
                    p,
                    agent_facet.MinorsAuthorisation,
                    oversight_facet(_, now),
                  ),
                ),
              ]),
            ),
            #("regulatoryState", regulatory_state(p, now)),
            #("policyVersion", json.int(agent_rules.policy_version)),
            #("rev", json.int(p.row.rev)),
            #("revAt", opt_int(p.row.rev_at)),
          ])
        }),
      ),
      #("nextCursor", json.nullable(next, json.string)),
      #("readOnly", json.bool(True)),
      #(
        "note",
        json.string(
          "Read-only oversight: states and provenance. Licence numbers and submitted references are not shown; attributed review is where they would be needed.",
        ),
      ),
    ]),
  )
}
