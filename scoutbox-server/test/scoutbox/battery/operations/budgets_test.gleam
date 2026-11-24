//// Checks of the rules from the rules suites of operations/clubOperations, first generated from the TypeScript
//// server's
//// scripts/rules/ (one test per recorded call). They are ordinary tests now: change them with the rule.

import gleam/json
import gleam/option.{None, Some}
import scoutbox/battery/base
import scoutbox/recruitment/budgets
import scoutbox/rows/case_budget_fx_assumptions
import scoutbox/rows/case_budget_lines
import scoutbox/rows/id
import scoutbox/vocab/currency

// clubOperations: convertMinor — convertMinor: 1000.00 @ 1.1732 = 1173.20 (integer math)
pub fn convertminor_1000_00_1_1732_1173_20_integer_math_test() {
  assert budgets.convert_minor(100_000, "1.1732") == Ok(117_320)
}

// clubOperations: convertMinor — convertMinor rounds half-up
pub fn convertminor_rounds_half_up_test() {
  assert budgets.convert_minor(1, "0.5") == Ok(1)
}

// clubOperations: convertMinor — convertMinor: 3.33 @ 0.3 = 1.00 (99.9 → 100 half-up)
pub fn convertminor_3_33_0_3_1_00_99_9_100_half_up_test() {
  assert budgets.convert_minor(333, "0.3") == Ok(100)
}

// clubOperations: convertMinor — convertMinor refuses a malformed rate
pub fn convertminor_refuses_a_malformed_rate_test() {
  assert budgets.convert_minor(1000, "not-a-rate") == Error(Nil)
}

// clubOperations: computeScenarioTotals — weekly wage over 12 months = 52 occurrences (integer)
pub fn weekly_wage_over_12_months_52_occurrences_integer_test() {
  assert json.to_string(
      budgets.totals_json(
        budgets.totals(
          term_months: 12,
          currency: currency.GBP,
          lines: [
            case_budget_lines.Row(
              ..base.budget_line(),
              id: id.budget_line("w"),
              kind: case_budget_lines.Wage,
              label: "wage",
              amount_minor: 50_000,
              currency: currency.GBP,
              schedule: case_budget_lines.Weekly,
              confirmed: True,
              conditional_assumption: None,
            ),
            case_budget_lines.Row(
              ..base.budget_line(),
              id: id.budget_line("f"),
              kind: case_budget_lines.Fee,
              label: "fee",
              amount_minor: 1_000_000,
              currency: currency.GBP,
              schedule: case_budget_lines.OneOff,
              confirmed: False,
              conditional_assumption: None,
            ),
            case_budget_lines.Row(
              ..base.budget_line(),
              id: id.budget_line("b"),
              kind: case_budget_lines.Bonus,
              label: "promotion bonus",
              amount_minor: 2_000_000,
              currency: currency.GBP,
              schedule: case_budget_lines.OneOff,
              confirmed: False,
              conditional_assumption: Some("only if promoted"),
            ),
          ],
          fx: [],
        ),
      ),
    )
    == "{\"termMonths\":12,\"perCurrency\":{\"GBP\":{\"confirmedMinor\":2600000,\"estimatedMinor\":1000000,\"conditionalCount\":1}},\"combined\":{\"currency\":\"GBP\",\"confirmedMinor\":2600000,\"estimatedMinor\":1000000,\"conditionalCount\":1,\"viaFx\":false},\"conditionalLines\":[{\"label\":\"promotion bonus\",\"amountMinor\":2000000,\"currency\":\"GBP\",\"schedule\":\"one_off\",\"assumption\":\"only if promoted\"}],\"conditionalNote\":\"Conditional amounts are listed with their assumptions and EXCLUDED from every total.\"}"
}

// clubOperations: computeScenarioTotals — annual line over 18 months = 2 occurrences (ceil)
pub fn annual_line_over_18_months_2_occurrences_ceil_test() {
  assert json.to_string(
      budgets.totals_json(
        budgets.totals(
          term_months: 18,
          currency: currency.GBP,
          lines: [
            case_budget_lines.Row(
              ..base.budget_line(),
              id: id.budget_line("a"),
              kind: case_budget_lines.Wage,
              label: "x",
              amount_minor: 100,
              currency: currency.GBP,
              schedule: case_budget_lines.Annual,
              confirmed: True,
              conditional_assumption: None,
            ),
          ],
          fx: [],
        ),
      ),
    )
    == "{\"termMonths\":18,\"perCurrency\":{\"GBP\":{\"confirmedMinor\":200,\"estimatedMinor\":0,\"conditionalCount\":0}},\"combined\":{\"currency\":\"GBP\",\"confirmedMinor\":200,\"estimatedMinor\":0,\"conditionalCount\":0,\"viaFx\":false},\"conditionalLines\":[],\"conditionalNote\":\"Conditional amounts are listed with their assumptions and EXCLUDED from every total.\"}"
}

