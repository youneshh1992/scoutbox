//// `/meta` and `/capabilities` (domains/platform/operator.mjs, capabilities.mjs): the catalogue, and what this
//// deployment can and cannot do. States and counts only: no keys, hostnames, connection strings or subjects.

import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{None}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/live_event
import scoutbox/platform/migrations
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/vocab/position
import wisp.{type Response}

pub type Plan {
  Plan(
    name: String,
    price_per_month_gbp: Int,
    seats: Int,
    attribution_window_months: Int,
    anti_circumvention: String,
  )
}

const pro_terms =
  "Any signing of a ScoutBox-discovered player within the attribution window, however contact was concluded, owes the discovery fee. Off-platform approaches to circumvent the ledger are a terms breach and forfeit Trusted Partner eligibility."

/// The plans (catalogue.mjs PLANS), in its order. An organisation's `plan` column allows exactly these names.
pub const plans = [
  Plan(
    "Grassroots",
    0,
    1,
    12,
    "Signing a ScoutBox-discovered player inside the attribution window owes the signing fee and discovery sell-on regardless of how contact concluded. Radius and level walls are platform rules, not preferences.",
  ),
  Plan("Academy", 99, 3, 18, pro_terms),
  Plan("Pro", 349, 15, 24, pro_terms),
  Plan(
    "Agency",
    499,
    10,
    24,
    "Agencies additionally warrant that no representation approach is made to any player who has not accepted a contact request, and never to a minor under any circumstances.",
  ),
]

/// `GET /meta`.
pub fn meta() -> Response {
  http.json(
    200,
    json.object([
      #(
        "adultAges",
        json.object([
          #(
            "note",
            json.string(
              "age of majority per country; DEFAULT applies otherwise",
            ),
          ),
        ]),
      ),
      #(
        "plans",
        json.object(
          list.map(plans, fn(p) {
            #(
              p.name,
              json.object([
                #("name", json.string(p.name)),
                #("pricePerMonthGBP", json.int(p.price_per_month_gbp)),
                #("seats", json.int(p.seats)),
                #(
                  "attributionWindowMonths",
                  json.int(p.attribution_window_months),
                ),
                #("antiCircumvention", json.string(p.anti_circumvention)),
              ]),
            )
          }),
        ),
      ),
      #("positions", json.array(position.pairs, fn(p) { json.string(p.0) })),
    ]),
  )
}

