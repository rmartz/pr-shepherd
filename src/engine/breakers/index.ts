// Public surface of the circuit-breakers module (issue #107).
//
// Two queue-halting safety gates: `createCiBudgetBreaker` halts expensive skill
// dispatch when CI can't validate it (budget exhausted), and `assessMainBroken`
// / `isQuarantined` quarantine all but the fix-main PR when `main` is broken.
export {
  createCiBudgetBreaker,
  isCiBudgetExhausted,
  type CiBudgetBreaker,
} from "./ciBudget";
export {
  assessMainBroken,
  isQuarantined,
  type MainBrokenAssessment,
  type MainStatus,
} from "./mainBroken";
