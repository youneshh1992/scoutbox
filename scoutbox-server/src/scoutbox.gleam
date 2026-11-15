//// Boots the server: configuration, the database (migrations, then the demo seed on a first development
//// boot), the in-memory limits, and the HTTP listener.

import ewe
import gleam/erlang/process
import gleam/result
import gleam/string
import scoutbox/app.{type Effect, Ctx, SendMail}
import scoutbox/messaging/outbox
import scoutbox/platform/clock
import scoutbox/platform/config
import scoutbox/platform/limits
import scoutbox/platform/migrations
import scoutbox/platform/secrets
import scoutbox/platform/store.{type Store}
import scoutbox/platform/wisp_ewe
import scoutbox/router
import scoutbox/seed
import simplifile
import wisp

pub fn main() -> Nil {
  case boot() {
    Ok(Nil) -> process.sleep_forever()
    Error(reason) -> panic as { "scoutbox did not boot: " <> reason }
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
  use store <- result.try(
    store.open(
      path: config.data_dir <> "/scoutbox.db",
      readers: 4,
      dispatch: fn(_) { Nil },
    ),
  )
  let store = store.with_dispatch(store, dispatch(store, _))
  use applied <- result.try(migrations.run(store))
  use seeded <- result.try(case config.dev_logins {
    True -> seed.run(store, clock.now_ms())
    False -> Ok(False)
  })
  log(config, "migrations applied: " <> string.inspect(applied))
  log(config, "demo seed loaded: " <> string.inspect(seeded))
  use limits <- result.try(limits.start())
  let ctx = Ctx(store:, config:, limits:, booted_at: clock.now_ms())
  let builder =
    router.handle(ctx, _)
    |> wisp_ewe.handler(secrets.random_hex(32))
    |> ewe.new
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

/// After COMMIT. A failing effect never undoes the act's data; it is logged.
fn dispatch(store: Store(Effect), effect: Effect) -> Nil {
  case effect {
    SendMail(to:, subject:, text:) -> {
      let recorded =
        store.unit(store, fn(tx) {
          outbox.append(tx, to:, subject:, text:, at: clock.now_ms())
          |> result.map(fn(_) { #(Nil, []) })
        })
      case recorded {
        Ok(Nil) -> Nil
        Error(e) -> wisp.log_error("mail not recorded: " <> string.inspect(e))
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
