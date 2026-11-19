//// API keys, the versioned export they read, and the provider connectors (domains/integrations/imports.mjs). A
//// key is stored only as the sha-256 of its plain text, which is shown once; an organisation exports only its own
//// records.

import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/orgs.{type Org}
import scoutbox/identity/players
import scoutbox/integrations/imports
import scoutbox/integrations/webhooks
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/secrets
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/api_key_scopes as scope_row
import scoutbox/rows/api_keys as key_row
import scoutbox/rows/id
import scoutbox/vocab/playing_level
import scoutbox/vocab/position
import sqlight
import wisp.{type Request, type Response}

pub const export_contract_version = "2026-09-01.v1"

const label_max = 60

type Key {
  Key(row: key_row.Row, scopes: List(scope_row.Scope))
}

fn keys(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(List(Key), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT " <> key_row.columns <> " FROM api_keys " <> where,
    args,
    key_row.decoder(),
  ))
  use scopes <- result.map(store.query(
    read,
    "SELECT "
      <> scope_row.columns
      <> " FROM api_key_scopes WHERE api_key_id IN (SELECT value FROM json_each(?)) ORDER BY api_key_id, ord",
    [
      json.array(rows, fn(k) { id.api_key_json(k.id) })
      |> json.to_string
      |> sqlight.text,
    ],
    scope_row.decoder(),
  ))
  list.map(rows, fn(k) {
    Key(
      row: k,
      scopes: list.filter_map(scopes, fn(s) {
        case s.api_key_id == k.id {
          True -> Ok(s.scope)
          False -> Error(Nil)
        }
      }),
    )
  })
}

/// The key as its organisation sees it: never its hash.
fn key_json(k: Key) -> Json {
  let r = k.row
  json.object([
    #("id", id.api_key_json(r.id)),
    #("orgId", id.org_json(r.org_id)),
    #("label", json.string(r.label)),
    #("createdBy", json.nullable(r.created_by_name, json.string)),
    #("createdAt", json.int(r.created_at)),
    #("revokedAt", json.nullable(r.revoked_at, json.int)),
    #("lastUsedAt", json.nullable(r.last_used_at, json.int)),
    #("scopes", json.array(k.scopes, scope_row.scope_to_json)),
  ])
}

/// `GET /org/api-keys`.
pub fn list_keys(ctx: Ctx, a: OrgAccess) -> Response {
  case
    store.read(ctx.store, fn(read) {
      keys(read, "WHERE org_id = ? ORDER BY rowid", [id.org_sql(a.org.id)])
    })
  {
    Error(e) -> http.internal(e)
    Ok(found) ->
      http.json(
        200,
        json.object([
          #("items", json.array(found, key_json)),
          #("contractVersion", json.string(export_contract_version)),
        ]),
      )
  }
}

type NewKey {
  NewKey(scopes: Option(List(scope_row.Scope)), label: Option(String))
}

