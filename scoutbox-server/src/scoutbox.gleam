//// Boots the server: configuration, the database (migrations, then the demo seed on a first development
//// boot), the in-memory limits, and the HTTP listener.

import ewe
import gleam/erlang/process
import gleam/io
import gleam/result
import gleam/string
import scoutbox/agents/agent_sweep
import scoutbox/agents/dev_reviewers
import scoutbox/app.{type Ctx, Ctx}
import scoutbox/discovery/match_facts
import scoutbox/insight/exposure
import scoutbox/integrations/webhooks
import scoutbox/messaging/delivery
import scoutbox/messaging/dev_mail
import scoutbox/messaging/live_routes
import scoutbox/messaging/outbox
import scoutbox/messaging/push
import scoutbox/operations/follow_ups
import scoutbox/platform/clock
import scoutbox/platform/config
import scoutbox/platform/effect.{
  type Effect, CloseStreams, Count, Live, SendMail, SendPush,
}
import scoutbox/platform/faults
import scoutbox/platform/limits
import scoutbox/platform/live.{type Hub}
import scoutbox/platform/migrations
import scoutbox/platform/operator
import scoutbox/platform/request_metrics
import scoutbox/platform/secrets
import scoutbox/platform/store.{type Store}
import scoutbox/platform/wisp_ewe
import scoutbox/recruitment/trial_routes
import scoutbox/router
import scoutbox/rows/id
import scoutbox/seed
import scoutbox/verification/review_routes as verification_review
import scoutbox/verification/transitions
import simplifile
import wisp

pub fn main() -> Nil {
  case boot() {
    Ok(Nil) -> process.sleep_forever()
    Error(reason) -> {
      io.println_error(reason)
      panic as { "scoutbox did not boot: " <> reason }
    }
  }
}

fn boot() -> Result(Nil, String) {
  wisp.configure_logger()
  use config <- result.try(config.load())
  case config.quiet_logs {
    True -> wisp.set_logger_level(wisp.ErrorLevel)
    False -> Nil
  }
  use _ <- result.try(
    simplifile.create_directory_all(config.data_dir)
    |> result.map_error(string.inspect),
  )
  // Each read connection is one process that runs one read at a time, so the pool bounds how many requests read
  // at once. With 4, 32 concurrent clients of the org player view queued on the readers (dev/perf.mjs: 534
  // requests a second, slower than one client); with 16, 1411.
  use store <- result.try(
    store.open(
      path: config.data_dir <> "/scoutbox.db",
      readers: 16,
      dispatch: fn(_) { Nil },
    ),
  )
  use faults <- result.try(faults.start(config.dev_logins, config.fault_rules))
  use hub <- result.try(live.start())
  use dev_mail <- result.try(dev_mail.start())
  use request_metrics <- result.try(request_metrics.start())
  let store =
    store.with_dispatch(store, dispatch(
      store,
      hub,
      dev_mail,
      request_metrics,
      _,
    ))
    |> store.with_seams(faults.should_fail(faults, _))
  use applied <- result.try(migrations.run(
    store,
    session_ttl_ms: config.session_ttl_ms,
  ))
  use seeded <- result.try(seed.run(
    store,
    clock.now_ms(),
    demo: config.seed_demo,
    data_dir: config.data_dir,
  ))
  use _ <- result.try(
    dev_reviewers.seed(store, clock.now_ms(), dev_logins: config.dev_logins)
    |> result.map_error(fn(e) { "dev reviewers: " <> string.inspect(e) }),
  )
  // The match facts are re-derived inside every unit from here on, just before its COMMIT. Not before: until the
  // migrations have run there is no table to derive them into. The dispatcher's own units see the same store.
  let store =
    store.with_before_commit(store, match_facts.drain(
      _,
      config.box_cam_test_provider,
    ))
  let store =
    store.with_dispatch(store, dispatch(
      store,
      hub,
      dev_mail,
      request_metrics,
      _,
    ))
  use _ <- result.try(
    match_facts.start(store, config.box_cam_test_provider)
    |> result.map_error(string.inspect),
  )
  log(config, "migrations applied: " <> string.inspect(applied))
  log(config, "demo seed loaded: " <> string.inspect(seeded))
  use limits <- result.try(limits.start())
  use known <- result.try(migrations.known())
  use _ <- result.try(migrations.counter_present(store))
  use integrity <- result.try(
    store.read(store, operator.integrity) |> result.map_error(string.inspect),
  )
  let ctx =
    Ctx(
      store:,
      config:,
      limits:,
      booted_at: clock.now_ms(),
      schema_version: migrations.version(known),
      migrations: known,
      integrity:,
      faults:,
      live: hub,
      request_metrics:,
      dev_mail:,
    )
  // Restart-safe: every dispatch is a row, so the first sweep picks up where the last process stopped. A trial's
  // reminder markers are rows too, so the boot pass re-sends nothing.
  let _ = delivery.sweep(ctx)
  let _ = follow_ups.sweep(ctx, clock.now_ms())
  let _ = trial_routes.remind(ctx, clock.now_ms())
  let _ = agent_sweep.sweep(ctx.store, clock.now_ms())
  let _ = exposure.sweep(ctx, clock.now_ms())
  transitions.sweep(ctx.store, clock.now_ms())
  process.spawn(fn() { sweeping(ctx) })
  let builder =
    router.handle(ctx, _)
    |> wisp_ewe.handler(
      config.trust_proxy.trust,
      secrets.random_hex(32),
      live_routes.stream_header,
      fn(marker, resp) { live_routes.open(ctx, marker, resp) },
    )
    |> ewe.new
    |> ewe.with_http1(wisp_ewe.http1_options())
    |> ewe.bind(to: "::")
    |> ewe.listening(on: config.port)
  let builder = case config.quiet_logs {
    True -> ewe.quiet(builder)
    False -> builder
  }
  ewe.start(builder)
  |> result.replace(Nil)
  |> result.map_error(fn(e) { "could not listen: " <> string.inspect(e) })
}

