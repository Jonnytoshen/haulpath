import type { TransportDemand } from './transport-demands';
import type { FleetOperations } from './fleet-operations';
import type { StationNetwork } from './station-network';
import type { RoadSettings } from './directed-roads';
import { measuredSegmentIssue } from './fleet-operations';

export * from './transport-demands';
export * from './fleet-operations';
export * from './power-connection-points';
export * from './station-network';
export * from './scenario-comparison';
export * from './directed-roads';
export * from './daily-transport';
export * from './vehicle-energy';
export * from './daily-station-turnover';
export * from './station-turnover';
export * from './shared-power';

export type CoordinateSystem = 'GCJ-02' | 'WGS84';
export const strategyGroups = [
  {
    label: '常用偏好',
    options: [
      { value: 32, label: '高德推荐', description: '采用高德地图 App 默认的推荐策略。' },
      { value: 33, label: '躲避拥堵', description: '优先避开拥堵路段。' },
      { value: 34, label: '高速优先', description: '优先选择高速道路。' },
      { value: 35, label: '不走高速', description: '按不走高速策略测算。' },
      { value: 36, label: '少收费', description: '偏向收费较少的路线，不等于不走收费路段。' },
      { value: 37, label: '大路优先', description: '优先选择大路。' },
      { value: 38, label: '速度最快', description: '按高德的速度最快策略测算。' },
    ],
  },
  {
    label: '组合偏好',
    options: [
      {
        value: 39,
        label: '躲避拥堵＋高速优先',
        description: '优先避开拥堵路段，并优先选择高速道路。',
      },
      { value: 40, label: '躲避拥堵＋不走高速', description: '结合躲避拥堵与不走高速策略测算。' },
      { value: 41, label: '躲避拥堵＋少收费', description: '结合躲避拥堵与少收费偏好测算。' },
      { value: 42, label: '少收费＋不走高速', description: '结合少收费与不走高速策略测算。' },
      {
        value: 43,
        label: '躲避拥堵＋少收费＋不走高速',
        description: '结合躲避拥堵、少收费与不走高速策略测算。',
      },
      { value: 44, label: '躲避拥堵＋大路优先', description: '优先避开拥堵路段，并优先选择大路。' },
      { value: 45, label: '躲避拥堵＋速度最快', description: '结合躲避拥堵与速度最快策略测算。' },
    ],
  },
  {
    label: '其他策略',
    options: [
      { value: 0, label: '速度优先', description: '只返回一条路线，不一定距离最短。' },
      { value: 1, label: '费用优先', description: '只返回一条不走收费路段、耗时最少的路线。' },
      { value: 2, label: '常规最快', description: '只返回一条路线，综合距离与耗时规划。' },
    ],
  },
] as const;

export type Strategy = (typeof strategyGroups)[number]['options'][number]['value'];
export type PointSource = 'manual' | 'map' | 'search' | 'import' | 'library' | 'generated';

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface Point {
  id: string;
  name: string;
  longitude: number;
  latitude: number;
  originalLongitude: number;
  originalLatitude: number;
  coordinateSystem: CoordinateSystem;
  source: PointSource;
  poiId?: string;
}

export interface Leg {
  index: number;
  from: Point;
  to: Point;
  distanceMeters: number;
  polyline: [number, number][];
}

export interface PlanningSnapshot {
  inputVersion: number;
  points: Point[];
  strategy: Strategy;
  legs: Leg[];
  totalDistanceMeters: number;
  calculatedAt: string;
}

export interface PlanningState {
  taskId: string;
  inputVersion: number;
  status: 'running' | 'failed';
  completed: number;
  total: number;
  error?: string;
}

export interface Route {
  id: string;
  projectId: string;
  name: string;
  points: Point[];
  strategy: Strategy;
  inputVersion: number;
  snapshot: PlanningSnapshot | null;
  planning: PlanningState | null;
  createdAt: string;
  updatedAt: string;
}

export const PLANNING_NOTICE = '未校验重卡限高、限重及货车限行';
export const strategyLabels = Object.fromEntries(
  strategyGroups.flatMap((group) => group.options.map((option) => [option.value, option.label])),
) as Record<Strategy, string>;

export function isStrategy(input: unknown): input is Strategy {
  return strategyGroups.some((group) => group.options.some((option) => option.value === input));
}

export function routeStatus(route: Route): '已规划' | '待重算' | '未规划' {
  if (!route.snapshot) return '未规划';
  return route.snapshot.inputVersion === route.inputVersion ? '已规划' : '待重算';
}

export function formatKilometers(integerMeters: number): string {
  return (integerMeters / 1000).toFixed(3);
}

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface SwapDetourLimits {
  maxExtraMeters: number | null;
  maxExtraMinutes: number | null;
}

