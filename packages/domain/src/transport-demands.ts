import type { TransportCycle } from './index';

/** Daily business demand, independent of individual vehicle loads or trip counts. */
export interface TransportDemand {
  id: string;
  cycleId: string;
  loadingPositionId: string;
  unloadingPositionId: string;
  dailyTonnes: number;
}

export type TransportDemandInput = Omit<TransportDemand, 'id'> & { id?: string };

export interface CycleDailyFlow {
  fromPositionId: string;
  toPositionId: string;
  dailyTonnes: number;
  demands: TransportDemand[];
}

/** Position identity and order remain meaningful even when a cycle is not confirmed. */
export function transportDemandIssue(
  demand: TransportDemand,
  cycles: TransportCycle[],
): string | null {
  const cycle = cycles.find((candidate) => candidate.id === demand.cycleId);
  if (!cycle) return '所属运输循环已删除或不存在';
  const loading = cycle.positions.findIndex((position) => position.id === demand.loadingPositionId);
  const unloading = cycle.positions.findIndex(
    (position) => position.id === demand.unloadingPositionId,
  );
  if (loading < 0) return '装货位置已删除或不属于所属循环';
  if (unloading < 0) return '卸货位置已删除或不属于所属循环';
  if (loading >= unloading) return '装货位置须排在卸货位置之前';
  return null;
}

export function demandReadiness(demand: TransportDemand, cycles: TransportCycle[]): string[] {
  const issue = transportDemandIssue(demand, cycles);
  if (issue) return [issue];
  const cycle = cycles.find((candidate) => candidate.id === demand.cycleId)!;
  return cycle.confirmed ? [] : ['所属运输循环的业务顺序与回程待确认'];
}

/** Daily flow is the sum of demands crossing each business segment, not a vehicle load. */
export function cycleDailyFlows(
  cycle: TransportCycle,
  demands: TransportDemand[],
): CycleDailyFlow[] {
  const ranges = demands
    .filter((demand) => transportDemandIssue(demand, [cycle]) === null)
    .map((demand) => ({
      demand,
      loading: cycle.positions.findIndex((position) => position.id === demand.loadingPositionId),
      unloading: cycle.positions.findIndex(
        (position) => position.id === demand.unloadingPositionId,
      ),
    }));
  return cycle.positions.slice(1).map((to, index) => {
    const crossing = ranges
      .filter(({ loading, unloading }) => loading <= index && unloading > index)
      .map(({ demand }) => demand);
    return {
      fromPositionId: cycle.positions[index].id,
      toPositionId: to.id,
      dailyTonnes: crossing.reduce((total, demand) => total + demand.dailyTonnes, 0),
      demands: crossing,
    };
  });
}