/// `POST /org/api-keys`: an unknown or repeated scope is refused, not dropped.
pub fn create(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use <- access.require_lead(a)
  let shape = {
    use scopes <- input.field(
      "scopes",
      input.nullish(webhooks.once_each(scope_row.scope_pairs, "a scope")),
    )
    use label <- input.field("label", input.nullish(input.text(label_max)))
    input.done(NewKey(scopes:, label:))
  }
  use body <- http.body(req, shape, [])
  case option.unwrap(body.scopes, []) {
    [] ->
      http.error_message(
        400,
        "SCOPES_REQUIRED",
        "Pick at least one of: "
          <> string.join(list.map(scope_row.scope_pairs, fn(p) { p.0 }), ", "),
      )
    scopes -> {
      let plaintext = "sbk_" <> secrets.random_hex(24)
      let now = clock.now_ms()
      store.unit(ctx.store, fn(tx) {
        use key_id <- result.try(id.next_api_key(tx))
        let k =
          key_row.Row(
            ..key_row.new(
              id: key_id,
              org_id: a.org.id,
              key_hash: secrets.sha256_hex(plaintext),
              label: input.filled(body.label) |> option.unwrap("API key"),
              created_at: now,
            ),
            created_by_name: Some(a.user.name),
          )
        use _ <- result.try(key_row.insert(tx, k))
        use _ <- result.map(
          list.index_map(scopes, fn(s, ord) { #(s, ord) })
          |> list.try_each(fn(p) {
            scope_row.insert(
              tx,
              scope_row.Row(api_key_id: key_id, ord: p.1, scope: p.0),
            )
          }),
        )
        Key(row: k, scopes:)
      })
      |> fn(made) {
        case made {
          Ok(k) ->
            http.json(
              201,
              json.object([
                #("key", key_json(k)),
                #("plaintext", json.string(plaintext)),
                #(
                  "note",
                  json.string(
                    "Store this now — the key is shown once and only its hash is kept.",
                  ),
                ),
              ]),
            )
          Error(e) -> http.internal(e)
        }
      }
    }
  }
}

/// `POST /org/api-keys/:id/revoke`: a revoked key keeps its first revocation.
pub fn revoke(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  key_id: String,
) -> Response {
  use <- access.require_lead(a)
  let key_id = id.api_key(key_id)
  case
    store.read(ctx.store, fn(read) {
      keys(read, "WHERE id = ? AND org_id = ?", [
        id.api_key_sql(key_id),
        id.org_sql(a.org.id),
      ])
    })
  {
    Error(e) -> http.internal(e)
    Ok([]) -> http.error(404, "KEY_NOT_FOUND")
    Ok(_) -> {
      use _ <- http.body(req, input.nothing(), [])
      case
        store.unit(ctx.store, fn(tx) {
          store.run(
            tx,
            "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
            [sqlight.int(clock.now_ms()), id.api_key_sql(key_id)],
          )
        })
      {
        Ok(Nil) -> http.json(200, json.object([#("ok", json.bool(True))]))
        Error(e) -> http.internal(e)
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------- the export

/// The organisation behind `Authorization: ApiKey <key>`, when the key is live and holds `scope`. A use of the
/// key is recorded apart from the request: a failed record never fails the export.
fn api_key_auth(
  ctx: Ctx,
  req: Request,
  scope: scope_row.Scope,
  next: fn(Org) -> Response,
) -> Response {
  case http.header(req, "authorization") {
    Ok("ApiKey " <> plain) -> {
      let found =
        store.read(ctx.store, fn(read) {
          keys(read, "WHERE key_hash = ? AND revoked_at IS NULL", [
            sqlight.text(secrets.sha256_hex(plain)),
          ])
        })
      case found {
        Error(e) -> http.internal(e)
        Ok([]) -> http.error(401, "API_KEY_INVALID")
        Ok([k, ..]) ->
          case list.contains(k.scopes, scope) {
            False ->
              http.json(
                403,
                json.object([
                  #("error", json.string("SCOPE_MISSING")),
                  #("required", scope_row.scope_to_json(scope)),
                  #("held", json.array(k.scopes, scope_row.scope_to_json)),
                ]),
              )
            True -> {
              case
                store.unit(ctx.store, fn(tx) {
                  store.run(
                    tx,
                    "UPDATE api_keys SET last_used_at = ? WHERE id = ?",
                    [sqlight.int(clock.now_ms()), id.api_key_sql(k.row.id)],
                  )
                })
              {
                Ok(Nil) -> Nil
                Error(e) ->
                  wisp.log_error(
                    "the API key's last use: " <> string.inspect(e),
                  )
              }
              case
                store.read(ctx.store, fn(read) {
                  orgs.by_id(read, k.row.org_id)
                })
              {
                Error(e) -> http.internal(e)
                Ok(Some(org)) if !org.suspended -> next(org)
                Ok(_) -> http.error(403, "ORG_UNAVAILABLE")
              }
            }
          }
      }
    }
    _ ->
      http.error_message(401, "API_KEY_REQUIRED", "Authorization: ApiKey <key>")
  }
}

/// `GET /api/v1/export/prospects`. `linkedPlayerId` stays in the contract, always null: nothing links a prospect
/// to a player.
pub fn export_prospects(ctx: Ctx, req: Request) -> Response {
  use org <- api_key_auth(ctx, req, scope_row.ExportProspects)
  case
    store.read(ctx.store, fn(read) { imports.live_prospects(read, org.id) })
  {
    Error(e) -> http.internal(e)
    Ok(found) ->
      http.json(
        200,
        json.object([
          #("contract", json.string(export_contract_version)),
          #("kind", json.string("prospects")),
          #("orgId", id.org_json(org.id)),
          #(
            "items",
            json.array(found, fn(p) {
              json.object([
                #("id", id.prospect_json(p.id)),
                #("name", json.string(p.name)),
                #("dob", json.nullable(p.dob, json.string)),
                #("position", json.nullable(p.position, position.to_json)),
                #("provider", json.string(p.provider)),
                #("externalId", json.string(p.external_id)),
                #("linkedPlayerId", json.null()),
              ])
            }),
          ),
        ]),
      )
  }
}

/// `GET /api/v1/export/shortlist`: visibility is checked again on every row, so revoked access exports nothing.
pub fn export_shortlist(ctx: Ctx, req: Request) -> Response {
  use org <- api_key_auth(ctx, req, scope_row.ExportShortlist)
  let now = clock.now_ms()
  let found =
    store.read(ctx.store, fn(read) {
      use ids <- result.try(store.query(
        read,
        "SELECT player_id FROM ledger WHERE org_id = ? AND type = 'shortlist' AND player_id IS NOT NULL GROUP BY player_id ORDER BY MIN(seq)",
        [id.org_sql(org.id)],
        decode.at([0], id.player_decoder()),
      ))
      players.for_org_many(read, ids, org, now)
    })
  case found {
    Error(e) -> http.internal(e)
    Ok(found) -> {
      let visible =
        list.filter_map(found, fn(f) {
          case { f.1 }.visible && !{ f.1 }.blocked {
            True -> Ok(f.0)
            False -> Error(Nil)
          }
        })
      http.json(
        200,
        json.object([
          #("contract", json.string(export_contract_version)),
          #("kind", json.string("shortlist")),
          #("orgId", id.org_json(org.id)),
          #(
            "items",
            json.array(visible, fn(p: players.Player) {
              json.object([
                #("id", id.player_json(p.row.id)),
                #("name", json.string(p.row.name)),
                #("position", json.nullable(p.row.position, position.to_json)),
                #("level", playing_level.to_json(p.row.level)),
                #(
                  "externalIds",
                  json.array(p.external_ids, fn(e) {
                    json.object([
                      #("provider", json.string(e.provider)),
                      #("externalId", json.string(e.external_id)),
                    ])
                  }),
                ),
              ])
            }),
          ),
        ]),
      )
    }
  }
}

// ------------------------------------------------------------------------------------------------- connectors

/// Nothing activates without real credentials and an authorised interface, and no build has either, so a
/// connector is `configured` only when its setting is.
const connectors = [
  #("stats-feed", "Match statistics feed", "CONNECTOR_STATS_KEY"),
  #("fed-registry", "Federation registration lookup", "CONNECTOR_FED_KEY"),
  #("video-host", "Licensed video platform", "CONNECTOR_VIDEO_KEY"),
]

/// `GET /org/connectors`.
pub fn connector_list(ctx: Ctx) -> Response {
  http.json(
    200,
    json.object([
      #(
        "items",
        json.array(connectors, fn(c) {
          let #(cid, name, setting) = c
          let configured =
            list.contains(ctx.config.configured_connectors, setting)
          json.object([
            #("id", json.string(cid)),
            #("name", json.string(name)),
            #("kind", json.string("inbound")),
            #(
              "status",
              json.string(case configured {
                True -> "configured"
                False -> "not_configured"
              }),
            ),
            #("note", case configured {
              True -> json.null()
              False ->
                json.string(
                  "No provider credentials — this connector performs no requests and imports nothing until an authorised integration is configured.",
                )
            }),
          ])
        }),
      ),
    ]),
  )
}
