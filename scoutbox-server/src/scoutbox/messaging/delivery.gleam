//// The delivery centre (domains/messaging/delivery.mjs): a transactional outbox. The notification row is the one
//// in-app record, so the act happens once; the sweep makes each notice's per-channel dispatches after the fact and
//// retries only the sending, so a retry never repeats the act. Status only moves forward (queued → accepted →
//// delivered → opened → actioned), and delivered and opened come only from the provider's confirmed callbacks:
//// an e-mail the provider accepted is never reported as read.
////
//// Real e-mail transport is not configured: the provider is the local fake, whose sends are outbox records.

import gleam/bit_array
import gleam/crypto
import gleam/dynamic/decode
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/integrations/webhooks
import scoutbox/messaging/dispatches.{type Dispatch, QuietRecheck, Sent}
import scoutbox/messaging/notifications.{type Notification}
import scoutbox/messaging/outbox
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/pages
import scoutbox/platform/paging.{IntKind}
import scoutbox/platform/secrets
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/dispatches as row
import scoutbox/rows/guardians as guardian_row
import scoutbox/rows/id
import scoutbox/rows/ops_events as ops_row
import scoutbox/rows/org_users as staff_row
import scoutbox/rows/players as player_row
import scoutbox/rules/age
import scoutbox/vocab/audience
import scoutbox/vocab/webhook_event
import sqlight
import wisp.{type Request, type Response}

const provider = "local-fake"

fn retry_ms(ctx: Ctx) -> List(Int) {
  case ctx.config.fast_sweeps {
    True -> [0, 300, 600, 900]
    False -> [0, 120_000, 900_000, 3_600_000]
  }
}

/// If the push was deferred when the notice was made, its external channels wait one re-check cycle.
fn quiet_hold_until(ctx: Ctx, n: Notification, now: Int) -> Option(Int) {
  case n.deferred_push {
    True ->
      Some(
        now
        + case ctx.config.fast_sweeps {
          True -> 500
          False -> 900_000
        },
      )
    False -> None
  }
}

fn short_reason(reason: String) -> String {
  string.slice(reason, 0, 500)
}

// ------------------------------------------------------------------------------------------------- the sweep

/// Every step, each item in a unit of its own: a refusal is logged by id and the sweep goes on. Returns how many
/// records it changed.
pub fn sweep(ctx: Ctx) -> Int {
  let made = dispatch_new(ctx, 0, 0)
  let sent = send_due(ctx)
  let opened = mirror_reads(ctx)
  made + sent + opened
}

fn item(ctx: Ctx, what: String, work: fn(Tx) -> Result(Int, Fail(Nil))) -> Int {
  case store.unit(ctx.store, fn(tx) { work(tx) }) {
    Ok(n) -> n
    Error(e) -> {
      wisp.log_error(
        "delivery sweep: "
        <> what
        <> " was not processed ("
        <> string.inspect(e)
        <> ")",
      )
      0
    }
  }
}

/// 1. Each notice without its marker gets its dispatches and the marker, in one unit. A notice that already has
/// dispatches only gets the marker.
fn dispatch_new(ctx: Ctx, after_seq: Int, changed: Int) -> Int {
  case store.read(ctx.store, notifications.undispatched(_, after_seq, 500)) {
    Error(e) -> {
      wisp.log_error("delivery sweep: " <> string.inspect(e))
      changed
    }
    Ok([]) -> changed
    Ok(batch) -> {
      let changed =
        list.fold(batch, changed, fn(acc, n) {
          acc
          + item(
            ctx,
            "notification " <> id.notification_to_string(n.id),
            make_dispatches(ctx, _, n),
          )
        })
      let assert Ok(last) = list.last(batch)
      dispatch_new(ctx, last.seq, changed)
    }
  }
}

type Destination {
  Destination(channel: row.Channel, to: Option(String), skip: Option(String))
}

fn email(to: Option(String)) -> Destination {
  case to {
    Some(address) -> Destination(row.Email, Some(address), None)
    None -> Destination(row.Email, None, Some("no email on record"))
  }
}

