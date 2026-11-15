import gleam/time/timestamp

/// Milliseconds since the Unix epoch: the unit every stored instant uses.
pub fn now_ms() -> Int {
  let #(seconds, nanoseconds) =
    timestamp.system_time() |> timestamp.to_unix_seconds_and_nanoseconds
  seconds * 1000 + nanoseconds / 1_000_000
}
