//// Outgoing webhooks (domains/integrations/imports.mjs, webhooks.mjs; `webhook_endpoints`, `webhook_deliveries`).
//// A club subscribes an endpoint to events; an act emits one inside its own unit, so the delivery row commits with
//// the change it announces; the sweep sends it, signed, and retries.
////
//// Not ported yet: listing endpoints, rotating a secret, deactivating one, and an endpoint's deliveries.

import gleam/bit_array
import gleam/crypto
import gleam/dynamic/decode
import gleam/http as method
import gleam/http/request
import gleam/httpc
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/regexp
import gleam/result
import gleam/string
import gleam/uri
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/ids
import scoutbox/platform/input
import scoutbox/platform/secrets
import scoutbox/platform/store.{type Fail, type Tx}
import scoutbox/rows/ops_events as ops_row
import scoutbox/rows/webhook_deliveries as delivery_row
import scoutbox/rows/webhook_delivery_attempts as attempt_row
import scoutbox/rows/webhook_endpoint_events as event_row
import scoutbox/rows/webhook_endpoints as endpoint_row
import scoutbox/vocab/webhook_event.{type WebhookEvent}
import sqlight
import wisp.{type Request, type Response}

/// While one sweep awaits the receiver, another leaves the delivery alone: the send holds it this long.
const lease_ms = 30_000

/// Why a destination is refused (SSRF guard): outgoing webhooks never reach private infrastructure. Loopback is
/// allowed only with ALLOW_LOCAL_WEBHOOKS=1, for the test receiver.
pub fn url_problem(raw: String, allow_local: Bool) -> Option(String) {
  case uri.parse(raw) {
    Error(Nil) -> Some("not a valid URL")
    Ok(u) ->
      case u.scheme, u.host {
        Some(scheme), Some(host) if host != "" -> {
          let scheme = string.lowercase(scheme)
          let host = string.lowercase(host)
          let loopback =
            host == "localhost"
            || host == "::1"
            || string.starts_with(host, "127.")
          let private_host =
            matches("^(localhost|.*\\.local|.*\\.internal|.*\\.lan)$", host)
          let private_ip =
            matches(
              "^(10\\.|127\\.|169\\.254\\.|192\\.168\\.|172\\.(1[6-9]|2\\d|3[01])\\.|0\\.|::1$|f[cd][0-9a-f]{2}:|fe80:)",
              host,
            )
          case scheme == "http" || scheme == "https", u.userinfo {
            False, _ -> Some("only http(s) destinations are allowed")
            True, Some(_) -> Some("credentials in the URL are not allowed")
            True, None ->
              case loopback, allow_local {
                True, True -> None
                True, False ->
                  Some(
                    "loopback destinations are blocked (set ALLOW_LOCAL_WEBHOOKS=1 only for local receiver tests)",
                  )
                False, _ ->
                  case private_host, private_ip, scheme {
                    True, _, _ -> Some("internal hostnames are blocked")
                    _, True, _ ->
                      Some("private/link-local IP ranges are blocked")
                    _, _, "http" -> Some("external destinations must use https")
                    _, _, _ -> None
                  }
              }
          }
        }
        _, _ -> Some("not a valid URL")
      }
  }
}

fn matches(pattern: String, s: String) -> Bool {
  let assert Ok(re) =
    regexp.compile(
      pattern,
      regexp.Options(case_insensitive: True, multi_line: False),
    )
  regexp.check(re, s)
}

// ------------------------------------------------------------------------------------------------- subscribing

type Subscription {
  Subscription(url: Option(String), events: Option(List(WebhookEvent)))
}

/// `POST /org/webhooks`: a lead subscribes an endpoint. The signing secret is shown here (and on rotation) only.
pub fn create(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use <- access.require_lead(a)
  let shape = {
    use url <- input.field("url", input.nullish(input.text(2000)))
    use events <- input.field(
      "events",
      input.nullish(input.list_of(input.one_of(webhook_event.pairs), 100)),
    )
    input.done(Subscription(url:, events:))
  }
  use body <- http.body(req, shape, [])
  let events = option.unwrap(body.events, [])
  let allow_local = ctx.config.allow_local_webhooks
  case list.length(list.unique(events)) == list.length(events) {
    False ->
      http.json(
        400,
        json.object([
          #("error", json.string("FIELD_INVALID")),
          #("field", json.string("events")),
          #("problem", json.string("invalid")),
          #("message", json.string("events must not name an event twice.")),
        ]),
      )
    True ->
      case url_problem(option.unwrap(body.url, "null"), allow_local), events {
        Some(problem), _ ->
          http.error_message(400, "WEBHOOK_URL_REJECTED", problem)
        None, [] ->
          http.error_message(
            400,
            "EVENTS_REQUIRED",
            "Subscribe to at least one of: "
              <> string.join(list.map(webhook_event.pairs, fn(p) { p.0 }), ", "),
          )
        None, _ -> subscribe(ctx, a, option.unwrap(body.url, ""), events)
      }
  }
}

