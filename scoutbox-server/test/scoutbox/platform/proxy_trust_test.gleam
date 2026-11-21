//// SCOUTBOX_TRUST_PROXY and the client address agree with the TypeScript server on every case in
//// test/fixtures/proxy_cases.json (written by `node dev/proxy_cases.mjs` from httpTrust.mjs and Express's own
//// proxy-addr): each setting's state and capability note, and the address each request settles on.

import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/option.{type Option}
import gleam/string
import scoutbox/platform/config
import scoutbox/platform/proxy_trust
import simplifile

type Setting {
  Setting(raw: Option(String), state: String, note: String)
}

type Request {
  Request(
    raw: Option(String),
    socket: String,
    forwarded: Option(String),
    client: String,
  )
}

fn cases() -> #(List(Setting), List(Request)) {
  let assert Ok(text) = simplifile.read("test/fixtures/proxy_cases.json")
  let assert Ok(cases) =
    json.parse(text, {
      use settings <- decode.field(
        "settings",
        decode.list({
          use raw <- decode.field("raw", decode.optional(decode.string))
          use state <- decode.field("state", decode.string)
          use note <- decode.field("note", decode.string)
          decode.success(Setting(raw:, state:, note:))
        }),
      )
      use requests <- decode.field(
        "requests",
        decode.list({
          use raw <- decode.field("raw", decode.optional(decode.string))
          use socket <- decode.field("socket", decode.string)
          use forwarded <- decode.field(
            "forwarded",
            decode.optional(decode.string),
          )
          use client <- decode.field("client", decode.string)
          decode.success(Request(raw:, socket:, forwarded:, client:))
        }),
      )
      decode.success(#(settings, requests))
    })
  cases
}

fn setting(raw: Option(String)) -> Result(String, Nil) {
  option.to_result(raw, Nil)
}

pub fn every_setting_reads_as_the_typescript_server_reads_it_test() {
  let #(settings, _) = cases()
  let wrong =
    list.filter(settings, fn(c) {
      let parsed = proxy_trust.parse(setting(c.raw))
      proxy_trust.state_text(parsed.state) != c.state || parsed.note != c.note
    })
  assert list.map(wrong, fn(c) { c.raw }) == []
  assert list.length(settings) > 40
}

pub fn every_request_settles_on_the_client_address_express_does_test() {
  let #(_, requests) = cases()
  let wrong =
    list.filter_map(requests, fn(c) {
      let trust = proxy_trust.parse(setting(c.raw)).trust
      let forwarded = option.values([c.forwarded])
      let client = proxy_trust.client_address(trust, c.socket, forwarded)
      case client == c.client {
        True -> Error(Nil)
        False ->
          Ok(string.inspect(#(c.raw, c.socket, c.forwarded, c.client, client)))
      }
    })
  assert list.take(wrong, 10) == []
  assert list.length(requests) > 6000
}

/// Several X-Forwarded-For headers read as one, joined in the order received, as Node joins them.
pub fn repeated_headers_are_one_chain_test() {
  let trust = proxy_trust.parse(Ok("2")).trust
  assert proxy_trust.client_address(trust, "127.0.0.1", [
      "198.51.100.9",
      "203.0.113.7",
    ])
    == "198.51.100.9"
  assert proxy_trust.client_address(trust, "127.0.0.1", [
      "198.51.100.9, 203.0.113.7",
    ])
    == "198.51.100.9"
}

pub fn an_unreadable_setting_is_fatal_in_production_only_test() {
  let env = fn(pairs) { fn(name) { list.key_find(pairs, name) } }
  let production = [
    #("NODE_ENV", "production"),
    #("MEDIA_SECRET", "synthetic-media-secret-0123456789abcdef"),
    #("ADMIN_KEY", "a-long-production-admin-key-0123"),
  ]
  let codes = fn(pairs) {
    config.problems(env(pairs), 100) |> list.map(fn(p) { p.code })
  }
  assert codes([#("SCOUTBOX_TRUST_PROXY", "fly"), ..production])
    == ["TRUST_PROXY_INVALID"]
  assert config.problems(
      env([#("SCOUTBOX_TRUST_PROXY", " fly "), ..production]),
      100,
    )
    |> list.map(fn(p) { p.message })
    == [
      "SCOUTBOX_TRUST_PROXY=\" fly \" is not a hop count, true/false, or a list of addresses and subnets.",
    ]
  assert codes([#("SCOUTBOX_TRUST_PROXY", "fly")]) == []
  assert codes([#("SCOUTBOX_TRUST_PROXY", "loopback, 10.0.0.0/8"), ..production])
    == []
  assert codes(production) == []
}
