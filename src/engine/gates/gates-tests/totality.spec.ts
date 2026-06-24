import { describe, expect, it } from "vitest";

import {
  Activity,
  DependabotRebaseState,
  type PrStateVector,
} from "../../derivation/state-vector";
import { Action, type DecideOptions, decide } from "../index";
import { AXIS_VALUES } from "./fixtures";

// Build every axis combination. Activity is included so the product proves the
// axis is genuinely never read (the result must be identical across its values).
function* allStateVectors(): Generator<PrStateVector> {
  for (const ci of AXIS_VALUES.ci) {
    for (const conflict of AXIS_VALUES.conflict) {
      for (const copilot of AXIS_VALUES.copilot) {
        for (const hold of AXIS_VALUES.hold) {
          for (const review of AXIS_VALUES.review) {
            for (const threads of AXIS_VALUES.threads) {
              for (const uat of AXIS_VALUES.uat) {
                for (const activity of AXIS_VALUES.activity) {
                  // dependabotRebase, like activity, is not a gate input —
                  // `decide()` never reads it (it feeds the rebase_dependabot
                  // action guard, not the merge gates). A fixed value keeps the
                  // product focused on the axes decide() actually consumes.
                  yield {
                    activity,
                    ci,
                    conflict,
                    copilot,
                    dependabotRebase: DependabotRebaseState.None,
                    hold,
                    review,
                    threads,
                    uat,
                  };
                }
              }
            }
          }
        }
      }
    }
  }
}

const ALL_ACTIONS = new Set<string>(Object.values(Action));
const OPTS_COMBINATIONS: DecideOptions[] = [
  {},
  { skipUat: true },
  { copilotUnavailable: true },
  { skipUat: true, copilotUnavailable: true },
];

describe("decide() is total over the full axis product", () => {
  // 165 888 evaluations. The default 5 s vitest timeout is insufficient on slow
  // CI runners (observed: 5 031–5 034 ms). 10 s gives headroom without masking
  // a genuine hang — the loop finishes in ~1.5 s locally and ~5 s on the
  // slowest observed runner.
  it("returns exactly one defined Action for every combination and never throws", () => {
    let count = 0;
    for (const state of allStateVectors()) {
      for (const opts of OPTS_COMBINATIONS) {
        const decision = decide(state, opts);
        expect(ALL_ACTIONS.has(decision.action)).toBe(true);
        expect(decision.blockingGate).toBeDefined();
        count += 1;
      }
    }
    // 6 ci × 3 conflict × 4 copilot × 6 hold × 4 review × 2 threads × 4 uat ×
    // 3 activity = 41 472 vectors × 4 opts = 165 888 evaluations.
    expect(count).toBe(165_888);
  }, 10_000);

  it("never reads the observational activity axis", () => {
    for (const ci of AXIS_VALUES.ci) {
      for (const conflict of AXIS_VALUES.conflict) {
        for (const copilot of AXIS_VALUES.copilot) {
          for (const hold of AXIS_VALUES.hold) {
            for (const review of AXIS_VALUES.review) {
              for (const threads of AXIS_VALUES.threads) {
                for (const uat of AXIS_VALUES.uat) {
                  const base = {
                    ci,
                    conflict,
                    copilot,
                    dependabotRebase: DependabotRebaseState.None,
                    hold,
                    review,
                    threads,
                    uat,
                  };
                  const active = decide({ ...base, activity: Activity.Active });
                  const idle = decide({ ...base, activity: Activity.Idle });
                  expect(active).toEqual(idle);
                }
              }
            }
          }
        }
      }
    }
  });
});
