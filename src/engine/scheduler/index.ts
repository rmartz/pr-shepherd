// Public surface of the scheduler module.
//
// `runSchedulerTick` (loop.ts) is the single-pass admission unit;
// `startScheduler` (eventScheduler.ts) is the long-running, event-driven
// daemon wrapper around it with a reconciliation-poll safety net (#120).
export {
  runSchedulerTick,
  type AdmittedStep,
  type RejectedStep,
  type SchedulerConfig,
  type SchedulerTickReport,
} from "./loop";
export {
  pendingStepInstancesTrigger,
  startScheduler,
  type SchedulerHandle,
  type SchedulerTimers,
  type StartSchedulerOptions,
  type TriggerSubscription,
} from "./eventScheduler";
export {
  canAdmitStep,
  countsAgainstRepo,
  AdmissionRejectReason,
  type ActiveCounts,
  type AdmissionDecision,
  type ConcurrencyConfig,
} from "./concurrency";