fn subscribe(
  ctx: Ctx,
  a: OrgAccess,
  url: String,
  events: List(WebhookEvent),
) -> Response {
  let now = clock.now_ms()
  let made =
    store.unit(ctx.store, fn(tx) {
      use id <- result.try(ids.next(tx, "whk"))
      let e =
        endpoint_row.Row(
          ..endpoint_row.new(
            id:,
            org_id: a.org.id,
            url:,
            secret: "whsec_" <> secrets.random_hex(24),
            active: True,
            created_at: now,
          ),
          created_by_name: Some(a.user.name),
        )
      use _ <- result.try(endpoint_row.insert(tx, e))
      use _ <- result.map(
        list.index_map(events, fn(ev, ord) { #(ev, ord) })
        |> list.try_each(fn(p) {
          event_row.insert(
            tx,
            event_row.new(endpoint_id: id, ord: p.1, event: p.0),
          )
        }),
      )
      e
    })
  case made {
    Ok(e) ->
      http.json(
        201,
        json.object([
          #("endpoint", endpoint_view(e, events)),
          #(
            "note",
            json.string(
              "The signing secret is shown here and on rotation only.",
            ),
          ),
        ]),
      )
    Error(failure) -> http.internal(failure)
  }
}

/// The endpoint as its creator sees it, its secret included; the previous secret never.
fn endpoint_view(e: endpoint_row.Row, events: List(WebhookEvent)) -> Json {
  json.object([
    #("id", json.string(e.id)),
    #("orgId", json.string(e.org_id)),
    #("url", json.string(e.url)),
    #("secret", json.string(e.secret)),
    #(
      "secretPrevValidUntil",
      json.nullable(e.secret_prev_valid_until, json.int),
    ),
    #("active", json.bool(e.active)),
    #("createdBy", json.nullable(e.created_by_name, json.string)),
    #("createdAt", json.int(e.created_at)),
    #(
      "events",
      json.array(events, fn(ev) { json.string(webhook_event.to_string(ev)) }),
    ),
  ])
}

// ------------------------------------------------------------------------------------------------- emitting

/// Queues `event` about `subject_id` for every active endpoint of `org_id` subscribed to it, in the caller's
/// unit.
pub fn emit(
  tx: Tx,
  org_id: Option(String),
  event: WebhookEvent,
  subject_id: String,
  at: Int,
) -> Result(Nil, Fail(e)) {
  case org_id {
    None -> Ok(Nil)
    Some(org_id) -> {
      use endpoints <- result.try(store.query(
        store.reading(tx),
        "SELECT w.id FROM webhook_endpoints w JOIN webhook_endpoint_events e ON e.endpoint_id = w.id WHERE w.org_id = ? AND w.active = 1 AND e.event = ? ORDER BY w.rowid",
        [sqlight.text(org_id), sqlight.text(webhook_event.to_string(event))],
        decode.at([0], decode.string),
      ))
      list.try_each(endpoints, fn(endpoint_id) {
        use id <- result.try(ids.next(tx, "dlv"))
        delivery_row.insert(
          tx,
          delivery_row.new(
            id:,
            endpoint_id:,
            org_id:,
            event_id: "evt_" <> secrets.random_hex(12),
            type_: event,
            subject_id:,
            status: delivery_row.Queued,
            next_at: at,
            created_at: at,
          ),
        )
      })
    }
  }
}

// ------------------------------------------------------------------------------------------------- the sweep

fn retry_ms(ctx: Ctx) -> List(Int) {
  case ctx.config.fast_sweeps {
    True -> [0, 300, 600, 900, 1200]
    False -> [0, 60_000, 300_000, 1_800_000, 7_200_000]
  }
}