fn state(state: String, note: String) -> Json {
  json.object([#("state", json.string(state)), #("note", json.string(note))])
}

/// `GET /capabilities`.
///
/// Not ported yet: the data layer's per-domain descriptions (`dataLayer.domains`, the TypeScript repositories'
/// own account of themselves); the notification preferences, so nothing is ever suppressed by one; the fault
/// layer; the proxy setting (SCOUTBOX_TRUST_PROXY), so no proxy is trusted.
pub fn capabilities(ctx: Ctx) -> Response {
  case store.read(ctx.store, read_report(_, ctx)) {
    Error(failure) -> http.internal(failure)
    Ok(#(schema, data_layer)) -> {
      let dev = ctx.config.dev_logins
      http.json(
        200,
        json.object([
          #("generatedAt", json.int(clock.now_ms())),
          #(
            "mode",
            json.string(case dev {
              True -> "development"
              False -> "production"
            }),
          ),
          #(
            "capabilities",
            json.object([
              // The provider registry is served as the spec snapshot has it, so `production_cv` is configured, as in
              // TypeScript; its analysis is a service of its own, and this server's stub reports the provider's
              // health as unavailable (`cv_stub`).
              #(
                "production_cv",
                json.object([
                  #("state", json.string("configured")),
                  #(
                    "note",
                    json.string(
                      "Box Cam uses server-side computer vision to observe supported activity. Combine verification for these CV protocols remains disabled pending real-world validation.",
                    ),
                  ),
                  #("serverSideObservation", json.bool(True)),
                  #("syntheticEvaluation", json.string("passed")),
                  #("realWorldValidation", json.string("not_completed")),
                  #("combineVerifiedProtocols", json.preprocessed_array([])),
                  #("combineVerificationAvailable", json.bool(False)),
                ]),
              ),
              #(
                "distributed_rate_limit",
                state(
                  "not_configured",
                  "Limits are counted per process. With more than one instance behind a load balancer each instance allows the full quota.",
                ),
              ),
              #(
                "authoritative_identity_provider",
                state(
                  "not_configured",
                  "Without one, the strongest identity a player can hold is a ScoutBox document review, which is scored below authoritative.",
                ),
              ),
              #(
                "email_transport",
                state(
                  "local_outbox",
                  "Without a transport, invitations and notifications are recorded in the local outbox and the delivery centre, and are not sent anywhere.",
                ),
              ),
              #(
                "object_storage",
                state(
                  "not_configured",
                  "Media is stored on the local disk of this instance.",
                ),
              ),
              #(
                "media_signing_secret",
                state(
                  case ctx.config.media_secret != None {
                    True -> "configured"
                    False -> "not_configured"
                  },
                  "A per-deployment secret (MEDIA_SECRET). Without one, development signs with a random key per process, so links stop working after a restart; production refuses to start.",
                ),
              ),
              #(
                "box_cam_test_provider",
                state(
                  "not_configured",
                  "The clearly-labelled simulated observer. Its results never count as production evidence.",
                ),
              ),
              #("staff_sso", case dev {
                True ->
                  state(
                    "test_only",
                    "Only the local test identity provider is available; it exercises the relying-party logic and never links an account that was not invited.",
                  )
                False ->
                  state(
                    "not_configured",
                    "No staff identity provider is configured; staff sign in with organisation credentials. The local test provider is disabled outside development.",
                  )
              }),
              #(
                "proxy_trust",
                state(
                  "not_configured",
                  "No reverse proxy is trusted; the connecting socket address is the client address. Behind a platform proxy every client would share the proxy's address and per-IP limits would apply to everyone at once.",
                ),
              ),
              #(
                "core_identity_storage",
                state(
                  "live",
                  "Players, guardians and guardian–child links are table-backed (migration 0005); writes go through the identity repositories and multi-domain operations run inside the store's unit of work.",
                ),
              ),
            ]),
          ),
          #("schema", schema),
          #("dataLayer", data_layer),
          #("integrity", ctx.integrity),
          #(
            "events",
            json.object([
              #("registered", json.int(list.length(live_event.registered))),
              #("payloadDrops", json.int(0)),
              #(
                "note",
                json.string(
                  "Every emitted event is registered with an audience and a payload allowlist; an unregistered name fails closed.",
                ),
              ),
            ]),
          ),
          #(
            "notifications",
            json.object([
              #("preferencesEnforced", json.bool(True)),
              #("suppressedByPreference", json.int(0)),
              #("unknownTypes", json.preprocessed_array([])),
              #(
                "note",
                json.string(
                  "Preferences are applied before a notification is created. security_account cannot be turned off.",
                ),
              ),
            ]),
          ),
          #("faultInjection", case dev {
            True ->
              state(
                "available",
                "Development only: SCOUTBOX_FAULTS and POST /__faults simulate slow and failing sources.",
              )
            False -> state("not_configured", "Disabled in production.")
          }),
          #(
            "note",
            json.string(
              "Capability states only. This report contains no keys, hostnames or connection details.",
            ),
          ),
        ]),
      )
    }
  }
}

