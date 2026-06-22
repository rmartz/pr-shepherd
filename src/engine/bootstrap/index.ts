// Public surface of the daemon's engine-bootstrap module (issue #207).
//
// Consumers import:
//   - `bootstrapEngine` — the `shepherd start` boot sequence that wires the
//     merged building blocks into a running headless daemon
//   - `createDiskWorkflowResolver` — the production `workflows/<id>.yaml`
//     resolver the bootstrap feeds to self-discovery
//   - the bootstrap contract types (`BootstrapOptions`, `BootstrapDeps`,
//     `DaemonHandle`)
export { bootstrapEngine } from "./bootstrap";
export { createDiskWorkflowResolver } from "./resolveWorkflow";
export type {
  BootstrapDeps,
  BootstrapOptions,
  DaemonHandle,
  PrReadTransport,
  WorkflowResolver,
} from "./types";
