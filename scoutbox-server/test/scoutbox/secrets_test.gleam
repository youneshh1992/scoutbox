import gleam/list
import gleam/string
import scoutbox/platform/secrets

pub fn a_one_time_code_is_drawn_from_the_code_alphabet_test() {
  let alphabet = string.to_graphemes("ABCDEFGHJKMNPQRSTUVWXYZ23456789")
  list.repeat(Nil, 200)
  |> list.each(fn(_) {
    let code = secrets.random_code(6)
    assert string.length(code) == 6
    assert list.all(string.to_graphemes(code), list.contains(alphabet, _))
  })
}

pub fn a_code_is_stored_by_its_normalised_hash_test() {
  assert secrets.code_hash(" j5vfme ") == secrets.code_hash("J5VFME")
  // sha256("J5VFME"), as the TypeScript server's hashCode stores it.
  assert secrets.code_hash("J5VFME") == secrets.sha256_hex("J5VFME")
  assert string.length(secrets.code_hash("x")) == 64
}