/** Versioned draft data; result entries are context, not validated calculation conclusions. */
export interface PlanningScenarioContext {
  schemaVersion: 1;
  resources: JsonObject;
  transportCycles?: TransportCycle[];
  transportDemands?: TransportDemand[];
  operations?: FleetOperations;
  stationNetwork?: StationNetwork;
  roadSettings?: RoadSettings;
  swapDetourLimits?: SwapDetourLimits;
  annual: JsonObject[];
  results: JsonObject[];
}

export interface PlanningScenario {
  id: string;
  projectId: string;
  name: string;
  status: 'draft' | 'frozen';
  /** Stable root of the copy lineage; each version still has its own id. */
  lineageId: string;
  copiedFrom: {
    scenarioId: string;
    name: string;
    inputVersion: number;
    revision: number;
  } | null;
  frozenAt: string | null;
  inputVersion: number;
  revision: number;
  context: PlanningScenarioContext;
  createdAt: string;
  updatedAt: string;
}

/** A position is one occurrence in the business order, including repeated locations. */
export interface TransportCyclePosition {
  id: string;
  point: Point;
  sourcePointId: string | null;
}

export interface TransportCycleRoad {
  fromPositionId: string;
  toPositionId: string;
  strategy: Strategy;
  leg: Leg;
}

export interface TransportCycle {
  id: string;
  name: string;
  strategy: Strategy;
  positions: TransportCyclePosition[];
  source: {
    routeId: string;
    name: string;
    inputVersion: number;
    points: Point[];
    strategy: Strategy;
    snapshot: PlanningSnapshot | null;
    importedAt: string;
  };
  roads: TransportCycleRoad[];
  confirmed: boolean;
  confirmedAt: string | null;
}

export function cycleIsClosed(cycle: TransportCycle): boolean {
  const first = cycle.positions[0]?.point;
  const last = cycle.positions.at(-1)?.point;
  return cycle.positions.length >= 3 && !!first && !!last && sameLocation(first, last);
}

function sameLocation(a: Point, b: Point): boolean {
  return a.longitude === b.longitude && a.latitude === b.latitude;
}

export function cycleHasAdjacentOverlap(cycle: TransportCycle): boolean {
  return cycle.positions.some(
    (position, index) =>
      index > 0 && sameLocation(position.point, cycle.positions[index - 1].point),
  );
}

/** Road data remains usable only for the exact directed occurrence and driving preference. */
export function effectiveCycleRoads(cycle: TransportCycle): TransportCycleRoad[] {
  return cycle.positions.slice(1).flatMap((to, index) => {
    const from = cycle.positions[index];
    const road = cycle.roads.find(
      (candidate) =>
        candidate.fromPositionId === from.id &&
        candidate.toPositionId === to.id &&
        candidate.strategy === cycle.strategy &&
        sameLocation(candidate.leg.from, from.point) &&
        sameLocation(candidate.leg.to, to.point),
    );
    return road ? [road] : [];
  });
}

export function cycleReadiness(cycle: TransportCycle, operations?: FleetOperations): string[] {
  const gaps: string[] = [];
  if (cycle.positions.length < 3) gaps.push('至少需要两个不同地点并返回起点');
  if (!cycleIsClosed(cycle)) gaps.push('尚未补齐闭合回程');
  if (cycleHasAdjacentOverlap(cycle)) gaps.push('相邻点位坐标重合');
  if (!cycle.confirmed) gaps.push('业务顺序与回程待确认');
  const missing = Math.max(0, cycle.positions.length - 1 - effectiveCycleRoads(cycle).length);
  if (missing) gaps.push(`缺少 ${missing} 个有向区间的有效道路资料`);
  const groups = operations?.vehicleGroups.filter((group) => group.count > 0) ?? [];
  if (!operations || !groups.length) {
    gaps.push('行驶时间待配置（现有路线方案不含时长）');
  } else {
    for (const group of groups) {
      if (group.speedKph !== null) continue;
      const missingTimes = cycle.positions.slice(1).filter((to, index) => {
        const from = cycle.positions[index];
        return !operations.measuredSegments.some(
          (measured) =>
            measured.vehicleGroupId === group.id &&
            measured.cycleId === cycle.id &&
            measured.fromPositionId === from.id &&
            measured.toPositionId === to.id &&
            measured.durationMinutes !== null &&
            measuredSegmentIssue(measured, operations, [cycle]) === null,
        );
      }).length;
      if (missingTimes) gaps.push(`车辆组“${group.name}”缺少 ${missingTimes} 个区间的行驶时间`);
    }
  }
  return gaps;
}

export * from './repeatable-day';

export * from './daily-transport-search';
