//// Backups and readiness: `POST /admin/backup`, `GET /admin/backups`, `POST /admin/backup/verify` and `GET /readyz`.
////
//// A backup is a directory under DATA_DIR/backups: a consistent copy of the database (`store.copy_to`), the media
//// files, and a manifest of every file's SHA-256, written last, so a directory without one is not a backup. A
//// restore is that directory copied into a new, empty DATA_DIR, booted as it is.

import gleam/bit_array
import gleam/crypto
import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{Some}
import gleam/result
import gleam/set
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/orgs
import scoutbox/identity/players
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/json_text
import scoutbox/platform/secrets
import scoutbox/platform/store.{type Fail, type Read, type Store}
import scoutbox/rows/id
import scoutbox/rows/ops_events as ops_row
import simplifile
import wisp.{type Request, type Response}

/// How long a database copy may take before the backup is reported failed: far longer than a read's wait.
const copy_timeout_ms = 600_000

const backup_dir_max = 200

fn root(ctx: Ctx) -> String {
  ctx.config.data_dir <> "/backups"
}

/// A queued media removal naming a clip a player still has, with those players: the backup can neither copy the
/// file as the player's nor leave it out as removed.
pub type Conflict {
  Conflict(media_id: String, owners: List(String))
}

pub fn conflicts(read: Read) -> Result(List(Conflict), Fail(e)) {
  use rows <- result.map(
    store.query(
      read,
      "SELECT d.media_id, m.player_id FROM media_deletions d
     JOIN player_media m ON m.id = d.media_id
     ORDER BY d.queued_at, d.media_id, m.player_id, m.position",
      [],
      {
        use media_id <- decode.field(0, decode.string)
        use player_id <- decode.field(1, decode.string)
        decode.success(#(media_id, player_id))
      },
    ),
  )
  // Rows come grouped by media id, in queue order; each entry lists its owners once, in the order first seen.
  list.fold(rows, [], fn(acc, row) {
    let #(media_id, player_id) = row
    case acc {
      [Conflict(m, owners), ..rest] if m == media_id ->
        case list.contains(owners, player_id) {
          True -> acc
          False -> [Conflict(m, list.append(owners, [player_id])), ..rest]
        }
      _ -> [Conflict(media_id, [player_id]), ..acc]
    }
  })
  |> list.reverse
}

fn queued_media(read: Read) -> Result(List(String), Fail(e)) {
  store.query(
    read,
    // A file in the media directory is named by its media id (an evidence file) or its blob key (a clip).
    "SELECT media_id FROM media_deletions UNION ALL SELECT blob_key FROM media_deletions WHERE blob_key IS NOT NULL",
    [],
    decode.at([0], decode.string),
  )
}

type Counts {
  Counts(players: Int, retained_players: Int, orgs: Int, notifications: Int)
}

fn count_of(read: Read, sql: String) -> Result(Int, Fail(e)) {
  store.one(read, sql, [], decode.at([0], decode.int))
  |> result.map(result.unwrap(_, 0))
}

fn counts(read: Read) -> Result(Counts, Fail(e)) {
  use players <- result.try(players.count(read))
  use retained_players <- result.try(count_of(
    read,
    "SELECT COUNT(*) FROM players WHERE deleted_at IS NOT NULL",
  ))
  use orgs <- result.try(orgs.count(read))
  use notifications <- result.map(count_of(
    read,
    "SELECT COUNT(*) FROM notifications",
  ))
  Counts(players:, retained_players:, orgs:, notifications:)
}

type File {
  File(path: String, sha256: String, bytes: Int)
}

fn file_json(f: File) -> Json {
  json.object([
    #("path", json.string(f.path)),
    #("sha256", json.string(f.sha256)),
    #("bytes", json.int(f.bytes)),
  ])
}

fn checksum(path: String) -> Result(#(String, Int), String) {
  use bits <- result.map(
    simplifile.read_bits(path) |> result.map_error(simplifile.describe_error),
  )
  #(crypto.hash(crypto.Sha256, bits) |> secrets.hex, bit_array.byte_size(bits))
}

fn described(r: Result(a, simplifile.FileError)) -> Result(a, String) {
  result.map_error(r, simplifile.describe_error)
}

/// An ops event, after the fact: what the backup did is already done whether or not it is recorded.
fn record(ctx: Ctx, event: fn(ops_row.New) -> ops_row.New, kind: ops_row.Kind) {
  let now = clock.now_ms()
  let recorded =
    store.unit(ctx.store, fn(tx) {
      use id <- result.try(id.next_ops_event(tx))
      ops_row.insert(tx, event(ops_row.new(id:, occurred_at: now, kind:)))
    })
  case recorded {
    Ok(_) -> Nil
    Error(e) -> wisp.log_error("ops event not recorded: " <> string.inspect(e))
  }
}

/// `POST /admin/backup`.
pub fn create(ctx: Ctx, req: Request) -> Response {
  use _ <- http.body(req, input.nothing(), [])
  let now = clock.now_ms()
  let stamp =
    clock.iso(now) |> string.replace(":", "-") |> string.replace(".", "-")
  let dir = root(ctx) <> "/" <> stamp
  // Refused before any directory exists.
  case store.read(ctx.store, conflicts) {
    Error(failure) -> http.internal(failure)
    Ok([_, ..] as found) -> {
      let n = list.length(found)
      record(
        ctx,
        fn(e) {
          ops_row.New(
            ..e,
            detail_dir: Some(stamp),
            detail_error: Some("MEDIA_QUEUE_OWNERSHIP_CONFLICT"),
            detail_conflict_count: Some(n),
          )
        },
        ops_row.BackupRefused,
      )
      http.json(
        409,
        json.object([
          #("error", json.string("MEDIA_QUEUE_OWNERSHIP_CONFLICT")),
          #(
            "message",
            json.string(
              int.to_string(n)
              <> " queued media removal(s) name a clip a live player still references; the backup was refused because it could neither copy the file as the player's nor leave it out as removed. Resolve the queue entry or the player's reference first.",
            ),
          ),
          #(
            "conflicts",
            json.array(found, fn(c) {
              json.object([
                #("mediaId", json.string(c.media_id)),
                #("owners", json.array(c.owners, json.string)),
              ])
            }),
          ),
        ]),
      )
    }
    Ok([]) ->
      case write_backup(ctx.store, ctx.config.data_dir, dir, now) {
        Ok(#(manifest, files, left_out)) -> {
          record(
            ctx,
            fn(e) {
              ops_row.New(
                ..e,
                detail_dir: Some(stamp),
                detail_files: Some(files),
                detail_queued_for_removal: Some(left_out),
              )
            },
            ops_row.BackupCreated,
          )
          http.json(
            201,
            json.object([#("dir", json.string(dir)), #("manifest", manifest)]),
          )
        }
        Error(reason) -> {
          // Nothing half-made is left behind looking usable.
          let _ = simplifile.delete(dir)
          wisp.log_error("backup failed (" <> stamp <> "): " <> reason)
          record(
            ctx,
            fn(e) {
              ops_row.New(
                ..e,
                detail_dir: Some(stamp),
                detail_error: Some(string.slice(reason, 0, 200)),
              )
            },
            ops_row.BackupFailed,
          )
          http.error_message(
            500,
            "BACKUP_FAILED",
            "The backup could not be completed; the partial directory was removed.",
          )
        }
      }
  }
}

/// The copy, the media and the manifest: the manifest, how many files it lists, and how many media files it left
/// out as queued for removal.
pub fn write_backup(
  db: Store,
  data_dir: String,
  dir: String,
  now: Int,
) -> Result(#(Json, Int, Int), String) {
  use _ <- result.try(simplifile.create_directory_all(dir) |> described)
  let database = dir <> "/scoutbox.db"
  // Read once: the copy carries this queue, and it decides which files are left out below.
  use queued <- result.try(
    store.read(db, queued_media) |> result.map_error(string.inspect),
  )
  let queued = set.from_list(queued)
  use _ <- result.try(store.copy_to(db, database, timeout_ms: copy_timeout_ms))
  // Files queued for removal are left out: a backup never carries a file without the intent to remove it.
  let media_src = data_dir <> "/media"
  let media_dst = dir <> "/media"
  use #(media, left_out) <- result.try(case simplifile.is_directory(media_src) {
    Ok(True) -> {
      use _ <- result.try(
        simplifile.create_directory_all(media_dst) |> described,
      )
      use names <- result.try(simplifile.read_directory(media_src) |> described)
      let #(skipped, copied) =
        list.sort(names, string.compare)
        |> list.partition(fn(name) { set.contains(queued, media_id_of(name)) })
      use files <- result.map(
        list.try_map(copied, fn(name) {
          let to = media_dst <> "/" <> name
          use _ <- result.try(
            simplifile.copy_file(media_src <> "/" <> name, to) |> described,
          )
          use #(sha256, bytes) <- result.map(checksum(to))
          File(path: "media/" <> name, sha256:, bytes:)
        }),
      )
      #(files, list.length(skipped))
    }
    _ -> Ok(#([], 0))
  })
  use #(sha256, bytes) <- result.try(checksum(database))
  let files = [File(path: "scoutbox.db", sha256:, bytes:), ..media]
  use c <- result.try(
    store.read(db, counts) |> result.map_error(string.inspect),
  )
  let copied = list.length(media)
  let manifest =
    json.object([
      #("contract", json.string("backup.2026-11.v2")),
      #("createdAt", json.int(now)),
      #("engine", json.string("sqlite database copy + media files")),
      #(
        "counts",
        json.object([
          #("players", json.int(c.players)),
          #("retainedPlayers", json.int(c.retained_players)),
          #("orgs", json.int(c.orgs)),
          #("notifications", json.int(c.notifications)),
          #("mediaFiles", json.int(copied)),
        ]),
      ),
      #(
        "media",
        json.object([
          #("copied", json.int(copied)),
          #("queuedForRemoval", json.int(left_out)),
          #(
            "note",
            json.string(
              "Files whose removal was committed but not yet completed are left out on purpose: their queue entries are in scoutbox.db, and the restored server serves nothing for them and finishes the removal at boot.",
            ),
          ),
        ]),
      ),
      #("files", json.array(files, file_json)),
      #(
        "secretsNote",
        json.string(
          "Backups contain NO server secrets (ADMIN_KEY, signing secrets live in env, never in the DB). Store backups with the same care as the live data directory.",
        ),
      ),
      #(
        "restore",
        json.string(
          "Copy this directory to a NEW empty DATA_DIR and start the server with DATA_DIR pointing at it. Never restore over a live data directory.",
        ),
      ),
    ])
  // Written last: a directory without a manifest is not a backup. Compact, where TypeScript indents by two: the
  // file is read as JSON, never compared as text.
  use _ <- result.map(
    simplifile.write(dir <> "/manifest.json", json.to_string(manifest))
    |> described,
  )
  #(manifest, list.length(files), left_out)
}

