//// Object storage for uploaded files (final-port-steps.md step 5). A file's bytes go between the client and storage
//// on a URL this server signs, never through the server. Two backends answer the same protocol, so the demo and
//// the batteries take the production path:
////
//// - `R2`: Cloudflare R2 through its S3 API, every request on a SigV4 presigned URL (`platform/sigv4`).
//// - `LocalDisk`: files under `DATA_DIR/media`, its signed URLs pointing back at this server (`/blobs/<token>`,
////   served by `platform/blob_routes`). It enforces what R2 does.
////
//// An upload URL signs the length, the type, the SHA-256 the client declared and `If-None-Match: *`: storage refuses
//// different bytes, and a key is written once. The server never hashes an upload itself. Whether R2 refuses a wrong
//// `x-amz-checksum-sha256` on a presigned PUT is still to be checked against a real bucket (step 5.3).
////
//// A key is ours (an upload intent's id, a media id): letters, digits and `-`. The time is passed in, so this
//// module stays below `platform/config`.

import gleam/bit_array
import gleam/crypto
import gleam/dynamic/decode
import gleam/http
import gleam/http/request
import gleam/http/response.{type Response}
import gleam/httpc
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/regexp
import gleam/result
import gleam/string
import scoutbox/platform/secrets
import scoutbox/platform/sigv4
import simplifile

pub type Blobs {
  R2(credentials: sigv4.Credentials, account_id: String, bucket: String)
  /// `secret` signs the `/blobs/<token>` URLs.
  LocalDisk(dir: String, secret: String)
}

/// The largest object any purpose may upload: 40 MiB, a player's clip. The transport admits a body this large on
/// `/blobs/<token>` only.
pub const max_bytes = 41_943_040

