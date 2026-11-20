//// Signing routes (domains/recruitment/signings/): the club's package up to presentation, each party's completion,
//// the signing's completion, and its cancellation, voiding and supersession; Trust & Safety's voiding; and the
//// player's, guardian's and agent's reads.
////
//// Offer accepted → package opened (club act) → exact document attached → presented (READY) → each required party
//// completes against the exact revision → completion → lifecycle `signed` → `under_contract`. Nobody signs for
//// someone else, and no body field names the actor, their role or a time. Every route reads "now" from the request
//// clock (`clock.request_ms`).

import gleam/bit_array
import gleam/crypto
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/agents/core_routes as agent_core
import scoutbox/agents/integration
import scoutbox/agents/representation
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess, type PlayerAccess}
import scoutbox/identity/guardians.{type Guardian}
import scoutbox/identity/orgs as org_store
import scoutbox/identity/players.{type Player}
import scoutbox/identity/roles
import scoutbox/messaging/notifications
import scoutbox/platform/canonical
import scoutbox/platform/clock
import scoutbox/platform/effect
import scoutbox/platform/faults
import scoutbox/platform/http
import scoutbox/platform/idempotency
import scoutbox/platform/ids
import scoutbox/platform/input
import scoutbox/platform/limits
import scoutbox/platform/live_event
import scoutbox/platform/media
import scoutbox/platform/rev
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/platform/temporal
import scoutbox/recruitment/case_lifecycle
import scoutbox/recruitment/cases.{type Room}
import scoutbox/recruitment/domain_errors
import scoutbox/recruitment/offer_rules.{type Offer}
import scoutbox/recruitment/offers
import scoutbox/recruitment/room_routes
import scoutbox/recruitment/room_rules
import scoutbox/recruitment/room_view
import scoutbox/recruitment/signing_packages.{type By, By}
import scoutbox/recruitment/signing_reads
import scoutbox/recruitment/signing_rules.{type Package, type Revision}
import scoutbox/recruitment/signing_writer
import scoutbox/recruitment/signings
import scoutbox/rows/agreement_scopes as scope_row
import scoutbox/rows/case_history as history_row
import scoutbox/rows/id
import scoutbox/rows/orgs
import scoutbox/rows/signing_documents as doc_row
import scoutbox/rows/signing_packages as pkg_row
import scoutbox/rows/signing_revision_parties as party_row
import scoutbox/rows/signing_revisions as rev_row
import scoutbox/rows/signings as signing_row
import scoutbox/rows/ver_evidence as evidence_row
import scoutbox/safety/audit
import scoutbox/verification/core
import scoutbox/verification/reviewer
import scoutbox/vocab/audience
import scoutbox/vocab/offer_status
import scoutbox/vocab/org_type
import scoutbox/vocab/party
import scoutbox/vocab/recruitment_actor_kind.{type RecruitmentActorKind}
import scoutbox/vocab/room_status
import scoutbox/vocab/signing_method
import scoutbox/vocab/signing_party_type
import sqlight
import wisp.{type Request, type Response}

// --------------------------------------------------------------------------------------------------- helpers