/// Where a notice goes: always in-app, and by e-mail where the person has an address. A minor's external
/// channels are the guardian's.
fn destinations(
  read: Read,
  n: Notification,
) -> Result(#(List(Destination), Option(id.OrgId)), Fail(e)) {
  let in_app =
    Destination(
      row.ChannelInApp,
      Some(audience.to_string(n.audience_kind) <> ":" <> n.audience_id),
      None,
    )
  case n.audience_kind {
    audience.Player -> {
      use p <- result.map(one(
        read,
        "SELECT "
          <> player_row.columns
          <> " FROM players WHERE id = ? AND deleted_at IS NULL",
        n.audience_id,
        player_row.decoder(),
      ))
      let minor = case p {
        Some(p) -> !age.is_adult(p.birth_date, p.country, n.occurred_at)
        None -> False
      }
      #(
        [
          in_app,
          case minor {
            True ->
              Destination(
                row.Email,
                None,
                Some(
                  "guardian_routed — external delivery for under-18s goes to the guardian record",
                ),
              )
            // A player record holds no e-mail address.
            False -> email(None)
          },
        ],
        None,
      )
    }
    audience.Guardian -> {
      use g <- result.map(one(
        read,
        "SELECT " <> guardian_row.columns <> " FROM guardians WHERE id = ?",
        n.audience_id,
        guardian_row.decoder(),
      ))
      #([in_app, email(option.map(g, fn(g) { g.email }))], None)
    }
    audience.OrgUser -> {
      use u <- result.map(one(
        read,
        "SELECT " <> staff_row.columns <> " FROM org_users WHERE id = ?",
        n.audience_id,
        staff_row.decoder(),
      ))
      let out = case u {
        Some(u) if !u.email_enabled ->
          Destination(
            row.Email,
            None,
            Some("channel disabled by user preference"),
          )
        Some(u) -> email(u.email)
        None -> email(None)
      }
      #([in_app, out], option.map(u, fn(u) { u.org_id }))
    }
  }
}

fn one(
  read: Read,
  sql: String,
  id: String,
  decoder: decode.Decoder(a),
) -> Result(Option(a), Fail(e)) {
  store.one(read, sql, [sqlight.text(id)], decoder)
  |> result.map(option.from_result)
}

fn centre_since(read: Read) -> Result(Int, Fail(e)) {
  store.one(
    read,
    "SELECT since FROM delivery_centre WHERE id = 1",
    [],
    decode.at([0], decode.int),
  )
  |> result.map(result.unwrap(_, 0))
}

fn make_dispatches(
  ctx: Ctx,
  tx: Tx,
  n: Notification,
) -> Result(Int, Fail(Nil)) {
  let read = store.reading(tx)
  let now = clock.now_ms()
  use existing <- result.try(dispatches.for_notification(read, n.id))
  case existing {
    [_, ..] -> notifications.mark_dispatched(tx, n.id, now) |> result.replace(0)
    [] -> {
      use since <- result.try(centre_since(read))
      use #(dests, org_id) <- result.try(destinations(read, n))
      // Notices older than the delivery centre get an in-app record only: no retroactive e-mail.
      let historical = n.occurred_at < since
      use _ <- result.try(
        list.try_each(dests, fn(dest) {
          let in_app = dest.channel == row.ChannelInApp
          let skip = case historical && !in_app {
            True ->
              Some("predates delivery centre — no retroactive external send")
            False -> dest.skip
          }
          let hold = case in_app {
            True -> None
            False -> quiet_hold_until(ctx, n, now)
          }
          let status = case skip, in_app, hold {
            Some(_), _, _ -> row.Skipped
            None, True, _ -> row.Delivered
            None, False, Some(_) -> row.HeldQuietHours
            None, False, None -> row.Queued
          }
          use id <- result.try(id.next_dispatch(tx))
          dispatches.create(
            tx,
            row.New(
              ..row.new(
                id:,
                notification_id: n.id,
                audience_kind: n.audience_kind,
                audience_id: n.audience_id,
                channel: dest.channel,
                provider: case in_app {
                  True -> row.ProviderInApp
                  False -> row.LocalFake
                },
                status:,
                next_at: option.unwrap(hold, now),
                created_at: now,
              ),
              org_id:,
              to_address: dest.to,
              skip_reason: skip,
              action_deadline_at: case n.action_required {
                True -> n.action_deadline_at
                False -> None
              },
              delivered_at: case in_app {
                True -> Some(now)
                False -> None
              },
            ),
          )
        }),
      )
      use _ <- result.map(notifications.mark_dispatched(tx, n.id, now))
      list.length(dests)
    }
  }
}

