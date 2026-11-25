//// `/blobs/<token>`: the local store's side of the upload protocol (`platform/blobs`), standing in for R2 in
//// development and the batteries. It refuses what R2 refuses: a PUT whose signed headers differ from the URL's,
//// whose length or SHA-256 differs from the declared one, or whose key already holds an object; a GET serves the
//// object, a single byte range included. With R2 configured the path doesn't exist.

import gleam/bit_array
import gleam/crypto
import gleam/http
import gleam/http/request
import gleam/int
import gleam/option.{Some}
import gleam/result
import gleam/string
import scoutbox/platform/blobs.{type Object}
import scoutbox/platform/http as scoutbox_http
import wisp.{type Request, type Response}

pub fn handle(
  store: blobs.Blobs,
  req: Request,
  token: String,
  now_ms: Int,
) -> Response {
  case store {
    blobs.R2(..) -> wisp.not_found()
    blobs.LocalDisk(..) ->
      case blobs.verify_token(store, token, now_ms), req.method {
        Ok(blobs.Token(method: blobs.Put(size:, mime:, sha256:), key:, ..)),
          http.Put
        -> put(store, req, key, size, mime, sha256)
        Ok(blobs.Token(method: blobs.Get, key:, ..)), http.Get ->
          get(store, req, key)
        _, _ -> scoutbox_http.error(403, "BLOB_LINK_INVALID")
      }
  }
}

fn put(
  store: blobs.Blobs,
  req: Request,
  key: String,
  size: Int,
  mime: String,
  sha256: BitArray,
) -> Response {
  let sent = fn(name) { request.get_header(req, name) }
  case
    sent("content-type") == Ok(mime),
    sent("if-none-match") == Ok("*"),
    sent("x-amz-checksum-sha256") == Ok(bit_array.base64_encode(sha256, True))
  {
    True, True, True ->
      // A byte more than declared is enough to refuse it.
      case
        wisp.read_body_bits(wisp.set_max_body_size(req, size + 1))
        |> result.try(fn(bytes) {
          case bit_array.byte_size(bytes) == size {
            True -> Ok(bytes)
            False -> Error(Nil)
          }
        })
      {
        Ok(bytes) ->
          case crypto.hash(crypto.Sha256, bytes) == sha256 {
            False -> scoutbox_http.error(400, "BLOB_DIGEST_MISMATCH")
            True ->
              case blobs.store_local(store, key, mime, bytes) {
                Ok(Nil) -> wisp.response(200)
                Error(blobs.AlreadyExists) ->
                  scoutbox_http.error(412, "BLOB_EXISTS")
                Error(blobs.Unavailable(why)) -> {
                  wisp.log_error("blob store: " <> why)
                  scoutbox_http.error(500, "BLOB_STORE_FAILED")
                }
              }
          }
        _ -> scoutbox_http.error(400, "BLOB_SIZE_MISMATCH")
      }
    _, _, _ -> scoutbox_http.error(403, "BLOB_HEADERS_MISMATCH")
  }
}

fn get(store: blobs.Blobs, req: Request, key: String) -> Response {
  case blobs.local_object(store, key) {
    option.None -> scoutbox_http.error(404, "BLOB_NOT_FOUND")
    Some(object) -> {
      let path = blobs.local_path(store, key)
      let whole =
        wisp.response(200)
        |> wisp.set_header("content-type", object.mime)
        |> wisp.set_header("accept-ranges", "bytes")
      case request.get_header(req, "range") {
        Error(Nil) ->
          wisp.set_body(whole, wisp.File(path:, offset: 0, limit: option.None))
        Ok(range) ->
          case byte_range(range, object) {
            // A range this store can't read (several, or not bytes) is ignored, as HTTP allows.
            Error(Nil) ->
              wisp.set_body(
                whole,
                wisp.File(path:, offset: 0, limit: option.None),
              )
            Ok(Error(Nil)) ->
              wisp.response(416)
              |> wisp.set_header(
                "content-range",
                "bytes */" <> int.to_string(object.size),
              )
            Ok(Ok(#(from, to))) ->
              wisp.response(206)
              |> wisp.set_header("content-type", object.mime)
              |> wisp.set_header("accept-ranges", "bytes")
              |> wisp.set_header(
                "content-range",
                "bytes "
                  <> int.to_string(from)
                  <> "-"
                  <> int.to_string(to)
                  <> "/"
                  <> int.to_string(object.size),
              )
              |> wisp.set_body(wisp.File(
                path:,
                offset: from,
                limit: Some(to - from + 1),
              ))
          }
      }
    }
  }
}

/// A single `bytes=` range within the object, as first and last byte. Error: not one this store reads.
/// Ok(Error): one that starts past the end.
pub fn byte_range(
  header: String,
  object: Object,
) -> Result(Result(#(Int, Int), Nil), Nil) {
  use spec <- result.try(case string.split_once(string.trim(header), "=") {
    Ok(#("bytes", spec)) -> Ok(spec)
    _ -> Error(Nil)
  })
  use #(first, last) <- result.try(string.split_once(spec, "-"))
  let last_byte = object.size - 1
  case first, last {
    // A suffix: the last n bytes.
    "", n -> {
      use n <- result.map(int.parse(n))
      case n > 0 && object.size > 0 {
        True -> Ok(#(int.max(object.size - n, 0), last_byte))
        False -> Error(Nil)
      }
    }
    from, "" -> {
      use from <- result.map(int.parse(from))
      case from <= last_byte {
        True -> Ok(#(from, last_byte))
        False -> Error(Nil)
      }
    }
    from, to -> {
      use from <- result.try(int.parse(from))
      use to <- result.try(int.parse(to))
      case from <= to {
        False -> Error(Nil)
        True ->
          Ok(case from <= last_byte {
            True -> Ok(#(from, int.min(to, last_byte)))
            False -> Error(Nil)
          })
      }
    }
  }
}