/// Sends every due delivery. Returns how many were due.
pub fn sweep(ctx: Ctx) -> Int {
  let now = clock.now_ms()
  case
    store.read(ctx.store, fn(read) {
      store.query(
        read,
        "SELECT "
          <> delivery_row.columns
          <> " FROM webhook_deliveries WHERE status IN ('queued', 'retrying') AND next_at <= ? ORDER BY rowid",
        [sqlight.int(now)],
        delivery_row.decoder(),
      )
    })
  {
    Error(e) -> {
      wisp.log_error("webhook sweep: " <> string.inspect(e))
      0
    }
    Ok(due) -> {
      list.each(due, deliver_one(ctx, _))
      list.length(due)
    }
  }
}

type Claim {
  Claim(endpoint: Option(endpoint_row.Row), sent_before: Int)
}

fn deliver_one(ctx: Ctx, d: delivery_row.Row) -> Nil {
  let now = clock.now_ms()
  // The lease: only the sweep that moves `next_at` on sends this time.
  let claimed =
    store.unit(ctx.store, fn(tx) {
      use rows <- result.try(store.write(
        tx,
        "UPDATE webhook_deliveries SET next_at = ? WHERE id = ? AND status IN ('queued', 'retrying') AND next_at = ? RETURNING id",
        [
          sqlight.int(now + lease_ms),
          sqlight.text(d.id),
          sqlight.int(d.next_at),
        ],
        decode.at([0], decode.string),
      ))
      case rows {
        [] -> Ok(None)
        _ -> {
          let read = store.reading(tx)
          use endpoint <- result.try(store.one(
            read,
            "SELECT "
              <> endpoint_row.columns
              <> " FROM webhook_endpoints WHERE id = ?",
            [sqlight.text(d.endpoint_id)],
            endpoint_row.decoder(),
          ))
          use sent <- result.map(
            store.one(
              read,
              "SELECT COUNT(*) FROM webhook_delivery_attempts WHERE delivery_id = ?",
              [sqlight.text(d.id)],
              decode.at([0], decode.int),
            )
            |> result.map(result.unwrap(_, 0)),
          )
          Some(Claim(option.from_result(endpoint), sent))
        }
      }
    })
  case claimed {
    Ok(None) -> Nil
    Error(e) -> wisp.log_error("webhook sweep: " <> string.inspect(e))
    Ok(Some(Claim(endpoint, sent_before))) ->
      case endpoint {
        Some(w) if w.active ->
          case url_problem(w.url, ctx.config.allow_local_webhooks) {
            Some(problem) ->
              record(
                ctx,
                d,
                sent_before,
                Error(input.utf16_take("destination rejected: " <> problem, 200)),
                Some(delivery_row.Failed),
                False,
              )
            None -> post(ctx, d, w, sent_before)
          }
        _ -> abandon(ctx, d)
      }
  }
}

fn post(
  ctx: Ctx,
  d: delivery_row.Row,
  w: endpoint_row.Row,
  sent_before: Int,
) -> Nil {
  let body = payload(d) |> json.to_string
  let ts = clock.now_ms()
  let ts_text = int.to_string(ts)
  let signature =
    crypto.hmac(
      bit_array.from_string(d.event_id <> "." <> ts_text <> "." <> body),
      crypto.Sha256,
      bit_array.from_string(w.secret),
    )
    |> secrets.hex
  let answer = case request.to(w.url) {
    Error(Nil) -> Error("not a valid URL")
    Ok(req) ->
      req
      |> request.set_method(method.Post)
      |> request.set_header("content-type", "application/json")
      |> request.set_header("x-scoutbox-event-id", d.event_id)
      |> request.set_header("x-scoutbox-timestamp", ts_text)
      |> request.set_header("x-scoutbox-signature", signature)
      |> request.set_body(body)
      |> httpc.dispatch(httpc.configure() |> httpc.timeout(5000), _)
      |> result.map(fn(resp) { resp.status })
      |> result.map_error(fn(e) { string.slice(string.inspect(e), 0, 120) })
  }
  case answer {
    Ok(status) if status >= 200 && status < 300 ->
      record(
        ctx,
        d,
        sent_before,
        Ok(status),
        Some(delivery_row.Delivered),
        False,
      )
    _ -> {
      let ladder = retry_ms(ctx)
      let sent = sent_before + 1
      case sent >= list.length(ladder) {
        True ->
          record(ctx, d, sent_before, answer, Some(delivery_row.Failed), True)
        False ->
          record_retry(
            ctx,
            d,
            sent_before,
            answer,
            clock.now_ms()
              + { list.drop(ladder, sent) |> list.first |> result.unwrap(0) },
          )
      }
    }
  }
}

