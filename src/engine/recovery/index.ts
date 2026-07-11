// Crash recovery: on startup, reconcile steps left `running` by a daemon that
// died mid-tick. Public interface for the recovery vertical.
export {
  CRASH_RECOVERY_HEARTBEAT_WINDOW_MS,
  CRASH_RECOVERY_ORPHAN_RUN_ERROR,
  recoverFromCrash,
  type CrashRecoveryReport,
  type RunningStepWarning,
} from "./startup";
