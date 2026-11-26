//// What every route is given.

import gleam/json.{type Json}
import scoutbox/messaging/dev_mail.{type Deliveries}
import scoutbox/platform/config.{type Config}
import scoutbox/platform/faults.{type Faults}
import scoutbox/platform/limits.{type Limits}
import scoutbox/platform/live.{type Hub}
import scoutbox/platform/portals.{type Portal}
import scoutbox/platform/request_metrics.{type RequestMetrics}
import scoutbox/platform/store.{type Store}

pub type Ctx {
  Ctx(
    store: Store,
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
    /// The live-sync hub every event stream subscribes to.
    live: Hub,
    /// The process's request counters, for `/admin/metrics`.
    request_metrics: RequestMetrics,
    /// The dev transport's full texts of mails whose stored record withholds a code.
    dev_mail: Deliveries,
    /// The web portals whose build was found at boot.
    portals: List(Portal),
  )
}
