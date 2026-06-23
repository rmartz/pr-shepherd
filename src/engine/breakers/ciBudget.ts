// ---------------------------------------------------------------------------
// CI-budget circuit breaker (issue #107).
//
// When a majority of the most recent `main` runs end in `startup_failure`, the
// runner can't pick up jobs — a billing/quota limit, not a code problem. There
// is no point dispatching expensive skill work whose CI can never validate it,
// so this breaker halts that dispatch queue-wide. A PR whose HEAD already
// passed CI needs no further CI and may still proceed.
//
// Once tripped it latches open for the rest of the process: a billing limit
// won't clear mid-run, and re-evaluating each tick would flap. Recovery is a
// fresh daemon start once the cause clears.
// ---------------------------------------------------------------------------

const STARTUP_FAILURE = "startup_failure";

// True when a strict majority of the given recent `main` run conclusions are
// `startup_failure`. Empty input is never exhausted.
export function isCiBudgetExhausted(conclusions: readonly string[]): boolean {
  if (conclusions.length === 0) return false;
  const startupFailures = conclusions.filter(
    (conclusion) => conclusion === STARTUP_FAILURE,
  ).length;
  return startupFailures * 2 > conclusions.length;
}

export interface CiBudgetBreaker {
  // Feed the most recent `main` run conclusions; trips (and latches) the
  // breaker if they show exhaustion.
  observe: (conclusions: readonly string[]) => void;
  isOpen: () => boolean;
  // When open, only a PR whose HEAD already passed CI may proceed; all other
  // (CI-requiring) dispatch is halted. When closed, everything proceeds.
  allowsDispatch: (prCiAlreadyPassed: boolean) => boolean;
}

// One breaker per daemon process. Latches open permanently once exhaustion is
// observed.
export function createCiBudgetBreaker(): CiBudgetBreaker {
  let open = false;
  return {
    observe: (conclusions) => {
      if (isCiBudgetExhausted(conclusions)) open = true;
    },
    isOpen: () => open,
    allowsDispatch: (prCiAlreadyPassed) => !open || prCiAlreadyPassed,
  };
}