/// Where a client sends an upload, and the headers it must send with it, exactly. The body must be the declared
/// number of bytes; its `Content-Length` is signed too, but a client's HTTP stack sets it (browsers refuse to).
/// A `LocalDisk` URL is a path on this server: the client resolves it against the API's address, as it would any
/// link the API returns.
pub type Upload {
  Upload(url: String, headers: List(#(String, String)))
}

/// What storage knows of a stored object.
pub type Object {
  Object(size: Int, mime: String)
}

pub type Problem {
  /// The key already holds an object.
  AlreadyExists
  /// Storage didn't answer as it should: unreachable, refusing our credentials, or a disk error.
  Unavailable(String)
}

/// How long a URL the server signs for its own request lives.
const own_request_seconds = 60

const request_timeout_ms = 30_000

/// A URL a client can PUT the declared file to until `expires_seconds` from `now_ms`.
pub fn presign_put(
  blobs: Blobs,
  key: String,
  size size: Int,
  mime mime: String,
  sha256 sha256: BitArray,
  expires_seconds expires_seconds: Int,
  now_ms now_ms: Int,
) -> Upload {
  check_key(key)
  let headers = upload_headers(mime, sha256)
  case blobs {
    R2(..) ->
      Upload(
        url: r2_url(
          blobs,
          "PUT",
          key,
          [#("content-length", int.to_string(size)), ..headers],
          expires_seconds,
          now_ms,
        ),
        headers:,
      )
    LocalDisk(secret:, ..) ->
      Upload(
        url: "/blobs/"
          <> sign_token(
          secret,
          Token(
            method: Put(size:, mime:, sha256:),
            key:,
            expires_ms: now_ms + expires_seconds * 1000,
          ),
        ),
        headers:,
      )
  }
}

fn upload_headers(mime: String, sha256: BitArray) -> List(#(String, String)) {
  [
    #("content-type", mime),
    #("if-none-match", "*"),
    #("x-amz-checksum-sha256", bit_array.base64_encode(sha256, True)),
  ]
}

/// A URL anyone holding it can GET the object from until `expires_seconds` from `now_ms`. Ranged requests work,
/// so a video can be seeked.
pub fn presign_get(
  blobs: Blobs,
  key: String,
  expires_seconds expires_seconds: Int,
  now_ms now_ms: Int,
) -> String {
  check_key(key)
  case blobs {
    R2(..) -> r2_url(blobs, "GET", key, [], expires_seconds, now_ms)
    LocalDisk(secret:, ..) ->
      "/blobs/"
      <> sign_token(
        secret,
        Token(method: Get, key:, expires_ms: now_ms + expires_seconds * 1000),
      )
  }
}

/// The object at `key`, if there is one.
pub fn head(
  blobs: Blobs,
  key: String,
  now_ms: Int,
) -> Result(Option(Object), Problem) {
  check_key(key)
  case blobs {
    LocalDisk(..) -> Ok(local_object(blobs, key))
    R2(..) -> {
      use r <- result.try(r2_send(blobs, http.Head, "HEAD", key, [], now_ms))
      case r.status {
        200 -> {
          let size =
            response.get_header(r, "content-length") |> result.try(int.parse)
          case size, response.get_header(r, "content-type") {
            Ok(size), Ok(mime) -> Ok(Some(Object(size:, mime:)))
            _, _ ->
              Error(Unavailable("HEAD answered without its length or type"))
          }
        }
        404 -> Ok(None)
        status -> Error(unexpected("HEAD", status))
      }
    }
  }
}

/// Up to `length` bytes of the object from `offset`: fewer past its end, none at all from beyond it.
pub fn read_range(
  blobs: Blobs,
  key: String,
  offset offset: Int,
  length length: Int,
  now_ms now_ms: Int,
) -> Result(Option(BitArray), Problem) {
  check_key(key)
  case blobs {
    // Development only, and only ever for a few bytes of a small file: the whole file is read.
    LocalDisk(..) ->
      case local_object(blobs, key) {
        None -> Ok(None)
        Some(_) ->
          case simplifile.read_bits(local_path(blobs, key)) {
            Error(e) -> Error(Unavailable(simplifile.describe_error(e)))
            Ok(bits) -> Ok(Some(slice(bits, offset, length)))
          }
      }
    R2(..) -> {
      let range =
        "bytes="
        <> int.to_string(offset)
        <> "-"
        <> int.to_string(offset + length - 1)
      use r <- result.try(r2_send(
        blobs,
        http.Get,
        "GET",
        key,
        [#("range", range)],
        now_ms,
      ))
      case r.status {
        206 -> Ok(Some(r.body))
        // A server may ignore the range and send it all.
        200 -> Ok(Some(slice(r.body, offset, length)))
        416 -> Ok(Some(<<>>))
        404 -> Ok(None)
        status -> Error(unexpected("GET", status))
      }
    }
  }
}

fn slice(bits: BitArray, offset: Int, length: Int) -> BitArray {
  let size = bit_array.byte_size(bits)
  let from = int.min(offset, size)
  let assert Ok(part) =
    bit_array.slice(bits, from, int.min(length, size - from))
    as "a slice within the bytes"
  part
}

/// Removes the object. One that isn't there is already removed.
pub fn delete(blobs: Blobs, key: String, now_ms: Int) -> Result(Nil, Problem) {
  check_key(key)
  case blobs {
    LocalDisk(..) -> {
      use _ <- result.try(remove(local_meta_path(blobs, key)))
      remove(local_path(blobs, key))
    }
    R2(..) -> {
      use r <- result.try(r2_send(blobs, http.Delete, "DELETE", key, [], now_ms))
      case r.status {
        200 | 204 | 404 -> Ok(Nil)
        status -> Error(unexpected("DELETE", status))
      }
    }
  }
}

fn remove(path: String) -> Result(Nil, Problem) {
  case simplifile.delete(path) {
    Ok(Nil) | Error(simplifile.Enoent) -> Ok(Nil)
    Error(e) -> Error(Unavailable(simplifile.describe_error(e)))
  }
}

/// The server's own write of a file it holds (the demo seed's clips), through the same checks as a client's upload.
pub fn put(
  blobs: Blobs,
  key: String,
  mime: String,
  bytes: BitArray,
  now_ms: Int,
) -> Result(Nil, Problem) {
  check_key(key)
  case blobs {
    LocalDisk(..) -> store_local(blobs, key, mime, bytes)
    R2(..) -> {
      let sha256 = crypto.hash(crypto.Sha256, bytes)
      let headers = [
        #("content-length", int.to_string(bit_array.byte_size(bytes))),
        ..upload_headers(mime, sha256)
      ]
      let url = r2_url(blobs, "PUT", key, headers, own_request_seconds, now_ms)
      use r <- result.try(send(http.Put, url, headers, bytes))
      case r.status {
        200 -> Ok(Nil)
        412 -> Error(AlreadyExists)
        status -> Error(unexpected("PUT", status))
      }
    }
  }
}

fn check_key(key: String) -> Nil {
  let assert Ok(shape) = regexp.from_string("^[A-Za-z0-9-]{1,80}$")
  let assert True = regexp.check(shape, key) as "a blob key is one of ours"
  Nil
}

// ------------------------------------------------------------------------------------------------------ R2

fn r2_host(account_id: String) -> String {
  account_id <> ".r2.cloudflarestorage.com"
}

fn r2_url(
  blobs: Blobs,
  method: String,
  key: String,
  headers: List(#(String, String)),
  expires_seconds: Int,
  now_ms: Int,
) -> String {
  let assert R2(credentials:, account_id:, bucket:) = blobs as "an R2 store"
  sigv4.presign(
    credentials,
    method,
    r2_host(account_id),
    "/" <> bucket <> "/" <> key,
    headers,
    expires_seconds,
    now_ms,
  )
}

/// One of the server's own requests, with headers it doesn't sign (a range).
fn r2_send(
  blobs: Blobs,
  method: http.Method,
  name: String,
  key: String,
  unsigned: List(#(String, String)),
  now_ms: Int,
) -> Result(Response(BitArray), Problem) {
  send(
    method,
    r2_url(blobs, name, key, [], own_request_seconds, now_ms),
    unsigned,
    <<>>,
  )
}

fn send(
  method: http.Method,
  url: String,
  headers: List(#(String, String)),
  body: BitArray,
) -> Result(Response(BitArray), Problem) {
  let assert Ok(req) = request.to(url) as "a presigned URL parses"
  let req =
    list.fold(headers, request.set_method(req, method), fn(req, h) {
      request.set_header(req, h.0, h.1)
    })
    |> request.set_body(body)
  httpc.configure()
  |> httpc.timeout(request_timeout_ms)
  |> httpc.dispatch_bits(req)
  |> result.map_error(fn(e) { Unavailable(string.inspect(e)) })
}

fn unexpected(what: String, status: Int) -> Problem {
  Unavailable(what <> " answered " <> int.to_string(status))
}

// ------------------------------------------------------------------------------------------------ local disk

/// What a `/blobs/<token>` URL allows.
pub type Method {
  Put(size: Int, mime: String, sha256: BitArray)
  Get
}

pub type Token {
  Token(method: Method, key: String, expires_ms: Int)
}

fn token_text(token: Token) -> String {
  let method = case token.method {
    Put(size:, mime:, sha256:) ->
      "PUT|"
      <> int.to_string(size)
      <> "|"
      <> mime
      <> "|"
      <> bit_array.base64_encode(sha256, True)
    Get -> "GET"
  }
  method <> "|" <> token.key <> "|" <> int.to_string(token.expires_ms)
}

fn token_signature(secret: String, text: String) -> BitArray {
  crypto.hmac(
    bit_array.from_string("blobs\n" <> text),
    crypto.Sha256,
    bit_array.from_string(secret),
  )
}

fn sign_token(secret: String, token: Token) -> String {
  let text = token_text(token)
  bit_array.base64_url_encode(bit_array.from_string(text), False)
  <> "."
  <> bit_array.base64_url_encode(token_signature(secret, text), False)
}

/// The token a `/blobs/<token>` URL carries, if this store signed it and it hasn't expired.
pub fn verify_token(
  blobs: Blobs,
  token: String,
  now_ms: Int,
) -> Result(Token, Nil) {
  let assert LocalDisk(secret:, ..) = blobs
    as "only the local store serves /blobs"
  use #(text, signature) <- result.try(string.split_once(token, "."))
  use text <- result.try(bit_array.base64_url_decode(text))
  use signature <- result.try(bit_array.base64_url_decode(signature))
  use text <- result.try(bit_array.to_string(text))
  use <- guard(crypto.secure_compare(token_signature(secret, text), signature))
  use token <- result.try(parse_token(text))
  use <- guard(token.expires_ms > now_ms)
  Ok(token)
}

fn guard(ok: Bool, next: fn() -> Result(a, Nil)) -> Result(a, Nil) {
  case ok {
    True -> next()
    False -> Error(Nil)
  }
}

fn parse_token(text: String) -> Result(Token, Nil) {
  use #(method, rest) <- result.try(case string.split(text, "|") {
    ["PUT", size, mime, sha256, ..rest] -> {
      use size <- result.try(int.parse(size))
      use sha256 <- result.map(bit_array.base64_decode(sha256))
      #(Put(size:, mime:, sha256:), rest)
    }
    ["GET", ..rest] -> Ok(#(Get, rest))
    _ -> Error(Nil)
  })
  case rest {
    [key, expires] -> {
      use expires_ms <- result.map(int.parse(expires))
      Token(method:, key:, expires_ms:)
    }
    _ -> Error(Nil)
  }
}

/// Where the local store keeps the object at `key`.
pub fn local_path(blobs: Blobs, key: String) -> String {
  let assert LocalDisk(dir:, ..) = blobs as "a local store"
  dir <> "/" <> key
}

fn local_meta_path(blobs: Blobs, key: String) -> String {
  local_path(blobs, key) <> ".json"
}

/// The local object at `key`. Its record is written last, so an object is there only once it is whole.
pub fn local_object(blobs: Blobs, key: String) -> Option(Object) {
  let decoder = {
    use size <- decode.field("size", decode.int)
    use mime <- decode.field("mime", decode.string)
    decode.success(Object(size:, mime:))
  }
  simplifile.read(local_meta_path(blobs, key))
  |> result.replace_error(Nil)
  |> result.try(fn(text) {
    json.parse(text, decoder) |> result.replace_error(Nil)
  })
  |> option.from_result
}

/// Writes an object the local store has checked, once: a key that holds one already is refused.
pub fn store_local(
  blobs: Blobs,
  key: String,
  mime: String,
  bytes: BitArray,
) -> Result(Nil, Problem) {
  let assert LocalDisk(dir:, ..) = blobs as "a local store"
  let path = local_path(blobs, key)
  let disk = fn(r) {
    result.map_error(r, fn(e) { Unavailable(simplifile.describe_error(e)) })
  }
  use _ <- result.try(disk(simplifile.create_directory_all(dir)))
  // Claiming the name is the atomic step: of two writers, one creates the file and the other is refused.
  use _ <- result.try(case simplifile.create_file(path) {
    Ok(Nil) -> Ok(Nil)
    Error(simplifile.Eexist) -> Error(AlreadyExists)
    Error(e) -> Error(Unavailable(simplifile.describe_error(e)))
  })
  let part = path <> ".part-" <> secrets.random_hex(8)
  use _ <- result.try(disk(simplifile.write_bits(part, bytes)))
  use _ <- result.try(disk(simplifile.rename(part, path)))
  let meta =
    json.object([
      #("size", json.int(bit_array.byte_size(bytes))),
      #("mime", json.string(mime)),
    ])
    |> json.to_string
  use _ <- result.try(disk(simplifile.write(part, meta)))
  disk(simplifile.rename(part, local_meta_path(blobs, key)))
}
