// Public surface of the daemon's run-enrollment module (issue #126).
//
// Consumers import:
//   - `matchWorkflowId` to resolve a PR author to a workflow id via the repo's
//     ordered workflowMap
//   - `enrollPr` to idempotently create a run + first step from a loaded
//     workflow definition
//   - `enrollDiscovered` to wire the discovery sweep's `onDiscovered` hook to
//     match-then-enroll, reused by the self-discovery path (#108)
export { matchWorkflowId } from "./match";
export { enrollPr, type EnrollOptions, type EnrollResult } from "./enroll";
export {
  enrollDiscovered,
  SkipReason,
  type EnrolledPr,
  type EnrollDiscoveredOptions,
  type EnrollmentReport,
  type SkippedPr,
  type WorkflowResolver,
} from "./enrollDiscovered";
