//// Contact routes (domains/recruitment/lifecycle/contactRoutes.mjs): the club side of one communication process.
//// There is no recipient route here: the recipient answers the request row a send creates through the Inbox
//// respond route, which lands the answer on the Contact (`contacts.on_request_responded`).
////
//// A send's request row, Contact and lifecycle entry commit in one unit, so the case cannot say `contacted` while
//// the Contact that justifies it was lost.
////
//// Not ported yet: the live contact events.

import gleam/dynamic.{type Dynamic}
import gleam/int
import gleam/io
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/order
import gleam/result
import gleam/string
import scoutbox/agents/integration
import scoutbox/agents/representation
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/guardians
import scoutbox/identity/orgs
import scoutbox/identity/players
import scoutbox/messaging/delivery
import scoutbox/messaging/notifications
import scoutbox/messaging/outbox
import scoutbox/platform/canonical
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/idempotency
import scoutbox/platform/input
import scoutbox/platform/limits
import scoutbox/platform/rev
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/recruitment/case_lifecycle
import scoutbox/recruitment/cases.{type Room}
import scoutbox/recruitment/contact_rules.{
  type Contact, type Refusal, type Routing, Routing,
}
import scoutbox/recruitment/contacts
import scoutbox/recruitment/domain_errors
import scoutbox/recruitment/recipients.{type Recipient}
import scoutbox/recruitment/request_routes
import scoutbox/recruitment/requests
import scoutbox/recruitment/room_routes
import scoutbox/recruitment/room_rules
import scoutbox/recruitment/room_view
import scoutbox/rows/delivery_fail_injections as injection_row
import scoutbox/rows/id
import scoutbox/rows/recruitment_contacts as row
import scoutbox/safety/audit
import scoutbox/safety/moderate
import scoutbox/vocab/audience
import scoutbox/vocab/contact_mode.{type ContactMode}
import scoutbox/vocab/party
import scoutbox/vocab/room_status
import wisp.{type Request, type Response}

// --------------------------------------------------------------------------------------------------- helpers