fn err(
  code: String,
  message: String,
  fields: List(#(String, Json)),
) -> Response {
  domain_errors.refuse(domain_errors.signing, code, message, fields)
}

fn fail(r: signing_rules.Refusal) -> Response {
  err(r.error, r.message, r.fields)
}

fn not_found() -> Response {
  err(
    "SIGNING_NOT_FOUND",
    "No signing with that reference is available to you.",
    [],
  )
}

fn document_not_found() -> Response {
  err(
    "SIGNING_DOCUMENT_NOT_FOUND",
    "No document with that reference is available to you.",
    [],
  )
}

fn state_unknown(message: String) -> Response {
  err("SIGNING_STATE_UNKNOWN", message, [])
}

fn read(ctx: Ctx, f: fn(Read) -> Result(a, Fail(e))) -> Result(a, Response) {
  store.read(ctx.store, f) |> result.map_error(http.internal)
}

fn storage(r: Result(a, Fail(e))) -> Result(a, Fail(Response)) {
  room_routes.storage(r)
}

fn rate_limited(action: limits.Action) -> Response {
  http.json(
    429,
    json.object(
      list.map(limits.limited_body(action), fn(p) { #(p.0, json.string(p.1)) }),
    ),
  )
}

/// A re-run after a lost race was charged on its first run.
fn limited(
  ctx: Ctx,
  req: Request,
  action: limits.Action,
  owner: String,
  next: fn() -> Response,
) -> Response {
  case
    !http.rerun(req)
    && limits.limited(ctx.limits, action, owner, clock.now_ms())
  {
    True -> rate_limited(action)
    False -> next()
  }
}

const codes = [
  #("contract.*", "SIGNING_CONTRACT_DATES_INVALID"),
  #("expiresAt", "SIGNING_EXPIRY_INVALID"),
  #("dataUrl", "SIGNING_DOCUMENT_INVALID"),
  #("method", "SIGNING_METHOD_UNKNOWN"),
  #("expectedRev", "SIGNING_REV_REQUIRED"),
  #("expectedVersion", "SIGNING_REV_REQUIRED"),
]

fn parsed(
  raw: Dynamic,
  shape: input.Shape(a),
  root: String,
  next: fn(a) -> Response,
) -> Response {
  case
    input.parse_coded(
      shape,
      raw,
      root:,
      codes:,
      default: "SIGNING_INPUT_INVALID",
    )
  {
    Error(r) ->
      domain_errors.send(
        domain_errors.signing,
        r.error,
        input.refusal_fields(r),
      )
    Ok(v) -> next(v)
  }
}

fn body(
  req: Request,
  shape: input.Shape(a),
  next: fn(a, Dynamic) -> Response,
) -> Response {
  use raw <- http.json_body(req)
  use v <- parsed(raw, shape, "body")
  next(v, raw)
}

fn query(
  req: Request,
  shape: input.Shape(a),
  next: fn(a) -> Response,
) -> Response {
  parsed(http.query_input(req), shape, "query", next)
}

fn client_key(
  raw: Option(Dynamic),
  next: fn(Option(String)) -> Response,
) -> Response {
  case idempotency.client_key(raw) {
    Ok(k) -> next(k)
    Error(m) -> err("SIGNING_CLIENT_KEY_INVALID", m, [])
  }
}

/// Cleaned text, measured after cleaning as the stored value is.
fn text_or_refuse(
  field: String,
  raw: Option(String),
  max: Int,
  required: Bool,
  next: fn(Option(String)) -> Response,
) -> Response {
  case signing_rules.clean_text(raw, max), required {
    Error(Nil), _ ->
      err(
        "SIGNING_INPUT_INVALID",
        field <> " must be at most " <> int.to_string(max) <> " characters.",
        [
          #("field", json.string(field)),
          #("problem", json.string("too_long")),
          #("max", json.int(max)),
        ],
      )
    Ok(None), True ->
      err("SIGNING_INPUT_INVALID", field <> " is required.", [
        #("field", json.string(field)),
        #("problem", json.string("required")),
      ])
    Ok(v), _ -> next(v)
  }
}

/// A raw value as the fingerprint reads it: whole numbers and text as sent, anything else null.
fn raw_value(v: Option(Dynamic)) -> canonical.Value {
  case v {
    None -> canonical.Null
    Some(d) ->
      case decode.run(d, decode.int), decode.run(d, decode.string) {
        Ok(n), _ -> canonical.Int(n)
        _, Ok(s) -> canonical.Str(s)
        _, _ -> canonical.Null
      }
  }
}

fn fingerprint(fields: List(#(String, canonical.Value))) -> String {
  canonical.to_string(canonical.Object(fields))
}

/// `expectedRev` (or `expectedVersion`) is required on every club change and compared with the package's rev.
fn rev_gate(raw: Dynamic, p: Package, next: fn() -> Response) -> Response {
  let named = fn(key) {
    case decode.run(raw, decode.at([key], decode.dynamic)) {
      Ok(v) ->
        case dynamic.classify(v) {
          "Nil" -> None
          _ -> Some(v)
        }
      Error(_) -> None
    }
  }
  case option.or(named("expectedRev"), named("expectedVersion")) {
    None ->
      err(
        "SIGNING_REV_REQUIRED",
        "expectedRev is required: send the rev you were looking at.",
        [
          #("field", json.string("expectedRev")),
          #("problem", json.string("required")),
        ],
      )
    Some(v) ->
      case decode.run(v, decode.int) {
        Ok(n) if n >= 0 ->
          rev.guard(
            rev.Expected(n),
            rev.Rev(p.row.rev, p.row.rev_at, p.row.rev_by_name),
            "SIGNING_REV_CONFLICT",
            [
              #("rev", json.int(p.row.rev)),
              #("status", pkg_row.status_to_json(p.row.status)),
            ],
            next,
          )
        _ ->
          err("SIGNING_REV_REQUIRED", "expectedRev must be a whole number.", [
            #("field", json.string("expectedRev")),
          ])
      }
  }
}

fn org_name(read: Read, org_id: id.OrgId) -> Result(Option(String), Fail(e)) {
  org_store.by_id(read, org_id) |> result.map(option.map(_, fn(o) { o.name }))
}

fn club(p: Package, now: Int, name: Option(String)) -> Json {
  json.object([#("signing", json.object(signing_rules.club_view(p, now, name)))])
}

fn blocked(read: Read, p: Package) -> Result(Bool, Fail(e)) {
  audit.is_blocked(read, p.row.player_id, p.row.org_id)
}

fn subject_removed(read: Read, room: Room) -> Result(Bool, Fail(e)) {
  use found <- result.map(players.by_id(read, room.row.player_id))
  room.row.subject_removed_at != None || found == None
}

fn by_org(a: OrgAccess) -> By {
  By(
    recruitment_actor_kind.Org,
    Some(id.org_user_to_string(a.user.id)),
    Some(a.user.name),
  )
}

fn touch_org(row: pkg_row.Row, a: OrgAccess, at: Int) -> pkg_row.Row {
  signing_packages.touch(
    row,
    at,
    Some(#(id.org_user_to_string(a.user.id), Some(a.user.name))),
  )
}

fn case_by(
  kind: RecruitmentActorKind,
  who: String,
  name: Option(String),
) -> cases.By {
  cases.By(
    case kind {
      recruitment_actor_kind.Org -> history_row.Org
      recruitment_actor_kind.Player -> history_row.Player
      recruitment_actor_kind.Guardian -> history_row.Guardian
      recruitment_actor_kind.Admin -> history_row.Admin
      recruitment_actor_kind.System -> history_row.System
    },
    Some(who),
    name,
  )
}

fn case_audit(
  tx: Tx,
  room: Room,
  by: cases.By,
  action: String,
  detail: List(#(String, Json)),
  at: Int,
) -> Result(Nil, Fail(e)) {
  cases.record(tx, room.row.id, by, [cases.entry(action, detail)], at)
}

fn live(tx: Tx, p: Package, room_id: String, change: live_event.SigningChange) {
  store.emit(
    tx,
    effect.Live(live_event.SigningChanged(
      change:,
      org_id: id.org_to_string(p.row.org_id),
      room_id:,
      package_id: id.signing_package_to_string(p.row.id),
    )),
  )
}

fn notify(
  tx: Tx,
  to: audience.Audience,
  who: String,
  text: String,
  p: Package,
  at: Int,
) -> Result(Nil, Fail(e)) {
  notifications.notify(
    tx,
    to:,
    id: who,
    type_: "recruitment_signing",
    text:,
    ref_id: Some(id.signing_package_to_string(p.row.id)),
    at:,
  )
}

/// A notice to the player, unless they blocked the club.
fn notify_player(
  tx: Tx,
  p: Package,
  text: String,
  at: Int,
) -> Result(Nil, Fail(e)) {
  use is_blocked <- result.try(blocked(store.reading(tx), p))
  case is_blocked {
    True -> Ok(Nil)
    False ->
      notify(
        tx,
        audience.Player,
        id.player_to_string(p.row.player_id),
        text,
        p,
        at,
      )
  }
}

/// The case's owner and lead scout, and whoever opened the package.
fn notify_club_leads(
  tx: Tx,
  p: Package,
  text: String,
  at: Int,
) -> Result(Nil, Fail(e)) {
  use room <- result.try(cases.room(store.reading(tx), p.row.case_id))
  let room = case room {
    Some(r) if r.row.org_id == p.row.org_id -> Some(r)
    _ -> None
  }
  [
    option.map(room, fn(r) { id.org_user_to_string(r.row.owner_user_id) }),
    option.then(room, fn(r) {
      option.map(r.row.room_lead_scout_user_id, id.org_user_to_string)
    }),
    Some(id.org_user_to_string(p.row.created_by_user_id)),
  ]
  |> option.values
  |> list.unique
  |> list.try_each(fn(u) { notify(tx, audience.OrgUser, u, text, p, at) })
}

/// Only while the client has shared the Offer and the agent's basis still holds.
fn notify_agent(
  tx: Tx,
  p: Package,
  text: String,
  at: Int,
) -> Result(Nil, Fail(e)) {
  use found <- result.try(offers.by_id(store.reading(tx), p.row.offer_id))
  case found {
    Some(o) if o.row.org_id == p.row.org_id ->
      case o.row.agent_share_user_id {
        None -> Ok(Nil)
        Some(agent) -> {
          use basis <- result.try(representation.basis(
            store.reading(tx),
            agent,
            id.player_to_string(p.row.player_id),
            clock.now_ms(),
          ))
          case basis.ok {
            True ->
              notify(
                tx,
                audience.OrgUser,
                id.org_user_to_string(agent),
                text,
                p,
                at,
              )
            False -> Ok(Nil)
          }
        }
      }
    _ -> Ok(Nil)
  }
}

fn squash(s: String) -> String {
  string.split(s, " ")
  |> list.filter(fn(w) { w != "" })
  |> string.join(" ")
}

fn simulated(ctx: Ctx, step: String) -> Result(Nil, Fail(Response)) {
  case faults.should_fail(ctx.faults, step) {
    True ->
      store.refuse(state_unknown(
        "The signing could not be recorded; nothing was recorded.",
      ))
    False -> Ok(Nil)
  }
}

// ----------------------------------------------------------------------------------------------- loading

pub type Need {
  View
  Manage
  Lead
}

type Loaded {
  Loaded(
    pkg: Package,
    room: Room,
    offer: Offer,
    role: Option(room_rules.RoomRole),
    consistency: List(String),
    player: Option(Player),
  )
}

/// A sound package of this organisation, or concealed.
fn package_for(
  ctx: Ctx,
  a: OrgAccess,
  package_id: id.SigningPackageId,
  need: Need,
  now: Int,
  next: fn(Loaded) -> Response,
) -> Response {
  let found =
    read(ctx, fn(r) {
      use p <- result.try(signing_packages.by_id(r, package_id))
      case p {
        Some(p) if p.row.org_id == a.org.id -> {
          use around <- result.map(signing_reads.around(r, p))
          Some(#(p, around))
        }
        _ -> Ok(None)
      }
    })
  case found {
    Error(response) -> response
    Ok(None) -> not_found()
    Ok(Some(#(p, around))) ->
      case
        signing_rules.integrity(p, Some(a.org.id)),
        around.room,
        around.offer
      {
        [_, ..], _, _ -> state_unknown("This signing cannot be read.")
        [], Some(room), Some(offer) -> {
          let c = signing_reads.consistency(p, around, now)
          case signing_rules.corrupt(c) {
            True -> state_unknown("This signing cannot be read.")
            False -> {
              let role = room_view.role(a, room)
              case
                room_rules.room_can(role, room_rules.OfferView),
                need,
                room_rules.room_can(role, room_rules.OfferIssue),
                access.is_lead(a.user)
              {
                False, _, _, _ ->
                  err(
                    "SIGNING_NOT_PERMITTED",
                    "Your role cannot read signings on this case.",
                    [],
                  )
                True, Manage, False, _ ->
                  err(
                    "SIGNING_NOT_PERMITTED",
                    "Only a room lead or recruitment lead can manage a signing.",
                    [],
                  )
                True, Lead, _, False ->
                  err(
                    "SIGNING_NOT_PERMITTED",
                    "Only a recruitment lead can sign for the club or complete a signing.",
                    [],
                  )
                _, _, _, _ ->
                  next(Loaded(p, room, offer, role, c, around.player))
              }
            }
          }
        }
        [], _, _ -> not_found()
      }
  }
}

fn packages_of_offer(
  read: Read,
  offer_id: id.OfferId,
  org_id: id.OrgId,
) -> Result(List(Package), Fail(e)) {
  signing_packages.for_offer(read, offer_id)
  |> result.map(list.filter(_, fn(p) { p.row.org_id == org_id }))
}

fn packages_of_case(read: Read, room: Room) -> Result(List(Package), Fail(e)) {
  signing_packages.for_case(read, room.row.id)
  |> result.map(list.filter(_, fn(p) { p.row.org_id == room.row.org_id }))
}

// -------------------------------------------------------------------------------------------- documents

fn sha256_hex(bits: BitArray) -> String {
  crypto.hash(crypto.Sha256, bits)
  |> bit_array.base16_encode
  |> string.lowercase
}

fn vault_record(
  read: Read,
  evidence_id: id.EvidenceId,
  org_id: id.OrgId,
) -> Result(Option(evidence_row.Row), Fail(e)) {
  store.query(
    read,
    "SELECT " <> evidence_row.columns <> " FROM ver_evidence WHERE id = ?",
    [id.evidence_sql(evidence_id)],
    evidence_row.decoder(),
  )
  |> result.map(fn(rows) {
    case rows {
      [e, ..] ->
        case e.org_id == Some(org_id) {
          True -> Some(e)
          False -> None
        }
      _ -> None
    }
  })
}

/// Before presenting, before a party confirms, at completion and before serving: the vault row must be this
/// package's and its bytes must hash to the revision's digest. Anything else is refused, never repaired.
fn document_bytes_problem(
  ctx: Ctx,
  read: Read,
  p: Package,
  doc: Option(doc_row.Row),
) -> Result(Option(String), Fail(e)) {
  case doc {
    None -> Ok(Some("missing"))
    Some(d) if d.sha256 == "" -> Ok(Some("missing"))
    Some(d) -> {
      use ev <- result.map(vault_record(read, d.evidence_id, p.row.org_id))
      let mine = Some(p.row.id)
      let digest = Some(d.sha256)
      case ev {
        None -> Some("evidence_missing")
        Some(e) if e.signing_package_id != mine -> Some("foreign")
        Some(e) if e.sha256 != digest -> Some("digest_mismatch")
        Some(e) ->
          case
            option.then(e.media_id, fn(m) {
              media.read(ctx.config.data_dir, m) |> option.from_result
            })
          {
            None -> Some("bytes_missing")
            Some(#(_, bits)) ->
              case sha256_hex(bits) == d.sha256 {
                True -> None
                False -> Some("bytes_mismatch")
              }
          }
      }
    }
  }
}

fn document_file(
  ctx: Ctx,
  read: Read,
  doc: doc_row.Row,
  org_id: id.OrgId,
) -> Result(Option(Json), Fail(e)) {
  use ev <- result.map(vault_record(read, doc.evidence_id, org_id))
  case ev {
    None -> None
    Some(e) -> {
      let blob =
        option.then(e.media_id, fn(m) {
          media.read(ctx.config.data_dir, m) |> option.from_result
        })
      let mime =
        option.or(
          option.map(e.mime, evidence_row.mime_to_string),
          option.map(blob, fn(b) { b.0 }),
        )
      Some(
        json.object([
          #(
            "document",
            json.object([
              #("id", id.signing_document_json(doc.id)),
              #("label", json.nullable(doc.label, json.string)),
              #("filename", json.nullable(e.filename, json.string)),
              #("mime", json.nullable(mime, json.string)),
              #(
                "bytes",
                json.nullable(
                  option.or(
                    e.bytes,
                    option.map(blob, fn(b) { bit_array.byte_size(b.1) }),
                  ),
                  json.int,
                ),
              ),
              #("sha256", json.nullable(e.sha256, json.string)),
            ]),
          ),
          #("file", case blob {
            Some(#(content_type, bits)) ->
              json.object([
                #("mime", json.string(option.unwrap(mime, content_type))),
                #("base64", json.string(bit_array.base64_encode(bits, True))),
              ])
            None -> json.null()
          }),
        ]),
      )
    }
  }
}

/// The served document of a revision, after its bytes are verified.
fn serve_document(
  ctx: Ctx,
  p: Package,
  rev: Option(Revision),
  executed: Bool,
  gone: Response,
) -> Response {
  let doc =
    option.then(rev, fn(r) {
      case executed {
        True -> r.executed
        False -> r.document
      }
    })
  case doc {
    None -> gone
    Some(d) ->
      case
        read(ctx, fn(rd) {
          use problem <- result.try(document_bytes_problem(ctx, rd, p, Some(d)))
          case problem {
            Some(_) -> Ok(Error(Nil))
            None -> document_file(ctx, rd, d, p.row.org_id) |> result.map(Ok)
          }
        })
      {
        Error(response) -> response
        Ok(Error(Nil)) -> state_unknown("This document cannot be read.")
        Ok(Ok(None)) -> gone
        Ok(Ok(Some(out))) -> http.json(200, out)
      }
  }
}

type Stored {
  Stored(file: core.File, label: Option(String))
}

type DocumentBody {
  DocumentBody(
    data_url: String,
    filename: Option(String),
    label: Option(String),
  )
}

fn document_shape() -> input.Shape(DocumentBody) {
  use <- rev.fields
  use data_url <- input.field(
    "dataUrl",
    input.required(input.id_of(100_000_000)),
  )
  use filename <- input.field(
    "filename",
    input.nullish(input.text(signing_rules.limit_filename)),
  )
  use label <- input.field("label", input.nullish(input.text(100_000_000)))
  input.done(DocumentBody(data_url:, filename:, label:))
}

/// Through the evidence upload path: digest, sniffed type, size limit. The file is stored before the unit; its
/// vault row is written by the unit, with the package change that names it.
fn store_document(
  ctx: Ctx,
  b: DocumentBody,
  next: fn(Stored) -> Response,
) -> Response {
  use label <- text_or_refuse(
    "label",
    b.label,
    signing_rules.limit_label,
    False,
  )
  case core.evidence_file(ctx, b.data_url, b.filename) {
    Error(code) ->
      err("SIGNING_DOCUMENT_INVALID", "The file was refused: " <> code <> ".", [
        #("field", json.string("dataUrl")),
        #("reasons", json.array([code], json.string)),
      ])
    Ok(file) -> next(Stored(file, label))
  }
}

/// Writes the vault row and the revision's document of `kind` (replacing one already there).
fn record_document(
  tx: Tx,
  a: OrgAccess,
  req: Request,
  p: Package,
  rev: Revision,
  kind: doc_row.Kind,
  stored: Stored,
  at: Int,
) -> Result(doc_row.Row, Fail(e)) {
  use ev <- result.try(core.add_evidence(
    tx,
    fn(evidence_id) {
      evidence_row.Row(
        ..core.blank_evidence(
          evidence_id,
          evidence_row.Document,
          "club_upload",
          evidence_row.OrgUser,
          at,
        ),
        supplied_by_id: Some(id.org_user_to_string(a.user.id)),
        org_id: Some(a.org.id),
        visibility: evidence_row.OrganisationInternal,
        retention: evidence_row.UntilSigningResolution,
        signing_package_id: Some(p.row.id),
        signing_document_kind: Some(case kind {
          doc_row.Signing -> evidence_row.Signing
          doc_row.Executed -> evidence_row.Executed
        }),
        label: stored.label,
      )
      |> core.with_file(stored.file)
    },
    [],
    core.staff_actor(a, req),
    at,
  ))
  use doc_id <- result.try(
    ids.next(tx, case kind {
      doc_row.Signing -> "sgd"
      doc_row.Executed -> "sgx"
    }),
  )
  let doc =
    doc_row.Row(
      ..doc_row.new(
        id: id.signing_document(doc_id),
        revision_id: rev.row.id,
        kind:,
        evidence_id: ev.id,
        sha256: option.unwrap(ev.sha256, stored.file.sha256),
        uploaded_at: at,
      ),
      filename: ev.filename,
      mime: option.map(ev.mime, evidence_row.mime_to_string),
      bytes: ev.bytes,
      label: stored.label,
      uploaded_by_kind: Some(recruitment_actor_kind.Org),
      uploaded_by_user_id: Some(a.user.id),
      uploaded_by_name: Some(a.user.name),
      uploaded_by_role: Some(a.user.role),
    )
  use _ <- result.try(
    store.run(
      tx,
      "DELETE FROM signing_documents WHERE revision_id = ? AND kind = ?",
      [
        id.signing_revision_sql(rev.row.id),
        sqlight.text(doc_row.kind_to_string(kind)),
      ],
    ),
  )
  use _ <- result.map(signing_packages.add_document(tx, doc))
  doc
}

// ------------------------------------------------------------------------------------------- the surface

fn accepted_revision(o: Offer, now: Int) -> Option(offer_rules.Revision) {
  list.find(o.revisions, fn(r) {
    offer_rules.effective(r.row, now) == offer_status.Accepted
  })
  |> option.from_result
}

fn recipient_type(r: Option(offer_rules.Revision)) -> Option(String) {
  case option.then(r, fn(x) { x.row.recipient_type }) {
    Some(party.Player) -> Some("player")
    Some(party.Guardian) -> Some("guardian")
    None -> None
  }
}

fn jurisdiction(org: Option(orgs.Row)) -> String {
  option.then(org, fn(o) { o.country }) |> option.unwrap("GB")
}

fn start_blockers(
  read: Read,
  room: Room,
  role: Option(room_rules.RoomRole),
  now: Int,
) -> Result(#(List(String), Option(Offer)), Fail(e)) {
  use removed <- result.try(subject_removed(read, room))
  use is_blocked <- result.try(audit.is_blocked(
    read,
    room.row.player_id,
    room.row.org_id,
  ))
  use subject <- result.try(players.by_id(read, room.row.player_id))
  use org <- result.try(org_store.by_id(read, room.row.org_id))
  use case_offers <- result.try(offers.for_case(read, room.row.id))
  let accepted =
    list.find(case_offers, fn(o) {
      o.row.org_id == room.row.org_id
      && offer_rules.status(o, now) == Some(offer_status.Accepted)
    })
    |> option.from_result
  use existing <- result.map(case accepted {
    Some(o) -> packages_of_offer(read, o.row.id, room.row.org_id)
    None -> Ok([])
  })
  let pathway = signing_rules.minor_pathway_open(jurisdiction(org))
  let blockers =
    list.flatten([
      case room_rules.room_can(role, room_rules.OfferIssue) {
        True -> []
        False -> ["SIGNING_ROLE"]
      },
      case removed {
        True -> ["SUBJECT_REMOVED"]
        False -> []
      },
      case is_blocked {
        True -> ["BLOCKED"]
        False -> []
      },
      case room.status == room_status.OfferAccepted {
        True -> []
        False -> ["CASE_STATE"]
      },
      case subject {
        Some(s) ->
          case !players.is_adult(s, now) && !pathway {
            True -> ["MINOR_PATHWAY_CLOSED"]
            False -> []
          }
        None -> []
      },
      case accepted {
        None -> ["OFFER_NOT_ACCEPTED"]
        Some(o) ->
          list.flatten([
            case
              recipient_type(accepted_revision(o, now)) == Some("guardian")
              && !pathway
            {
              True -> ["MINOR_PATHWAY_CLOSED"]
              False -> []
            },
            case
              list.any(existing, fn(p) {
                signing_rules.effective_status(p, now)
                == signing_rules.Completed
              }),
              list.any(existing, signing_rules.is_live(_, now))
            {
              True, _ -> ["ALREADY_COMPLETED"]
              False, True -> ["PACKAGE_LIVE"]
              False, False -> []
            },
          ])
      },
    ])
    |> list.unique
  #(blockers, accepted)
}

const surface_honest =
  "An accepted Offer is not a signing. A signing is completed only when every required party has confirmed the exact document and a recruitment lead completes the package; only then does the case read Signed."

/// `GET /org/rooms/:id/signing`: the case's packages (each with what its record and its case say about it), the
/// legacy signing and what opening one needs.
pub fn surface(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
) -> Response {
  let now = clock.request_ms(ctx.config, req)
  use room <- room_routes.with_room(ctx, a, room_id)
  let role = room_view.role(a, room)
  case room_rules.room_can(role, room_rules.OfferView) {
    False ->
      err(
        "SIGNING_NOT_PERMITTED",
        "Your role cannot read signings on this case.",
        [],
      )
    True ->
      case
        read(ctx, fn(r) {
          use all <- result.try(packages_of_case(r, room))
          use items <- result.try(
            list.try_map(all, fn(p) {
              use name <- result.try(org_name(r, p.row.org_id))
              use around <- result.map(signing_reads.around(r, p))
              let problems =
                list.append(
                  signing_rules.integrity(p, Some(room.row.org_id)),
                  case around.offer {
                    Some(_) ->
                      signing_rules.consistency(
                        p,
                        around.offer,
                        Some(room),
                        around.rows,
                        option.map(around.player, fn(x) { x.row }),
                        now,
                      )
                    None -> ["OFFER_MISSING"]
                  },
                )
              #(
                p.row.created_at,
                json.object(
                  list.append(signing_rules.club_view(p, now, name), [
                    #("integrity", json.array(problems, json.string)),
                  ]),
                ),
              )
            }),
          )
          use #(blockers, accepted) <- result.try(start_blockers(
            r,
            room,
            role,
            now,
          ))
          use legacy <- result.map(signing_writer.for_org_player(
            r,
            room.row.org_id,
            room.row.player_id,
          ))
          #(all, items, blockers, accepted, legacy)
        })
      {
        Error(response) -> response
        Ok(#(all, items, blockers, accepted, legacy)) -> {
          let live_one = list.find(all, signing_rules.is_live(_, now))
          let legacy = list.find(legacy, fn(s) { s.signing_package_id == None })
          http.json(
            200,
            json.object([
              #(
                "packages",
                items
                  |> list.sort(fn(x, y) { int.compare(y.0, x.0) })
                  |> list.map(fn(x) { x.1 })
                  |> json.preprocessed_array,
              ),
              #("livePackageId", case live_one {
                Ok(p) -> id.signing_package_json(p.row.id)
                Error(Nil) -> json.null()
              }),
              #("legacySigning", case legacy {
                Ok(s) ->
                  json.object([
                    #("id", id.signing_json(s.id)),
                    #("at", json.int(s.ts)),
                    #("method", signing_row.method_to_json(s.method)),
                  ])
                Error(Nil) -> json.null()
              }),
              #(
                "requirements",
                json.object([
                  #(
                    "role",
                    json.nullable(
                      option.map(role, room_rules.role_code),
                      json.string,
                    ),
                  ),
                  #(
                    "canManage",
                    json.bool(room_rules.room_can(role, room_rules.OfferIssue)),
                  ),
                  #("canComplete", json.bool(access.is_lead(a.user))),
                  #("status", room_status.to_json(room.status)),
                  #("startBlockers", json.array(blockers, json.string)),
                  #(
                    "acceptedOfferId",
                    json.nullable(
                      option.map(accepted, fn(o) { o.row.id }),
                      id.offer_json,
                    ),
                  ),
                ]),
              ),
              #("vocabulary", signing_rules.vocabulary_json()),
              #("policyVersion", json.int(signing_rules.policy_version)),
              #("honest", json.string(surface_honest)),
            ]),
          )
        }
      }
  }
}