/// A media file is named `<id>.<ext>`, or a stored object `<key>` with its record `<key>.json`.
fn media_id_of(name: String) -> String {
  case string.split(name, ".") {
    [only] -> only
    parts -> list.take(parts, list.length(parts) - 1) |> string.join(".")
  }
}

/// `GET /admin/backups`: the newest 20, each with its manifest as written, or null when it can't be read.
pub fn list(ctx: Ctx) -> Response {
  let items = case simplifile.read_directory(root(ctx)) {
    Error(_) -> []
    Ok(dirs) ->
      list.sort(dirs, string.compare)
      |> list.reverse
      |> list.take(20)
      |> list.map(fn(d) {
        let manifest =
          simplifile.read(root(ctx) <> "/" <> d <> "/manifest.json")
          |> result.replace_error(Nil)
          |> result.try(json_text.parse)
          |> result.unwrap(json.null())
        json.object([#("dir", json.string(d)), #("manifest", manifest)])
      })
  }
  http.json(200, json.object([#("items", json.preprocessed_array(items))]))
}

/// Node's `path.basename`: the last segment, trailing slashes ignored.
fn basename(path: String) -> String {
  let trimmed = case string.ends_with(path, "/") && path != "/" {
    True -> trim_slashes(path)
    False -> path
  }
  string.split(trimmed, "/") |> list.last |> result.unwrap("")
}

fn trim_slashes(path: String) -> String {
  case string.ends_with(path, "/") {
    True -> trim_slashes(string.drop_end(path, 1))
    False -> path
  }
}

/// `POST /admin/backup/verify`: every file the manifest lists, against its checksum.
pub fn verify(ctx: Ctx, req: Request) -> Response {
  let shape = {
    use dir <- input.field("dir", input.required(input.text(backup_dir_max)))
    input.done(dir)
  }
  use given <- http.body(req, shape, [])
  let dir = root(ctx) <> "/" <> basename(given)
  let listed = {
    use text <- result.try(
      simplifile.read(dir <> "/manifest.json") |> result.replace_error(Nil),
    )
    let file = {
      use path <- decode.field("path", decode.string)
      use sha256 <- decode.field("sha256", decode.string)
      decode.success(#(path, sha256))
    }
    json.parse(text, decode.at(["files"], decode.list(file)))
    |> result.replace_error(Nil)
  }
  case listed {
    Error(Nil) -> http.error(404, "BACKUP_NOT_FOUND")
    Ok(files) -> {
      let results =
        list.map(files, fn(f) {
          let #(path, sha256) = f
          case checksum(dir <> "/" <> path) {
            Ok(#(found, _)) -> #(path, found == sha256, False)
            Error(_) -> #(path, False, True)
          }
        })
      http.json(
        200,
        json.object([
          #("ok", json.bool(list.all(results, fn(r) { r.1 }))),
          #(
            "results",
            json.array(results, fn(r) {
              let #(path, ok, missing) = r
              json.object(
                [#("path", json.string(path)), #("ok", json.bool(ok))]
                |> list.append(case missing {
                  True -> [#("missing", json.bool(True))]
                  False -> []
                }),
              )
            }),
          ),
        ]),
      )
    }
  }
}

/// `GET /readyz`: the database answers.
pub fn readyz(ctx: Ctx) -> Response {
  case store.read(ctx.store, players.count) {
    Ok(n) ->
      http.json(
        200,
        json.object([#("ready", json.bool(True)), #("players", json.int(n))]),
      )
    Error(e) ->
      http.json(
        503,
        json.object([
          #("ready", json.bool(False)),
          #("error", json.string(string.inspect(e))),
        ]),
      )
  }
}
