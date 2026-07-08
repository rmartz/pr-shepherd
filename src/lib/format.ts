// Human-readable duration: sub-second in ms, under a minute with one decimal
// second, otherwise `Nm Ns`. Shared by the run/step views (#306, #307).
export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms).toString()}ms`;
  const seconds = ms / 1000;
  const totalSeconds = Math.round(seconds);
  if (totalSeconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes.toString()}m ${(totalSeconds % 60).toString()}s`;
}
