//// Notification preferences (domains/platform/notificationPrefs.mjs; `notification_prefs`,
//// `notification_pref_categories`). `notify` checks them before a row is created, so a muted category is never
//// created rather than hidden by a client. A type with no category is delivered: a missing notice is worse than
//// a spare one. The mandatory categories cannot be turned off.
////
//// There is no e-mail transport, so `emailIntent` records what the person would want once there is one.

import gleam/dict
import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/regexp
import gleam/result
import scoutbox/app.{type Ctx}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/vocab/audience.{type Audience}
import scoutbox/vocab/notification_category.{
  type NotificationCategory, Activity, Assignments, BriefUpdates, Combine,
  Compliance, DevelopmentUpdates, DiscoveryNudges, EvidenceRequests, Mentions,
  Messages, OfferUpdates, Representation, RoomChanges, SecondLook,
  SecurityAccount, SigningUpdates, TransactionUpdates, TrialUpdates,
  WatchlistChanges,
}
import sqlight
import wisp.{type Request, type Response}

pub type Category {
  Category(
    id: NotificationCategory,
    label: String,
    default: Bool,
    mandatory: Bool,
  )
}

/// CATEGORIES, in its order. `test/scoutbox/spec_test.gleam` proves it equals the snapshot.
pub const categories = [
  Category(Mentions, "Mentions", True, False),
  Category(Assignments, "Assignments and tasks", True, False),
  Category(RoomChanges, "Recruitment Room changes", True, False),
  Category(EvidenceRequests, "Evidence requests and evidence", True, False),
  Category(Combine, "Combine requests and results", True, False),
  Category(TrialUpdates, "Trials and trial days", True, False),
  Category(SecondLook, "Second Look", True, False),
  Category(BriefUpdates, "Recruitment Briefs and coverage", True, False),
  Category(Messages, "Messages and requests", True, False),
  Category(Activity, "Recruitment outcomes and activity", True, False),
  // Off by default: unrequested nudges.
  Category(DiscoveryNudges, "Discovery nudges and badges", False, False),
  Category(WatchlistChanges, "Dynamic Watchlist changes", True, False),
  Category(
    DevelopmentUpdates,
    "Development plans, goals and reviews",
    True,
    False,
  ),
  Category(
    Representation,
    "Agent representation requests and changes",
    True,
    False,
  ),
  // Mandatory: muting it would mute a regulatory obligation.
  Category(
    Compliance,
    "Regulatory review, consent and verification",
    True,
    True,
  ),
  Category(TransactionUpdates, "Transaction workspace activity", True, False),
  Category(OfferUpdates, "Offers and Offer answers", True, False),
  Category(SigningUpdates, "Signing workflow", True, False),
  Category(SecurityAccount, "Security and account", True, True),
]

/// The category of each notification type this server sends: the part of TYPE_CATEGORY ported so far.
/// `test/scoutbox/spec_test.gleam` proves each entry agrees with the snapshot.
pub const type_category = [
  #("request", Messages),
  #("message", Messages),
  #("accepted", Messages),
  #("declined", Messages),
  #("guardian_decision", Messages),
  #("report_resolved", SecurityAccount),
  #("badge", DiscoveryNudges),
  #("verification", SecurityAccount),
  #("transition", SecurityAccount),
  #("support", SecurityAccount),
]

/// Mentions and assignments share the `recruitment_room` type, so they are told apart by the server's own
/// wording, never by user text.
pub fn category_of(
  type_: String,
  text: String,
) -> Option(NotificationCategory) {
  let said = fn(pattern) {
    let assert Ok(re) =
      regexp.compile(
        pattern,
        regexp.Options(case_insensitive: True, multi_line: False),
      )
    regexp.check(re, text)
  }
  case type_ {
    "recruitment_room" ->
      case said("mentioned you"), said("assigned you") {
        True, _ -> Some(Mentions)
        False, True -> Some(Assignments)
        False, False -> lookup(type_)
      }
    _ -> lookup(type_)
  }
}

fn lookup(type_: String) -> Option(NotificationCategory) {
  list.key_find(type_category, type_) |> option.from_result
}

fn info(c: NotificationCategory) -> Category {
  let assert Ok(found) = list.find(categories, fn(i) { i.id == c })
    as "every category is in CATEGORIES"
  found
}

pub type Effective {
  Effective(categories: List(#(NotificationCategory, Bool)), email_intent: Bool)
}

/// Stored over the defaults; the mandatory categories always on.
pub fn effective(
  read: Read,
  kind: Audience,
  id: String,
) -> Result(Effective, Fail(e)) {
  let args = [sqlight.text(audience.to_string(kind)), sqlight.text(id)]
  use intent <- result.try(store.one(
    read,
    "SELECT email_intent FROM notification_prefs WHERE audience_kind = ? AND audience_id = ?",
    args,
    decode.at([0], sqlight.decode_bool()),
  ))
  use stored <- result.map(
    store.query(
      read,
      "SELECT category, enabled FROM notification_pref_categories WHERE audience_kind = ? AND audience_id = ? ORDER BY rowid",
      args,
      {
        use c <- decode.field(0, notification_category.decoder())
        use on <- decode.field(1, sqlight.decode_bool())
        decode.success(#(c, on))
      },
    ),
  )
  let stored = dict.from_list(stored)
  Effective(
    categories: list.map(categories, fn(c) {
      #(c.id, case c.mandatory, dict.get(stored, c.id) {
        True, _ -> True
        False, Ok(on) -> on
        False, Error(Nil) -> c.default
      })
    }),
    email_intent: result.unwrap(intent, False),
  )
}

/// Whether a notice of `type_` reaches this person.
pub fn allows(
  read: Read,
  kind: Audience,
  id: String,
  category: Option(NotificationCategory),
) -> Result(Bool, Fail(e)) {
  case category {
    None -> Ok(True)
    Some(c) ->
      case info(c).mandatory {
        True -> Ok(True)
        False -> {
          use e <- result.map(effective(read, kind, id))
          list.key_find(e.categories, c) != Ok(False)
        }
      }
  }
}

fn view(e: Effective) -> Json {
  json.object([
    #(
      "categories",
      json.array(categories, fn(c) {
        json.object([
          #("id", json.string(notification_category.to_string(c.id))),
          #("label", json.string(c.label)),
          #(
            "enabled",
            json.bool(
              list.key_find(e.categories, c.id) |> result.unwrap(c.default),
            ),
          ),
          #("mandatory", json.bool(c.mandatory)),
        ])
      }),
    ),
    #("emailIntent", json.bool(e.email_intent)),
    #(
      "channels",
      json.object([
        #("inApp", json.string("always")),
        #("email", json.string("local_outbox")),
        #(
          "note",
          json.string(
            "In-app delivery always keeps the record. There is no external email transport in this build; the email preference records what you would want when one exists.",
          ),
        ),
      ]),
    ),
  ])
}