fn err(
  code: String,
  message: String,
  fields: List(#(String, Json)),
) -> Response {
  domain_errors.refuse(domain_errors.lifecycle, code, message, fields)
}

fn fail(r: Refusal) -> Response {
  err(r.error, r.message, r.fields)
}

fn with_read(
  ctx: Ctx,
  f: fn(Read) -> Result(a, Fail(e)),
  next: fn(a) -> Response,
) -> Response {
  case store.read(ctx.store, f) {
    Ok(a) -> next(a)
    Error(e) -> http.internal(e)
  }
}

fn storage(r: Result(a, Fail(e))) -> Result(a, Fail(Response)) {
  room_routes.storage(r)
}

/// A re-run after a lost race was charged on its first run.
fn limited(
  ctx: Ctx,
  req: Request,
  action: limits.Action,
  a: OrgAccess,
  next: fn() -> Response,
) -> Response {
  case
    !http.rerun(req)
    && limits.limited(
      ctx.limits,
      action,
      id.org_to_string(a.org.id),
      clock.now_ms(),
    )
  {
    True ->
      http.json(
        429,
        json.object(
          list.map(limits.limited_body(action), fn(p) {
            #(p.0, json.string(p.1))
          }),
        ),
      )
    False -> next()
  }
}

const codes = [
  #("expectedRev", "EXPECTED_REV_INVALID"),
  #("expectedVersion", "EXPECTED_REV_INVALID"),
  #("contactMode", "CONTACT_MODE_INVALID"),
]

/// The request body read with its shape, or the refusal (CONTACT_CONTENT_INVALID unless a field names its own).
fn body(
  req: Request,
  shape: input.Shape(a),
  next: fn(a, Dynamic) -> Response,
) -> Response {
  use raw <- http.json_body(req)
  case
    input.parse_coded(
      shape,
      raw,
      root: "body",
      codes:,
      default: "CONTACT_CONTENT_INVALID",
    )
  {
    Error(r) ->
      domain_errors.send(
        domain_errors.lifecycle,
        r.error,
        input.refusal_fields(r),
      )
    Ok(v) -> next(v, raw)
  }
}

fn client_key(
  raw: Option(Dynamic),
  next: fn(Option(String)) -> Response,
) -> Response {
  case idempotency.client_key(raw) {
    Ok(k) -> next(k)
    Error(m) -> err("CONTACT_CLIENT_KEY_INVALID", m, [])
  }
}

/// Shape and type only: `validate_content` cleans the words and judges their length (markup is stripped first,
/// so the raw text may run longer than the limit).
const words_max = 1_000_000

fn words() -> input.Rule(Option(String)) {
  input.nullish(input.text(words_max))
}

fn fingerprint(fields: List(#(String, canonical.Value))) -> String {
  canonical.to_string(canonical.Object(fields))
}

fn staff(a: OrgAccess) -> contacts.Actor {
  contacts.Staff(a.user.id, a.user.name)
}

fn by_staff(
  a: OrgAccess,
  at: Int,
  history: List(contacts.Entry),
) -> contacts.Acted {
  contacts.Acted(
    at:,
    rev_by: Some(#(a.user.id, a.user.name)),
    touch: True,
    bump: True,
    history:,
  )
}

fn guard(bad: Bool, refusal: fn() -> Response, next: fn() -> Response) {
  case bad {
    True -> refusal()
    False -> next()
  }
}

fn contact_json(c: Contact) -> #(String, Json) {
  #("contact", contact_rules.view(c))
}

// ---------------------------------------------------------------------------------------------------- lookups

/// A Room of this organisation (through the rooms' concealing lookup) the member may act on for `need`.
fn room_for(
  ctx: Ctx,
  a: OrgAccess,
  room_id: id.RecruitmentCaseId,
  need: contact_rules.Need,
  next: fn(Room, Option(room_rules.RoomRole)) -> Response,
) -> Response {
  use room <- room_routes.with_room(ctx, a, room_id)
  let role = room_view.role(a, room)
  case contact_rules.role_allows(role, need) {
    True -> next(room, role)
    False ->
      err(
        "CONTACT_NOT_PERMITTED",
        case need {
          contact_rules.ContactWrite ->
            "Only a room lead or recruitment lead can draft, send or record a contact."
          contact_rules.ContactView ->
            "Your role cannot read contacts in this room."
        },
        [],
      )
  }
}

fn log_integrity(c: Contact, problems: List(String)) -> Nil {
  io.println_error(
    "CONTACT integrity "
    <> id.contact_to_string(c.row.id)
    <> ": "
    <> string.join(problems, ","),
  )
}

/// This case's contacts, oldest first; corrupt ones are omitted, named in the log and counted.
fn contacts_of(
  read: Read,
  room: Room,
) -> Result(#(List(Contact), Int), Fail(e)) {
  use all <- result.map(contacts.for_case(read, room.row.id))
  let #(good, omitted) =
    list.fold(all, #([], 0), fn(acc, c) {
      let #(good, omitted) = acc
      case c.row.org_id == room.row.org_id {
        False -> acc
        True ->
          case
            contact_rules.integrity(c, Some(room.row.org_id), Some(room.row.id))
          {
            [] -> #([c, ..good], omitted)
            problems -> {
              log_integrity(c, problems)
              #(good, omitted + 1)
            }
          }
      }
    })
  let sorted =
    list.sort(good, fn(x, y) {
      case int.compare(x.row.created_at, y.row.created_at) {
        order.Eq ->
          string.compare(
            id.contact_to_string(x.row.id),
            id.contact_to_string(y.row.id),
          )
        other -> other
      }
    })
  #(sorted, omitted)
}

fn with_contact(
  ctx: Ctx,
  room: Room,
  cid: String,
  next: fn(Contact) -> Response,
) -> Response {
  use found <- with_read(ctx, contacts.by_id(_, id.contact(cid)))
  case found {
    Some(c) if c.row.case_id == room.row.id && c.row.org_id == room.row.org_id ->
      case
        contact_rules.integrity(c, Some(room.row.org_id), Some(room.row.id))
      {
        [] -> next(c)
        problems -> {
          log_integrity(c, problems)
          err("CONTACT_STATE_UNKNOWN", "This contact cannot be read.", [])
        }
      }
    _ -> err("CONTACT_NOT_FOUND", "No such contact.", [])
  }
}

/// Computed now, never trusted from a client.
fn recipient_for(
  read: Read,
  a: OrgAccess,
  room: Room,
) -> Result(Result(Recipient, Refusal), Fail(e)) {
  use r <- result.map(recipients.resolve(
    read,
    room.row.player_id,
    a.org,
    clock.now_ms(),
  ))
  result.map_error(r, contact_rules.recipient_refusal)
}

/// The agent decision is the integration seam's (representation, licence and disclosure rules), re-derived at
/// compose time and again at send. A minor's route is the guardian's; an agent is never substituted for one.
fn route_for(
  read: Read,
  a: OrgAccess,
  room: Room,
  recipient: Recipient,
  mode: ContactMode,
) -> Result(Routing, Fail(e)) {
  let player_only = fn(refusal) {
    Routing(contact_mode.PlayerOnly, None, refusal)
  }
  let now = clock.now_ms()
  let client = id.player_to_string(room.row.player_id)
  case mode, recipient.minor {
    contact_mode.PlayerOnly, _ -> Ok(player_only(None))
    _, True -> Ok(player_only(Some("MINOR_PATHWAY_DISABLED")))
    contact_mode.Both, False -> {
      use #(sole, ambiguous) <- result.try(representation.sole_active(
        read,
        client,
        now,
      ))
      case sole, ambiguous {
        None, True -> Ok(player_only(Some("REPRESENTATION_AMBIGUOUS")))
        None, False -> Ok(player_only(Some("NO_REPRESENTATION")))
        Some(agreement), _ -> {
          use decision <- result.map(integration.decide(
            read,
            integration.ContactParticipation,
            client,
            agreement.row.agent_user_id,
            Some(a.org.id),
            now,
          ))
          case decision {
            integration.Allowed(basis) ->
              Routing(
                contact_mode.Both,
                Some(contact_rules.RoutedAgent(
                  basis.row.agent_user_id,
                  basis.row.id,
                )),
                None,
              )
            integration.Denied(code, _) -> player_only(Some(code))
          }
        }
      }
    }
  }
}

