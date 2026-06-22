// Public surface of the daemon's self-discovery integration (issue #108).
//
// Consumers import:
//   - `runSelfDiscoveryPass` — the cohesive discover → match → enroll pass the
//     drain loop invokes upfront, mid-batch, and at end of each drain
//   - `DiscoveryPhase` — the trigger tag carried through the pass for logging
//   - the report types (`SelfDiscoveryReport`, `SelfDiscoveryPassOptions`)
export {
  runSelfDiscoveryPass,
  DiscoveryPhase,
  type SelfDiscoveryPassOptions,
  type SelfDiscoveryReport,
} from "./selfDiscover";
