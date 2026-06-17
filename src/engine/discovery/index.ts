// Public surface of the daemon's PR-discovery module (issue #125).
//
// Consumers import:
//   - `discoverOpenPrs` for a single-pass sweep across enabled repos
//   - `startDiscoveryLoop` for the long-running poll on the configured cadence
//   - the discovery types (`DiscoveredPr`, `PrReadTransport`, etc.)
export { discoverOpenPrs } from "./discover";
export {
  startDiscoveryLoop,
  type DiscoveryHandle,
  type StartDiscoveryLoopOptions,
} from "./loop";
export type {
  DiscoveredPr,
  DiscoveryError,
  DiscoverySweep,
  PrReadTransport,
} from "./types";