/// 2. The external sends that are due.
fn send_due(ctx: Ctx) -> Int {
  case store.read(ctx.store, dispatches.due(_, clock.now_ms())) {
    Error(e) -> {
      wisp.log_error("delivery sweep: " <> string.inspect(e))
      0
    }
    Ok(due) ->
      list.fold(due, 0, fn(acc, d) {
        acc
        + item(ctx, "dispatch " <> id.dispatch_to_string(d.row.id), attempt(
          ctx,
          _,
          d,
        ))
      })
  }
}

/// The fake provider: a send is an outbox record and a message id, unless a failure was injected.
fn fake_send(
  tx: Tx,
  to: Option(String),
  text: String,
  at: Int,
) -> Result(Result(String, String), Fail(e)) {
  use failing <- result.try(consume_injected(tx, "email"))
  case failing {
    True -> Ok(Error("injected provider failure"))
    False -> {
      let message_id = "fm_" <> secrets.random_hex(8)
      use _ <- result.map(outbox.append_delivery(
        tx,
        to: option.unwrap(to, ""),
        text:,
        provider_message_id: message_id,
        at:,
      ))
      Ok(message_id)
    }
  }
}

/// One sweep's send. Two sweeps can overlap (the minute sweep and an administrator's), so the dispatch is read
/// again inside the unit and left alone if another sweep already moved it.
fn attempt(ctx: Ctx, tx: Tx, listed: Dispatch) -> Result(Int, Fail(Nil)) {
  let read = store.reading(tx)
  let now = clock.now_ms()
  use current <- result.try(dispatches.by_id(read, listed.row.id))
  case current {
    Some(due)
      if due.row.next_at == listed.row.next_at
      && due.row.status == listed.row.status
      && due.attempts == listed.attempts
    -> send(ctx, tx, due, now)
    _ -> Ok(0)
  }
}

fn send(ctx: Ctx, tx: Tx, due: Dispatch, now: Int) -> Result(Int, Fail(Nil)) {
  let d = due.row
  let read = store.reading(tx)
  use n <- result.try(notifications.by_id(read, d.notification_id))
  let recheck = case d.status, n {
    row.HeldQuietHours, Some(n) ->
      case quiet_hold_until(ctx, n, now), due.attempts {
        Some(until), [] -> Some(until)
        _, _ -> None
      }
    _, _ -> None
  }
  case recheck {
    Some(until) -> {
      use _ <- result.try(dispatches.record_attempt(
        tx,
        d,
        QuietRecheck("quiet hours re-check"),
        now,
      ))
      dispatches.patch(tx, d.id, [dispatches.NextAt(until)])
      |> result.replace(1)
    }
    None -> {
      let text = option.map(n, fn(n) { n.text }) |> option.unwrap("")
      use sent <- result.try(fake_send(tx, d.to_address, text, now))
      let error = case sent {
        Ok(_) -> None
        Error(reason) -> Some(short_reason(reason))
      }
      use sends <- result.try(dispatches.record_attempt(
        tx,
        d,
        Sent(ok: result.is_ok(sent), error:),
        clock.now_ms(),
      ))
      let ladder = retry_ms(ctx)
      case sent {
        // Accepted by the provider: not delivered, not read.
        Ok(message_id) ->
          dispatches.patch(tx, d.id, [
            dispatches.Status(row.Accepted),
            dispatches.ProviderMessageId(message_id),
          ])
        Error(reason) ->
          case sends >= list.length(ladder) {
            True -> {
              use _ <- result.try(
                dispatches.patch(tx, d.id, [
                  dispatches.Status(row.Failed),
                  dispatches.FailedAt(clock.now_ms()),
                  dispatches.FailReason(short_reason(reason)),
                ]),
              )
              use _ <- result.try(delivery_failed(tx, d, clock.now_ms()))
              webhooks.emit(
                tx,
                d.org_id,
                webhook_event.DeliveryFailed,
                id.dispatch_to_string(d.id),
                clock.now_ms(),
              )
            }
            False -> {
              let wait =
                list.drop(ladder, sends) |> list.first |> result.unwrap(0)
              dispatches.patch(tx, d.id, [
                dispatches.Status(row.Retrying),
                dispatches.NextAt(clock.now_ms() + wait),
              ])
            }
          }
      }
      |> result.replace(1)
    }
  }
}

fn delivery_failed(tx: Tx, d: row.Row, at: Int) -> Result(Nil, Fail(e)) {
  use id <- result.try(id.next_ops_event(tx))
  ops_row.insert(
    tx,
    ops_row.New(
      ..ops_row.new(id:, occurred_at: at, kind: ops_row.DeliveryFailed),
      detail_dispatch_id: Some(d.id),
      detail_channel: Some(row.channel_to_string(d.channel)),
    ),
  )
}