/// The recipient and, when there is one, the route for `mode`.
fn routed(
  ctx: Ctx,
  a: OrgAccess,
  room: Room,
  mode: ContactMode,
  next: fn(Result(Recipient, Refusal), Option(Routing)) -> Response,
) -> Response {
  use found <- with_read(ctx, fn(read) {
    use r <- result.try(recipient_for(read, a, room))
    case r {
      Error(_) -> Ok(#(r, None))
      Ok(rec) -> {
        use routing <- result.map(route_for(read, a, room, rec, mode))
        #(r, Some(routing))
      }
    }
  })
  next(found.0, found.1)
}

/// An unrecognised mode is refused rather than read as `player_only`, which would hide a client bug behind a safe
/// default.
fn mode_of(raw: Option(String), next: fn(ContactMode) -> Response) -> Response {
  case raw {
    None | Some("") -> next(contact_mode.PlayerOnly)
    Some(text) ->
      case list.key_find(contact_mode.pairs, text) {
        Ok(mode) -> next(mode)
        Error(Nil) ->
          err(
            "CONTACT_MODE_INVALID",
            "contactMode must be \"player_only\" or \"both\". There is no mode that reaches an agent instead of the player.",
            [#("allowed", modes_json())],
          )
      }
  }
}

fn modes_json() -> Json {
  json.array(contact_mode.pairs, fn(p) { json.string(p.0) })
}

fn case_statuses_json() -> Json {
  json.array(contact_rules.case_statuses, room_status.to_json)
}

/// The case must have agreed to approach the player (contact_planned) or already have done so.
fn case_gate(room: Room, next: fn() -> Response) -> Response {
  case contact_rules.accepts_case(room.status) {
    True -> next()
    False ->
      err(
        "CONTACT_CASE_STATE",
        "A case at \""
          <> room_rules.status_label(room.status)
          <> "\" cannot contact the player. Plan the contact first (planContact).",
        [#("allowed", case_statuses_json())],
      )
  }
}

/// Required on a mutation of an existing Contact; absent is refused, never coerced.
fn rev_gate(raw: Dynamic, c: Contact, next: fn() -> Response) -> Response {
  case rev.expected(raw) {
    Error(refused) -> refused
    Ok(rev.Unguarded) ->
      err(
        "CONTACT_REV_REQUIRED",
        "expectedRev is required: send the rev you were editing.",
        [],
      )
    Ok(expected) ->
      rev.guard(
        expected,
        rev.Rev(c.row.rev, c.row.rev_at, c.row.rev_by_name),
        "CONTACT_VERSION_CONFLICT",
        [#("status", row.status_to_json(c.row.status))],
        next,
      )
  }
}

fn moderated(
  ctx: Ctx,
  a: OrgAccess,
  text: String,
  kind: String,
  next: fn() -> Response,
) -> Response {
  moderate.or_refuse(
    ctx,
    text,
    audit.Context(
      kind:,
      player_id: None,
      org_id: Some(a.org.id),
      user_id: Some(a.user.id),
      channel_id: None,
      request_id: None,
    ),
    next,
  )
}

fn words_of(c: contact_rules.Content) -> String {
  option.unwrap(c.subject, "") <> "\n" <> c.body
}

fn can(
  c: Contact,
  action: contact_rules.Action,
  role: Option(room_rules.RoomRole),
  next: fn() -> Response,
) -> Response {
  case contact_rules.can_act(c, action, role) {
    Ok(Nil) -> next()
    Error(r) -> fail(r)
  }
}

// ---------------------------------------------------------------------------------------------- the case moves

type Moved {
  MovedCase(from: room_status.RoomStatus, to: room_status.RoomStatus)
  NotMoved
}

/// The Contact writes no case status: it asks the lifecycle whether `recordContact` is possible (the evidence is
/// this Contact, already written) and moves through the status writer. "Already contacted" is not an error.
fn advance(
  tx: Tx,
  a: OrgAccess,
  room: Room,
  role: Option(room_rules.RoomRole),
  c: Contact,
  at: Int,
) -> Result(#(Contact, Moved), Fail(e)) {
  let assert Some(action) = case_lifecycle.action_named("recordContact")
    as "the contact act names a lifecycle action"
  // The case as it is now: a concurrent send or external record may have moved it since the room was read.
  use current <- result.try(cases.room(store.reading(tx), room.row.id))
  let room = option.unwrap(current, room)
  use verdict <- result.try(case_lifecycle.check(
    store.reading(tx),
    room,
    action,
    role,
    [],
    at,
    False,
  ))
  case verdict {
    Ok(allowed) -> {
      use #(from, to) <- result.try(case_lifecycle.apply(
        tx,
        room,
        room_view.level(a.org),
        allowed.to,
        [],
        "contact:" <> id.contact_to_string(c.row.id),
        case_lifecycle.StaffMover(a.user.id, a.user.name),
        case_lifecycle.status_detail("recordContact", None, [
          #("contactId", id.contact_json(c.row.id)),
        ]),
      ))
      use stored <- result.map(contacts.record_lifecycle(
        tx,
        c.row.id,
        contacts.Applied(
          room_status.to_string(from),
          room_status.to_string(to),
          at,
        ),
      ))
      #(stored, MovedCase(from, to))
    }
    Error(r) -> {
      case r.error {
        "LIFECYCLE_NO_CHANGE" -> Nil
        other ->
          io.println_error(
            "CONTACT lifecycle_not_applied "
            <> id.contact_to_string(c.row.id)
            <> " "
            <> other,
          )
      }
      use stored <- result.map(contacts.record_lifecycle(
        tx,
        c.row.id,
        contacts.NotApplied(r.error, at),
      ))
      #(stored, NotMoved)
    }
  }
}

fn case_json(m: Moved, room: Room) -> Json {
  case m {
    MovedCase(from, to) ->
      json.object([
        #("from", room_status.to_json(from)),
        #("to", room_status.to_json(to)),
      ])
    NotMoved ->
      json.object([
        #("unchanged", json.bool(True)),
        #("status", room_status.to_json(room.status)),
      ])
  }
}

// ------------------------------------------------------------------------------------------------------- list

/// `GET /org/rooms/:id/contacts`. The preview asks for the widest mode so the club can see whether an agent would
/// be a party before drafting; nothing is sent and nobody is told.
pub fn list_contacts(ctx: Ctx, a: OrgAccess, rid: String) -> Response {
  use room, role <- room_for(
    ctx,
    a,
    id.recruitment_case(rid),
    contact_rules.ContactView,
  )
  use #(items, omitted) <- with_read(ctx, contacts_of(_, room))
  use everyone <- with_read(ctx, contacts.for_org_player(
    _,
    room.row.org_id,
    room.row.player_id,
  ))
  use recipient, routing <- routed(ctx, a, room, contact_mode.Both)
  let cooldown =
    contact_rules.cooldown_until(
      everyone,
      room.row.org_id,
      room.row.player_id,
      clock.now_ms(),
      None,
    )
  http.json(
    200,
    json.object([
      #("items", json.array(items, contact_rules.view)),
      #("omitted", json.int(omitted)),
      #("routing", contact_rules.routing_view(recipient, routing)),
      #(
        "case",
        json.object([
          #("status", room_status.to_json(room.status)),
          #(
            "acceptsContact",
            json.bool(contact_rules.accepts_case(room.status)),
          ),
          #("planAction", json.string("planContact")),
        ]),
      ),
      #(
        "canWrite",
        json.bool(contact_rules.role_allows(role, contact_rules.ContactWrite)),
      ),
      #("cooldown", case cooldown {
        Some(until) -> json.object([#("until", json.int(until))])
        None -> json.null()
      }),
      #(
        "channels",
        json.object([
          #("inApp", json.string("in_app")),
          #(
            "external",
            json.array(contact_rules.external_channels(), fn(c) {
              json.object([
                #("id", row.channel_to_json(c)),
                #("label", json.string(contact_rules.channel_label(c))),
              ])
            }),
          ),
        ]),
      ),
      #(
        "limits",
        json.object([
          #("subject", json.int(contact_rules.subject_max)),
          #("body", json.int(contact_rules.body_max)),
          #("summary", json.int(contact_rules.summary_max)),
          #("replyMessage", json.int(contact_rules.reply_max)),
        ]),
      ),
      #("policyVersion", json.int(contact_rules.policy_version)),
      #(
        "note",
        json.string(
          "A draft is internal to your organisation. Only a sent message or a recorded external contact is a contact.",
        ),
      ),
    ]),
  )
}

