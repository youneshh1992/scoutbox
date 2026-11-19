//// The process's request counters, as `/admin/metrics` reports them (domains/platform/metrics.mjs).

import scoutbox/platform/request_metrics

pub fn requests_are_counted_by_status_slowness_and_first_segment_test() {
  let assert Ok(m) = request_metrics.start()
  let seen = fn(path, status, ms) {
    request_metrics.finished_request(m, path:, status:, ms:)
  }
  seen("/orgs", 200, 3)
  seen("/nope/x", 404, 1)
  seen("/player/uploads/u-1", 413, 2)
  seen("/events", 200, 501)
  seen("/", 500, 0)
  seen("/orgs/directory", 304, 500)
  request_metrics.count(m, "analytics", "recruitment_analytics_read")
  request_metrics.count(m, "analytics", "recruitment_analytics_read")
  let s = request_metrics.snapshot(m)
  assert s.requests == 6
  assert s.status_2xx == 3
  assert s.status_4xx == 2
  assert s.status_5xx == 1
  assert s.slow_requests == 1
  assert s.failed_uploads == 1
  assert s.sse_connects == 1
  // In the order each was first seen, as a JavaScript object's keys are.
  assert s.by_route
    == [
      #("/orgs", 2),
      #("/nope", 1),
      #("/player", 1),
      #("/events", 1),
      #("/", 1),
    ]
  assert request_metrics.counter(s, "analytics", "recruitment_analytics_read")
    == 2
  assert request_metrics.counter(s, "analytics", "never") == 0
}