/// 3. In-app reads become opened.
fn mirror_reads(ctx: Ctx) -> Int {
  case store.read(ctx.store, dispatches.unopened_in_app_read) {
    Error(e) -> {
      wisp.log_error("delivery sweep: " <> string.inspect(e))
      0
    }
    Ok(rows) ->
      list.fold(rows, 0, fn(acc, d) {
        acc
        + item(ctx, "dispatch " <> id.dispatch_to_string(d.id), fn(tx) {
          let now = clock.now_ms()
          dispatches.patch(
            tx,
            d.id,
            case dispatches.below(d.status, row.Opened) {
              True -> [dispatches.OpenedAt(now), dispatches.Status(row.Opened)]
              False -> [dispatches.OpenedAt(now)]
            },
          )
          |> result.replace(1)
        })
      })
  }
}

// ------------------------------------------------------------------------------------------------- injected failures

pub fn consume_injected(tx: Tx, channel: String) -> Result(Bool, Fail(e)) {
  store.write(
    tx,
    "UPDATE delivery_fail_injections SET remaining = remaining - 1 WHERE channel = ? AND remaining > 0 RETURNING remaining",
    [sqlight.text(channel)],
    decode.at([0], decode.int),
  )
  |> result.map(fn(rows) { rows != [] })
}

type Injection {
  Injection(channel: Option(String), count: Option(Int))
}

const injectable = ["email", "push", "contact", "trial", "decision"]

