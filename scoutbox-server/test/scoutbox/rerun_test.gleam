import gleam/erlang/process.{type Subject}
import gleam/http as gleam_http
import gleam/http/request
import gleam/http/response
import gleam/list
import gleeunit/should
import scoutbox/platform/http
import wisp.{type Request, type Response}
import wisp/simulate

/// A handler that answers `stale` for its first `losses` runs, recording each run's body and re-run mark.
fn racing(
  runs: Subject(#(BitArray, Bool)),
  losses: Int,
) -> fn(Request) -> Response {
  fn(req) {
    let assert Ok(body) = wisp.read_body_bits(req)
    process.send(runs, #(body, http.rerun(req)))
    let seen = list.length(drain_copy(runs))
    case seen <= losses {
      True -> http.stale("test")
      False -> wisp.ok()
    }
  }
}

// The runs so far, put back so the next run counts them too.
fn drain_copy(runs: Subject(#(BitArray, Bool))) -> List(#(BitArray, Bool)) {
  let all = drain(runs, [])
  list.each(all, process.send(runs, _))
  all
}

fn drain(s: Subject(a), acc: List(a)) -> List(a) {
  case process.receive(s, 0) {
    Ok(x) -> drain(s, [x, ..acc])
    Error(Nil) -> list.reverse(acc)
  }
}

fn post(body: String) -> Request {
  simulate.request(gleam_http.Post, "/x") |> simulate.string_body(body)
}

pub fn a_lost_race_is_run_again_with_the_same_body_test() {
  let runs = process.new_subject()
  let answer = http.rerun_on_stale(post("{\"a\":1}"), racing(runs, 2))
  answer.status |> should.equal(200)
  drain(runs, [])
  |> should.equal([
    #(<<"{\"a\":1}">>, False),
    #(<<"{\"a\":1}">>, True),
    #(<<"{\"a\":1}">>, True),
  ])
}

pub fn a_client_cannot_mark_its_own_request_a_rerun_test() {
  let runs = process.new_subject()
  let req = post("{}") |> request.set_header("x-scoutbox-rerun", "1")
  let _ = http.rerun_on_stale(req, racing(runs, 0))
  drain(runs, []) |> should.equal([#(<<"{}">>, False)])
}

pub fn a_route_that_keeps_losing_gives_up_with_a_plain_500_test() {
  let runs = process.new_subject()
  let answer = http.rerun_on_stale(post("{}"), racing(runs, 1000))
  answer.status |> should.equal(500)
  response.get_header(answer, "x-scoutbox-stale") |> should.equal(Error(Nil))
  list.length(drain(runs, [])) |> should.equal(5)
}