/// `GET /org/rooms/:id/contacts/:cid`.
pub fn get(ctx: Ctx, a: OrgAccess, rid: String, cid: String) -> Response {
  use room, _ <- room_for(
    ctx,
    a,
    id.recruitment_case(rid),
    contact_rules.ContactView,
  )
  use c <- with_contact(ctx, room, cid)
  http.json(200, json.object([contact_json(c)]))
}

// ------------------------------------------------------------------------------------------------------ draft

type Draft {
  Draft(
    subject: Option(String),
    body: Option(String),
    contact_mode: Option(String),
    client_key: Option(Dynamic),
  )
}

fn draft_shape() -> input.Shape(Draft) {
  use subject <- input.field("subject", words())
  use body <- input.field("body", words())
  use contact_mode <- input.field("contactMode", words())
  use client_key <- input.field("clientKey", input.optional(input.anything()))
  input.done(Draft(subject:, body:, contact_mode:, client_key:))
}

/// `POST /org/rooms/:id/contacts`: a draft, a record of intent. No case history, notification, request row or
/// delivery state, and no agent is told anything.
pub fn create(ctx: Ctx, req: Request, a: OrgAccess, rid: String) -> Response {
  use room, _ <- room_for(
    ctx,
    a,
    id.recruitment_case(rid),
    contact_rules.ContactWrite,
  )
  use b, _ <- body(req, draft_shape())
  use key <- client_key(b.client_key)
  case contact_rules.validate_content(b.subject, b.body) {
    Error(r) -> fail(r)
    Ok(content) -> {
      use mode <- mode_of(b.contact_mode)
      // The same words to the player alone and to the player and agent are two different contacts, so the mode is
      // part of the fingerprint. A fingerprint over the words alone still matches when the stored mode agrees.
      let words = [
        #("subject", canonical.text(content.subject)),
        #("body", canonical.Str(content.body)),
      ]
      let fp =
        fingerprint([
          #("contactMode", canonical.Str(contact_mode.to_string(mode))),
          ..words
        ])
      let legacy_fp = fingerprint(words)
      use #(own, _) <- with_read(ctx, contacts_of(_, room))
      let prior = case key {
        Some(k) -> list.find(own, fn(c) { c.row.create_key == Some(k) })
        None -> Error(Nil)
      }
      case prior {
        Ok(c)
          if c.row.create_fp == Some(fp)
          || {
            c.row.create_fp == Some(legacy_fp)
            && c.row.contact_mode == mode
          }
        ->
          http.json(
            200,
            json.object([contact_json(c), #("idempotent", json.bool(True))]),
          )
        Ok(_) ->
          err(
            "CONTACT_IDEMPOTENCY_CONFLICT",
            "This clientKey was already used for a different draft.",
            [],
          )
        Error(Nil) -> {
          use <- case_gate(room)
          use <- limited(ctx, req, limits.ContactDraft, a)
          // Refused at compose time, and the same rule runs again at send.
          use recipient, routing <- routed(ctx, a, room, mode)
          case recipient {
            Error(r) -> fail(r)
            Ok(_) -> {
              use <- moderated(ctx, a, words_of(content), "recruitment_contact")
              create_draft(
                ctx,
                a,
                room,
                content,
                mode,
                key,
                fp,
                recipient,
                routing,
              )
            }
          }
        }
      }
    }
  }
}

fn create_draft(
  ctx: Ctx,
  a: OrgAccess,
  room: Room,
  content: contact_rules.Content,
  mode: ContactMode,
  key: Option(String),
  fp: String,
  recipient: Result(Recipient, Refusal),
  routing: Option(Routing),
) -> Response {
  let at = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    use contact_id <- result.try(id.next_contact(tx) |> storage)
    use h <- result.try(
      contacts.entry(
        tx,
        "contact_created",
        staff(a),
        Some([
          #("channel", json.string("in_app")),
          #("contactMode", contact_mode.to_json(mode)),
        ]),
        at,
      )
      |> storage,
    )
    use stored <- result.map(
      contacts.create(
        tx,
        row.Row(
          ..row.new(
            id: contact_id,
            org_id: room.row.org_id,
            case_id: room.row.id,
            player_id: room.row.player_id,
            status: row.Draft,
            channel: row.InApp,
            contact_mode: mode,
            created_by_user_id: a.user.id,
            created_at: at,
            updated_at: at,
            rev: 1,
            policy_version: contact_rules.policy_version,
          ),
          created_by_name: Some(a.user.name),
          subject: content.subject,
          body: Some(content.body),
          create_key: key,
          create_fp: option.map(key, fn(_) { fp }),
          rev_at: Some(at),
          rev_by_user_id: Some(a.user.id),
          rev_by_name: Some(a.user.name),
        ),
        [h],
      )
      |> storage,
    )
    http.json(
      201,
      json.object([
        contact_json(stored),
        #("routing", contact_rules.routing_view(recipient, routing)),
      ]),
    )
  })
  |> room_routes.answer
}

