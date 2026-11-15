import gleeunit
import simplifile

pub fn main() -> Nil {
  // Each test opens its own database under build/test-dbs; the previous run's go first.
  let _ = simplifile.delete("build/test-dbs")
  gleeunit.main()
}
