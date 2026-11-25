//// The local blob store and its `/blobs/<token>` routes, which must refuse what R2 refuses, and the storage setting.

import gleam/bit_array
import gleam/crypto
import gleam/http
import gleam/http/request
import gleam/http/response
import gleam/list
import gleam/option.{None, Some}
import gleam/string
import scoutbox/platform/blob_routes
import scoutbox/platform/blobs
import scoutbox/platform/config
import scoutbox/platform/secrets
import scoutbox/platform/wisp_ewe
import simplifile
import wisp
import wisp/simulate

const now = 1_800_000_000_000

fn store() -> blobs.Blobs {
  blobs.LocalDisk(
    dir: "build/test-blobs/" <> secrets.random_hex(8),
    secret: "test-secret",
  )
}

fn sha(bytes: BitArray) -> BitArray {
  crypto.hash(crypto.Sha256, bytes)
}

fn token_of(url: String) -> String {
  let assert "/blobs/" <> token = url
  token
}

/// The PUT a client makes with what `presign_put` handed it, the body and its headers adjustable.
fn upload(
  store: blobs.Blobs,
  key: String,
  declared: BitArray,
  sent: BitArray,
  change: fn(List(#(String, String))) -> List(#(String, String)),
  at: Int,
) -> wisp.Response {
  let up =
    blobs.presign_put(
      store,
      key,
      size: bit_array.byte_size(declared),
      mime: "video/mp4",
      sha256: sha(declared),
      expires_seconds: 900,
      now_ms: now,
    )
  let req =
    list.fold(
      change(up.headers),
      simulate.request(http.Put, up.url) |> simulate.bit_array_body(sent),
      fn(req, h) { request.set_header(req, h.0, h.1) },
    )
  blob_routes.handle(store, req, token_of(up.url), at)
}

fn same(headers: List(#(String, String))) -> List(#(String, String)) {
  headers
}

fn fetch(store: blobs.Blobs, key: String, range: option.Option(String)) {
  let url = blobs.presign_get(store, key, expires_seconds: 60, now_ms: now)
  let req = simulate.request(http.Get, url)
  let req = case range {
    Some(r) -> request.set_header(req, "range", r)
    None -> req
  }
  blob_routes.handle(store, req, token_of(url), now)
}

fn code(r: wisp.Response) -> String {
  simulate.read_body(r)
}

pub fn an_upload_with_its_signed_headers_is_stored_and_served_test() {
  let s = store()
  let bytes = <<"a clip of some length":utf8>>
  let r = upload(s, "upl-1", bytes, bytes, same, now)
  assert r.status == 200
  assert blobs.head(s, "upl-1", now)
    == Ok(Some(blobs.Object(size: 21, mime: "video/mp4")))
  let got = fetch(s, "upl-1", None)
  assert got.status == 200
  assert response.get_header(got, "content-type") == Ok("video/mp4")
  assert simulate.read_body_bits(got) == bytes
}

pub fn bytes_other_than_the_declared_ones_are_refused_test() {
  let s = store()
  let declared = <<"the declared file":utf8>>
  let r =
    upload(s, "upl-1", declared, <<"another file, same len":utf8>>, same, now)
  assert r.status == 400
  let r = upload(s, "upl-1", declared, <<"the declared filE":utf8>>, same, now)
  assert r.status == 400
  assert string.contains(code(r), "BLOB_DIGEST_MISMATCH")
  let r = upload(s, "upl-1", declared, <<"the declared file!":utf8>>, same, now)
  assert string.contains(code(r), "BLOB_SIZE_MISMATCH")
  let r = upload(s, "upl-1", declared, <<"the declared":utf8>>, same, now)
  assert string.contains(code(r), "BLOB_SIZE_MISMATCH")
  assert blobs.head(s, "upl-1", now) == Ok(None)
}

pub fn a_signed_header_left_off_or_changed_is_refused_test() {
  let s = store()
  let bytes = <<"file":utf8>>
  let without = fn(name) {
    fn(hs) { list.filter(hs, fn(h: #(String, String)) { h.0 != name }) }
  }
  list.each(
    ["content-type", "if-none-match", "x-amz-checksum-sha256"],
    fn(name) {
      let r = upload(s, "upl-1", bytes, bytes, without(name), now)
      assert r.status == 403
      assert string.contains(code(r), "BLOB_HEADERS_MISMATCH")
    },
  )
  let r =
    upload(
      s,
      "upl-1",
      bytes,
      bytes,
      fn(hs) { list.key_set(hs, "content-type", "image/png") },
      now,
    )
  assert r.status == 403
}

pub fn a_key_is_written_once_test() {
  let s = store()
  let bytes = <<"first":utf8>>
  assert upload(s, "upl-1", bytes, bytes, same, now).status == 200
  let r = upload(s, "upl-1", <<"again":utf8>>, <<"again":utf8>>, same, now)
  assert r.status == 412
  assert string.contains(code(r), "BLOB_EXISTS")
  assert simulate.read_body_bits(fetch(s, "upl-1", None)) == bytes
  assert blobs.put(s, "upl-1", "video/mp4", bytes, now)
    == Error(blobs.AlreadyExists)
}

pub fn an_expired_or_tampered_link_is_refused_test() {
  let s = store()
  let bytes = <<"file":utf8>>
  // The URL lives 900 seconds.
  assert upload(s, "upl-1", bytes, bytes, same, now + 900_000).status == 403
  let up =
    blobs.presign_put(
      s,
      "upl-1",
      size: 4,
      mime: "video/mp4",
      sha256: sha(bytes),
      expires_seconds: 900,
      now_ms: now,
    )
  let token = token_of(up.url)
  let assert Ok(#(text, signature)) = string.split_once(token, ".")
  let assert Ok(plain) = bit_array.base64_url_decode(text)
  let assert Ok(plain) = bit_array.to_string(plain)
  let forged =
    bit_array.base64_url_encode(
      bit_array.from_string(string.replace(plain, "upl-1", "upl-2")),
      False,
    )
    <> "."
    <> signature
  let put = fn(token) {
    list.fold(
      up.headers,
      simulate.request(http.Put, "/blobs/" <> token)
        |> simulate.bit_array_body(bytes),
      fn(req, h) { request.set_header(req, h.0, h.1) },
    )
    |> blob_routes.handle(s, _, token, now)
  }
  assert put(forged).status == 403
  assert put("nonsense").status == 403
  // Another store's secret signs nothing here.
  let other = blobs.LocalDisk(dir: "build/test-blobs/other", secret: "other")
  assert blob_routes.handle(
      other,
      simulate.request(http.Put, up.url),
      token,
      now,
    ).status
    == 403
}

pub fn a_link_allows_only_its_own_method_test() {
  let s = store()
  let bytes = <<"file":utf8>>
  let up =
    blobs.presign_put(
      s,
      "upl-1",
      size: 4,
      mime: "video/mp4",
      sha256: sha(bytes),
      expires_seconds: 900,
      now_ms: now,
    )
  let get = simulate.request(http.Get, up.url)
  assert blob_routes.handle(s, get, token_of(up.url), now).status == 403
  assert blobs.put(s, "upl-1", "video/mp4", bytes, now) == Ok(Nil)
  let url = blobs.presign_get(s, "upl-1", expires_seconds: 60, now_ms: now)
  let put =
    simulate.request(http.Put, url) |> simulate.bit_array_body(<<"evil":utf8>>)
  assert blob_routes.handle(s, put, token_of(url), now).status == 403
}

pub fn a_byte_range_is_served_test() {
  let s = store()
  assert blobs.put(s, "upl-1", "video/mp4", <<"0123456789":utf8>>, now)
    == Ok(Nil)
  let r = fetch(s, "upl-1", Some("bytes=2-5"))
  assert r.status == 206
  assert response.get_header(r, "content-range") == Ok("bytes 2-5/10")
  assert r.body == wisp.File(blobs.local_path(s, "upl-1"), 2, Some(4))
  assert fetch(s, "upl-1", Some("bytes=-3")).body
    == wisp.File(blobs.local_path(s, "upl-1"), 7, Some(3))
  assert fetch(s, "upl-1", Some("bytes=8-")).body
    == wisp.File(blobs.local_path(s, "upl-1"), 8, Some(2))
  assert fetch(s, "upl-1", Some("bytes=10-")).status == 416
  // Several ranges: the whole file, as HTTP allows.
  assert fetch(s, "upl-1", Some("bytes=0-1,4-5")).status == 200
  assert fetch(s, "upl-2", None).status == 404
}

pub fn reads_ranges_and_deletes_test() {
  let s = store()
  assert blobs.put(s, "upl-1", "image/png", <<"0123456789":utf8>>, now)
    == Ok(Nil)
  assert blobs.read_range(s, "upl-1", offset: 0, length: 4, now_ms: now)
    == Ok(Some(<<"0123":utf8>>))
  assert blobs.read_range(s, "upl-1", offset: 8, length: 4, now_ms: now)
    == Ok(Some(<<"89":utf8>>))
  assert blobs.read_range(s, "upl-1", offset: 20, length: 4, now_ms: now)
    == Ok(Some(<<>>))
  assert blobs.read_range(s, "upl-2", offset: 0, length: 4, now_ms: now)
    == Ok(None)
  assert blobs.delete(s, "upl-1", now) == Ok(Nil)
  assert blobs.head(s, "upl-1", now) == Ok(None)
  assert simplifile.is_file(blobs.local_path(s, "upl-1")) == Ok(False)
  // Already gone is gone.
  assert blobs.delete(s, "upl-1", now) == Ok(Nil)
}

pub fn the_transport_admits_the_largest_upload_test() {
  assert wisp_ewe.transport_limit > blobs.max_bytes
}

fn env(pairs: List(#(String, String))) -> fn(String) -> Result(String, Nil) {
  fn(name) { list.key_find(pairs, name) }
}

pub fn storage_is_r2_with_all_four_settings_and_local_with_none_test() {
  let all = [
    #("R2_ACCOUNT_ID", "acct"),
    #("R2_BUCKET", "media"),
    #("R2_ACCESS_KEY_ID", "AKID"),
    #("R2_SECRET_ACCESS_KEY", "secret"),
  ]
  let assert Ok(blobs.R2(account_id: "acct", bucket: "media", credentials:)) =
    config.blobs_from(env(all), "data", "k")
  assert credentials.region == "auto"
  assert config.blobs_from(env([]), "data", "k")
    == Ok(blobs.LocalDisk(dir: "data/media", secret: "k"))
  let assert Error(why) = config.blobs_from(env(list.drop(all, 2)), "data", "k")
  assert string.contains(why, "missing R2_ACCOUNT_ID, R2_BUCKET.")
}
