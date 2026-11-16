import gleam/json
import gleam/string
import gleeunit/should
import scoutbox/media/links

const key = "test-key"

const now = 1_000_000

fn signed(body: json.Json) -> String {
  links.sign_body(key, json.to_string(body), "sid1", now)
}

pub fn a_media_value_is_signed_for_the_session_test() {
  let out = signed(json.object([#("url", json.string("/media/m-1"))]))
  let assert "{\"url\":\"/media/m-1?e=1900000&s=" <> rest = out
  let assert [sig, "sid1\"}"] = string.split(rest, "&v=")
  string.length(sig) |> should.equal(24)
}

pub fn values_in_arrays_and_every_position_are_signed_test() {
  let out =
    signed(
      json.object([
        #("a", json.array(["/media/x", "/media/y"], json.string)),
        #("b", json.string("/media/z")),
      ]),
    )
  string.split(out, "?e=") |> should.not_equal([out])
  { string.split(out, "&v=sid1") |> list_length } |> should.equal(4)
}

pub fn a_key_or_a_longer_text_stays_as_it_is_test() {
  let body =
    json.object([
      #("/media/key", json.string("text")),
      #("note", json.string("see /media/m-1")),
      #("deeper", json.string("/media/m-1/frame")),
      #("quoted", json.string("a:\"/media/m-1\"")),
      #("query", json.string("/media/m-1?x=1")),
    ])
  signed(body) |> should.equal(json.to_string(body))
}

pub fn the_signature_depends_on_the_session_test() {
  let body = json.to_string(json.object([#("u", json.string("/media/m"))]))
  links.sign_body(key, body, "a", now)
  |> string.replace("&v=a", "")
  |> should.not_equal(
    links.sign_body(key, body, "b", now) |> string.replace("&v=b", ""),
  )
}

fn list_length(parts: List(String)) -> Int {
  case parts {
    [] -> 0
    [_, ..rest] -> 1 + list_length(rest)
  }
}