fn read_report(read: Read, ctx: Ctx) -> Result(#(Json, Json), Fail(e)) {
  use applied <- result.try(store.query(
    read,
    "SELECT id FROM data_migrations ORDER BY id",
    [],
    decode.at([0], decode.string),
  ))
  let known = ctx.migrations
  let applied_known = list.filter(applied, list.contains(known, _))
  let version = case list.last(applied) {
    Ok(id) -> string.slice(id, 0, 4) |> int.parse |> result.unwrap(0)
    Error(Nil) -> 0
  }
  let applied_count = list.length(applied_known)
  let known_count = list.length(known)
  use tables <- result.try(store.query(
    read,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       AND name NOT IN ('counters', 'data_migrations', 'meta') ORDER BY name",
    [],
    decode.at([0], decode.string),
  ))
  use init_state <- result.try(store.query(
    read,
    "SELECT value FROM meta WHERE key = 'coreIdentityInit'",
    [],
    decode.at([0], decode.string),
  ))
  // A queued removal that names a clip a live player still carries is a conflict: it is kept, never removed.
  use deletions <- result.map(
    store.query(
      read,
      "SELECT COUNT(*), COUNT(m.id) FROM media_deletions d
       LEFT JOIN player_media m ON m.id = d.media_id
       LEFT JOIN players p ON p.id = m.player_id AND p.deleted_at IS NULL",
      [],
      {
        use queued <- decode.field(0, decode.int)
        use conflicts <- decode.field(1, decode.int)
        decode.success(#(queued, conflicts))
      },
    ),
  )
  let schema =
    json.object([
      #("version", json.int(version)),
      #("expected", json.int(ctx.schema_version)),
      #("migrationsApplied", json.int(applied_count)),
      #("migrationsKnown", json.int(known_count)),
      #("upToDate", json.bool(migrations.up_to_date(applied, known))),
    ])
  let assert [#(queued, conflicts)] = deletions
  let data_layer =
    json.object([
      #("engine", json.string("sqlite")),
      #("migrationsApplied", json.int(applied_count)),
      #("migrationsKnown", json.int(known_count)),
      #("migrations", json.array(known, json.string)),
      #("tables", json.array(tables, json.string)),
      #(
        "identity",
        json.object([
          #(
            "initState",
            json.string(list.first(init_state) |> result.unwrap("done")),
          ),
        ]),
      ),
      #(
        "mediaDeletions",
        json.object([
          #("queued", json.int(queued)),
          #("conflicts", json.int(conflicts)),
        ]),
      ),
      #(
        "note",
        json.string(
          "Each domain's tables and row counts. Counts are counts, never subjects.",
        ),
      ),
    ])
  #(schema, data_layer)
}

/// The invariants the tables' own keys can't state (domains/platform/integrity.mjs): one open Room per
/// organisation and player, Rooms that name a live player, and a valid Room revision. Checked once at boot and
/// reported on `/capabilities`, never repaired.
pub fn integrity(read: Read) -> Result(Json, Fail(e)) {
  use counts <- result.map(
    store.query(
      read,
      "WITH rooms AS (SELECT * FROM recruitment_cases WHERE room_status IS NOT NULL),
          named AS (SELECT DISTINCT r.player_id FROM rooms r JOIN players p ON p.id = r.player_id)
     SELECT
       (SELECT COUNT(*) FROM rooms) + (SELECT COUNT(*) FROM named) + (SELECT COUNT(*) FROM orgs),
       (SELECT COALESCE(SUM(n), 0) FROM (SELECT COUNT(*) AS n FROM rooms
          WHERE room_status NOT IN ('signed', 'withdrawn', 'archived', 'closed')
          GROUP BY org_id, player_id HAVING COUNT(*) > 1)),
       (SELECT COUNT(*) FROM rooms r WHERE NOT EXISTS (SELECT 1 FROM players p WHERE p.id = r.player_id)),
       (SELECT COUNT(*) FROM rooms WHERE room_rev IS NULL OR room_rev < 1)",
      [],
      {
        use checked <- decode.field(0, decode.int)
        use duplicate <- decode.field(1, decode.int)
        use orphan <- decode.field(2, decode.int)
        use rev <- decode.field(3, decode.int)
        decode.success(#(checked, duplicate, orphan, rev))
      },
    ),
  )
  let assert [#(checked, duplicate, orphan, rev)] = counts
  let by_code =
    [
      #("ROOM_OPEN_DUPLICATE", duplicate),
      #("ROOM_ORPHAN_PLAYER", orphan),
      #("ROOM_REV_INVALID", rev),
    ]
    |> list.filter(fn(c) { c.1 > 0 })
  let violations = duplicate + orphan + rev
  json.object([
    #("ok", json.bool(violations == 0)),
    #("checked", json.int(checked)),
    #("violations", json.int(violations)),
    #("byCode", json.object(list.map(by_code, fn(c) { #(c.0, json.int(c.1)) }))),
    #(
      "note",
      json.string(
        "Checked once at boot; violations are reported, never repaired.",
      ),
    ),
  ])
}
