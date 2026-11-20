//// A backup's media: what the battery's seed can't reach. A file queued for removal is left out, and a queued
//// removal naming a clip a player still has is a conflict that refuses the backup.

import gleam/dynamic/decode
import gleam/json
import gleam/string
import scoutbox/enterprise/backups
import scoutbox/platform/secrets
import scoutbox/platform/store
import scoutbox/support
import simplifile
import sqlight

fn queue(s: store.Store, media_id: String) -> Nil {
  let assert Ok(Nil) =
    store.unit(s, fn(tx) {
      store.run(
        tx,
        "INSERT INTO media_deletions (media_id, player_id, queued_at) VALUES (?, NULL, 1)",
        [sqlight.text(media_id)],
      )
    })
  Nil
}

fn scratch_dir() -> String {
  let dir = "build/test-dbs/" <> secrets.random_hex(8)
  let assert Ok(_) = simplifile.create_directory_all(dir <> "/media")
  dir
}

pub fn a_file_queued_for_removal_is_left_out_of_the_backup_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let data_dir = scratch_dir()
  let assert Ok(_) = simplifile.write(data_dir <> "/media/keep.webm", "k")
  let assert Ok(_) = simplifile.write(data_dir <> "/media/gone.webm", "g")
  queue(s, "gone")
  let dir = data_dir <> "/backups/one"
  let assert Ok(#(manifest, files, left_out)) =
    backups.write_backup(s, data_dir, dir, 1)
  assert files == 2
  assert left_out == 1
  assert simplifile.is_file(dir <> "/media/keep.webm") == Ok(True)
  assert simplifile.is_file(dir <> "/media/gone.webm") == Ok(False)
  let paths =
    json.parse(
      json.to_string(manifest),
      decode.at(["files"], decode.list(decode.at(["path"], decode.string))),
    )
  assert paths == Ok(["scoutbox.db", "media/keep.webm"])
  // The manifest on disk is the one answered.
  assert simplifile.read(dir <> "/manifest.json")
    == Ok(json.to_string(manifest))
  // A second backup into the same directory is refused, never written over the first.
  let assert Error(reason) = backups.write_backup(s, data_dir, dir, 2)
  assert string.contains(reason, "already exists")
}

pub fn a_queued_removal_of_a_clip_a_player_has_is_a_conflict_test() {
  let s = support.fresh_store(fn(_) { Nil })
  assert store.read(s, backups.conflicts) == Ok([])
  let assert Ok([#(media_id, player_id), ..]) =
    store.read(
      s,
      store.query(_, "SELECT id, player_id FROM player_media ORDER BY id", [], {
        use m <- decode.field(0, decode.string)
        use p <- decode.field(1, decode.string)
        decode.success(#(m, p))
      }),
    )
  queue(s, media_id)
  queue(s, "not-anyones")
  assert store.read(s, backups.conflicts)
    == Ok([backups.Conflict(media_id:, owners: [player_id])])
}