/// The periodic sweeps, one after another, forever: the delivery centre, the webhooks, verification expiries and
/// warnings, the signing follow-ups and application reminders, the trial reminders, the match facts whose time-only
/// change is due, the agent core's expiry and stale-verification notices, the review-later reminders and the exposure
/// window, and the transition cases' expiries and check-ins.
fn sweeping(ctx: Ctx) -> Nil {
  process.sleep(ctx.config.sweep_ms)
  let _ = delivery.sweep(ctx)
  let _ = webhooks.sweep(ctx)
  let _ = verification_review.sweep(ctx)
  let _ = follow_ups.sweep(ctx, clock.now_ms())
  let _ = trial_routes.remind(ctx, clock.now_ms())
  let _ = match_facts.sweep(ctx.store)
  let _ = agent_sweep.sweep(ctx.store, clock.now_ms())
  let _ = exposure.sweep(ctx, clock.now_ms())
  transitions.sweep(ctx.store, clock.now_ms())
  sweeping(ctx)
}

/// After COMMIT. A failing effect never undoes the act's data; it is logged.
fn dispatch(
  store: Store,
  hub: Hub,
  dev_mail: dev_mail.Deliveries,
  request_metrics: request_metrics.RequestMetrics,
  effect: Effect,
) -> Nil {
  case effect {
    Count(group:, name:) -> request_metrics.count(request_metrics, group, name)
    Live(event:) -> live_routes.publish(store, hub, event)
    CloseStreams(org_user_id:) ->
      live.close_streams_of(hub, id.org_user(org_user_id))
    SendMail(to:, subject:, text:, secrets:) -> {
      let recorded =
        store.unit(store, fn(tx) {
          outbox.append(tx, to:, subject:, text:, secrets:, at: clock.now_ms())
        })
      case recorded, secrets {
        Ok(_), [] -> Nil
        Ok(mail), _ -> dev_mail.keep(dev_mail, mail, text)
        Error(e), _ ->
          wisp.log_error("mail not recorded: " <> string.inspect(e))
      }
    }
    SendPush(to:, id:, title:, body:) -> {
      let recorded =
        store.unit(store, fn(tx) {
          push.send(tx, to, id, title, body, clock.now_ms())
          |> result.replace(Nil)
        })
      case recorded {
        Ok(Nil) -> Nil
        Error(e) -> wisp.log_error("push not recorded: " <> string.inspect(e))
      }
    }
  }
}

fn log(config: config.Config, message: String) -> Nil {
  case config.quiet_logs {
    True -> Nil
    False -> wisp.log_info(message)
  }
}
