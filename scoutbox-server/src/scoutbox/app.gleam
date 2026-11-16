//// What every route is given, and the effects an act can ask for.

import gleam/json.{type Json}
import scoutbox/platform/config.{type Config}
import scoutbox/platform/faults.{type Faults}
import scoutbox/platform/limits.{type Limits}
import scoutbox/platform/store.{type Store}

/// Something that leaves the act: dispatched after COMMIT, never sent by a refused unit.
pub type Effect {
  /// A mail, recorded in the outbox (the dev transport: the outbox is the delivery).
  SendMail(to: String, subject: String, text: String)
}

pub type Ctx {
  Ctx(
    store: Store(Effect),
    config: Config,
    limits: Limits,
    booted_at: Int,
    /// The latest migration's number: what `X-ScoutBox-Schema` and `/healthz` state.
    schema_version: Int,
    /// Every migration this build knows, in order.
    migrations: List(String),
    /// The boot's integrity check, as `/capabilities` reports it.
    integrity: Json,
    /// The development fault layer (inert in production).
    faults: Faults,
  )
}