/// The body a receiver gets: the event and the record it names.
fn payload(d: delivery_row.Row) -> Json {
  let data = case d.type_ {
    webhook_event.ImportCommitted -> [
      #("batchId", json.string(d.subject_id)),
      #("created", json.nullable(d.created_count, json.int)),
    ]
    webhook_event.IdentityResolved -> [
      #("reviewId", json.string(d.subject_id)),
      #(
        "resolution",
        json.nullable(
          option.map(d.resolution, delivery_row.resolution_to_string),
          json.string,
        ),
      ),
    ]
    webhook_event.TransitionGranted | webhook_event.TransitionRevoked -> [
      #("transitionId", json.string(d.subject_id)),
    ]
    webhook_event.DeliveryFailed -> [#("dispatchId", json.string(d.subject_id))]
  }
  json.object([
    #("eventId", json.string(d.event_id)),
    #("type", json.string(webhook_event.to_string(d.type_))),
    #("createdAt", json.int(d.created_at)),
    #("data", json.object(data)),
  ])
}

fn attempt_row_of(
  d: delivery_row.Row,
  sent_before: Int,
  answer: Result(Int, String),
) -> attempt_row.Row {
  let base = attempt_row.new(d.id, sent_before + 1, clock.now_ms())
  case answer {
    Ok(status) -> attempt_row.Row(..base, http_status: Some(status))
    Error(e) ->
      attempt_row.Row(
        ..base,
        error: Some(case e {
          "" -> "request failed"
          e -> e
        }),
      )
  }
}

fn record(
  ctx: Ctx,
  d: delivery_row.Row,
  sent_before: Int,
  answer: Result(Int, String),
  status: Option(delivery_row.Status),
  failed_for_good: Bool,
) -> Nil {
  let outcome =
    store.unit(ctx.store, fn(tx) {
      let now = clock.now_ms()
      use _ <- result.try(attempt_row.insert(
        tx,
        attempt_row_of(d, sent_before, answer),
      ))
      use _ <- result.try(case status {
        Some(delivery_row.Delivered) ->
          store.run(
            tx,
            "UPDATE webhook_deliveries SET status = 'delivered', delivered_at = ? WHERE id = ?",
            [sqlight.int(now), sqlight.text(d.id)],
          )
        Some(s) ->
          store.run(
            tx,
            "UPDATE webhook_deliveries SET status = ? WHERE id = ?",
            [
              sqlight.text(delivery_row.status_to_string(s)),
              sqlight.text(d.id),
            ],
          )
        None -> Ok(Nil)
      })
      use _ <- result.map(case failed_for_good {
        False -> Ok(Nil)
        True -> {
          use id <- result.try(ids.next(tx, "ops"))
          ops_row.insert(
            tx,
            ops_row.New(
              ..ops_row.new(id:, occurred_at: now, kind: ops_row.WebhookFailed),
              detail_delivery_id: Some(d.id),
              detail_endpoint_id: Some(d.endpoint_id),
            ),
          )
        }
      })
      Nil
    })
  case outcome {
    Ok(Nil) -> Nil
    Error(e) -> wisp.log_error("webhook sweep: " <> string.inspect(e))
  }
}

fn record_retry(
  ctx: Ctx,
  d: delivery_row.Row,
  sent_before: Int,
  answer: Result(Int, String),
  next_at: Int,
) -> Nil {
  let outcome =
    store.unit(ctx.store, fn(tx) {
      use _ <- result.try(attempt_row.insert(
        tx,
        attempt_row_of(d, sent_before, answer),
      ))
      store.run(
        tx,
        "UPDATE webhook_deliveries SET status = 'retrying', next_at = ? WHERE id = ?",
        [sqlight.int(next_at), sqlight.text(d.id)],
      )
      |> result.replace(Nil)
    })
  case outcome {
    Ok(Nil) -> Nil
    Error(e) -> wisp.log_error("webhook sweep: " <> string.inspect(e))
  }
}

fn abandon(ctx: Ctx, d: delivery_row.Row) -> Nil {
  case
    store.unit(ctx.store, fn(tx) {
      store.run(
        tx,
        "UPDATE webhook_deliveries SET status = 'abandoned' WHERE id = ?",
        [
          sqlight.text(d.id),
        ],
      )
      |> result.replace(Nil)
    })
  {
    Ok(Nil) -> Nil
    Error(e) -> wisp.log_error("webhook sweep: " <> string.inspect(e))
  }
}