// ---------------------------------------------------------------------------------------------- opening

type ContractInput {
  ContractInput(start: Option(String), end: Option(Option(Option(String))))
}

fn contract_shape() -> input.Check(ContractInput) {
  input.object({
    use start <- input.field("startDate", input.nullish(input.day_or_blank()))
    use end <- input.field("endDate", input.clearable(input.day_or_blank()))
    let text = option.map(_, temporal.day_text)
    input.done(ContractInput(
      option.flatten(start) |> text,
      option.map(end, option.map(_, text)),
    ))
  })
}

/// The end a contract input names: absent keeps `current`; null or blank clears it.
fn end_of(c: ContractInput, current: Option(String)) -> Option(String) {
  case c.end {
    None -> current
    Some(None) | Some(Some(None)) -> None
    Some(Some(day)) -> day
  }
}

type StartBody {
  StartBody(
    client_key: Option(Dynamic),
    contract: Option(ContractInput),
    internal_note: Option(String),
    expires_at: Option(Dynamic),
  )
}

/// `POST /org/offers/:id/signing`: opens a DRAFT package over the Offer's accepted revision.
pub fn start(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  offer_id: id.OfferId,
) -> Response {
  let now = clock.request_ms(ctx.config, req)
  let found =
    read(ctx, fn(r) {
      use o <- result.try(offers.by_id(r, offer_id))
      case o {
        Some(o) if o.row.org_id == a.org.id -> {
          use room <- result.map(cases.room(r, o.row.case_id))
          Some(#(o, room))
        }
        _ -> Ok(None)
      }
    })
  case found {
    Error(response) -> response
    Ok(None) -> not_found()
    Ok(Some(#(_, None))) -> not_found()
    Ok(Some(#(_, Some(room)))) if room.row.org_id != a.org.id -> not_found()
    Ok(Some(#(offer, Some(room)))) -> {
      let role = room_view.role(a, room)
      case
        room_rules.room_can(role, room_rules.OfferView),
        room_rules.room_can(role, room_rules.OfferIssue)
      {
        False, _ ->
          err(
            "SIGNING_NOT_PERMITTED",
            "Your role cannot read signings on this case.",
            [],
          )
        True, False ->
          err(
            "SIGNING_NOT_PERMITTED",
            "Only a room lead or recruitment lead can open a signing.",
            [],
          )
        True, True -> start_checked(ctx, req, a, offer, room, now)
      }
    }
  }
}

fn start_checked(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  offer: Offer,
  room: Room,
  now: Int,
) -> Response {
  let shape = {
    use client_key <- input.field("clientKey", input.optional(input.anything()))
    use contract <- input.field("contract", input.nullish(contract_shape()))
    use internal_note <- input.field(
      "internalNote",
      input.nullish(input.text(100_000_000)),
    )
    use expires_at <- input.field("expiresAt", input.nullish(input.instant()))
    input.done(StartBody(client_key:, contract:, internal_note:, expires_at:))
  }
  use b, _ <- body(req, shape)
  use key <- client_key(b.client_key)
  let accepted = accepted_revision(offer, now)
  let start_in =
    option.or(
      option.then(b.contract, fn(c) { c.start }),
      option.then(accepted, fn(r) { r.row.term_start_date }),
    )
  let end_in = case b.contract {
    Some(c) ->
      case end_of(c, None) {
        Some(e) -> Some(e)
        None -> option.then(accepted, fn(r) { r.row.term_end_date })
      }
    None -> option.then(accepted, fn(r) { r.row.term_end_date })
  }
  use internal_note <- text_or_refuse(
    "internalNote",
    b.internal_note,
    signing_rules.limit_internal_note,
    False,
  )
  let fp =
    fingerprint([
      #("offerId", canonical.Str(id.offer_to_string(offer.row.id))),
      #(
        "contract",
        canonical.Object([
          #("startDate", canonical.text(start_in)),
          #("endDate", canonical.text(end_in)),
        ]),
      ),
      #("internalNote", canonical.text(internal_note)),
      #("expiresAt", raw_value(b.expires_at)),
    ])
  let looked =
    read(ctx, fn(r) {
      use existing <- result.try(packages_of_offer(r, offer.row.id, a.org.id))
      use removed <- result.try(subject_removed(r, room))
      use is_blocked <- result.try(audit.is_blocked(
        r,
        room.row.player_id,
        room.row.org_id,
      ))
      use org <- result.map(org_store.by_id(r, room.row.org_id))
      #(existing, removed, is_blocked, org)
    })
  case looked {
    Error(response) -> response
    Ok(#(existing, removed, is_blocked, org)) -> {
      let prior =
        option.then(key, fn(k) {
          list.find(existing, fn(p) {
            signing_rules.key_row(p, "start", k) |> option.is_some
          })
          |> option.from_result
        })
      case prior, key {
        Some(p), Some(k) ->
          case signing_rules.key_row(p, "start", k) {
            Some(row) if row.fp == Some(fp) ->
              http.json(
                200,
                json.object([
                  #(
                    "signing",
                    json.object(signing_rules.club_view(
                      p,
                      now,
                      Some(a.org.name),
                    )),
                  ),
                  #("idempotent", json.bool(True)),
                ]),
              )
            _ ->
              err(
                "SIGNING_IDEMPOTENCY_CONFLICT",
                "This clientKey was already used for a different request.",
                [],
              )
          }
        _, _ ->
          case removed, is_blocked {
            True, _ ->
              err(
                "SIGNING_SUBJECT_REMOVED",
                "This player removed their ScoutBox account. No signing is opened about a person who left.",
                [],
              )
            _, True ->
              err(
                "SIGNING_BLOCKED",
                "This player (or their guardian) has blocked your organisation. No signing is opened while the block stands.",
                [],
              )
            False, False -> {
              let facts =
                signing_rules.StartFacts(
                  offer_status: offer_rules.status(offer, now),
                  offer_revision_status: option.map(accepted, fn(r) {
                    offer_rules.effective(r.row, now)
                  }),
                  case_status: Some(room.status),
                  recipient: recipient_type(accepted),
                  jurisdiction: jurisdiction(org),
                  existing:,
                )
              case signing_rules.can_start(facts, now), accepted {
                Error(r), _ -> fail(r)
                Ok(Nil), None -> state_unknown("This Offer cannot be read.")
                Ok(Nil), Some(_) if offer.row.player_id != room.row.player_id ->
                  state_unknown("This Offer cannot be read.")
                Ok(Nil), Some(acc) ->
                  case
                    signing_rules.validate_contract_dates(start_in, end_in),
                    signing_rules.validate_expiry(b.expires_at, now)
                  {
                    Error(r), _ -> fail(r)
                    _, Error(r) -> fail(r)
                    Ok(contract), Ok(#(expires, _)) -> {
                      use <- limited(
                        ctx,
                        req,
                        limits.SigningStart,
                        id.org_to_string(a.org.id),
                      )
                      open_package(
                        ctx,
                        a,
                        offer,
                        acc,
                        room,
                        facts,
                        contract,
                        internal_note,
                        expires,
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
  }
}

fn party_rows(
  revision_id: id.SigningRevisionId,
  specs: List(signing_rules.PartySpec),
) -> List(party_row.Row) {
  list.index_map(specs, fn(s, i) {
    party_row.Row(
      ..party_row.new(revision_id:, position: i, party_type: s.party_type),
      for_entity_id: Some(s.for_entity_id),
      for_player_id: Some(s.for_player_id),
      status: party_row.Pending,
    )
  })
}

fn open_package(
  ctx: Ctx,
  a: OrgAccess,
  offer: Offer,
  accepted: offer_rules.Revision,
  room: Room,
  facts: signing_rules.StartFacts,
  contract: signing_rules.Contract,
  internal_note: Option(String),
  expires: Int,
  key: Option(String),
  fp: String,
  now: Int,
) -> Response {
  store.unit(ctx.store, fn(tx) {
    // A second package opened by a racing request answers from the new state.
    use fresh <- result.try(
      packages_of_offer(store.reading(tx), offer.row.id, a.org.id) |> storage,
    )
    use _ <- result.try(
      case
        signing_rules.can_start(
          signing_rules.StartFacts(..facts, existing: fresh),
          now,
        )
      {
        Ok(Nil) -> Ok(Nil)
        Error(_) -> store.stale("another package opened over this Offer")
      },
    )
    use pkg_id <- result.try(id.next_signing_package(tx) |> storage)
    use rev_id <- result.try(id.next_signing_revision(tx) |> storage)
    let staff = Some(a.user.id)
    let package =
      pkg_row.Row(
        ..pkg_row.new(
          id: pkg_id,
          org_id: room.row.org_id,
          case_id: room.row.id,
          player_id: room.row.player_id,
          offer_id: offer.row.id,
          offer_revision_id: id.offer_revision_to_string(accepted.row.id),
          status: pkg_row.Draft,
          current_revision_id: rev_id,
          created_at: now,
          created_by_user_id: a.user.id,
          updated_at: now,
        ),
        transaction_id: option.map(offer.row.transaction_id, id.transaction),
        expires_at: Some(expires),
        internal_note:,
        created_by_kind: Some(recruitment_actor_kind.Org),
        created_by_name: Some(a.user.name),
        created_by_role: Some(a.user.role),
        rev: 1,
        rev_at: Some(now),
        rev_by_user_id: Some(id.org_user_to_string(a.user.id)),
        rev_by_name: Some(a.user.name),
        policy_version: signing_rules.policy_version,
      )
    let first =
      rev_row.Row(
        ..rev_row.new(
          id: rev_id,
          package_id: pkg_id,
          position: 0,
          revision_number: 1,
          status: rev_row.Draft,
          created_at: now,
        ),
        created_by_kind: Some(recruitment_actor_kind.Org),
        created_by_user_id: staff,
        created_by_name: Some(a.user.name),
        created_by_role: Some(a.user.role),
        contract_start_date: Some(contract.start),
        contract_end_date: contract.end,
        policy_version: Some(signing_rules.policy_version),
        policy_jurisdiction: Some(facts.jurisdiction),
        policy_offer_policy_version: Some(offer.row.policy_version),
      )
    let parties =
      party_rows(
        rev_id,
        signing_rules.required_parties_for(
          accepted.row.recipient_guardian_id
            |> option.then(fn(g) {
              case accepted.row.recipient_type {
                Some(party.Guardian) -> Some(g)
                _ -> None
              }
            }),
          room.row.player_id,
          room.row.org_id,
        ),
      )
    use _ <- result.try(
      signing_packages.insert(tx, package, first, parties) |> storage,
    )
    use _ <- result.try(case key {
      Some(k) ->
        signing_packages.add_key(tx, pkg_id, "start", k, fp, [], None)
        |> storage
      None -> Ok(Nil)
    })
    use _ <- result.try(
      signing_packages.add_history(
        tx,
        pkg_id,
        "signing_created",
        by_org(a),
        [
          #("revisionId", id.signing_revision_json(rev_id)),
          #("offerId", id.offer_json(offer.row.id)),
          #("offerRevisionId", id.offer_revision_json(accepted.row.id)),
        ],
        now,
      )
      |> storage,
    )
    use _ <- result.try(
      case_audit(
        tx,
        room,
        cases.by_staff(a.user.id, a.user.name),
        "signing_created",
        [
          #("signingPackageId", id.signing_package_json(pkg_id)),
          #("offerId", id.offer_json(offer.row.id)),
        ],
        now,
      )
      |> storage,
    )
    use stored <- result.try(signing_packages.reread(tx, pkg_id) |> storage)
    live(
      tx,
      stored,
      id.recruitment_case_to_string(room.row.id),
      live_event.SigningCreated(id.offer_to_string(offer.row.id)),
    )
    Ok(http.json(201, club(stored, now, Some(a.org.name))))
  })
  |> room_routes.answer
}

// ------------------------------------------------------------------------------------------------ reads

/// `GET /org/signings/:id`.
pub fn get(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  package_id: id.SigningPackageId,
) -> Response {
  let now = clock.request_ms(ctx.config, req)
  use l <- package_for(ctx, a, package_id, View, now)
  http.json(
    200,
    json.object([
      #(
        "signing",
        json.object(signing_rules.club_view(l.pkg, now, Some(a.org.name))),
      ),
      #("integrity", json.array(l.consistency, json.string)),
    ]),
  )
}

/// `GET /org/signings/:id/history`.
pub fn history(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  package_id: id.SigningPackageId,
) -> Response {
  let now = clock.request_ms(ctx.config, req)
  use l <- package_for(ctx, a, package_id, View, now)
  http.json(
    200,
    json.object([
      #("items", signing_rules.history_view(l.pkg, False)),
      #("signingPackageId", id.signing_package_json(l.pkg.row.id)),
    ]),
  )
}

type DocumentQuery {
  DocumentQuery(executed: Bool, revision_id: Option(String))
}

/// `GET /org/signings/:id/document`: the document (or the executed copy) of a revision, by default the current.
pub fn document(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  package_id: id.SigningPackageId,
) -> Response {
  let now = clock.request_ms(ctx.config, req)
  use l <- package_for(ctx, a, package_id, View, now)
  let shape = {
    use kind <- input.field(
      "kind",
      input.optional(input.one_of([#("document", False), #("executed", True)])),
    )
    use revision_id <- input.field("revisionId", input.optional(input.id()))
    input.done(DocumentQuery(option.unwrap(kind, False), revision_id))
  }
  use q <- query(req, shape)
  let rev = case q.revision_id {
    Some(r) -> signing_rules.revision(l.pkg, r)
    None -> signing_rules.current_revision(l.pkg)
  }
  serve_document(ctx, l.pkg, rev, q.executed, document_not_found())
}

// ---------------------------------------------------------------------------------------- draft and documents

type DraftBody {
  DraftBody(
    contract: Option(Option(ContractInput)),
    internal_note: Option(Option(String)),
  )
}

/// `PATCH /org/signings/:id`: a DRAFT's contract days and internal note.
pub fn edit_draft(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  package_id: id.SigningPackageId,
) -> Response {
  let now = clock.request_ms(ctx.config, req)
  use l <- package_for(ctx, a, package_id, Manage, now)
  case signing_rules.can_attach_document(l.pkg, now) {
    Error(r) -> fail(r)
    Ok(_) -> {
      let shape = {
        use <- rev.fields
        use contract <- input.field(
          "contract",
          input.clearable(contract_shape()),
        )
        use internal_note <- input.field(
          "internalNote",
          input.clearable(input.text(100_000_000)),
        )
        input.done(DraftBody(contract:, internal_note:))
      }
      use b, raw <- body(req, shape)
      use <- rev_gate(raw, l.pkg)
      let assert Some(rev) = signing_rules.current_revision(l.pkg)
        as "a sound package has its revision"
      let contract = case b.contract {
        None -> Ok(None)
        Some(c) -> {
          let start =
            option.or(
              option.then(c, fn(c) { c.start }),
              rev.row.contract_start_date,
            )
          let end = case c {
            Some(c) -> end_of(c, rev.row.contract_end_date)
            None -> rev.row.contract_end_date
          }
          signing_rules.validate_contract_dates(start, end) |> result.map(Some)
        }
      }
      case contract {
        Error(r) -> fail(r)
        Ok(contract) -> {
          use note <- note_change(b.internal_note)
          use <- limited(
            ctx,
            req,
            limits.SigningDocumentWrite,
            id.org_to_string(a.org.id),
          )
          store.unit(ctx.store, fn(tx) {
            use _ <- result.try(
              signing_packages.unchanged(tx, l.pkg) |> storage,
            )
            use _ <- result.try(case contract {
              Some(c) ->
                signing_packages.save_revision(
                  tx,
                  rev_row.Row(
                    ..rev.row,
                    contract_start_date: Some(c.start),
                    contract_end_date: c.end,
                  ),
                )
                |> storage
              None -> Ok(Nil)
            })
            let row = case note {
              Some(n) -> pkg_row.Row(..l.pkg.row, internal_note: n)
              None -> l.pkg.row
            }
            use _ <- result.try(
              signing_packages.add_history(
                tx,
                l.pkg.row.id,
                "signing_draft_updated",
                by_org(a),
                [#("revisionId", id.signing_revision_json(rev.row.id))],
                now,
              )
              |> storage,
            )
            use _ <- result.try(
              signing_packages.save(tx, touch_org(row, a, now)) |> storage,
            )
            use fresh <- result.try(
              signing_packages.reread(tx, l.pkg.row.id) |> storage,
            )
            Ok(http.json(200, club(fresh, now, Some(a.org.name))))
          })
          |> room_routes.answer
        }
      }
    }
  }
}

/// A note the request changes (None: untouched): cleaned and measured.
fn note_change(
  raw: Option(Option(String)),
  next: fn(Option(Option(String))) -> Response,
) -> Response {
  case raw {
    None -> next(None)
    Some(v) -> {
      use cleaned <- text_or_refuse(
        "internalNote",
        v,
        signing_rules.limit_internal_note,
        False,
      )
      next(Some(cleaned))
    }
  }
}

/// `POST /org/signings/:id/document`: the exact document a DRAFT will present.
pub fn attach(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  package_id: id.SigningPackageId,
) -> Response {
  let now = clock.request_ms(ctx.config, req)
  use l <- package_for(ctx, a, package_id, Manage, now)
  case signing_rules.can_attach_document(l.pkg, now) {
    Error(r) -> fail(r)
    Ok(_) -> {
      use b, raw <- body(req, document_shape())
      use <- rev_gate(raw, l.pkg)
      use <- limited(
        ctx,
        req,
        limits.SigningDocumentWrite,
        id.org_to_string(a.org.id),
      )
      use stored <- store_document(ctx, b)
      write_document(ctx, req, a, l, doc_row.Signing, stored, now)
    }
  }
}

fn write_document(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  l: Loaded,
  kind: doc_row.Kind,
  stored: Stored,
  now: Int,
) -> Response {
  let assert Some(rev) = signing_rules.current_revision(l.pkg)
    as "a sound package has its revision"
  store.unit(ctx.store, fn(tx) {
    use _ <- result.try(signing_packages.unchanged(tx, l.pkg) |> storage)
    use doc <- result.try(
      record_document(tx, a, req, l.pkg, rev, kind, stored, now) |> storage,
    )
    use _ <- result.try(
      signing_packages.add_history(
        tx,
        l.pkg.row.id,
        case kind {
          doc_row.Signing -> "signing_document_attached"
          doc_row.Executed -> "signing_executed_document_attached"
        },
        by_org(a),
        [
          #("revisionId", id.signing_revision_json(rev.row.id)),
          #("sha256", json.string(doc.sha256)),
        ],
        now,
      )
      |> storage,
    )
    use _ <- result.try(
      signing_packages.save(tx, touch_org(l.pkg.row, a, now)) |> storage,
    )
    use fresh <- result.try(
      signing_packages.reread(tx, l.pkg.row.id) |> storage,
    )
    Ok(http.json(200, club(fresh, now, Some(a.org.name))))
  })
  |> room_routes.answer
}

/// `POST /org/signings/:id/executed-document`: the executed copy, on a presented signing.
pub fn attach_executed(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  package_id: id.SigningPackageId,
) -> Response {
  let now = clock.request_ms(ctx.config, req)
  use l <- package_for(ctx, a, package_id, Manage, now)
  let st = signing_rules.effective_status(l.pkg, now)
  case st == signing_rules.Ready || st == signing_rules.InProgress {
    False ->
      case signing_rules.can_void(l.pkg, now) {
        Ok(_) ->
          err(
            "SIGNING_STATE_INVALID",
            "The executed document is attached to a presented signing.",
            [],
          )
        Error(r) -> fail(r)
      }
    True -> {
      use b, raw <- body(req, document_shape())
      use <- rev_gate(raw, l.pkg)
      use <- limited(
        ctx,
        req,
        limits.SigningDocumentWrite,
        id.org_to_string(a.org.id),
      )
      use stored <- store_document(ctx, b)
      write_document(ctx, req, a, l, doc_row.Executed, stored, now)
    }
  }
}

// ---------------------------------------------------------------------------------------------- present

type KeyBody {
  KeyBody(client_key: Option(Dynamic), expires_at: Option(Dynamic))
}

/// The response a replayed key answers with, or the conflict.
fn replay(
  p: Package,
  act: String,
  key: Option(String),
  fp: String,
  view: fn() -> List(#(String, Json)),
  next: fn() -> Response,
) -> Response {
  case key {
    None -> next()
    Some(k) ->
      case signing_rules.key_row(p, act, k) {
        None -> next()
        Some(row) if row.fp == Some(fp) ->
          http.json(
            200,
            json.object(list.append(view(), [#("idempotent", json.bool(True))])),
          )
        Some(_) ->
          err(
            "SIGNING_IDEMPOTENCY_CONFLICT",
            "This clientKey was already used for a different request.",
            [],
          )
      }
  }
}

fn club_fields(p: Package, now: Int, a: OrgAccess) -> List(#(String, Json)) {
  [#("signing", json.object(signing_rules.club_view(p, now, Some(a.org.name))))]
}

/// `POST /org/signings/:id/ready`: the DRAFT is presented (READY) to the parties.
pub fn ready(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  package_id: id.SigningPackageId,
) -> Response {
  let now = clock.request_ms(ctx.config, req)
  use l <- package_for(ctx, a, package_id, Manage, now)
  let shape = {
    use client_key <- input.field("clientKey", input.optional(input.anything()))
    use <- rev.fields
    use expires_at <- input.field("expiresAt", input.nullish(input.instant()))
    input.done(KeyBody(client_key:, expires_at:))
  }
  use b, raw <- body(req, shape)
  use key <- client_key(b.client_key)
  let fp = fingerprint([#("expiresAt", raw_value(b.expires_at))])
  use <- replay(l.pkg, "ready", key, fp, fn() { club_fields(l.pkg, now, a) })
  case signing_rules.can_mark_ready(l.pkg, now) {
    Error(r) -> fail(r)
    Ok(rev) -> {
      use <- rev_gate(raw, l.pkg)
      let checked =
        read(ctx, fn(r) {
          use is_blocked <- result.try(blocked(r, l.pkg))
          use removed <- result.try(subject_removed(r, l.room))
          use problem <- result.map(document_bytes_problem(
            ctx,
            r,
            l.pkg,
            rev.document,
          ))
          #(is_blocked, removed, problem)
        })
      case checked {
        Error(response) -> response
        Ok(#(True, _, _)) ->
          err(
            "SIGNING_BLOCKED",
            "This player (or their guardian) has blocked your organisation. Nothing is presented while the block stands.",
            [],
          )
        Ok(#(_, True, _)) ->
          err(
            "SIGNING_SUBJECT_REMOVED",
            "This player removed their ScoutBox account.",
            [],
          )
        Ok(#(False, False, problem)) -> {
          let expiry = case b.expires_at {
            None -> Ok(l.pkg.row.expires_at)
            Some(_) ->
              signing_rules.validate_expiry(b.expires_at, now)
              |> result.map(fn(e) { Some(e.0) })
          }
          case expiry, problem {
            Error(r), _ -> fail(r)
            _, Some(_) ->
              state_unknown(
                "This signing cannot be presented: its document cannot be verified.",
              )
            Ok(expires_at), None -> {
              use <- limited(
                ctx,
                req,
                limits.SigningDocumentWrite,
                id.org_to_string(a.org.id),
              )
              present(ctx, a, l, rev, expires_at, key, fp, now)
            }
          }
        }
      }
    }
  }
}

fn present(
  ctx: Ctx,
  a: OrgAccess,
  l: Loaded,
  rev: Revision,
  expires_at: Option(Int),
  key: Option(String),
  fp: String,
  now: Int,
) -> Response {
  let p = l.pkg
  store.unit(ctx.store, fn(tx) {
    use _ <- result.try(signing_packages.unchanged(tx, p) |> storage)
    use _ <- result.try(
      signing_packages.save_revision(
        tx,
        rev_row.Row(
          ..rev.row,
          status: rev_row.Ready,
          ready_at: Some(now),
          ready_by_kind: Some(recruitment_actor_kind.Org),
          ready_by_user_id: Some(a.user.id),
          ready_by_name: Some(a.user.name),
          ready_by_role: Some(a.user.role),
        ),
      )
      |> storage,
    )
    use _ <- result.try(case key {
      Some(k) ->
        signing_packages.add_key(
          tx,
          p.row.id,
          "ready",
          k,
          fp,
          [#("revisionId", id.signing_revision_json(rev.row.id))],
          Some(now),
        )
        |> storage
      None -> Ok(Nil)
    })
    let sha = option.map(rev.document, fn(d) { d.sha256 }) |> option.unwrap("")
    use _ <- result.try(
      signing_packages.add_history(
        tx,
        p.row.id,
        "signing_ready",
        by_org(a),
        [
          #("revisionId", id.signing_revision_json(rev.row.id)),
          #("sha256", json.string(sha)),
        ],
        now,
      )
      |> storage,
    )
    use _ <- result.try(
      case_audit(
        tx,
        l.room,
        cases.by_staff(a.user.id, a.user.name),
        "signing_ready",
        [
          #("signingPackageId", id.signing_package_json(p.row.id)),
          #("revisionId", id.signing_revision_json(rev.row.id)),
        ],
        now,
      )
      |> storage,
    )
    use _ <- result.try(
      signing_packages.save(
        tx,
        touch_org(
          pkg_row.Row(..p.row, status: pkg_row.Ready, expires_at:),
          a,
          now,
        ),
      )
      |> storage,
    )
    use fresh <- result.try(signing_packages.reread(tx, p.row.id) |> storage)
    live(
      tx,
      fresh,
      id.recruitment_case_to_string(l.room.row.id),
      live_event.SigningReady(id.signing_revision_to_string(rev.row.id)),
    )
    use _ <- result.try(
      notify_player(
        tx,
        fresh,
        a.org.name
          <> " has presented your contract for signing. Read the exact document in ScoutBox and confirm it when you are ready; nothing is signed until you do.",
        now,
      )
      |> storage,
    )
    use _ <- result.try(
      notify_agent(
        tx,
        fresh,
        squash(
          "Your client "
          <> option.map(l.player, fn(x) { x.row.name }) |> option.unwrap("")
          <> " was presented a document to sign by "
          <> a.org.name
          <> ". Their signature is their own act.",
        ),
        now,
      )
      |> storage,
    )
    Ok(http.json(200, club(fresh, now, Some(a.org.name))))
  })
  |> room_routes.answer
}

// ------------------------------------------------------------------------------------------ party completion

/// Who completes a party: the club signatory (a recruitment lead) or the recipient themselves.
pub type Signer {
  ClubSigner(access: OrgAccess)
  PlayerSigner(id: id.PlayerId, name: Option(String))
}

type PartyBody {
  PartyBody(
    client_key: Option(Dynamic),
    revision_id: String,
    document_sha256: String,
  )
}

fn party_shape(with_rev: Bool) -> input.Shape(PartyBody) {
  use client_key <- input.field("clientKey", input.optional(input.anything()))
  use _ <- input.field(
    "method",
    input.optional(
      input.one_of([
        #("PLATFORM_ACKNOWLEDGMENT", signing_method.PlatformAcknowledgment),
      ]),
    ),
  )
  use revision_id <- input.field("revisionId", input.required(input.id()))
  use document_sha256 <- input.field(
    "documentSha256",
    input.required(input.matching("^[0-9a-fA-F]{64}$")),
  )
  let done = input.done(PartyBody(client_key:, revision_id:, document_sha256:))
  case with_rev {
    True -> rev.fields(fn() { done })
    False -> done
  }
}

/// A party's completion against the exact presented revision, as the authenticated actor.
pub fn complete_party(
  ctx: Ctx,
  req: Request,
  p: Package,
  room: Room,
  signer: Signer,
  org_name: Option(String),
  player_name: Option(String),
  now: Int,
) -> Response {
  let #(party_type, actor_kind, actor_id, actor_name, rate_key) = case signer {
    ClubSigner(a) -> #(
      signing_party_type.ClubSignatory,
      recruitment_actor_kind.Org,
      id.org_user_to_string(a.user.id),
      Some(a.user.name),
      "org:" <> id.org_user_to_string(a.user.id),
    )
    PlayerSigner(pid, name) -> #(
      signing_party_type.Player,
      recruitment_actor_kind.Player,
      id.player_to_string(pid),
      name,
      "player:" <> id.player_to_string(pid),
    )
  }
  let for_club = actor_kind == recruitment_actor_kind.Org
  let view = fn(pkg: Package) {
    case for_club {
      True -> signing_rules.club_view(pkg, now, org_name)
      False ->
        signing_rules.recipient_view(pkg, now, org_name, party_type, actor_id)
    }
  }
  use b, raw <- body(req, party_shape(for_club))
  use key <- client_key(b.client_key)
  let fp =
    fingerprint([
      #("partyType", canonical.Str(signing_party_type.to_string(party_type))),
      #("revisionId", canonical.Str(b.revision_id)),
      #("documentSha256", canonical.Str(b.document_sha256)),
    ])
  let current = id.signing_revision_to_string(p.row.current_revision_id)
  let used = option.then(key, signing_rules.key_row(p, "party", _))
  case used {
    Some(row) -> {
      let same =
        row.fp == Some(fp)
        && signing_rules.key_entry(row, "actorId") == Some(actor_id)
      case same && b.revision_id == current {
        True ->
          http.json(
            200,
            json.object([
              #("signing", json.object(view(p))),
              #("idempotent", json.bool(True)),
            ]),
          )
        False ->
          err(
            "SIGNING_IDEMPOTENCY_CONFLICT",
            case same {
              True ->
                "This clientKey signed a revision that is no longer current; sign the current revision with a new key."
              False ->
                "This clientKey was already used for a different request."
            },
            [],
          )
      }
    }
    None -> {
      let gated = fn(next) {
        case signer {
          ClubSigner(_) -> rev_gate(raw, p, next)
          PlayerSigner(..) -> next()
        }
      }
      use <- gated
      let checked =
        read(ctx, fn(r) {
          use is_blocked <- result.try(blocked(r, p))
          use removed <- result.map(subject_removed(r, room))
          #(is_blocked, removed)
        })
      case checked {
        Error(response) -> response
        Ok(#(True, _)) ->
          case for_club {
            True ->
              err(
                "SIGNING_BLOCKED",
                "This player (or their guardian) has blocked your organisation.",
                [],
              )
            False ->
              err(
                "SIGNING_STATE_INVALID",
                "This signing cannot be completed right now.",
                [],
              )
          }
        Ok(#(_, True)) ->
          err(
            "SIGNING_SUBJECT_REMOVED",
            "This player removed their ScoutBox account.",
            [],
          )
        Ok(#(False, False)) ->
          case
            signing_rules.can_complete_party(
              p,
              party_type,
              actor_kind,
              actor_id,
              b.revision_id,
              b.document_sha256,
              now,
            )
          {
            Error(r) -> fail(r)
            Ok(_) if room.status != room_status.OfferAccepted ->
              err(
                "SIGNING_LIFECYCLE_CONFLICT",
                "The case is no longer at Offer accepted; the club must resolve it before signatures continue.",
                [
                  #(
                    "current",
                    json.object([#("status", room_status.to_json(room.status))]),
                  ),
                ],
              )
            Ok(#(rev, party)) ->
              case read(ctx, document_bytes_problem(ctx, _, p, rev.document)) {
                Error(response) -> response
                Ok(Some(_)) ->
                  state_unknown(
                    "This signing cannot be confirmed: its document cannot be verified.",
                  )
                Ok(None) -> {
                  use <- limited(
                    ctx,
                    req,
                    limits.SigningPartyCompletion,
                    rate_key,
                  )
                  record_party(
                    ctx,
                    p,
                    room,
                    rev,
                    party,
                    signer,
                    actor_kind,
                    actor_id,
                    actor_name,
                    key,
                    fp,
                    org_name,
                    player_name,
                    view,
                    now,
                  )
                }
              }
          }
      }
    }
  }
}

fn record_party(
  ctx: Ctx,
  p: Package,
  room: Room,
  rev: Revision,
  party: party_row.Row,
  signer: Signer,
  actor_kind: RecruitmentActorKind,
  actor_id: String,
  actor_name: Option(String),
  key: Option(String),
  fp: String,
  org_name: Option(String),
  player_name: Option(String),
  view: fn(Package) -> List(#(String, Json)),
  now: Int,
) -> Response {
  let sha = option.map(rev.document, fn(d) { d.sha256 }) |> option.unwrap("")
  let by = By(actor_kind, Some(actor_id), actor_name)
  store.unit(ctx.store, fn(tx) {
    use _ <- result.try(signing_packages.unchanged(tx, p) |> storage)
    use evidence_id <- result.try(ids.next(tx, "sgev") |> storage)
    use _ <- result.try(
      signing_packages.save_party(
        tx,
        party_row.Row(
          ..party,
          status: party_row.Completed,
          completed_at: Some(now),
          completed_by_kind: Some(actor_kind),
          completed_by_id: Some(actor_id),
          completed_by_name: actor_name,
          method: Some(signing_method.PlatformAcknowledgment),
          evidence_ref_kind: Some(party_row.PlatformAcknowledgment),
          evidence_ref_id: Some(evidence_id),
          evidence_revision_id: Some(rev.row.id),
          evidence_document_sha256: Some(sha),
          evidence_at: Some(now),
          evidence_actor_kind: Some(recruitment_actor_kind.to_string(actor_kind)),
          evidence_actor_id: Some(actor_id),
          evidence_session: Some("authenticated"),
        ),
      )
      |> storage,
    )
    use _ <- result.try(case rev.row.status {
      rev_row.Ready ->
        signing_packages.save_revision(
          tx,
          rev_row.Row(..rev.row, status: rev_row.InProgress),
        )
        |> storage
      _ -> Ok(Nil)
    })
    use _ <- result.try(case key {
      Some(k) ->
        signing_packages.add_key(
          tx,
          p.row.id,
          "party",
          k,
          fp,
          [
            #("revisionId", id.signing_revision_json(rev.row.id)),
            #("actorId", json.string(actor_id)),
          ],
          Some(now),
        )
        |> storage
      None -> Ok(Nil)
    })
    use _ <- result.try(
      signing_packages.add_history(
        tx,
        p.row.id,
        "signing_party_completed",
        by,
        [
          #("revisionId", id.signing_revision_json(rev.row.id)),
          #("partyType", signing_party_type.to_json(party.party_type)),
          #("sha256", json.string(sha)),
        ],
        now,
      )
      |> storage,
    )
    use _ <- result.try(
      case_audit(
        tx,
        room,
        case_by(actor_kind, actor_id, actor_name),
        "signing_party_completed",
        [
          #("signingPackageId", id.signing_package_json(p.row.id)),
          #("revisionId", id.signing_revision_json(rev.row.id)),
          #("partyType", signing_party_type.to_json(party.party_type)),
        ],
        now,
      )
      |> storage,
    )
    let status = case p.row.status {
      pkg_row.Ready -> pkg_row.InProgress
      other -> other
    }
    use _ <- result.try(
      signing_packages.save(
        tx,
        signing_packages.touch(
          pkg_row.Row(..p.row, status:),
          now,
          Some(#(actor_id, actor_name)),
        ),
      )
      |> storage,
    )
    use fresh <- result.try(signing_packages.reread(tx, p.row.id) |> storage)
    let done =
      signing_rules.current_revision(fresh)
      |> option.map(signing_rules.parties_complete)
      |> option.unwrap(False)
    live(
      tx,
      fresh,
      id.recruitment_case_to_string(room.row.id),
      live_event.SigningPartyCompleted(
        id.signing_revision_to_string(rev.row.id),
        signing_party_type.to_string(party.party_type),
      ),
    )
    use _ <- result.try(case signer {
      PlayerSigner(..) ->
        notify_club_leads(
          tx,
          fresh,
          option.unwrap(actor_name, "The player")
            <> " confirmed the signing document for "
            <> option.unwrap(player_name, "the player")
            <> ". "
            <> case done {
            True ->
              "Every required party has signed: a recruitment lead can now complete the signing."
            False -> "Waiting on the remaining party."
          },
          now,
        )
        |> storage
      ClubSigner(_) ->
        notify_player(
          tx,
          fresh,
          option.unwrap(org_name, "")
            <> " has signed for the club. "
            <> case done {
            True ->
              "Every required party has now signed; the club completes the signing next."
            False -> "Your signature is still needed."
          },
          now,
        )
        |> storage
    })
    use _ <- result.try(
      case faults.should_fail(ctx.faults, "signing.party.after_write") {
        True ->
          store.refuse(state_unknown(
            "The signature could not be recorded; nothing was recorded.",
          ))
        False -> Ok(Nil)
      },
    )
    Ok(http.json(200, json.object([#("signing", json.object(view(fresh)))])))
  })
  |> room_routes.answer
}

/// `POST /org/signings/:id/parties/club/complete`: a recruitment lead signs for the club.
pub fn club_party(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  package_id: id.SigningPackageId,
) -> Response {
  let now = clock.request_ms(ctx.config, req)
  use l <- package_for(ctx, a, package_id, Lead, now)
  complete_party(
    ctx,
    req,
    l.pkg,
    l.room,
    ClubSigner(a),
    Some(a.org.name),
    option.map(l.player, fn(x) { x.row.name }),
    now,
  )
}

// ------------------------------------------------------------------------------------------------ completion

fn gate_code(first: String) -> String {
  case first {
    "EXPIRED" -> "SIGNING_EXPIRED"
    "ALREADY_COMPLETED" -> "SIGNING_ALREADY_COMPLETED"
    "STATE_VOIDED" -> "SIGNING_VOIDED"
    "STATE_CANCELLED" -> "SIGNING_CANCELLED"
    "PARTIES_INCOMPLETE" -> "SIGNING_PARTIES_INCOMPLETE"
    "DOCUMENT_REQUIRED" -> "SIGNING_DOCUMENT_REQUIRED"
    "DOCUMENT_MISMATCH" | "EVIDENCE_INVALID" | "TEMPORAL_ORDER" ->
      "SIGNING_EVIDENCE_INVALID"
    "BLOCKED" -> "SIGNING_BLOCKED"
    "LIFECYCLE_CONFLICT" -> "SIGNING_LIFECYCLE_CONFLICT"
    "OFFER_NOT_ACCEPTED" | "OFFER_REVISION_MISMATCH" ->
      "SIGNING_OFFER_NOT_ACCEPTED"
    "CONFLICTING_COMPLETED_SIGNING" -> "SIGNING_CONFLICT"
    other ->
      case string.starts_with(other, "STATE_") {
        True -> "SIGNING_STATE_INVALID"
        False -> "SIGNING_STATE_UNKNOWN"
      }
  }
}

type CompleteBody {
  CompleteBody(client_key: Option(Dynamic))
}

/// `POST /org/signings/:id/complete`: the completion gate, the signing writer, the lifecycle move and the notices,
/// as one unit.
pub fn complete(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  package_id: id.SigningPackageId,
) -> Response {
  let now = clock.request_ms(ctx.config, req)
  use l <- package_for(ctx, a, package_id, Lead, now)
  let p = l.pkg
  let shape = {
    use client_key <- input.field("clientKey", input.optional(input.anything()))
    use <- rev.fields
    input.done(CompleteBody(client_key:))
  }
  use b, raw <- body(req, shape)
  use key <- client_key(b.client_key)
  let fp = fingerprint([#("complete", canonical.Bool(True))])
  use <- replay(p, "complete", key, fp, fn() {
    [
      #(
        "signing",
        json.object(signing_rules.club_view(p, now, Some(a.org.name))),
      ),
      #("lifecycle", completion_lifecycle(p.row)),
    ]
  })
  case p.row.status {
    pkg_row.Completed ->
      err("SIGNING_ALREADY_COMPLETED", "This signing is already completed.", [])
    _ -> {
      use <- rev_gate(raw, p)
      let rev = signing_rules.current_revision(p)
      let checked =
        read(ctx, fn(r) {
          use problem <- result.try(case rev {
            Some(x) ->
              case x.document {
                Some(_) -> document_bytes_problem(ctx, r, p, x.document)
                None -> Ok(Some("missing"))
              }
            None -> Ok(Some("missing"))
          })
          use siblings <- result.try(packages_of_offer(
            r,
            p.row.offer_id,
            p.row.org_id,
          ))
          use by_offer <- result.try(signing_writer.for_offer(r, p.row.offer_id))
          use is_blocked <- result.try(blocked(r, p))
          use removed <- result.try(subject_removed(r, l.room))
          use org <- result.map(org_store.by_id(r, p.row.org_id))
          let other =
            list.any(siblings, fn(x) {
              x.row.id != p.row.id
              && signing_rules.effective_status(x, now)
              == signing_rules.Completed
            })
            || by_offer != None
          #(
            signing_rules.completion_gate(
              p,
              signing_rules.GateFacts(
                now:,
                offer: Some(l.offer),
                kase: Some(l.room),
                other_completed: other,
                blocked: is_blocked,
                document_problem: problem,
              ),
            ),
            removed,
            org,
          )
        })
      case checked, rev {
        Error(response), _ -> response
        Ok(#([first, ..] as problems, _, _)), _ ->
          case string.starts_with(first, "DOCUMENT_BYTES_") {
            True ->
              state_unknown(
                "This signing cannot be completed: its document cannot be verified.",
              )
            False ->
              err(gate_code(first), "The signing cannot be completed yet.", [
                #("blockers", json.array(problems, json.string)),
                #(
                  "current",
                  json.object([
                    #(
                      "status",
                      json.string(
                        signing_rules.status_name(
                          signing_rules.effective_status(p, now),
                        ),
                      ),
                    ),
                  ]),
                ),
              ])
          }
        Ok(#([], True, _)), _ ->
          err(
            "SIGNING_SUBJECT_REMOVED",
            "This player removed their ScoutBox account.",
            [],
          )
        Ok(#([], False, Some(org))), Some(rev) ->
          case l.player {
            None -> state_unknown("This signing cannot be completed.")
            Some(player) -> {
              use <- limited(
                ctx,
                req,
                limits.SigningClosure,
                id.org_to_string(a.org.id),
              )
              finish(ctx, a, l, rev, player, org, key, fp, now)
            }
          }
        Ok(#([], False, _)), _ ->
          state_unknown("This signing cannot be completed.")
      }
    }
  }
}

fn completion_lifecycle(r: pkg_row.Row) -> Json {
  case
    r.completion_lifecycle_from,
    r.completion_lifecycle_to,
    r.completion_lifecycle_at
  {
    None, None, None -> json.null()
    from, to, at ->
      json.object([
        #("from", json.nullable(from, json.string)),
        #("to", json.nullable(to, json.string)),
        #("at", json.nullable(at, json.int)),
      ])
  }
}

fn finish(
  ctx: Ctx,
  a: OrgAccess,
  l: Loaded,
  rev: Revision,
  player: Player,
  org: orgs.Row,
  key: Option(String),
  fp: String,
  now: Int,
) -> Response {
  let p = l.pkg
  let sha = option.map(rev.document, fn(d) { d.sha256 }) |> option.unwrap("")
  store.unit(ctx.store, fn(tx) {
    use _ <- result.try(signing_packages.unchanged(tx, p) |> storage)
    use written <- result.try(
      signing_writer.record_completed(
        tx,
        player,
        org,
        Some(#(a.user.id, a.user.name)),
        now,
        signing_writer.FromPackage(p, rev),
      )
      |> storage,
    )
    use _ <- result.try(case written.duplicate {
      True ->
        store.refuse(
          err(
            "SIGNING_ALREADY_COMPLETED",
            "A completed signing record already exists for this package.",
            [],
          ),
        )
      False -> Ok(Nil)
    })
    let signing = written.signing
    use _ <- result.try(simulated(ctx, "signing.complete.after_row"))
    use _ <- result.try(
      signing_packages.save_revision(
        tx,
        rev_row.Row(
          ..rev.row,
          status: rev_row.Completed,
          completed_at: Some(now),
          completed_by_kind: Some(recruitment_actor_kind.Org),
          completed_by_user_id: Some(a.user.id),
          completed_by_name: Some(a.user.name),
          completed_by_role: Some(a.user.role),
        ),
      )
      |> storage,
    )
    let completed =
      pkg_row.Row(
        ..p.row,
        status: pkg_row.Completed,
        completion_signing_id: Some(signing.id),
        completion_completed_at: Some(now),
        completion_by_kind: Some(recruitment_actor_kind.Org),
        completion_by_user_id: Some(a.user.id),
        completion_by_name: Some(a.user.name),
        completion_by_role: Some(a.user.role),
        completion_contract_start_date: rev.row.contract_start_date,
        completion_contract_end_date: rev.row.contract_end_date,
        completion_document_sha256: Some(sha),
      )
    use _ <- result.try(signing_packages.save(tx, completed) |> storage)
    // The evidence provider now finds the row this completion just wrote.
    use moved <- result.try(
      case_lifecycle.advance(
        tx,
        l.room,
        room_view.level(a.org),
        "confirmSignedOutcome",
        l.role,
        case_lifecycle.StaffMover(a.user.id, a.user.name),
        "signing:complete:" <> id.signing_package_to_string(p.row.id),
        [
          #("signingPackageId", id.signing_package_json(p.row.id)),
          #("signingId", id.signing_json(signing.id)),
        ],
        now,
      )
      |> storage,
    )
    use _ <- result.try(case moved.applied {
      True -> Ok(Nil)
      False ->
        store.refuse(
          err(
            "SIGNING_LIFECYCLE_CONFLICT",
            option.unwrap(
              moved.message,
              "The case could not be moved to Signed; nothing was recorded.",
            ),
            [
              #("lifecycle", case_lifecycle.advanced_json(moved)),
              #(
                "current",
                json.object([#("status", room_status.to_json(l.room.status))]),
              ),
            ],
          ),
        )
    })
    let completed =
      pkg_row.Row(
        ..completed,
        completion_lifecycle_from: Some(moved.from),
        completion_lifecycle_to: moved.to,
        completion_lifecycle_at: Some(now),
      )
    use _ <- result.try(simulated(ctx, "signing.complete.after_lifecycle"))
    use _ <- result.try(case key {
      Some(k) ->
        signing_packages.add_key(
          tx,
          p.row.id,
          "complete",
          k,
          fp,
          [#("signingId", id.signing_json(signing.id))],
          Some(now),
        )
        |> storage
      None -> Ok(Nil)
    })
    use _ <- result.try(
      signing_packages.add_history(
        tx,
        p.row.id,
        "signing_completed",
        by_org(a),
        [
          #("revisionId", id.signing_revision_json(rev.row.id)),
          #("signingId", id.signing_json(signing.id)),
          #("sha256", json.string(sha)),
        ],
        now,
      )
      |> storage,
    )
    use _ <- result.try(
      cases.link(
        tx,
        l.room.row.id,
        None,
        None,
        Some(id.signing_to_string(signing.id)),
      )
      |> storage,
    )
    use _ <- result.try(
      case_audit(
        tx,
        l.room,
        cases.by_staff(a.user.id, a.user.name),
        "signing_completed",
        [
          #("signingPackageId", id.signing_package_json(p.row.id)),
          #("signingId", id.signing_json(signing.id)),
          #("to", json.nullable(moved.to, json.string)),
        ],
        now,
      )
      |> storage,
    )
    use _ <- result.try(
      signing_packages.save(tx, touch_org(completed, a, now)) |> storage,
    )
    use fresh <- result.try(signing_packages.reread(tx, p.row.id) |> storage)
    live(
      tx,
      fresh,
      id.recruitment_case_to_string(l.room.row.id),
      live_event.SigningCompleted(id.signing_to_string(signing.id)),
    )
    use _ <- result.try(
      notify_agent(
        tx,
        fresh,
        org.name
          <> " completed the signing for your client "
          <> player.row.name
          <> ".",
        now,
      )
      |> storage,
    )
    use _ <- result.try(
      notify_club_leads(
        tx,
        fresh,
        "Signing completed for "
          <> player.row.name
          <> ". The case reads Signed.",
        now,
      )
      |> storage,
    )
    use _ <- result.try(simulated(ctx, "signing.complete.at_commit"))
    Ok(http.json(
      200,
      json.object([
        #(
          "signing",
          json.object(signing_rules.club_view(fresh, now, Some(a.org.name))),
        ),
        #("lifecycle", case_lifecycle.advanced_json(moved)),
        #("signingId", id.signing_json(signing.id)),
      ]),
    ))
  })
  |> room_routes.answer
}

// --------------------------------------------------------------------------------------------- closures

type CloseBody {
  CloseBody(client_key: Option(Dynamic), reason: Option(String))
}

fn close_shape() -> input.Shape(CloseBody) {
  use client_key <- input.field("clientKey", input.optional(input.anything()))
  use <- rev.fields
  use reason <- input.field("reason", input.nullish(input.text(100_000_000)))
  input.done(CloseBody(client_key:, reason:))
}

pub type Closure {
  Cancel
  Void
}

/// `POST /org/signings/:id/cancel` (a room lead) and `/void` (a recruitment lead).
pub fn close(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  package_id: id.SigningPackageId,
  action: Closure,
) -> Response {
  let now = clock.request_ms(ctx.config, req)
  let need = case action {
    Cancel -> Manage
    Void -> Lead
  }
  let word = case action {
    Cancel -> "cancel"
    Void -> "void"
  }
  use l <- package_for(ctx, a, package_id, need, now)
  let p = l.pkg
  use b, raw <- body(req, close_shape())
  use key <- client_key(b.client_key)
  use reason <- text_or_refuse(
    "reason",
    b.reason,
    signing_rules.limit_reason,
    False,
  )
  let fp =
    fingerprint([
      #("action", canonical.Str(word)),
      #("reason", canonical.text(reason)),
    ])
  use <- replay(p, word, key, fp, fn() { club_fields(p, now, a) })
  let gate = case action {
    Cancel -> signing_rules.can_cancel(p, now)
    Void -> signing_rules.can_void(p, now)
  }
  case gate {
    Error(r) -> fail(r)
    Ok(_) -> {
      use <- rev_gate(raw, p)
      use <- limited(
        ctx,
        req,
        limits.SigningSafetyClosure,
        id.org_to_string(a.org.id),
      )
      let assert Some(rev) = signing_rules.current_revision(p)
        as "a sound package has its revision"
      let #(rev_status, status, action_name) = case action {
        Cancel -> #(rev_row.Cancelled, pkg_row.Cancelled, "signing_cancelled")
        Void -> #(rev_row.Voided, pkg_row.Voided, "signing_voided")
      }
      store.unit(ctx.store, fn(tx) {
        use _ <- result.try(signing_packages.unchanged(tx, p) |> storage)
        use _ <- result.try(
          signing_packages.save_revision(
            tx,
            rev_row.Row(..rev.row, status: rev_status),
          )
          |> storage,
        )
        let row = case action {
          Cancel ->
            pkg_row.Row(
              ..p.row,
              status:,
              cancelled_at: Some(now),
              cancelled_by_kind: Some(recruitment_actor_kind.Org),
              cancelled_by_user_id: Some(a.user.id),
              cancelled_by_name: Some(a.user.name),
              cancelled_by_role: Some(a.user.role),
              cancel_reason: reason,
            )
          Void ->
            pkg_row.Row(
              ..p.row,
              status:,
              voided_at: Some(now),
              voided_by_kind: Some(recruitment_actor_kind.Org),
              voided_by_id: Some(id.org_user_to_string(a.user.id)),
              voided_by_name: Some(a.user.name),
              voided_by_role: Some(a.user.role),
              void_reason: reason,
            )
        }
        use _ <- result.try(case key {
          Some(k) ->
            signing_packages.add_key(tx, p.row.id, word, k, fp, [], Some(now))
            |> storage
          None -> Ok(Nil)
        })
        use _ <- result.try(
          signing_packages.add_history(
            tx,
            p.row.id,
            action_name,
            by_org(a),
            [
              #("revisionId", id.signing_revision_json(rev.row.id)),
              #("hadReason", json.bool(reason != None)),
            ],
            now,
          )
          |> storage,
        )
        use _ <- result.try(
          case_audit(
            tx,
            l.room,
            cases.by_staff(a.user.id, a.user.name),
            action_name,
            [#("signingPackageId", id.signing_package_json(p.row.id))],
            now,
          )
          |> storage,
        )
        use _ <- result.try(
          signing_packages.save(tx, touch_org(row, a, now)) |> storage,
        )
        use fresh <- result.try(
          signing_packages.reread(tx, p.row.id) |> storage,
        )
        live(
          tx,
          fresh,
          id.recruitment_case_to_string(l.room.row.id),
          case action {
            Cancel -> live_event.SigningCancelled
            Void -> live_event.SigningVoided
          },
        )
        use _ <- result.try(case rev.row.ready_at {
          Some(_) ->
            notify_player(
              tx,
              fresh,
              a.org.name
                <> " "
                <> case action {
                Cancel -> "cancelled"
                Void -> "voided"
              }
                <> " the signing presented to you. Nothing was signed. Your accepted Offer is unchanged.",
              now,
            )
            |> storage
          None -> Ok(Nil)
        })
        Ok(http.json(200, club(fresh, now, Some(a.org.name))))
      })
      |> room_routes.answer
    }
  }
}

/// `POST /org/signings/:id/supersede`: the presented revision is SUPERSEDED and a fresh DRAFT opens with the same
/// contract days, every party pending.
pub fn supersede(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  package_id: id.SigningPackageId,
) -> Response {
  let now = clock.request_ms(ctx.config, req)
  use l <- package_for(ctx, a, package_id, Manage, now)
  let p = l.pkg
  use b, raw <- body(req, close_shape())
  use key <- client_key(b.client_key)
  use reason <- text_or_refuse(
    "reason",
    b.reason,
    signing_rules.limit_reason,
    False,
  )
  let fp =
    fingerprint([
      #("supersede", canonical.Bool(True)),
      #("reason", canonical.text(reason)),
    ])
  use <- replay(p, "supersede", key, fp, fn() { club_fields(p, now, a) })
  case signing_rules.can_supersede(p, now) {
    Error(r) -> fail(r)
    Ok(_) -> {
      use <- rev_gate(raw, p)
      use <- limited(
        ctx,
        req,
        limits.SigningDocumentWrite,
        id.org_to_string(a.org.id),
      )
      let assert Some(prev) = signing_rules.current_revision(p)
        as "a sound package has its revision"
      let accepted =
        list.find(l.offer.revisions, fn(r) {
          id.offer_revision_to_string(r.row.id) == p.row.offer_revision_id
        })
        |> option.from_result
      store.unit(ctx.store, fn(tx) {
        use _ <- result.try(signing_packages.unchanged(tx, p) |> storage)
        use rev_id <- result.try(id.next_signing_revision(tx) |> storage)
        use _ <- result.try(
          signing_packages.save_revision(
            tx,
            rev_row.Row(
              ..prev.row,
              status: rev_row.Superseded,
              superseded_by_revision_id: Some(rev_id),
              superseded_at: Some(now),
            ),
          )
          |> storage,
        )
        let next =
          rev_row.Row(
            ..rev_row.new(
              id: rev_id,
              package_id: p.row.id,
              position: list.length(p.revisions),
              revision_number: signing_rules.next_revision_number(p),
              status: rev_row.Draft,
              created_at: now,
            ),
            created_by_kind: Some(recruitment_actor_kind.Org),
            created_by_user_id: Some(a.user.id),
            created_by_name: Some(a.user.name),
            created_by_role: Some(a.user.role),
            contract_start_date: prev.row.contract_start_date,
            contract_end_date: prev.row.contract_end_date,
            policy_version: prev.row.policy_version,
            policy_jurisdiction: prev.row.policy_jurisdiction,
            policy_offer_policy_version: prev.row.policy_offer_policy_version,
            supersedes_revision_id: Some(prev.row.id),
          )
        let guardian =
          option.then(accepted, fn(r) {
            case r.row.recipient_type {
              Some(party.Guardian) -> r.row.recipient_guardian_id
              _ -> None
            }
          })
        use _ <- result.try(
          signing_packages.add_revision(
            tx,
            next,
            party_rows(
              rev_id,
              signing_rules.required_parties_for(
                guardian,
                p.row.player_id,
                p.row.org_id,
              ),
            ),
          )
          |> storage,
        )
        use _ <- result.try(case key {
          Some(k) ->
            signing_packages.add_key(
              tx,
              p.row.id,
              "supersede",
              k,
              fp,
              [#("revisionId", id.signing_revision_json(rev_id))],
              Some(now),
            )
            |> storage
          None -> Ok(Nil)
        })
        use _ <- result.try(
          signing_packages.add_history(
            tx,
            p.row.id,
            "signing_superseded",
            by_org(a),
            [
              #("revisionId", id.signing_revision_json(rev_id)),
              #("supersedes", id.signing_revision_json(prev.row.id)),
              #("hadReason", json.bool(reason != None)),
            ],
            now,
          )
          |> storage,
        )
        use _ <- result.try(
          case_audit(
            tx,
            l.room,
            cases.by_staff(a.user.id, a.user.name),
            "signing_superseded",
            [
              #("signingPackageId", id.signing_package_json(p.row.id)),
              #("revisionId", id.signing_revision_json(rev_id)),
              #("supersedes", id.signing_revision_json(prev.row.id)),
            ],
            now,
          )
          |> storage,
        )
        use _ <- result.try(
          signing_packages.save(
            tx,
            touch_org(
              pkg_row.Row(
                ..p.row,
                current_revision_id: rev_id,
                status: pkg_row.Draft,
              ),
              a,
              now,
            ),
          )
          |> storage,
        )
        use fresh <- result.try(
          signing_packages.reread(tx, p.row.id) |> storage,
        )
        live(
          tx,
          fresh,
          id.recruitment_case_to_string(l.room.row.id),
          live_event.SigningSuperseded(
            id.signing_revision_to_string(rev_id),
            id.signing_revision_to_string(prev.row.id),
          ),
        )
        use _ <- result.try(
          notify_player(
            tx,
            fresh,
            a.org.name
              <> " withdrew the document presented to you; any confirmation you gave no longer applies. A new document will be presented before anything is signed.",
            now,
          )
          |> storage,
        )
        Ok(http.json(201, club(fresh, now, Some(a.org.name))))
      })
      |> room_routes.answer
    }
  }
}

/// `POST /admin/signings/:id/void`: Trust & Safety voids a live signing, with a reason.
pub fn admin_void(
  ctx: Ctx,
  req: Request,
  package_id: id.SigningPackageId,
) -> Response {
  let now = clock.request_ms(ctx.config, req)
  let who = reviewer.of(req)
  case read(ctx, signing_packages.by_id(_, package_id)) {
    Error(response) -> response
    Ok(None) -> not_found()
    Ok(Some(p)) -> {
      let shape = {
        use reason <- input.field(
          "reason",
          input.nullish(input.text(100_000_000)),
        )
        input.done(reason)
      }
      use reason, _ <- body(req, shape)
      use reason <- text_or_refuse(
        "reason",
        reason,
        signing_rules.limit_reason,
        True,
      )
      let gate = case signing_rules.can_void(p, now) {
        Ok(_) -> Ok(Nil)
        Error(_) -> signing_rules.can_cancel(p, now) |> result.replace(Nil)
      }
      case gate, signing_rules.current_revision(p) {
        Error(r), _ -> fail(r)
        Ok(Nil), None -> state_unknown("This signing cannot be read.")
        Ok(Nil), Some(rev) ->
          store.unit(ctx.store, fn(tx) {
            use _ <- result.try(signing_packages.unchanged(tx, p) |> storage)
            use _ <- result.try(
              signing_packages.save_revision(
                tx,
                rev_row.Row(..rev.row, status: rev_row.Voided),
              )
              |> storage,
            )
            let by =
              By(recruitment_actor_kind.Admin, Some(who.id), Some(who.name))
            use _ <- result.try(
              signing_packages.add_history(
                tx,
                p.row.id,
                "signing_voided",
                by,
                [
                  #("revisionId", id.signing_revision_json(rev.row.id)),
                  #("hadReason", json.bool(True)),
                  #("byTrustAndSafety", json.bool(True)),
                ],
                now,
              )
              |> storage,
            )
            use room <- result.try(
              cases.room(store.reading(tx), p.row.case_id) |> storage,
            )
            use _ <- result.try(case room {
              Some(room) if room.row.org_id == p.row.org_id ->
                case_audit(
                  tx,
                  room,
                  case_by(recruitment_actor_kind.Admin, who.id, Some(who.name)),
                  "signing_voided",
                  [
                    #("signingPackageId", id.signing_package_json(p.row.id)),
                    #("byTrustAndSafety", json.bool(True)),
                  ],
                  now,
                )
                |> storage
              _ -> Ok(Nil)
            })
            use _ <- result.try(
              signing_packages.save(
                tx,
                signing_packages.touch(
                  pkg_row.Row(
                    ..p.row,
                    status: pkg_row.Voided,
                    voided_at: Some(now),
                    voided_by_kind: Some(recruitment_actor_kind.Admin),
                    voided_by_id: Some(who.id),
                    voided_by_name: Some(who.name),
                    voided_by_role: None,
                    void_reason: reason,
                  ),
                  now,
                  Some(#(who.id, Some(who.name))),
                ),
              )
              |> storage,
            )
            use fresh <- result.try(
              signing_packages.reread(tx, p.row.id) |> storage,
            )
            live(
              tx,
              fresh,
              id.recruitment_case_to_string(p.row.case_id),
              live_event.SigningVoided,
            )
            use _ <- result.try(
              notify_club_leads(
                tx,
                fresh,
                "Trust & Safety voided a signing on one of your cases. Nothing was signed.",
                now,
              )
              |> storage,
            )
            use _ <- result.try(case rev.row.ready_at {
              Some(_) ->
                notify_player(
                  tx,
                  fresh,
                  "The signing presented to you was voided by Trust & Safety. Nothing was signed.",
                  now,
                )
                |> storage
              None -> Ok(Nil)
            })
            Ok(http.json(
              200,
              json.object([
                #("ok", json.bool(True)),
                #("signingPackageId", id.signing_package_json(p.row.id)),
                #("status", json.string("VOIDED")),
              ]),
            ))
          })
          |> room_routes.answer
      }
    }
  }
}

// ------------------------------------------------------------------------------------------- recipients

/// The packages presented to the addressed adult, over an Offer they accepted, on a sound row, newest first.
fn recipient_packages(
  read: Read,
  player_id: id.PlayerId,
  now: Int,
) -> Result(List(Package), Fail(e)) {
  use all <- result.try(signing_packages.for_player(read, player_id))
  let me = Some(id.player_to_string(player_id))
  use kept <- result.map(
    list.try_fold(all, [], fn(out, p) {
      use ok <- result.map(signing_reads.sound(read, p, now))
      let presented = list.any(p.revisions, fn(r) { r.row.ready_at != None })
      let addressed = case signing_rules.current_revision(p) {
        Some(rev) ->
          case signing_rules.find_party(rev, signing_party_type.Player, None) {
            Some(q) -> q.for_entity_id == me
            None -> False
          }
        None -> False
      }
      case ok && presented && addressed {
        True -> [p, ..out]
        False -> out
      }
    }),
  )
  list.sort(kept, fn(x, y) { int.compare(y.row.updated_at, x.row.updated_at) })
}

fn recipient_json(
  read: Read,
  p: Package,
  player_id: id.PlayerId,
  now: Int,
) -> Result(Json, Fail(e)) {
  use name <- result.map(org_name(read, p.row.org_id))
  json.object(signing_rules.recipient_view(
    p,
    now,
    name,
    signing_party_type.Player,
    id.player_to_string(player_id),
  ))
}

const player_list_note =
  "Documents presented to you for signing, exactly as the club presented them. Confirming one records your signature on that exact document; nothing is signed until every required party has confirmed and the club completes the signing."

/// `GET /player/signings`.
pub fn player_list(ctx: Ctx, req: Request, a: PlayerAccess) -> Response {
  let now = clock.request_ms(ctx.config, req)
  let pid = a.player.row.id
  case
    read(ctx, fn(r) {
      use ps <- result.try(recipient_packages(r, pid, now))
      list.try_map(ps, recipient_json(r, _, pid, now))
    })
  {
    Error(response) -> response
    Ok(items) ->
      http.json(
        200,
        json.object([
          #("items", json.preprocessed_array(items)),
          #("note", json.string(player_list_note)),
        ]),
      )
  }
}

fn player_package(
  ctx: Ctx,
  a: PlayerAccess,
  package_id: id.SigningPackageId,
  now: Int,
  next: fn(Package) -> Response,
) -> Response {
  case read(ctx, recipient_packages(_, a.player.row.id, now)) {
    Error(response) -> response
    Ok(ps) ->
      case list.find(ps, fn(p) { p.row.id == package_id }) {
        Ok(p) -> next(p)
        Error(Nil) -> not_found()
      }
  }
}

/// `GET /player/signings/:id`.
pub fn player_get(
  ctx: Ctx,
  req: Request,
  a: PlayerAccess,
  package_id: id.SigningPackageId,
) -> Response {
  let now = clock.request_ms(ctx.config, req)
  use p <- player_package(ctx, a, package_id, now)
  case read(ctx, recipient_json(_, p, a.player.row.id, now)) {
    Error(response) -> response
    Ok(view) ->
      http.json(
        200,
        json.object([
          #("signing", view),
          #("history", signing_rules.history_view(p, True)),
        ]),
      )
  }
}

/// `GET /player/signings/:id/document`: a presented revision's document.
pub fn player_document(
  ctx: Ctx,
  req: Request,
  a: PlayerAccess,
  package_id: id.SigningPackageId,
) -> Response {
  let now = clock.request_ms(ctx.config, req)
  use p <- player_package(ctx, a, package_id, now)
  let shape = {
    use revision_id <- input.field("revisionId", input.optional(input.id()))
    input.done(revision_id)
  }
  use revision_id <- query(req, shape)
  let rev =
    case revision_id {
      Some(r) -> signing_rules.revision(p, r)
      None -> signing_rules.current_revision(p)
    }
    |> option.then(fn(r) {
      case r.row.ready_at {
        Some(_) -> Some(r)
        None -> None
      }
    })
  serve_document(ctx, p, rev, False, document_not_found())
}

/// `POST /player/signings/:id/complete`: the player's own signature.
pub fn player_complete(
  ctx: Ctx,
  req: Request,
  a: PlayerAccess,
  package_id: id.SigningPackageId,
) -> Response {
  let now = clock.request_ms(ctx.config, req)
  use p <- player_package(ctx, a, package_id, now)
  case
    read(ctx, fn(r) {
      use room <- result.try(cases.room(r, p.row.case_id))
      use name <- result.map(org_name(r, p.row.org_id))
      #(room, name)
    })
  {
    Error(response) -> response
    Ok(#(None, _)) -> not_found()
    Ok(#(Some(room), name)) ->
      complete_party(
        ctx,
        req,
        p,
        room,
        PlayerSigner(a.player.row.id, Some(a.player.row.name)),
        name,
        Some(a.player.row.name),
        now,
      )
  }
}

const guardian_note =
  "Signing on behalf of a player under the age of majority is not open in this jurisdiction."

/// `GET /guardian/signings`: dormant while the guardian pathway is closed everywhere.
pub fn guardian_list(_g: Guardian) -> Response {
  http.json(
    200,
    json.object([
      #("items", json.preprocessed_array([])),
      #("note", json.string(guardian_note)),
    ]),
  )
}

/// `GET /guardian/signings/:id`.
pub fn guardian_get() -> Response {
  not_found()
}

/// `GET /guardian/signings/:id/document`.
pub fn guardian_document() -> Response {
  document_not_found()
}

/// `POST /guardian/signings/:id/complete`: no package is ever addressed to a guardian while the pathway is closed,
/// so every reference is concealed.
pub fn guardian_complete() -> Response {
  not_found()
}

// ------------------------------------------------------------------------------------------------ agent

/// `GET /org/agent/clients/:id/signings`: the client's presented packages over an Offer they shared with this agent.
pub fn agent_signings(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  agreement_id: id.AgreementId,
) -> Response {
  use m <- agent_core.membership(ctx, a)
  use found <- agent_core.own_agreement(ctx, m, agreement_id)
  case found {
    agent_core.Summary(_) ->
      http.error_message(
        403,
        "AGENT_ACTION_NOT_PERMITTED",
        "A summary row does not open a client's signings.",
      )
    agent_core.Own(agreement) -> {
      let now = clock.request_ms(ctx.config, req)
      let client_id = agreement.row.client_id
      let closed = fn(code, rule) {
        http.json(
          403,
          json.object([
            #("error", json.string(code)),
            #("rule", json.nullable(rule, json.string)),
            #(
              "message",
              json.string(
                "This client's signings are not open to you right now.",
              ),
            ),
          ]),
        )
      }
      let checked =
        read(ctx, fn(rd) {
          use decision <- result.try(integration.decide(
            rd,
            integration.ClientPrivate,
            client_id,
            a.user.id,
            None,
            now,
          ))
          use licence <- result.map(integration.licence_current(
            rd,
            a.user.id,
            agreement.row.jurisdiction,
            now,
          ))
          #(decision, licence)
        })
      case checked {
        Error(response) -> response
        Ok(#(integration.Denied(code:, rule:), _)) -> closed(code, Some(rule))
        Ok(#(integration.Allowed(basis), licence)) ->
          case
            list.any(basis.scope, fn(s) {
              s == scope_row.Employment || s == scope_row.Transfer
            }),
            licence
          {
            False, _ ->
              http.error_message(
                403,
                "SCOPE_INSUFFICIENT",
                "Your representation scope with this client does not cover employment or transfer.",
              )
            True, False -> closed("LICENCE_NOT_CURRENT", Some("LICENCE"))
            True, True -> agent_items(ctx, a, client_id, now)
          }
      }
    }
  }
}

fn agent_items(
  ctx: Ctx,
  a: OrgAccess,
  client_id: String,
  now: Int,
) -> Response {
  case
    read(ctx, fn(rd) {
      use all <- result.try(signing_packages.for_player(
        rd,
        id.player(client_id),
      ))
      use items <- result.try(
        list.try_fold(all, [], fn(out, p) {
          use ok <- result.try(signing_reads.sound(rd, p, now))
          use offer <- result.try(offers.by_id(rd, p.row.offer_id))
          let shared = case offer {
            Some(o) ->
              o.row.org_id == p.row.org_id
              && o.row.agent_share_user_id == Some(a.user.id)
            None -> False
          }
          let presented =
            list.any(p.revisions, fn(r) { r.row.ready_at != None })
          case ok && shared && presented {
            True -> {
              use name <- result.map(org_name(rd, p.row.org_id))
              [json.object(signing_rules.agent_view(p, now, name)), ..out]
            }
            False -> Ok(out)
          }
        }),
      )
      use seen <- result.map(players.for_org(
        rd,
        id.player(client_id),
        a.org,
        now,
      ))
      #(list.reverse(items), case seen {
        Some(#(p, access)) if access.visible && !access.blocked ->
          json.string(p.row.name)
        _ -> json.null()
      })
    })
  {
    Error(response) -> response
    Ok(#(items, name)) ->
      http.json(
        200,
        json.object([
          #("items", json.preprocessed_array(items)),
          #("clientId", json.string(client_id)),
          #("clientName", name),
          #("honest", json.string(signing_rules.agent_honest)),
        ]),
      )
  }
}

// ------------------------------------------------------------------------------------------------ legacy

/// An accepted Offer or a live or completed package between this club and player means the workflow owns the
/// signing (legacyRecordingBlocker).
fn legacy_blocker(
  read: Read,
  player_id: id.PlayerId,
  org_id: id.OrgId,
  now: Int,
) -> Result(Option(String), Fail(e)) {
  use player_offers <- result.try(offers.for_player(read, player_id))
  use packages <- result.map(signing_packages.for_org_player(
    read,
    org_id,
    player_id,
  ))
  case
    list.any(player_offers, fn(o) {
      o.row.org_id == org_id
      && offer_rules.status(o, now) == Some(offer_status.Accepted)
    }),
    list.any(packages, fn(p) {
      signing_rules.is_live(p, now)
      || signing_rules.effective_status(p, now) == signing_rules.Completed
    })
  {
    True, _ ->
      Some(
        "This player accepted a canonical Offer from your club: complete the signing through the signing workflow on the case.",
      )
    _, True ->
      Some(
        "A signing workflow exists for this player on your case: complete it there.",
      )
    False, False -> None
  }
}

/// `POST /org/players/:id/signing`: a club lead records a signing of a recruitment that never used an Offer,
/// through the one writer. Refused when the workflow owns the outcome.
pub fn legacy_record(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  player_id: String,
) -> Response {
  let now = clock.now_ms()
  let pid = id.player(player_id)
  case a.org.type_, a.org.level, roles.is_lead_role(a.user.role) {
    org_type.Agency, _, _ | _, Some(orgs.LevelAgency), _ ->
      http.error_message(
        403,
        "SIGNING_NOT_PERMITTED",
        "Only a club records a signing.",
      )
    _, _, False ->
      http.error_message(
        403,
        "LEAD_REQUIRED",
        "Only recruitment leads and directors can record a signing.",
      )
    _, _, True ->
      case
        read(ctx, fn(r) {
          use seen <- result.try(players.for_org(r, pid, a.org, now))
          case seen {
            None -> Ok(None)
            Some(#(p, access)) -> {
              use blocker <- result.try(legacy_blocker(r, pid, a.org.id, now))
              use rows <- result.map(signing_writer.for_org_player(
                r,
                a.org.id,
                pid,
              ))
              Some(#(
                p,
                access,
                blocker,
                list.find(rows, fn(s) { s.signing_package_id == None }),
              ))
            }
          }
        })
      {
        Error(response) -> response
        Ok(None) -> http.error(404, "PLAYER_NOT_FOUND")
        Ok(Some(#(_, access, _, _))) if !access.visible ->
          http.error(403, "UNDER_18_WALL")
        Ok(Some(#(_, access, _, _))) if access.blocked ->
          http.error(403, "BLOCKED")
        Ok(Some(#(_, _, Some(message), _))) ->
          http.json(
            409,
            json.object([
              #("ok", json.bool(False)),
              #("error", json.string("SIGNING_CANONICAL_REQUIRED")),
              #("message", json.string(message)),
            ]),
          )
        Ok(Some(#(_, _, None, Ok(standing)))) ->
          http.json(
            409,
            json.object([
              #("ok", json.bool(False)),
              #("error", json.string("SIGNING_ALREADY_RECORDED")),
              #(
                "message",
                json.string(
                  "A signing of this player by your club is already on record.",
                ),
              ),
              #("signingId", id.signing_json(standing.id)),
            ]),
          )
        Ok(Some(#(player, _, None, Error(Nil)))) -> {
          let shape = {
            use note <- input.field("note", input.nullish(input.text(400)))
            input.done(note)
          }
          use note <- http.body(req, shape, [])
          use <- limited(
            ctx,
            req,
            limits.SigningClosure,
            id.org_to_string(a.org.id),
          )
          store.unit(ctx.store, fn(tx) {
            use written <- result.try(
              signing_writer.record_completed(
                tx,
                player,
                a.org,
                Some(#(a.user.id, a.user.name)),
                now,
                signing_writer.Legacy(input.filled(note)),
              )
              |> storage,
            )
            Ok(http.json(
              201,
              json.object([
                #("ok", json.bool(True)),
                #(
                  "signing",
                  signings.legacy_json(written.signing, written.first),
                ),
              ]),
            ))
          })
          |> room_routes.answer
        }
      }
  }
}
