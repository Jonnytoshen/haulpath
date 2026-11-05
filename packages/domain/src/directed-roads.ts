import type { PlanningScenarioContext, Point, Strategy } from './index';
import { effectiveCycleRoads } from './index';

export interface RoadSettings {
  continuationStrategy: Strategy;
}

export interface RoadUse {
  kind: 'business' | 'station-entry' | 'station-exit' | 'continuation';
  cycleId: string;
  fromPositionId?: string;
  toPositionId?: string;
  siteId?: string;
  toCycleId?: string;
}

/** Several business occurrences may use one exact directed coordinate/preference basis. */
export interface RoadRequirement {
  key: string;
  from: Point;
  to: Point;
  strategy: Strategy;
  uses: RoadUse[];
}

export interface PreparedRoad {
  key: string;
  from: Point;
  to: Point;
  strategy: Strategy;
  distanceMeters: number;
  polyline: [number, number][];
  source: 'amap' | 'cycle-snapshot' | 'same-location';
  preparedAt: string;
}

export type RoadTaskStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'stopped'
  | 'failed'
  | 'timed-out'
  | 'interrupted'
  | 'superseded';

export interface RoadTaskSummary {
  taskId: string;
  projectId: string;
  scenarioId: string;
  inputVersion: number;
  status: RoadTaskStatus;
  completed: number;
  total: number;
  reused: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RoadPreparationTask extends RoadTaskSummary {
  snapshot: {
    context: PlanningScenarioContext;
    revision: number;
    requirements: RoadRequirement[];
  };
  roads: PreparedRoad[];
}

export interface RoadPreparationView {
  projectId: string;
  scenarioId: string;
  inputVersion: number;
  settings: RoadSettings;
  requirements: RoadRequirement[];
  roads: PreparedRoad[];
  task: RoadPreparationTask | null;
  tasks: RoadTaskSummary[];
  currentReady: boolean;
  completed: number;
  total: number;
}

/** Keep exact input numbers as well as the serialized upstream request basis. */
export function directedRoadKey(from: Point, to: Point, strategy: Strategy): string {
  return JSON.stringify([
    from.longitude,
    from.latitude,
    to.longitude,
    to.latitude,
    strategy,
    `${from.longitude.toFixed(6)},${from.latitude.toFixed(6)}`,
    `${to.longitude.toFixed(6)},${to.latitude.toFixed(6)}`,
  ]);
}

export function roadRequirements(context: PlanningScenarioContext): RoadRequirement[] {
  const requirements = new Map<string, RoadRequirement>();
  function add(from: Point, to: Point, strategy: Strategy, use: RoadUse) {
    const key = directedRoadKey(from, to, strategy);
    const existing = requirements.get(key);
    if (existing) existing.uses.push(use);
    else requirements.set(key, { key, from, to, strategy, uses: [use] });
  }
  const cycles = context.transportCycles ?? [];
  const sites = context.stationNetwork?.sites ?? [];
  for (const cycle of cycles) {
    for (let index = 1; index < cycle.positions.length; index++) {
      const from = cycle.positions[index - 1];
      const to = cycle.positions[index];
      const basis = { cycleId: cycle.id, fromPositionId: from.id, toPositionId: to.id };
      add(from.point, to.point, cycle.strategy, { kind: 'business', ...basis });
      for (const site of sites) {
        add(from.point, site, cycle.strategy, {
          kind: 'station-entry',
          ...basis,
          siteId: site.id,
        });
        add(site, to.point, cycle.strategy, {
          kind: 'station-exit',
          ...basis,
          siteId: site.id,
        });
      }
    }
  }
  for (const from of cycles) {
    for (const to of cycles) {
      if (from.id === to.id || !from.positions[0] || !to.positions[0]) continue;
      add(
        from.positions[0].point,
        to.positions[0].point,
        context.roadSettings?.continuationStrategy ?? 32,
        {
          kind: 'continuation',
          cycleId: from.id,
          toCycleId: to.id,
          fromPositionId: from.positions[0].id,
          toPositionId: to.positions[0].id,
        },
      );
    }
  }
  return [...requirements.values()];
}

export function reusableCycleRoads(context: PlanningScenarioContext): PreparedRoad[] {
  return (context.transportCycles ?? []).flatMap((cycle) =>
    effectiveCycleRoads(cycle).map((road) => ({
      key: directedRoadKey(road.leg.from, road.leg.to, road.strategy),
      from: road.leg.from,
      to: road.leg.to,
      strategy: road.strategy,
      distanceMeters: road.leg.distanceMeters,
      polyline: road.leg.polyline,
      source: 'cycle-snapshot' as const,
      preparedAt: cycle.source.snapshot?.calculatedAt ?? cycle.source.importedAt,
    })),
  );
}