fn respond(ctx: Ctx, kind: Audience, id: String) -> Response {
  case store.read(ctx.store, effective(_, kind, id)) {
    Ok(e) -> http.json(200, json.object([#("preferences", view(e))]))
    Error(failure) -> http.internal(failure)
  }
}

/// `GET /…/notification-preferences`.
pub fn show(ctx: Ctx, kind: Audience, id: String) -> Response {
  respond(ctx, kind, id)
}

type Update {
  Update(
    categories: List(#(NotificationCategory, Bool)),
    email_intent: Option(Bool),
  )
}

/// Each category named once, each true or false.
fn categories_shape(
  left: List(Category),
  given: List(#(NotificationCategory, Bool)),
) -> input.Shape(List(#(NotificationCategory, Bool))) {
  case left {
    [] -> input.done(list.reverse(given))
    [c, ..rest] -> {
      use on <- input.field(
        notification_category.to_string(c.id),
        input.optional(input.boolean()),
      )
      categories_shape(rest, case on {
        Some(on) -> [#(c.id, on), ..given]
        None -> given
      })
    }
  }
}

fn update_shape() -> input.Shape(Update) {
  use given <- input.field(
    "categories",
    input.optional(input.object(categories_shape(categories, []))),
  )
  use email_intent <- input.field(
    "emailIntent",
    input.optional(input.boolean()),
  )
  input.done(Update(categories: option.unwrap(given, []), email_intent:))
}

fn refuse(r: input.Refusal) -> Response {
  let category = case r.field {
    "categories." <> name -> Some(name)
    _ -> None
  }
  let error = case category, r.problem, r.error {
    Some(_), input.UnknownField, _ -> "PREF_CATEGORY_UNKNOWN"
    _, _, "FIELD_INVALID" -> "PREFS_INVALID"
    _, _, code -> code
  }
  http.json(
    400,
    json.object(
      list.append(
        input.refusal_fields(input.Refusal(..r, error:)),
        case category {
          Some(name) -> [#("category", json.string(name))]
          None -> []
        },
      ),
    ),
  )
}

/// `PUT /…/notification-preferences`: the categories given are set, the others kept.
pub fn update(ctx: Ctx, req: Request, kind: Audience, id: String) -> Response {
  use raw <- http.json_body(req)
  case input.parse(update_shape(), raw, root: "body", codes: []) {
    Error(r) -> refuse(r)
    Ok(body) ->
      case list.find(body.categories, fn(p) { !p.1 && info(p.0).mandatory }) {
        Ok(#(c, _)) ->
          http.json(
            400,
            json.object([
              #("error", json.string("PREF_CATEGORY_MANDATORY")),
              #("category", json.string(notification_category.to_string(c))),
              #(
                "message",
                json.string(
                  "Security and account notices cannot be turned off.",
                ),
              ),
            ]),
          )
        Error(Nil) -> {
          let now = clock.now_ms()
          case
            store.unit(ctx.store, fn(tx) {
              save(tx, kind, id, body, now) |> result.map(fn(_) { #(Nil, []) })
            })
          {
            Ok(Nil) -> respond(ctx, kind, id)
            Error(failure) -> http.internal(failure)
          }
        }
      }
  }
}

fn save(
  tx: Tx,
  kind: Audience,
  id: String,
  body: Update,
  at: Int,
) -> Result(Nil, Fail(e)) {
  let who = [sqlight.text(audience.to_string(kind)), sqlight.text(id)]
  use intent <- result.try(case body.email_intent {
    Some(b) -> Ok(b)
    None ->
      effective(store.reading(tx), kind, id)
      |> result.map(fn(e) { e.email_intent })
  })
  use _ <- result.try(store.run(
    tx,
    "INSERT INTO notification_prefs (audience_kind, audience_id, email_intent, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(audience_kind, audience_id) DO UPDATE SET email_intent = excluded.email_intent, updated_at = excluded.updated_at",
    list.append(who, [sqlight.bool(intent), sqlight.int(at)]),
  ))
  list.try_each(body.categories, fn(p) {
    store.run(
      tx,
      "INSERT INTO notification_pref_categories (audience_kind, audience_id, category, enabled) VALUES (?, ?, ?, ?) ON CONFLICT(audience_kind, audience_id, category) DO UPDATE SET enabled = excluded.enabled",
      list.append(who, [
        sqlight.text(notification_category.to_string(p.0)),
        sqlight.bool(p.1),
      ]),
    )
  })
}
