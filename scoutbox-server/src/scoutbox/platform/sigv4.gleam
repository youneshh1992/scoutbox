//// AWS Signature Version 4 in its query-string form: S3's presigned URL, which Cloudflare R2 accepts. Only what
//// `platform/blobs` needs: every request it makes, its own included, travels on a presigned URL, so there is no
//// `Authorization` header form. The payload is never signed (`UNSIGNED-PAYLOAD`); an upload's integrity is the
//// `x-amz-checksum-sha256` header it signs instead.
////
//// Spec: docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html. The tests pin AWS's own example and
//// vectors from a reference signer that reproduces it and AWS's SDK.

import gleam/bit_array
import gleam/crypto
import gleam/int
import gleam/list
import gleam/string
import gleam/time/calendar
import gleam/time/timestamp

pub type Credentials {
  Credentials(access_key_id: String, secret_access_key: String, region: String)
}

/// A presigned URL for `method` on `https://<host><path>`. Each of `headers` is signed with `host`, so the
/// request must carry it with exactly that value. `path` is encoded segment by segment, its `/`s kept.
pub fn presign(
  credentials: Credentials,
  method: String,
  host: String,
  path: String,
  headers: List(#(String, String)),
  expires_seconds: Int,
  now_ms: Int,
) -> String {
  let amz_date = amz_date(now_ms)
  let day = string.slice(amz_date, 0, 8)
  let scope = day <> "/" <> credentials.region <> "/s3/aws4_request"
  let headers =
    [#("host", host), ..headers]
    |> list.map(fn(h) { #(string.lowercase(h.0), string.trim(h.1)) })
    |> list.sort(fn(a, b) { string.compare(a.0, b.0) })
  let signed_headers = list.map(headers, fn(h) { h.0 }) |> string.join(";")
  let query =
    [
      #("X-Amz-Algorithm", "AWS4-HMAC-SHA256"),
      #("X-Amz-Credential", credentials.access_key_id <> "/" <> scope),
      #("X-Amz-Date", amz_date),
      #("X-Amz-Expires", int.to_string(expires_seconds)),
      #("X-Amz-SignedHeaders", signed_headers),
    ]
    |> list.map(fn(q) { encode(q.0) <> "=" <> encode(q.1) })
    // Already in byte order: every name starts `X-Amz-` and the rest sorts as written.
    |> string.join("&")
  let path = string.split(path, "/") |> list.map(encode) |> string.join("/")
  let canonical =
    string.join(
      [
        method,
        path,
        query,
        string.concat(list.map(headers, fn(h) { h.0 <> ":" <> h.1 <> "\n" })),
        signed_headers,
        "UNSIGNED-PAYLOAD",
      ],
      "\n",
    )
  let to_sign =
    string.join(
      ["AWS4-HMAC-SHA256", amz_date, scope, hex(sha256(canonical))],
      "\n",
    )
  let key =
    ["AWS4" <> credentials.secret_access_key, day, credentials.region, "s3"]
    |> list.fold(<<>>, fn(key, part) {
      case key {
        <<>> -> bit_array.from_string(part)
        key -> hmac(key, part)
      }
    })
    |> hmac("aws4_request")
  let signature = hex(hmac(key, to_sign))
  "https://" <> host <> path <> "?" <> query <> "&X-Amz-Signature=" <> signature
}

/// `20130524T000000Z`.
fn amz_date(now_ms: Int) -> String {
  let #(date, time) =
    timestamp.from_unix_seconds(now_ms / 1000)
    |> timestamp.to_calendar(calendar.utc_offset)
  let pad = fn(n, w) { int.to_string(n) |> string.pad_start(w, "0") }
  pad(date.year, 4)
  <> pad(calendar.month_to_int(date.month), 2)
  <> pad(date.day, 2)
  <> "T"
  <> pad(time.hours, 2)
  <> pad(time.minutes, 2)
  <> pad(time.seconds, 2)
  <> "Z"
}

/// RFC 3986 percent-encoding over the UTF-8 bytes: everything but `A-Za-z0-9-._~`, in upper-case hex.
pub fn encode(text: String) -> String {
  encode_bytes(bit_array.from_string(text), "")
}

fn encode_bytes(bytes: BitArray, done: String) -> String {
  case bytes {
    <<b, rest:bytes>> -> {
      let unreserved =
        { b >= 0x41 && b <= 0x5A }
        || { b >= 0x61 && b <= 0x7A }
        || { b >= 0x30 && b <= 0x39 }
        || b == 0x2D
        || b == 0x2E
        || b == 0x5F
        || b == 0x7E
      let piece = case unreserved {
        True -> {
          let assert Ok(c) = bit_array.to_string(<<b>>) as "ASCII is UTF-8"
          c
        }
        False -> "%" <> bit_array.base16_encode(<<b>>)
      }
      encode_bytes(rest, done <> piece)
    }
    _ -> done
  }
}

fn hmac(key: BitArray, data: String) -> BitArray {
  crypto.hmac(bit_array.from_string(data), crypto.Sha256, key)
}

fn sha256(data: String) -> BitArray {
  crypto.hash(crypto.Sha256, bit_array.from_string(data))
}

fn hex(bits: BitArray) -> String {
  bit_array.base16_encode(bits) |> string.lowercase
}
