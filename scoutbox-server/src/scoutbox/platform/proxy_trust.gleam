//// Which reverse proxies' `X-Forwarded-For` to believe (SCOUTBOX_TRUST_PROXY), and the client address that follows.
////
//// Every per-address control (the /auth limiter, the share-link and pairing budgets) keys on the client address.
//// Trusting nothing behind a platform proxy would make every client share the proxy's address; trusting the header
//// blindly would let a client talking to the server directly choose its own. The setting is read as the
//// TypeScript server's `parseTrustProxy` reads it (httpTrust.mjs), and the address is worked out as Express's
//// `trust proxy` works it out (e2e/support/CONTRACT.md, "The client address").

import gleam/bit_array
import gleam/int
import gleam/json
import gleam/list
import gleam/result
import gleam/string

pub type Trust {
  /// The socket's address is the client address; `X-Forwarded-For` is ignored.
  NoProxy
  /// Every hop is trusted: the leftmost forwarded address is the client's.
  EveryHop
  /// That many proxy hops in front of the server.
  Hops(Int)
  /// Proxies at these addresses and subnets.
  Proxies(List(Subnet))
}

/// An address and how many of its leading bits a match must share.
pub opaque type Subnet {
  Subnet(address: Address, bits: Int)
}

type Address {
  V4(BitArray)
  V6(BitArray)
}

pub type State {
  NotConfigured
  Configured
  Invalid
}

/// The parsed setting, with how the capability report describes it.
pub type Setting {
  Setting(trust: Trust, state: State, note: String)
}

pub fn state_text(state: State) -> String {
  case state {
    NotConfigured -> "not_configured"
    Configured -> "configured"
    Invalid -> "invalid"
  }
}

pub fn parse(setting: Result(String, Nil)) -> Setting {
  let value = setting |> result.unwrap("") |> string.trim
  let lower = string.lowercase(value)
  let none = value == "" || list.contains(["0", "false", "off", "no"], lower)
  let all = lower == "true" || lower == "all"
  case none, all, digits(value) {
    True, _, _ ->
      Setting(
        NoProxy,
        NotConfigured,
        "No reverse proxy is trusted; the connecting socket address is the client address. Behind a platform proxy every client would share the proxy's address and per-IP limits would apply to everyone at once.",
      )
    _, True, _ ->
      Setting(
        EveryHop,
        Configured,
        "Every X-Forwarded-For hop is trusted. The client address is spoofable unless the proxy in front of this server strips the inbound header.",
      )
    _, _, Ok(hops) -> {
      let #(noun, verb) = case hops {
        1 -> #("hop", "is")
        _ -> #("hops", "are")
      }
      Setting(
        Hops(hops),
        Configured,
        int.to_string(hops)
          <> " proxy "
          <> noun
          <> " in front of the server "
          <> verb
          <> " trusted; the client address is read from X-Forwarded-For.",
      )
    }
    _, _, Error(Nil) -> {
      let entries =
        string.split(value, ",")
        |> list.map(string.trim)
        |> list.filter(fn(e) { e != "" })
      case entries, list.try_map(entries, entry) {
        [_, ..], Ok(subnets) -> {
          let listed = string.join(entries, ", ")
          Setting(
            Proxies(list.flatten(subnets)),
            Configured,
            "Proxies at "
              <> listed
              <> " are trusted; the client address is read from X-Forwarded-For.",
          )
        }
        _, _ ->
          Setting(
            NoProxy,
            Invalid,
            "SCOUTBOX_TRUST_PROXY="
              <> json.to_string(json.string(value))
              <> " is not a hop count, true/false, or a list of addresses and subnets. Nothing is trusted.",
          )
      }
    }
  }
}

/// The client address of a request that came from `socket` and carries `forwarded`, the values of every
/// `X-Forwarded-For` header in the order received.
///
/// The socket's address, then the forwarded entries from right to left, are walked while each is trusted; the
/// client address is where the walk stops, or the last entry when every one before it was trusted.
pub fn client_address(
  trust: Trust,
  socket: String,
  forwarded: List(String),
) -> String {
  let chain = [socket, ..list.reverse(entries(string.join(forwarded, ",")))]
  walk(chain, 0, trust)
}

fn walk(chain: List(String), index: Int, trust: Trust) -> String {
  case chain {
    [] -> ""
    [last] -> last
    [address, ..rest] ->
      case trusted(trust, address, index) {
        True -> walk(rest, index + 1, trust)
        False -> address
      }
  }
}

fn trusted(trust: Trust, address: String, index: Int) -> Bool {
  case trust {
    NoProxy -> False
    EveryHop -> True
    Hops(n) -> index < n
    Proxies(subnets) ->
      case parse_address(address) {
        Error(Nil) -> False
        Ok(a) -> list.any(subnets, matches(_, a))
      }
  }
}

/// The forwarded entries, left to right, as the `forwarded` package splits them: on commas, with spaces trimmed
/// from each end and empty entries dropped.
fn entries(header: String) -> List(String) {
  string.split(header, ",")
  |> list.map(trim_spaces)
  |> list.filter(fn(e) { e != "" })
}

fn trim_spaces(text: String) -> String {
  case text {
    " " <> rest -> trim_spaces(rest)
    _ ->
      case string.ends_with(text, " ") {
        True -> trim_spaces(string.drop_end(text, 1))
        False -> text
      }
  }
}

/// An IPv4-mapped IPv6 address matches an IPv4 subnet as its IPv4 address, and an IPv4 address an IPv6 subnet as
/// its mapped form, as proxy-addr matches them.
fn matches(subnet: Subnet, address: Address) -> Bool {
  case subnet.address, address {
    V4(s), V4(a) | V6(s), V6(a) -> same_prefix(s, a, subnet.bits)
    V4(s), V6(a) ->
      case a {
        <<0:80, 0xffff:16, v4:bits-size(32)>> -> same_prefix(s, v4, subnet.bits)
        _ -> False
      }
    V6(s), V4(a) -> same_prefix(s, <<0:80, 0xffff:16, a:bits>>, subnet.bits)
  }
}