/// `POST /admin/delivery/inject-failure`: the next sends on a channel fail at the provider, so the honest failure
/// states can be exercised end to end.
pub fn inject_failure(ctx: Ctx, req: Request) -> Response {
  let shape = {
    use channel <- input.field(
      "channel",
      input.nullish(input.one_of(list.map(injectable, fn(c) { #(c, c) }))),
    )
    use count <- input.field("count", input.nullish(input.whole_number(1, 20)))
    input.done(Injection(channel:, count:))
  }
  use body <- http.body(req, shape, [])
  let channel = option.unwrap(body.channel, "email")
  let count = option.unwrap(body.count, 1)
  case
    store.unit(ctx.store, fn(tx) {
      store.run(
        tx,
        "UPDATE delivery_fail_injections SET remaining = remaining + ? WHERE channel = ?",
        [sqlight.int(count), sqlight.text(channel)],
      )
      |> result.replace(Nil)
    })
  {
    Ok(Nil) ->
      http.json(
        200,
        json.object([
          #(
            "injected",
            json.object([
              #("channel", json.string(channel)),
              #("count", json.int(count)),
            ]),
          ),
          #(
            "note",
            json.string(
              "The next sends on this channel will fail at the provider — for monitoring/retry tests.",
            ),
          ),
        ]),
      )
    Error(failure) -> http.internal(failure)
  }
}

// ------------------------------------------------------------------------------------------------- acknowledgment

type AckRefusal {
  AckNotFound
  NoActionRequired
}

/// `POST /…/notifications/:id/ack`: the first acknowledgment stands. Every dispatch of the notice gains its
/// actioned time, a skipped one included (it keeps its status).
pub fn ack(
  ctx: Ctx,
  kind: audience.Audience,
  audience_id: String,
  id: id.NotificationId,
) -> Response {
  let now = clock.now_ms()
  let acked =
    store.unit(ctx.store, fn(tx) {
      let read = store.reading(tx)
      use found <- result.try(notifications.by_id(read, id))
      case found {
        Some(n) if n.audience_kind == kind && n.audience_id == audience_id ->
          case n.action_required, n.action_acked_at {
            False, _ -> store.refuse(NoActionRequired)
            True, Some(at) -> Ok(at)
            True, None -> {
              use _ <- result.try(notifications.ack(tx, n.id, now))
              use ds <- result.try(dispatches.for_notification(read, n.id))
              use _ <- result.map(
                list.try_each(ds, fn(d) {
                  dispatches.patch(
                    tx,
                    d.row.id,
                    case dispatches.below(d.row.status, row.Actioned) {
                      True -> [
                        dispatches.ActionedAt(now),
                        dispatches.Status(row.Actioned),
                      ]
                      False -> [dispatches.ActionedAt(now)]
                    },
                  )
                }),
              )
              now
            }
          }
        _ -> store.refuse(AckNotFound)
      }
    })
  case acked {
    Ok(at) ->
      http.json(
        200,
        json.object([#("ok", json.bool(True)), #("ackedAt", json.int(at))]),
      )
    Error(store.Refused(AckNotFound)) ->
      http.error(404, "NOTIFICATION_NOT_FOUND")
    Error(store.Refused(NoActionRequired)) ->
      http.error(400, "NO_ACTION_REQUIRED")
    Error(failure) -> http.internal(failure)
  }
}

// ------------------------------------------------------------------------------------------------- callbacks

type Event {
  Event(
    callback_id: String,
    provider_message_id: String,
    status: String,
    at: Option(Int),
    reason: Option(String),
  )
}

const statuses = ["delivered", "opened", "bounced", "failed"]

fn callback_shape() -> input.Shape(List(Event)) {
  let event = {
    use callback_id <- input.field(
      "callbackId",
      input.required(input.id_of(200)),
    )
    use provider_message_id <- input.field(
      "providerMessageId",
      input.required(input.id_of(200)),
    )
    use status <- input.field(
      "status",
      input.required(input.one_of(list.map(statuses, fn(s) { #(s, s) }))),
    )
    use at <- input.field(
      "at",
      input.nullish(input.whole_number(1, 9_007_199_254_740_991)),
    )
    use reason <- input.field("reason", input.nullish(input.text(10_000)))
    input.done(Event(callback_id:, provider_message_id:, status:, at:, reason:))
  }
  use _ <- input.field("provider", input.nullish(input.text(200)))
  use events <- input.field(
    "events",
    input.optional(input.items(input.object(event), 100)),
  )
  input.done(option.unwrap(events, []))
}

fn sign(secret: String, ts: String, body: String) -> String {
  crypto.hmac(
    bit_array.from_string("callback." <> ts <> "." <> body),
    crypto.Sha256,
    bit_array.from_string(secret),
  )
  |> secrets.hex
}

/// `POST /callbacks/delivery`: signed, idempotent and safe out of order. The whole batch is checked before any of
/// it is applied; each event then commits with its seen marker, one unit per event.
///
/// The signature is checked over the body as it arrived; the TypeScript server re-serialises the parsed body,
/// which is the same text for a compact JSON body.
pub fn callback(ctx: Ctx, req: Request) -> Response {
  let ts = http.header(req, "x-provider-timestamp") |> result.unwrap("")
  let sig = http.header(req, "x-provider-signature") |> result.unwrap("")
  let now = clock.now_ms()
  let fresh = case int.parse(ts) {
    Ok(t) -> int.absolute_value(now - t) <= 300_000
    Error(Nil) -> False
  }
  use text, raw <- http.signed_body(req)
  let body = case string.trim(text) {
    "" -> "{}"
    _ -> text
  }
  case
    fresh,
    secrets.equal(sig, sign(ctx.config.delivery_callback_secret, ts, body))
  {
    False, _ ->
      http.error_message(
        401,
        "TIMESTAMP_INVALID",
        "Callbacks older than 5 minutes are rejected (replay protection).",
      )
    True, False -> http.error(401, "SIGNATURE_INVALID")
    True, True ->
      case input.parse(callback_shape(), raw, root: "body", codes: []) {
        Error(refusal) -> http.refused(refusal)
        Ok(events) -> {
          let outcomes = list.map(events, apply_event(ctx, _))
          let count = fn(o) { list.count(outcomes, fn(x) { x == o }) }
          http.json(
            200,
            json.object([
              #("applied", json.int(count(Applied))),
              #("duplicates", json.int(count(Duplicate))),
            ]),
          )
        }
      }
  }
}

type Outcome {
  Applied
  Duplicate
  Unknown
  NotApplied
}

fn apply_event(ctx: Ctx, ev: Event) -> Outcome {
  let outcome =
    store.unit(ctx.store, fn(tx) {
      let now = clock.now_ms()
      use seen <- result.try(mark_seen(tx, ev.callback_id, now))
      case seen {
        False -> Ok(Duplicate)
        True -> {
          use found <- result.try(dispatches.by_provider_message_id(
            store.reading(tx),
            ev.provider_message_id,
          ))
          case found {
            // The id is still remembered.
            None -> Ok(Unknown)
            Some(d) -> {
              let d = d.row
              let clock = option.unwrap(ev.at, now)
              let changes = case ev.status {
                "delivered" ->
                  list.flatten([
                    case d.delivered_at {
                      None -> [dispatches.DeliveredAt(clock)]
                      Some(_) -> []
                    },
                    case dispatches.below(d.status, row.Delivered) {
                      True -> [dispatches.Status(row.Delivered)]
                      False -> []
                    },
                  ])
                "opened" -> {
                  let opened_at = option.unwrap(d.opened_at, clock)
                  list.flatten([
                    case d.opened_at {
                      None -> [dispatches.OpenedAt(clock)]
                      Some(_) -> []
                    },
                    // Out of order: opened implies delivered.
                    case d.delivered_at {
                      None -> [dispatches.DeliveredAt(opened_at)]
                      Some(_) -> []
                    },
                    case dispatches.below(d.status, row.Opened) {
                      True -> [dispatches.Status(row.Opened)]
                      False -> []
                    },
                  ])
                }
                // A failure report never un-delivers: failed only if nothing better was confirmed.
                status ->
                  list.flatten([
                    [
                      dispatches.FailReason(string.slice(
                        case ev.reason {
                          Some("") | None -> status
                          Some(r) -> r
                        },
                        0,
                        120,
                      )),
                    ],
                    case dispatches.at_most(d.status, row.Accepted) {
                      True -> [
                        dispatches.Status(row.Failed),
                        dispatches.FailedAt(now),
                      ]
                      False -> []
                    },
                  ])
              }
              use _ <- result.map(dispatches.patch(tx, d.id, changes))
              Applied
            }
          }
        }
      }
    })
  case outcome {
    Ok(o) -> o
    Error(e) -> {
      wisp.log_error("delivery callback not applied: " <> string.inspect(e))
      NotApplied
    }
  }
}

/// Remembers a callback id; false when it was already seen. The newest 5,000 are kept.
fn mark_seen(tx: Tx, callback_id: String, at: Int) -> Result(Bool, Fail(e)) {
  use added <- result.try(store.write(
    tx,
    "INSERT OR IGNORE INTO delivery_callbacks_seen (callback_id, seen_at) VALUES (?, ?) RETURNING callback_id",
    [sqlight.text(callback_id), sqlight.int(at)],
    decode.at([0], decode.string),
  ))
  case added {
    [] -> Ok(False)
    _ -> {
      use kept <- result.try(
        store.one(
          store.reading(tx),
          "SELECT COUNT(*) FROM delivery_callbacks_seen",
          [],
          decode.at([0], decode.int),
        )
        |> result.map(result.unwrap(_, 0)),
      )
      case kept > 5000 {
        True ->
          store.run(
            tx,
            "DELETE FROM delivery_callbacks_seen WHERE rowid IN (SELECT rowid FROM delivery_callbacks_seen ORDER BY rowid LIMIT 1000)",
            [],
          )
          |> result.replace(True)
        False -> Ok(True)
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------- views

/// `GET /admin/delivery`.
pub fn admin_view(ctx: Ctx) -> Response {
  let found =
    store.read(ctx.store, fn(read) {
      use counts <- result.try(dispatches.counts_by_status(read))
      use awaiting <- result.try(notifications.awaiting_ack_count(read))
      use recent <- result.map(dispatches.recent(read, 100))
      json.object([
        #("provider", json.string(provider)),
        #(
          "providerNote",
          json.string(
            "Local fake provider only — real email/SMS/push transport is not configured; no message leaves this machine.",
          ),
        ),
        #(
          "counts",
          json.object(list.map(counts, fn(c) { #(c.0, json.int(c.1)) })),
        ),
        #("awaitingAck", json.int(awaiting)),
        #("recent", json.array(recent, dispatches.view)),
      ])
    })
  case found {
    Ok(body) -> http.json(200, body)
    Error(failure) -> http.internal(failure)
  }
}

/// `POST /admin/delivery/sweep`.
pub fn admin_sweep(ctx: Ctx, req: Request) -> Response {
  use _ <- http.body(req, input.nothing(), [])
  http.json(200, json.object([#("processed", json.int(sweep(ctx)))]))
}

/// `GET /org/delivery`: the club's staff dispatches, newest first.
pub fn org_list(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use page <- pages.strict(req, [IntKind])
  case store.read(ctx.store, dispatches.page_for_org(_, a.org.id, page)) {
    Ok(#(items, next)) -> pages.respond(items, next, dispatches.view)
    Error(failure) -> http.internal(failure)
  }
}
