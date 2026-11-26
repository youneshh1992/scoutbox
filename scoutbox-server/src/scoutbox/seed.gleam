//// The demo world a first development boot loads: `priv/seed.sql` (first dumped from the TypeScript server's seed),
//// edited by hand. Its timestamps are `NOW_MS + offset`, so the world is as fresh on every first boot. Staff
//// accounts are not seeded; a demo organisation's first sign-in under a name creates the account.

import gleam/dynamic/decode
import gleam/int
import gleam/list
import gleam/result
import gleam/string
import scoutbox/platform/blobs.{type Blobs}
import scoutbox/platform/store.{type Store}
import scoutbox/rows/id
import simplifile
import sqlight
import wisp

/// The first boot of a database: loads the demo world when `demo` is set, and marks the database installed either
/// way, as the TypeScript server does (`meta.orgsInit` and `meta.coreIdentityInit` go from `pending`, which the
/// migrations write, to `done`). An installed database is never seeded again, nor is one a fixture wrote.
pub fn run(
  store: Store,
  now: Int,
  demo demo: Bool,
  blobs blobs: Blobs,
) -> Result(Bool, String) {
  use priv <- result.try(
    wisp.priv_directory("scoutbox") |> result.replace_error("no priv directory"),
  )
  use sql <- result.try(
    simplifile.read(priv <> "/seed.sql") |> result.map_error(string.inspect),
  )
  store.unit(store, fn(tx) {
    use state <- result.try(store.query(
      store.reading(tx),
      "SELECT value FROM meta WHERE key = 'orgsInit'",
      [],
      decode.at([0], decode.string),
    ))
    case state, demo {
      ["pending"], True -> {
        use _ <- result.try(store.exec(
          tx,
          string.replace(sql, "NOW_MS", int.to_string(now)),
        ))
        use _ <- result.try(installed(tx))
        Ok(True)
      }
      ["pending"], False -> {
        use _ <- result.try(installed(tx))
        Ok(False)
      }
      _, _ -> Ok(False)
    }
  })
  |> result.map_error(fn(e) { "seed: " <> string.inspect(e) })
  |> result.map(fn(seeded) {
    case seeded {
      True -> install_sample_clips(store, priv, blobs, now)
      False -> Nil
    }
    seeded
  })
}

/// Three demo players' sample clips (sampleClips.mjs), stored where their seeded `/media/<id>` rows say. The
/// files are optional: without one, that clip's link answers 404. A clip's key is the seed's own, so seeding again
/// against the same bucket finds the file already there.
fn install_sample_clips(
  store: Store,
  priv: String,
  blobs: Blobs,
  now: Int,
) -> Nil {
  use #(file, player_id, title) <- list.each([
    #("clip-sprint.webm", "pl-adeyemi", "Sprint & finishing session"),
    #("clip-passing.webm", "pl-carvalho", "Passing range compilation"),
    #("clip-wingplay.webm", "pl-guni", "U15 highlights — wing play"),
  ])
  let media_id =
    store.read(store, fn(read) {
      store.one(
        read,
        "SELECT id FROM player_media WHERE player_id = ? AND title = ?",
        [id.player_sql(id.player(player_id)), sqlight.text(title)],
        decode.at([0], id.media_decoder()),
      )
    })
  case media_id, simplifile.read_bits(priv <> "/sample_clips/" <> file) {
    Ok(Ok(media_id)), Ok(bytes) -> {
      let key = "seed-" <> id.media_to_string(media_id)
      case blobs.put(blobs, key, "video/webm", bytes, now) {
        Ok(Nil) | Error(blobs.AlreadyExists) -> {
          let _ =
            store.unit(store, fn(tx) {
              store.run(
                tx,
                "UPDATE player_media SET blob_key = ? WHERE id = ?",
                [sqlight.text(key), id.media_sql(media_id)],
              )
            })
          Nil
        }
        Error(blobs.Unavailable(why)) ->
          wisp.log_error("seed: sample clip " <> file <> ": " <> why)
      }
    }
    _, _ -> Nil
  }
}

fn installed(tx: store.Tx) -> Result(Nil, store.Fail(e)) {
  store.exec(
    tx,
    "UPDATE meta SET value = 'done' WHERE key IN ('orgsInit', 'coreIdentityInit')",
  )
}
