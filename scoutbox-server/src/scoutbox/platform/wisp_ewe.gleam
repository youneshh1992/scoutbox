//// Runs a Wisp handler on the Ewe server.
////
//// Vendored from `wisp_ewe` in the wisp repository (github.com/gleam-wisp/wisp, `wisp_ewe/`), which is not
//// published to Hex and pins `ewe < 4`. This copy targets ewe 9, whose request body is read with
//// `read_body_chunk` (each chunk hands back the request to read the next one from) rather than a consumer.

import ewe
import exception
import gleam/http/request.{type Request}
import gleam/http/response
import gleam/list
import gleam/option
import gleam/string
import wisp
import wisp/internal

/// The header the client's address travels in, replaced on every request.
pub const peer_header = "x-scoutbox-peer"

fn peer(connection: ewe.Connection) -> String {
  case ewe.get_client_info(connection) {
    ewe.TcpSocketAddress(ip_address:, ..) ->
      ewe.ip_address_to_string(ip_address)
    ewe.UnixSocketAddress(path:) -> path
  }
}

/// The most a request body can carry at the transport. Wisp enforces its own, smaller limit per request.
const transport_limit = 32_000_000

/// A route that answers with a server-sent event stream returns an ordinary response carrying `stream_header`,
/// so the middleware treats it like any other; `stream` is then given that header's value and the response
/// (without it) and opens the stream. Wisp's body type can't carry an ewe stream.
pub fn handler(
  handler: fn(wisp.Request) -> wisp.Response,
  secret_key_base: String,
  stream_header: String,
  stream: fn(String, response.Response(Nil)) -> response.Response(ewe.Body),
) -> fn(Request(ewe.Connection)) -> response.Response(ewe.Body) {
  fn(req: Request(ewe.Connection)) {
    let connection = req.body
    // Wisp's request has no client address, so the adapter carries it in a header the client cannot set.
    let req = request.set_header(req, peer_header, peer(connection))
    let conn = internal.make_connection(reader(req), secret_key_base)
    let req = request.set_body(req, conn)
    use <- exception.defer(fn() {
      let assert Ok(_) = wisp.delete_temporary_files(req)
    })
    let resp = handler(req)
    case response.get_header(resp, stream_header) {
      Ok(marker) ->
        response.Response(
          ..resp,
          headers: list.filter(resp.headers, fn(h) { h.0 != stream_header }),
        )
        |> response.set_body(Nil)
        |> stream(marker, _)
      Error(Nil) -> to_ewe(resp, connection)
    }
  }
}

fn reader(req: Request(ewe.Connection)) -> internal.Reader {
  fn(size) {
    case
      ewe.read_body_chunk(req, max_chunk_bytes: size, limit: transport_limit)
    {
      Ok(ewe.Chunk(data:, request: next)) ->
        Ok(internal.Chunk(data, reader(next)))
      Ok(ewe.Done(_)) -> Ok(internal.ReadingFinished)
      Error(_) -> Error(Nil)
    }
  }
}

fn to_ewe(
  resp: wisp.Response,
  connection: ewe.Connection,
) -> response.Response(ewe.Body) {
  case resp.body {
    wisp.Text(text) -> response.set_body(resp, ewe.Text(text))
    wisp.Bytes(bytes) -> response.set_body(resp, ewe.Bytes(bytes))
    wisp.File(path:, offset:, limit:) ->
      case ewe.file(connection, path, offset: option.Some(offset), limit:) {
        Ok(file) -> response.set_body(resp, file)
        Error(error) -> {
          wisp.log_error(string.inspect(error))
          response.new(500) |> response.set_body(ewe.Empty)
        }
      }
  }
}
