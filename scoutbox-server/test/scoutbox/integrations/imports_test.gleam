//// The CSV import's parser and its date-of-birth reasons (imports.mjs `parseCsv`, temporal.ts `parseDobStrict`).

import scoutbox/integrations/imports
import scoutbox/platform/temporal
import scoutbox/rules/age

pub fn quoted_fields_test() {
  assert imports.parse_csv("a,b\n\"x, y\",\"say \"\"hi\"\"\"")
    == [["a", "b"], ["x, y", "say \"hi\""]]
}

/// Line ends are `\n`, `\r\n` or a lone `\r`; inside quotes they are text.
pub fn line_ends_test() {
  assert imports.parse_csv("a\r\nb\rc\n\"d\re\"")
    == [["a"], ["b"], ["c"], ["d\re"]]
}

/// A row whose cells are all empty is dropped, so the rows after it keep their numbers.
pub fn empty_rows_test() {
  assert imports.parse_csv("h1,h2\n,\n\nx,\n") == [["h1", "h2"], ["x", ""]]
  assert imports.parse_csv("") == []
}

/// A combining mark after a quote is still text after a quote, not part of it.
pub fn code_points_test() {
  assert imports.parse_csv("\"e\u{301}\",f") == [["e\u{301}", "f"]]
}

// 2026-11-19T12:00:00Z
const now = 1_795_089_600_000

pub fn dob_reasons_test() {
  let problem = fn(dob) {
    case age.parse_dob(dob, now) {
      Ok(_) -> Ok(Nil)
      Error(p) -> Error(p)
    }
  }
  assert problem("2004-03-14") == Ok(Nil)
  assert problem("20-13-99") == Error(age.DobNotADay(temporal.DayWrongShape))
  assert problem("1899-01-01")
    == Error(age.DobNotADay(temporal.DayYearOutside(1900, 2100)))
  assert problem("2004-13-01") == Error(age.DobNotADay(temporal.NoSuchMonth))
  assert problem("2004-02-00") == Error(age.DobNotADay(temporal.NoSuchDay))
  assert problem("2004-02-30")
    == Error(age.DobNotADay(temporal.NoSuchDayInMonth))
  assert problem("2026-11-20") == Error(age.InTheFuture)
  assert problem("2026-11-19") == Ok(Nil)
  assert problem("1905-01-01") == Error(age.ImplausiblyOld)
  assert age.dob_why(age.DobNotADay(temporal.DayYearOutside(1900, 2100)))
    == "year outside 1900–2100"
  assert age.dob_why(age.ImplausiblyOld) == "implausibly old"
}