type EditBody {
  EditBody(
    subject: Option(Option(String)),
    body: Option(Option(String)),
    contact_mode: Option(Option(String)),
  )
}

fn edit_shape() -> input.Shape(EditBody) {
  use subject <- input.field("subject", input.clearable(input.text(words_max)))
  use body <- input.field("body", input.clearable(input.text(words_max)))
  use contact_mode <- input.field(
    "contactMode",
    input.clearable(input.text(words_max)),
  )
  use <- rev.fields
  input.done(EditBody(subject:, body:, contact_mode:))
}

/// `PATCH /org/rooms/:id/contacts/:cid`: a draft's words or mode. An absent field keeps what is stored.
pub fn edit(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  rid: String,
  cid: String,
) -> Response {
  use room, role <- room_for(
    ctx,
    a,
    id.recruitment_case(rid),
    contact_rules.ContactWrite,
  )
  use c <- with_contact(ctx, room, cid)
  use <- can(c, contact_rules.Edit, role)
  use b, raw <- body(req, edit_shape())
  use <- rev_gate(raw, c)
  let kept = fn(sent: Option(Option(String)), stored: Option(String)) {
    case sent {
      None -> stored
      Some(v) -> v
    }
  }
  case
    contact_rules.validate_content(
      kept(b.subject, c.row.subject),
      kept(b.body, c.row.body),
    )
  {
    Error(r) -> fail(r)
    Ok(content) -> {
      let with_mode = fn(next) {
        case b.contact_mode {
          None -> next(c.row.contact_mode)
          Some(sent) -> mode_of(sent, next)
        }
      }
      use mode <- with_mode
      use recipient, routing <- routed(ctx, a, room, mode)
      case recipient {
        Error(r) -> fail(r)
        Ok(_) -> {
          use <- moderated(ctx, a, words_of(content), "recruitment_contact")
          let changed =
            [
              #("subject", content.subject != c.row.subject),
              #("body", Some(content.body) != c.row.body),
              #("contactMode", mode != c.row.contact_mode),
            ]
            |> list.filter_map(fn(f) {
              case f.1 {
                True -> Ok(f.0)
                False -> Error(Nil)
              }
            })
          let at = clock.now_ms()
          store.unit(ctx.store, fn(tx) {
            use h <- result.try(
              contacts.entry(
                tx,
                "contact_edited",
                staff(a),
                Some([#("fields", json.array(changed, json.string))]),
                at,
              )
              |> storage,
            )
            use stored <- result.map(
              contacts.edit_draft(
                tx,
                c.row.id,
                content.subject,
                content.body,
                mode,
                by_staff(a, at, [h]),
              )
              |> storage,
            )
            http.json(
              200,
              json.object([
                contact_json(stored),
                #("routing", contact_rules.routing_view(recipient, routing)),
              ]),
            )
          })
          |> room_routes.answer
        }
      }
    }
  }
}

fn rev_only_shape() -> input.Shape(Nil) {
  use <- rev.fields
  input.done(Nil)
}

/// `POST /org/rooms/:id/contacts/:cid/cancel`. The draft text is kept: cancelling records that nothing was sent.
pub fn cancel(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  rid: String,
  cid: String,
) -> Response {
  use room, role <- room_for(
    ctx,
    a,
    id.recruitment_case(rid),
    contact_rules.ContactWrite,
  )
  use c <- with_contact(ctx, room, cid)
  use <- can(c, contact_rules.Cancel, role)
  use _, raw <- body(req, rev_only_shape())
  use <- rev_gate(raw, c)
  let at = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    use h <- result.try(
      contacts.entry(tx, "contact_cancelled", staff(a), None, at) |> storage,
    )
    use stored <- result.map(
      contacts.cancel(tx, c.row.id, staff(a), by_staff(a, at, [h]))
      |> storage,
    )
    http.json(200, json.object([contact_json(stored)]))
  })
  |> room_routes.answer
}

// ------------------------------------------------------------------------------------------------------- send

fn send_shape() -> input.Shape(Option(Dynamic)) {
  use client_key <- input.field("clientKey", input.optional(input.anything()))
  use <- rev.fields
  input.done(client_key)
}

fn delivered(c: Contact) -> Bool {
  c.row.status == row.Delivered || c.row.status == row.Responded
}

