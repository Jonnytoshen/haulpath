import type {
  DailyTransportBest,
  DailyTransportConfig,
  DailyTransportProgress,
  DailyTransportResult,
  DailyTransportSearch,
  DailyTransportSnapshot,
} from './daily-transport';
import { generateRepeatableDay } from './repeatable-day';

export const FIXED_LAYOUT_SEARCH_VERSION = 'fixed-layout-dispatch-1';
const factorial = (size: number): bigint => {
  let count = 1n;
  for (let n = 2; n <= size; n++) count *= BigInt(n);
  return count;
};
const DEPARTURE_STEP_MINUTES = 15;
function dispatches(snapshot: DailyTransportSnapshot) {
  return snapshot.context.operations!.vehicleGroups.flatMap((group) => {
    const shift = [...group.shifts].sort((a, b) => a.startMinute - b.startMinute)[0];
    return group.vehicleIds.slice(0, group.count).map((vehicleId) => ({
      vehicleId,
      startMinute: shift.startMinute,
      count: BigInt(Math.floor((shift.endMinute - shift.startMinute) / DEPARTURE_STEP_MINUTES) + 1),
    }));
  });
}
export function initialDailyTransportSearch(
  snapshot: DailyTransportSnapshot,
): DailyTransportSearch {
  return {
    algorithmVersion: FIXED_LAYOUT_SEARCH_VERSION,
    nextOrder: '0',
    totalOrders: dispatches(snapshot)
      .reduce((n, item) => n * item.count, factorial(snapshot.context.transportCycles!.length))
      .toString(),
    attempts: 0,
    improvements: 0,
    phase: 'searching',
    best: null,
  };
}
type CandidateMetrics = Pick<DailyTransportBest, 'completedTonnes' | 'distanceMeters'>;
/** Larger served tonnage, then shorter actual driving; no economic assumptions. */
export function improvesDailyTransportMetrics(
  candidate: CandidateMetrics,
  best?: CandidateMetrics | null,
): boolean {
  return (
    !best ||
    candidate.completedTonnes > best.completedTonnes ||
    (candidate.completedTonnes === best.completedTonnes &&
      candidate.distanceMeters < best.distanceMeters)
  );
}
export function improvesDailyTransport(
  result: DailyTransportResult,
  best: DailyTransportSearch['best'],
): boolean {
  return improvesDailyTransportMetrics(
    {
      completedTonnes: result.totalCompletedTonnes,
      distanceMeters: result.vehicleEnergy!.totalDistanceMeters,
    },
    best,
  );
}
function permutation(ids: string[], rank: bigint): string[] {
  const remaining = [...ids];
  const order: string[] = [];
  while (remaining.length) {
    const block = factorial(remaining.length - 1);
    const index = Number(rank / block);
    rank %= block;
    order.push(remaining.splice(index, 1)[0]);
  }
  return order;
}
function constructionInputs(snapshot: DailyTransportSnapshot, rank: bigint) {
  const context = snapshot.context;
  const cycles = new Map(context.transportCycles!.map((cycle) => [cycle.id, cycle]));
  const count = factorial(cycles.size);
  const order = permutation([...cycles.keys()], rank % count);
  rank /= count;
  const notBefore = new Map<string, number>();
  for (const dispatch of dispatches(snapshot)) {
    notBefore.set(
      dispatch.vehicleId,
      dispatch.startMinute + Number(rank % dispatch.count) * DEPARTURE_STEP_MINUTES,
    );
    rank /= dispatch.count;
  }
  return {
    snapshot: {
      ...snapshot,
      context: { ...context, transportCycles: order.map((id) => cycles.get(id)!) },
    },
    notBefore,
  };
}
/** Finite distinct priority orders; interrupted attempts may be repeated, completed checkpoints reused. */
export function searchDailyTransport(
  snapshot: DailyTransportSnapshot,
  config: DailyTransportConfig,
  taskId: string,
  checkpoint: DailyTransportSearch,
  onProgress: (progress: DailyTransportProgress) => void,
  onSearch: (search: DailyTransportSearch, result?: DailyTransportResult) => void,
): void {
  const search = { ...checkpoint };
  const deadline = Date.now() + config.maxRuntimeMs;
  const total = BigInt(search.totalOrders);
  let cursor = BigInt(search.nextOrder);
  let reason = '本次未找到可行方案，不证明全局无解';
  while (cursor < total) {
    if (Date.now() >= deadline) throw new Error('已达到搜索时限，完整候选继续保留');
    // Seed selects a reproducible starting order without changing the candidate's provenance.
    const rank = (cursor + BigInt(config.seed) - 1n + total) % total;
    let candidate: DailyTransportResult | undefined;
    try {
      const construction = constructionInputs(snapshot, rank);
      candidate = generateRepeatableDay(
        construction.snapshot,
        onProgress,
        { ...config, maxRuntimeMs: Math.max(1, deadline - Date.now()) },
        (phase) => {
          search.phase = phase;
          onSearch({ ...search });
        },
        construction.notBefore,
      );
    } catch (error) {
      reason = error instanceof Error ? error.message : reason;
      // A time-limited partial attempt is retried by a continuation.
      if (Date.now() >= deadline) throw new Error(reason);
    }
    cursor++;
    search.nextOrder = cursor.toString();
    search.attempts++;
    search.phase = 'searching';
    if (
      candidate &&
      candidate.totalCompletedTonnes > 0 &&
      improvesDailyTransport(candidate, search.best)
    ) {
      search.improvements++;
      search.best = {
        sourceTaskId: taskId,
        order: (cursor - 1n).toString(),
        foundAt: new Date().toISOString(),
        completedTonnes: candidate.totalCompletedTonnes,
        distanceMeters: candidate.vehicleEnergy!.totalDistanceMeters,
      };
      onSearch({ ...search }, candidate);
    } else onSearch({ ...search });
  }
  search.phase = 'finished';
  onSearch({ ...search });
  if (!search.best) throw new Error(reason);
}
