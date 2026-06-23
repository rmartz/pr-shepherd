// Public surface of the daemon's graceful-shutdown module (issue #208).
//
// `installShutdownHandlers` wires SIGTERM/SIGINT to `gracefulShutdown`, which
// halts the scheduler, drains in-flight steps within a bounded grace period,
// tears the daemon down, and exits — never hanging.
export {
  gracefulShutdown,
  installShutdownHandlers,
  type GracefulShutdownOptions,
  type GracefulShutdownResult,
} from "./shutdown";
