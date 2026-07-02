// Step advance-on-completion (#284): evaluate a completed step's routing and
// create the next step (or finish the run). The first half of the workflow
// execution loop; the dispatch half (queued → runner → advance) is #284 part 2.
export {
  advanceCompletedStep,
  type AdvanceDeps,
  type AdvanceResult,
} from "./advance";
