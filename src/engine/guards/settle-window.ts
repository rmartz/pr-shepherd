// ---------------------------------------------------------------------------
// Settle windows after label-writing actions (Epic 10, #101).
//
// GitHub's label/state writes are eventually consistent: after a label-writing
// action (e.g. `/review` applying a verdict label), an immediate re-read can
// still show the old labels for ~1–2 s (design doc §6, §7). Without a guard,
// that lag is misread as "the action changed nothing" — which the same-action
// loop detector then treats as a failure to make progress.
//
// The settle window is a **one-shot** recheck: when an action reports it wrote
// something but the very next observation is unchanged, the guard says "settle"
// (wait briefly, then re-derive once) rather than concluding immediately. If the
// re-read after settling is *still* unchanged, the one shot is spent and the
// guard concludes — so a genuine no-op action is not retried forever.
//
// Pure by construction: the caller passes the before/after observation
// signatures and whether the one settle has already been spent. This function
// reads no clock and does no I/O; the actual sleep is the executor's job.
// ---------------------------------------------------------------------------

// The verdict the settle guard yields after a label-writing action.
export enum SettleVerdict {
  // The observation already changed — the write is visible; conclude normally.
  Changed = "changed",
  // The observation is unchanged but a settle has not been spent — wait once and
  // re-derive before concluding, to absorb eventual-consistency lag.
  Settle = "settle",
  // The observation is unchanged and the one-shot settle is already spent — the
  // action genuinely changed nothing; conclude.
  Unchanged = "unchanged",
}

// The inputs the settle guard decides on. `before`/`after` are opaque signatures
// of the observable state the action was expected to change (e.g. the sorted
// label set serialised to a string); equality means "no change observed yet".
export interface SettleInput {
  // The observed signature before the action ran (or before the last recheck).
  before: string;
  // The observed signature after the action ran (the latest re-read).
  after: string;
  // Whether the one-shot settle/recheck has already been spent this cycle. The
  // caller flips this to true once it has waited and re-derived once.
  settleSpent: boolean;
}

// Default settle delay (ms) the executor should wait before its one recheck —
// long enough to clear GitHub's typical ~1–2 s label-propagation lag. Exposed so
// the executor and tests share one source of truth; the guard itself is pure and
// does not consume it.
export const DEFAULT_SETTLE_MS = 2000;

// Decide whether to conclude or settle after a label-writing action. A visible
// change concludes immediately; an unchanged observation settles once, then
// concludes if the recheck is still unchanged.
export function settleGuard(input: SettleInput): SettleVerdict {
  if (input.before !== input.after) {
    return SettleVerdict.Changed;
  }
  return input.settleSpent ? SettleVerdict.Unchanged : SettleVerdict.Settle;
}
