import type { OperatingShift } from './fleet-operations';

export const REPRESENTATIVE_DAY_MINUTES = 1440;

/** Expand calendar windows to cover any overnight shift in this representative day. */
export function representativeDayIntervals(
  windows: OperatingShift[],
  finalDay = 1,
): OperatingShift[] {
  const offsets = Array.from(
    { length: finalDay + 2 },
    (_, day) => (day - 1) * REPRESENTATIVE_DAY_MINUTES,
  );
  const sorted = offsets
    .flatMap((offset) =>
      windows.map((window) => ({
        startMinute: window.startMinute + offset,
        endMinute: window.endMinute + offset,
      })),
    )
    .sort((a, b) => a.startMinute - b.startMinute);
  const intervals: OperatingShift[] = [];
  for (const window of sorted) {
    const previous = intervals.at(-1);
    if (previous && window.startMinute <= previous.endMinute)
      previous.endMinute = Math.max(previous.endMinute, window.endMinute);
    else intervals.push(window);
  }
  return intervals;
}