/// `POST /org/rooms/:id/contacts/:cid/send`. The in-app Inbox is the transport of record; a refusal leaves an
/// honest `failed` attempt and no recipient object.
pub fn send(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  rid: String,
  cid: String,
) -> Response {
  use room, role <- room_for(
    ctx,
    a,
    id.recruitment_case(rid),
    contact_rules.ContactWrite,
  )
  use c <- with_contact(ctx, room, cid)
  use raw_key, raw <- body(req, send_shape())
  use key <- client_key(raw_key)
  use #(own, _) <- with_read(ctx, contacts_of(_, room))
  // A send key is bound to the Contact it first sent; `delivered` is the Contact's current truth.
  let holder = case key {
    Some(k) -> list.find(own, fn(x) { x.row.send_key == Some(k) })
    None -> Error(Nil)
  }
  case holder {
    Ok(h) if h.row.id != c.row.id ->
      err(
        "CONTACT_IDEMPOTENCY_CONFLICT",
        "This clientKey was already used to send a different contact.",
        [],
      )
    Ok(_) ->
      http.json(
        200,
        json.object([
          contact_json(c),
          #("delivered", json.bool(delivered(c))),
          #("idempotent", json.bool(True)),
        ]),
      )
    Error(Nil) -> {
      // Validation before the rev guard, so a stale rev on an impossible action reports the impossibility.
      use <- can(c, contact_rules.Send, role)
      use <- case_gate(room)
      use <- rev_gate(raw, c)
      use <- limited(ctx, req, limits.ContactSend, a)
      // Re-derived now, not from the draft: age, guardian route, block, visibility and the agent's authority. A
      // draft composed while the agent was permitted sends to the player alone if that has since changed.
      use recipient, routing <- routed(ctx, a, room, c.row.contact_mode)
      case recipient, routing {
        Error(r), _ -> fail(r)
        Ok(_), None -> http.internal(Nil)
        Ok(rec), Some(route) -> {
          use everyone <- with_read(ctx, contacts.for_org_player(
            _,
            room.row.org_id,
            room.row.player_id,
          ))
          case
            contact_rules.cooldown_until(
              everyone,
              room.row.org_id,
              room.row.player_id,
              clock.now_ms(),
              Some(c.row.id),
            )
          {
            Some(retry_at) ->
              err(
                "CONTACT_COOLDOWN",
                "A contact was delivered to this player recently and has not been answered yet. Wait before sending another.",
                [#("retryAt", json.int(retry_at))],
              )
            None ->
              case contact_rules.validate_content(c.row.subject, c.row.body) {
                Error(r) -> fail(r)
                Ok(_) -> {
                  use <- moderated(
                    ctx,
                    a,
                    option.unwrap(c.row.subject, "")
                      <> "\n"
                      <> option.unwrap(c.row.body, ""),
                    "recruitment_contact",
                  )
                  send_now(ctx, a, room, role, c, key, rec, route)
                }
              }
          }
        }
      }
    }
  }
}

/// The guardian's courtesy copy: recorded in the outbox after the send commits, with the record's id on the copy.
type Mail {
  Mail(to: String, subject: String, text: String)
}

type Sent {
  SendFailed(Contact)
  Sent(contact: Contact, moved: Moved, mail: Option(Mail))
}

fn send_now(
  ctx: Ctx,
  a: OrgAccess,
  room: Room,
  role: Option(room_rules.RoomRole),
  c: Contact,
  key: Option(String),
  rec: Recipient,
  route: Routing,
) -> Response {
  let at = clock.now_ms()
  let by = staff(a)
  let send_key =
    contacts.SendKey(
      key:,
      fp: fingerprint([
        #("contactId", canonical.Str(id.contact_to_string(c.row.id))),
      ]),
    )
  let attempt = list.length(c.attempts) + 1
  let sent =
    store.unit(ctx.store, fn(tx) {
      use refused <- result.try(
        delivery.consume_injected(tx, injection_row.Contact) |> storage,
      )
      case refused {
        True -> {
          use h <- result.try(
            contacts.entry(
              tx,
              "contact_send_failed",
              by,
              Some([
                #("code", json.string("TRANSPORT_REFUSED")),
                #("attempt", json.int(attempt)),
              ]),
              at,
            )
            |> storage,
          )
          use failed <- result.map(
            contacts.record_send_failure(
              tx,
              c.row.id,
              send_key,
              "TRANSPORT_REFUSED",
              by_staff(a, at, [h]),
            )
            |> storage,
          )
          io.println_error(
            "CONTACT transport_failed "
            <> id.contact_to_string(c.row.id)
            <> " attempt="
            <> int.to_string(list.length(failed.attempts)),
          )
          SendFailed(failed)
        }
        False ->
          deliver(tx, a, room, role, c, rec, route, send_key, attempt, at)
      }
    })
  case sent {
    Ok(SendFailed(failed)) ->
      http.json(
        200,
        json.object([contact_json(failed), #("delivered", json.bool(False))]),
      )
    Ok(Sent(contact, moved, mail)) -> {
      // The guardian's copy is sent once the unit committed; its record and state are a later write of their own.
      case mail {
        Some(m) -> {
          let now = clock.now_ms()
          let _ =
            store.unit(ctx.store, fn(tx) {
              use mail_id <- result.try(outbox.append(
                tx,
                to: m.to,
                subject: m.subject,
                text: m.text,
                secrets: [],
                at: now,
              ))
              contacts.set_email_copy(
                tx,
                c.row.id,
                row.LocalOutbox,
                Some(id.mail_to_string(mail_id)),
                now,
              )
            })
          Nil
        }
        None -> Nil
      }
      http.json(
        200,
        json.object([
          contact_json(contact),
          #("delivered", json.bool(True)),
          #("routing", contact_rules.routing_view(Ok(rec), Some(route))),
          #("case", case_json(moved, room)),
        ]),
      )
    }
    Error(store.Refused(response)) -> response
    Error(store.Lost(what)) -> http.stale(what)
    Error(failure) -> http.internal(failure)
  }
}

fn deliver(
  tx: Tx,
  a: OrgAccess,
  room: Room,
  role: Option(room_rules.RoomRole),
  c: Contact,
  rec: Recipient,
  route: Routing,
  send_key: contacts.SendKey,
  attempt: Int,
  at: Int,
) -> Result(Sent, Fail(Response)) {
  let read = store.reading(tx)
  use player <- result.try(players.by_id(read, room.row.player_id) |> storage)
  let assert Some(player) = player as "a routable recipient's player reads"
  use certified <- result.try(
    orgs.safeguarding_certified(read, a.org) |> storage,
  )
  use request <- result.try(
    request_routes.issue_contact(
      tx,
      player,
      requests.NewContact(
        player_id: player.row.id,
        player_name: player.row.name,
        org_id: a.org.id,
        org_name: a.org.name,
        org_type: a.org.type_,
        org_verified: a.org.verified,
        org_safeguarding_certified: certified,
        org_trusted_partner: a.org.trusted_partner,
        user_id: a.user.id,
        scout_name: a.user.name,
        scout_role: a.user.role,
        message: option.unwrap(c.row.body, ""),
        guardian_id: rec.guardian_id,
        at:,
        subject: c.row.subject,
        contact_id: Some(c.row.id),
      ),
    )
    |> storage,
  )
  // A courtesy email to the guardian only (a player record carries no email): never the body, never the
  // transport of record, never "delivered".
  use guardian <- result.try(case rec.guardian_id {
    Some(g) -> guardians.by_id(read, g) |> storage
    None -> Ok(None)
  })
  let mail = case rec.kind, guardian {
    party.Guardian, Some(g) if g.row.email != "" ->
      Some(#(g.row.email, g.row.name))
    _, _ -> None
  }
  let copy = case rec.kind, mail {
    party.Guardian, Some(_) -> Some(#(row.Queued, at))
    party.Guardian, None -> Some(#(row.NotAvailable, at))
    _, _ -> None
  }
  let by = staff(a)
  use sent_entry <- result.try(
    contacts.entry(
      tx,
      "contact_sent",
      by,
      Some([
        #("channel", json.string("in_app")),
        #("recipientType", party.to_json(rec.kind)),
        #("attempt", json.int(attempt)),
        #("mode", contact_mode.to_json(route.mode)),
        #("agentParty", json.bool(route.agent != None)),
      ]),
      at,
    )
    |> storage,
  )
  // Recorded in the history, not only the response: that is where a club later looks to understand who saw a
  // message.
  use refused_entry <- result.try(
    case c.row.contact_mode != contact_mode.PlayerOnly && route.agent == None {
      True ->
        contacts.entry(
          tx,
          "contact_agent_routing_refused",
          by,
          Some([
            #(
              "reasonCode",
              json.string(option.unwrap(
                route.agent_refusal,
                "NO_REPRESENTATION",
              )),
            ),
          ]),
          at,
        )
        |> result.map(fn(e) { [e] })
        |> storage
      False -> Ok([])
    },
  )
  use delivered <- result.try(
    contacts.record_delivery(
      tx,
      c.row.id,
      contacts.Delivery(
        by:,
        send_key:,
        recipient: rec,
        request_id: request.id,
        routing: route,
        email_copy: copy,
      ),
      by_staff(a, at, [sent_entry, ..refused_entry]),
    )
    |> storage,
  )
  use #(stored, moved) <- result.try(
    advance(tx, a, room, role, delivered, at) |> storage,
  )
  // The agent hears through the notification stream into the Agent workspace's own Inbox and cannot answer:
  // accepting or declining belongs to the person the message is about.
  use _ <- result.try(case route.agent {
    Some(agent) ->
      notifications.notify(
        tx,
        to: audience.OrgUser,
        id: id.org_user_to_string(agent.agent_user_id),
        type_: "representation_contact",
        text: a.org.name
          <> " has sent your client a message and routed you a copy. Your client answers it themselves, in their own Inbox.",
        ref_id: Some(id.contact_to_string(c.row.id)),
        at:,
      )
      |> storage
    None -> Ok(Nil)
  })
  let mail =
    option.map(mail, fn(m) {
      let #(email, guardian_name) = m
      Mail(
        to: email,
        subject: a.org.name
          <> " has sent a message about "
          <> player.row.name
          <> " on ScoutBox",
        text: "Hi "
          <> guardian_name
          <> ",\n\n"
          <> a.org.name
          <> " ("
          <> case a.user.role {
          "" -> "Scout"
          r -> r
        }
          <> ": "
          <> a.user.name
          <> ") has sent a message about "
          <> player.row.name
          <> " in ScoutBox.\n\nOpen your ScoutBox guardian Inbox to read it and respond. Nothing about this contact happens outside ScoutBox unless you choose to accept it.",
      )
    })
  Ok(Sent(stored, moved, mail))
}

// --------------------------------------------------------------------------------------------- external record

type ExternalBody {
  ExternalBody(
    client_key: Option(Dynamic),
    channel: Option(Dynamic),
    occurred_at: Option(Dynamic),
    summary: Option(String),
    recipient_type: Option(String),
  )
}

fn external_shape() -> input.Shape(ExternalBody) {
  use client_key <- input.field("clientKey", input.optional(input.anything()))
  use channel <- input.field("channel", input.optional(input.anything()))
  use occurred_at <- input.field("occurredAt", input.optional(input.anything()))
  use summary <- input.field("summary", words())
  use recipient_type <- input.field(
    "recipientType",
    input.optional(input.text(words_max)),
  )
  input.done(ExternalBody(
    client_key:,
    channel:,
    occurred_at:,
    summary:,
    recipient_type:,
  ))
}

/// `POST /org/rooms/:id/contacts/external`: a contact that happened outside ScoutBox, attested by a named member
/// of staff. A minor recorded as "the player" is refused, not corrected. It carries no routing mode, and the
/// `agent` channel is a statement about the world that grants the agent no read.
pub fn record_external(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  rid: String,
) -> Response {
  use room, role <- room_for(
    ctx,
    a,
    id.recruitment_case(rid),
    contact_rules.ContactWrite,
  )
  use b, _ <- body(req, external_shape())
  use key <- client_key(b.client_key)
  use <- guard(b.recipient_type == None, fn() {
    err(
      "CONTACT_CONTENT_INVALID",
      "recipientType is required: who did you speak to, the player or the guardian?",
      [],
    )
  })
  use recipient <- with_read(ctx, recipient_for(_, a, room))
  case recipient {
    Error(r) -> fail(r)
    Ok(rec) ->
      case
        contact_rules.validate_external(
          b.channel,
          b.occurred_at,
          b.summary,
          b.recipient_type,
          clock.now_ms(),
          rec.kind,
        )
      {
        Error(r) -> fail(r)
        Ok(check) -> {
          let fp =
            fingerprint([
              #("channel", canonical.Str(row.channel_to_string(check.channel))),
              #("occurredAt", canonical.Int(check.occurred_at)),
              #("summary", canonical.text(check.summary)),
              #("recipientType", canonical.Str(party.to_string(rec.kind))),
            ])
          use #(own, _) <- with_read(ctx, contacts_of(_, room))
          let prior = case key {
            Some(k) -> list.find(own, fn(c) { c.row.record_key == Some(k) })
            None -> Error(Nil)
          }
          case prior {
            Ok(c) if c.row.record_fp == Some(fp) ->
              http.json(
                200,
                json.object([contact_json(c), #("idempotent", json.bool(True))]),
              )
            Ok(_) ->
              err(
                "CONTACT_IDEMPOTENCY_CONFLICT",
                "This clientKey was already used to record a different contact.",
                [],
              )
            Error(Nil) -> {
              use <- case_gate(room)
              use <- limited(ctx, req, limits.ContactExternalRecord, a)
              let summary_checked = fn(next) {
                case check.summary {
                  Some(s) ->
                    moderated(ctx, a, s, "recruitment_contact_record", next)
                  None -> next()
                }
              }
              use <- summary_checked
              file_external(ctx, a, room, role, rec, check, key, fp)
            }
          }
        }
      }
  }
}

fn file_external(
  ctx: Ctx,
  a: OrgAccess,
  room: Room,
  role: Option(room_rules.RoomRole),
  rec: Recipient,
  check: contact_rules.External,
  key: Option(String),
  fp: String,
) -> Response {
  let at = clock.now_ms()
  store.unit(ctx.store, fn(tx) {
    use contact_id <- result.try(id.next_contact(tx) |> storage)
    use h <- result.try(
      contacts.entry(
        tx,
        "contact_external_recorded",
        staff(a),
        Some([
          #("channel", row.channel_to_json(check.channel)),
          #("occurredAt", json.int(check.occurred_at)),
          #("recipientType", party.to_json(rec.kind)),
        ]),
        at,
      )
      |> storage,
    )
    // Written before the case is asked to move: the evidence is this record.
    use created <- result.try(
      contacts.create(
        tx,
        row.Row(
          ..row.new(
            id: contact_id,
            org_id: room.row.org_id,
            case_id: room.row.id,
            player_id: room.row.player_id,
            status: row.Recorded,
            channel: check.channel,
            contact_mode: contact_mode.PlayerOnly,
            created_by_user_id: a.user.id,
            created_at: at,
            updated_at: at,
            rev: 1,
            policy_version: contact_rules.policy_version,
          ),
          recipient_type: Some(rec.kind),
          recipient_player_id: Some(rec.player_id),
          recipient_guardian_id: rec.guardian_id,
          recipient_minor: Some(rec.minor),
          summary: check.summary,
          created_by_name: Some(a.user.name),
          occurred_at: Some(check.occurred_at),
          recorded_by_user_id: Some(a.user.id),
          recorded_by_name: Some(a.user.name),
          recorded_at: Some(at),
          record_key: key,
          record_fp: option.map(key, fn(_) { fp }),
          rev_at: Some(at),
          rev_by_user_id: Some(a.user.id),
          rev_by_name: Some(a.user.name),
        ),
        [h],
      )
      |> storage,
    )
    use #(stored, moved) <- result.map(
      advance(tx, a, room, role, created, at) |> storage,
    )
    http.json(
      201,
      json.object([contact_json(stored), #("case", case_json(moved, room))]),
    )
  })
  |> room_routes.answer
}

// ------------------------------------------------------------------------------------------------- vocabulary

/// `GET /org/recruitment/contact-policy`.
pub fn policy() -> Response {
  http.json(
    200,
    json.object([
      #("policyVersion", json.int(contact_rules.policy_version)),
      #("statuses", json.array(contact_rules.statuses, row.status_to_json)),
      #(
        "channels",
        json.array(contact_rules.channels, fn(c) {
          json.object([
            #("id", row.channel_to_json(c)),
            #("label", json.string(contact_rules.channel_label(c))),
            #("external", json.bool(contact_rules.external(c))),
          ])
        }),
      ),
      #("caseStatuses", case_statuses_json()),
      #(
        "limits",
        json.object([
          #("subject", json.int(contact_rules.subject_max)),
          #("body", json.int(contact_rules.body_max)),
          #("summary", json.int(contact_rules.summary_max)),
          #("replyMessage", json.int(contact_rules.reply_max)),
          #("clientKey", json.int(idempotency.client_key_max)),
          #("occurredAtSkewMs", json.int(900_000)),
          #("occurredAtMaxAgeMs", json.int(15_552_000_000)),
          #("cooldownMs", json.int(contact_rules.cooldown_ms)),
          #("historyPage", json.int(100)),
        ]),
      ),
      #("modes", modes_json()),
      #(
        "note",
        json.string(
          "A draft is not a contact. Delivered means the message is in the recipient's ScoutBox Inbox; ScoutBox does not report whether it was read.",
        ),
      ),
      #(
        "agentNote",
        json.string(
          "You may ask that the player's own agent be a party as well (\"both\"). Whether that is permitted is decided by the player's relationship, the agent's licence and the player's own choice — and it is decided again when you send. There is no mode that reaches an agent instead of the player.",
        ),
      ),
    ]),
  )
}
