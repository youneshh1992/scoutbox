//// Media files, outside the database on the local disk under DATA_DIR/media, as the TypeScript server keeps them
//// (adapters.mjs `createStorage`): the database holds only ids. A file is named `<id>.<ext>`, the extension
//// standing for the only types the store tells apart (video/webm, video/mp4, anything else).

import gleam/result
import gleam/string
import simplifile

fn extension(content_type: String) -> String {
  case
    string.contains(content_type, "webm"),
    string.contains(content_type, "mp4")
  {
    True, _ -> "webm"
    _, True -> "mp4"
    _, _ -> "bin"
  }
}

pub fn save(
  data_dir: String,
  id: String,
  content_type: String,
  bytes: BitArray,
) -> Result(Nil, String) {
  let dir = data_dir <> "/media"
  use _ <- result.try(
    simplifile.create_directory_all(dir) |> result.map_error(string.inspect),
  )
  simplifile.write_bits(
    dir <> "/" <> id <> "." <> extension(content_type),
    bytes,
  )
  |> result.map_error(string.inspect)
}

/// A stored file and the type the store knows it by.
pub fn read(data_dir: String, id: String) -> Result(#(String, BitArray), Nil) {
  let at = fn(ext) { data_dir <> "/media/" <> id <> "." <> ext }
  case simplifile.read_bits(at("webm")) {
    Ok(bytes) -> Ok(#("video/webm", bytes))
    Error(_) ->
      case simplifile.read_bits(at("mp4")) {
        Ok(bytes) -> Ok(#("video/mp4", bytes))
        Error(_) ->
          simplifile.read_bits(at("bin"))
          |> result.map(fn(bytes) { #("application/octet-stream", bytes) })
          |> result.replace_error(Nil)
      }
  }
}