fn same_prefix(a: BitArray, b: BitArray, bits: Int) -> Bool {
  case a, b {
    <<x:bits-size(bits), _:bits>>, <<y:bits-size(bits), _:bits>> -> x == y
    _, _ -> False
  }
}

// ------------------------------------------------------------------ the setting's entries

const ranges = [
  #("linklocal", ["169.254.0.0/16", "fe80::/10"]),
  #("loopback", ["127.0.0.1/8", "::1/128"]),
  #("uniquelocal", ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"]),
]

/// One entry of the list: a named range, an address, or an address with a prefix length (at least 1: proxy-addr
/// refuses `/0`).
fn entry(text: String) -> Result(List(Subnet), Nil) {
  case list.key_find(ranges, text) {
    Ok(named) -> list.try_map(named, entry) |> result.map(list.flatten)
    Error(Nil) ->
      case string.split(text, "/") {
        [address] -> {
          use a <- result.map(parse_address(address))
          // A bare IPv4-mapped address is stored as its IPv4 address, as proxy-addr stores it.
          let a = case a {
            V6(<<0:80, 0xffff:16, v4:bits-size(32)>>) -> V4(v4)
            _ -> a
          }
          [Subnet(a, width(a))]
        }
        [address, prefix] -> {
          use a <- result.try(parse_address(address))
          use bits <- result.try(digits(prefix))
          case string.length(prefix) <= 3 && bits >= 1 && bits <= width(a) {
            True -> Ok([Subnet(a, bits)])
            False -> Error(Nil)
          }
        }
        _ -> Error(Nil)
      }
  }
}

fn width(address: Address) -> Int {
  case address {
    V4(_) -> 32
    V6(_) -> 128
  }
}

// ------------------------------------------------------------------ addresses, as Node's net.isIP reads them

fn parse_address(text: String) -> Result(Address, Nil) {
  case parse_v4(text) {
    Ok(bytes) -> Ok(V4(bytes))
    Error(Nil) -> parse_v6(text) |> result.map(V6)
  }
}

/// Four decimal parts from 0 to 255, with no leading zeros.
fn parse_v4(text: String) -> Result(BitArray, Nil) {
  case string.split(text, ".") {
    [_, _, _, _] as parts ->
      list.try_map(parts, fn(part) {
        use n <- result.try(digits(part))
        case n <= 255 && { part == "0" || !string.starts_with(part, "0") } {
          True -> Ok(<<n:8>>)
          False -> Error(Nil)
        }
      })
      |> result.map(bit_array.concat)
    _ -> Error(Nil)
  }
}

/// Eight groups of one to four hex digits, at most one `::` standing for one or more zero groups, an IPv4 address
/// as the last two groups, and a zone (`%eth0`), which is dropped.
fn parse_v6(text: String) -> Result(BitArray, Nil) {
  use text <- result.try(case string.split_once(text, "%") {
    Error(Nil) -> Ok(text)
    Ok(#(address, zone)) ->
      case zone != "" && string.to_graphemes(zone) |> list.all(zone_char) {
        True -> Ok(address)
        False -> Error(Nil)
      }
  })
  case string.split(text, "::") {
    [whole] -> {
      use groups <- result.try(v6_groups(whole, True))
      case list.length(groups) == 8 {
        True -> Ok(bit_array.concat(groups))
        False -> Error(Nil)
      }
    }
    [left, right] -> {
      use head <- result.try(case left {
        "" -> Ok([])
        _ -> v6_groups(left, False)
      })
      use tail <- result.try(case right {
        "" -> Ok([])
        _ -> v6_groups(right, True)
      })
      let missing = 8 - list.length(head) - list.length(tail)
      case missing >= 1 {
        True ->
          Ok(
            bit_array.concat(
              list.flatten([head, list.repeat(<<0:16>>, missing), tail]),
            ),
          )
        False -> Error(Nil)
      }
    }
    _ -> Error(Nil)
  }
}

/// Colon-separated groups, each 16 bits; when `last`, the final group may be an IPv4 address (two groups).
fn v6_groups(text: String, last: Bool) -> Result(List(BitArray), Nil) {
  let parts = string.split(text, ":")
  let count = list.length(parts)
  list.index_map(parts, fn(part, i) {
    case last && i == count - 1 && string.contains(part, ".") {
      True ->
        parse_v4(part)
        |> result.map(fn(b) {
          let assert <<x:16, y:16>> = b
          [<<x:16>>, <<y:16>>]
        })
      False -> hex_group(part) |> result.map(fn(g) { [g] })
    }
  })
  |> result.all
  |> result.map(list.flatten)
}

fn hex_group(part: String) -> Result(BitArray, Nil) {
  let length = string.length(part)
  case length >= 1 && length <= 4 && list.all(string.to_graphemes(part), hex) {
    True -> int.base_parse(part, 16) |> result.map(fn(n) { <<n:16>> })
    False -> Error(Nil)
  }
}

fn hex(c: String) -> Bool {
  string.contains("0123456789abcdefABCDEF", c)
}

fn zone_char(c: String) -> Bool {
  string.contains(
    "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-.:",
    c,
  )
}

/// A whole number written in ASCII digits only (`/^\d+$/`).
fn digits(text: String) -> Result(Int, Nil) {
  case
    text != ""
    && list.all(string.to_graphemes(text), string.contains("0123456789", _))
  {
    True -> int.parse(text)
    False -> Error(Nil)
  }
}