// clubOperations: computeScenarioTotals — mixed currencies WITHOUT a stated rate: combined total honestly unavailable
pub fn mixed_currencies_without_a_stated_rate_combined_total_honestly_unavailab_test() {
  assert json.to_string(
      budgets.totals_json(
        budgets.totals(
          term_months: 12,
          currency: currency.GBP,
          lines: [
            case_budget_lines.Row(
              ..base.budget_line(),
              id: id.budget_line("w"),
              kind: case_budget_lines.Wage,
              label: "wage",
              amount_minor: 50_000,
              currency: currency.GBP,
              schedule: case_budget_lines.Weekly,
              confirmed: True,
              conditional_assumption: None,
            ),
            case_budget_lines.Row(
              ..base.budget_line(),
              id: id.budget_line("e"),
              kind: case_budget_lines.Fee,
              label: "eur fee",
              amount_minor: 500_000,
              currency: currency.EUR,
              schedule: case_budget_lines.OneOff,
              confirmed: True,
              conditional_assumption: None,
            ),
          ],
          fx: [],
        ),
      ),
    )
    == "{\"termMonths\":12,\"perCurrency\":{\"GBP\":{\"confirmedMinor\":2600000,\"estimatedMinor\":0,\"conditionalCount\":0},\"EUR\":{\"confirmedMinor\":500000,\"estimatedMinor\":0,\"conditionalCount\":0}},\"combined\":{\"unavailable\":true,\"reason\":\"Currencies mixed without a stated exchange-rate assumption for each — totals stay per-currency.\"},\"conditionalLines\":[],\"conditionalNote\":\"Conditional amounts are listed with their assumptions and EXCLUDED from every total.\"}"
}

// clubOperations: computeScenarioTotals — mixed currencies WITH a labelled manual rate combine correctly
pub fn mixed_currencies_with_a_labelled_manual_rate_combine_correctly_test() {
  assert json.to_string(
      budgets.totals_json(
        budgets.totals(
          term_months: 12,
          currency: currency.GBP,
          lines: [
            case_budget_lines.Row(
              ..base.budget_line(),
              id: id.budget_line("w"),
              kind: case_budget_lines.Wage,
              label: "wage",
              amount_minor: 50_000,
              currency: currency.GBP,
              schedule: case_budget_lines.Weekly,
              confirmed: True,
              conditional_assumption: None,
            ),
            case_budget_lines.Row(
              ..base.budget_line(),
              id: id.budget_line("e"),
              kind: case_budget_lines.Fee,
              label: "eur fee",
              amount_minor: 500_000,
              currency: currency.EUR,
              schedule: case_budget_lines.OneOff,
              confirmed: True,
              conditional_assumption: None,
            ),
          ],
          fx: [
            case_budget_fx_assumptions.Row(
              ..base.budget_fx(),
              from_currency: currency.EUR,
              to_currency: currency.GBP,
              rate: "0.85",
              source: Some("manual"),
              date: "2026-09-01",
              manual: True,
            ),
          ],
        ),
      ),
    )
    == "{\"termMonths\":12,\"perCurrency\":{\"GBP\":{\"confirmedMinor\":2600000,\"estimatedMinor\":0,\"conditionalCount\":0},\"EUR\":{\"confirmedMinor\":500000,\"estimatedMinor\":0,\"conditionalCount\":0}},\"combined\":{\"currency\":\"GBP\",\"confirmedMinor\":3025000,\"estimatedMinor\":0,\"viaFx\":true,\"fxApplied\":[{\"from\":\"EUR\",\"to\":\"GBP\",\"rate\":\"0.85\",\"source\":\"manual\",\"date\":\"2026-09-01\",\"manual\":true}],\"fxNote\":\"Converted with the stated manual assumptions — not market rates.\"},\"conditionalLines\":[],\"conditionalNote\":\"Conditional amounts are listed with their assumptions and EXCLUDED from every total.\"}"
}
