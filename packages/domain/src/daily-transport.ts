import type { PlanningScenarioContext, Point, TransportCycle } from './index';
import { cycleHasAdjacentOverlap, cycleIsClosed } from './index';
import type { OperatingShift, VehicleGroup } from './fleet-operations';
import { measuredSegmentIssue, vehicleGroupIssue } from './fleet-operations';
import { transportDemandIssue } from './transport-demands';
import type { PreparedRoad, RoadTaskStatus } from './directed-roads';
import { directedRoadKey } from './directed-roads';

export const DAILY_TRANSPORT_ALGORITHM_VERSION = 'daily-transport-greedy-1';

export interface DailyTransportSnapshot {
  context: PlanningScenarioContext;
  roads: PreparedRoad[];
  revision: number;
}
export interface DailyTransportConfig {
  seed: number;
  maxRuntimeMs: number;
}
export interface DailyTransportProgress {
  completedTrips: number;
  completedTonnes: number;
  totalTonnes: number;
}
export interface DailyTransportAllocation {
  demandId: string;
  tonnes: number;
}
export interface DailyTransportSegment {
  fromPositionId: string;
  toPositionId: string;
  roadKey: string;
  distanceMeters: number;
  durationMinutes: number;
  durationSource: 'measured' | 'speed';
  measuredSegmentId: string | null;
  loadTonnes: number;
  allocations: DailyTransportAllocation[];
}
export type DailyTransportEventKind =
  'transport' | 'loading' | 'unloading' | 'continuation' | 'return';
export interface DailyTransportEvent {
  id: string;
  kind: DailyTransportEventKind;
  startMinute: number;
  endMinute: number;
  tripId: string | null;
  cycleId: string;
  fromPositionId: string;
  toPositionId: string;
  from: Point;
  to: Point;
  distanceMeters: number;
  /** On-board tonnes while driving; handled tonnes for loading/unloading. */
  loadTonnes: number;
  allocations: DailyTransportAllocation[];
  roadKey: string | null;
  durationSource: 'measured' | 'speed' | 'operation';
  measuredSegmentId: string | null;
}
export interface DailyTransportTrip {
  id: string;
  vehicleId: string;
  vehicleGroupId: string;
  cycleId: string;
  sequence: number;
  startMinute: number;
  endMinute: number;
  allocations: DailyTransportAllocation[];
  segments: DailyTransportSegment[];
  eventIds: string[];
}
export interface DailyTransportVehicle {
  vehicleId: string;
  vehicleGroupId: string;
  vehicleGroupName: string;
  baseCycleId: string;
  basePositionId: string;
  payloadTonnes: number;
  shifts: OperatingShift[];
  events: DailyTransportEvent[];
  tripIds: string[];
  workingMinutes: number;
  totalDistanceMeters: number;
  returnedToBase: boolean;
}
export interface DailyTransportDemandResult {
  demandId: string;
  cycleId: string;
  loadingPositionId: string;
  unloadingPositionId: string;
  requestedTonnes: number;
  completedTonnes: number;
  missingTonnes: number;
  reason: string | null;
}
export interface DailyTransportValidation {
  valid: boolean;
  issues: string[];
}
export interface DailyTransportResult {
  algorithmVersion: string;
  seed: number;
  vehicles: DailyTransportVehicle[];
  trips: DailyTransportTrip[];
  demands: DailyTransportDemandResult[];
  totalCompletedTonnes: number;
  totalMissingTonnes: number;
  totalDistanceMeters: number;
  validation: DailyTransportValidation;
  energyStatus: 'not-checked';
  physicalFeasibility: 'not-established';
  limitations: string[];
}
export interface DailyTransportTaskSummary {
  taskId: string;
  projectId: string;
  scenarioId: string;
  inputVersion: number;
  status: RoadTaskStatus;
  algorithmVersion: string;
  config: DailyTransportConfig;
  progress: DailyTransportProgress;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface DailyTransportTask extends DailyTransportTaskSummary {
  snapshot: DailyTransportSnapshot;
  result: DailyTransportResult | null;
}
export interface DailyTransportView {
  projectId: string;
  scenarioId: string;
  inputVersion: number;
  gaps: string[];
  task: DailyTransportTask | null;
  tasks: DailyTransportTaskSummary[];
  resultTask: DailyTransportTask | null;
}

const tolerance = 1e-7;
function close(a: number, b: number): boolean {
  return (
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    Math.abs(a - b) <= 1e-8 + Number.EPSILON * 32 * Math.max(1, Math.abs(a), Math.abs(b))
  );
}
function samePoint(a: Point, b: Point): boolean {
  return a.longitude === b.longitude && a.latitude === b.latitude;
}
type TonnageSum = { total: number; correction: number };
const emptyTonnage = (): TonnageSum => ({ total: 0, correction: 0 });
function addTonnes(sum: TonnageSum, tonnes: number): TonnageSum {
  const adjusted = tonnes - sum.correction;
  const total = sum.total + adjusted;
  return { total, correction: total - sum.total - adjusted };
}
function sumTonnes(allocations: DailyTransportAllocation[]): number {
  return allocations.reduce((sum, { tonnes }) => addTonnes(sum, tonnes), emptyTonnage()).total;
}
function remainingTonnes(target: number, assigned: number): number {
  const remaining = target - assigned;
  // Collapse only representation noise after compensated addition. An unserved positive
  // demand, even below the display precision, retains its full amount.
  return assigned > 0 && remaining <= Number.EPSILON * target ? 0 : remaining;
}
function positive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}
function nonnegative(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

/** Only transportation inputs are required here. Energy and finance remain separate checks. */
export function dailyTransportReadiness(snapshot: DailyTransportSnapshot): string[] {
  const { context } = snapshot;
  const cycles = context.transportCycles ?? [];
  const demands = context.transportDemands ?? [];
  const operations = context.operations;
  const groups = operations?.vehicleGroups.filter((group) => group.count > 0) ?? [];
  const gaps: string[] = [];
  if (!cycles.length) gaps.push('运输循环待配置');
  if (!demands.length) gaps.push('运输需求待配置');
  if (!groups.length) gaps.push('可用车辆待配置');
  const roads = new Map(snapshot.roads.map((road) => [road.key, road]));
  for (const cycle of cycles) {
    if (!cycle.confirmed || !cycleIsClosed(cycle) || cycleHasAdjacentOverlap(cycle))
      gaps.push(`运输循环“${cycle.name}”：业务顺序与闭合回程须有效并确认`);
    for (let index = 1; index < cycle.positions.length; index++) {
      const key = directedRoadKey(
        cycle.positions[index - 1].point,
        cycle.positions[index].point,
        cycle.strategy,
      );
      const road = roads.get(key);
      if (!road || !Number.isSafeInteger(road.distanceMeters) || road.distanceMeters < 0)
        gaps.push(`运输循环“${cycle.name}”：缺少有效有向道路资料`);
    }
  }
  for (const demand of demands) {
    const issue = transportDemandIssue(demand, cycles);
    if (issue) gaps.push(`运输需求：${issue}`);
    if (!positive(demand.dailyTonnes)) gaps.push('运输需求：日吨数须大于零');
  }
  for (const group of groups) {
    const prefix = `车辆组“${group.name}”`;
    const issue = vehicleGroupIssue(group, cycles);
    if (issue) gaps.push(`${prefix}：${issue}`);
    if (
      group.vehicleIds.length < group.count ||
      new Set(group.vehicleIds.slice(0, group.count)).size !== group.count
    )
      gaps.push(`${prefix}：可用计划车辆身份不完整`);
    if (!positive(group.payloadTonnes)) gaps.push(`${prefix}：载重待配置`);
    if (!nonnegative(group.loadingMinutes)) gaps.push(`${prefix}：装货耗时待配置`);
    if (!nonnegative(group.unloadingMinutes)) gaps.push(`${prefix}：卸货耗时待配置`);
    if (!group.source.trim()) gaps.push(`${prefix}：参数来源待填写`);
    const sorted = [...group.shifts].sort((a, b) => a.startMinute - b.startMinute);
    if (
      !sorted.length ||
      sorted.some(
        (shift, index) =>
          !Number.isFinite(shift.startMinute) ||
          !Number.isFinite(shift.endMinute) ||
          shift.startMinute < 0 ||
          shift.startMinute >= 1440 ||
          shift.endMinute <= shift.startMinute ||
          shift.endMinute > shift.startMinute + 1440 ||
          (index > 0 && shift.startMinute < sorted[index - 1].endMinute),
      )
    )
      gaps.push(`${prefix}：班次作业窗口无效或待配置`);
    for (const cycle of cycles) {
      let drivingMinutes = 0;
      for (let index = 1; index < cycle.positions.length; index++) {
        const measured = operations?.measuredSegments.find(
          (entry) =>
            entry.vehicleGroupId === group.id &&
            entry.cycleId === cycle.id &&
            entry.fromPositionId === cycle.positions[index - 1].id &&
            entry.toPositionId === cycle.positions[index].id &&
            entry.durationMinutes !== null &&
            measuredSegmentIssue(entry, operations, cycles, 'travel-time') === null,
        );
        if (!measured && !positive(group.speedKph))
          gaps.push(`${prefix}：循环“${cycle.name}”缺少业务速度或有效实测时间`);
        const key = directedRoadKey(
          cycle.positions[index - 1].point,
          cycle.positions[index].point,
          cycle.strategy,
        );
        drivingMinutes +=
          measured?.durationMinutes ??
          ((roads.get(key)?.distanceMeters ?? NaN) / 1000 / (group.speedKph ?? NaN)) * 60;
      }
      if (
        demands.some((demand) => demand.cycleId === cycle.id) &&
        drivingMinutes === 0 &&
        group.loadingMinutes === 0 &&
        group.unloadingMinutes === 0
      )
        gaps.push(`${prefix}：循环“${cycle.name}”的全程及装卸耗时为零，无法生成有界逐车日计划`);
    }
    for (const from of cycles)
      for (const to of cycles) {
        if (from.id === to.id || !from.positions[0] || !to.positions[0]) continue;
        const a = from.positions[0].point;
        const b = to.positions[0].point;
        if (!samePoint(a, b) && !positive(group.speedKph))
          gaps.push(`${prefix}：跨线接续及归位需要业务速度`);
        if (!roads.has(directedRoadKey(a, b, context.roadSettings?.continuationStrategy ?? 32)))
          gaps.push('跨线接续及归位缺少有向道路资料');
      }
  }
  if (operations)
    for (const measured of operations.measuredSegments) {
      if (
        measured.durationMinutes === null ||
        !groups.some((group) => group.id === measured.vehicleGroupId)
      )
        continue;
      const issue = measuredSegmentIssue(measured, operations, cycles, 'travel-time');
      if (issue) gaps.push(`区间实测时间：${issue}`);
      if (!nonnegative(measured.durationMinutes)) gaps.push('区间实测时间须为非负数');
    }
  return [...new Set(gaps)];
}

function businessSegment(
  snapshot: DailyTransportSnapshot,
  group: VehicleGroup,
  cycle: TransportCycle,
  index: number,
  allocations: DailyTransportAllocation[],
): DailyTransportSegment {
  const from = cycle.positions[index];
  const to = cycle.positions[index + 1];
  const key = directedRoadKey(from.point, to.point, cycle.strategy);
  const road = snapshot.roads.find((entry) => entry.key === key)!;
  const operations = snapshot.context.operations!;
  const measured = operations.measuredSegments.find(
    (entry) =>
      entry.vehicleGroupId === group.id &&
      entry.cycleId === cycle.id &&
      entry.fromPositionId === from.id &&
      entry.toPositionId === to.id &&
      entry.durationMinutes !== null &&
      measuredSegmentIssue(
        entry,
        operations,
        snapshot.context.transportCycles ?? [],
        'travel-time',
      ) === null,
  );
  return {
    fromPositionId: from.id,
    toPositionId: to.id,
    roadKey: key,
    distanceMeters: road.distanceMeters,
    durationMinutes:
      measured?.durationMinutes ?? (road.distanceMeters / 1000 / group.speedKph!) * 60,
    durationSource: measured ? 'measured' : 'speed',
    measuredSegmentId: measured?.id ?? null,
    loadTonnes: sumTonnes(allocations),
    allocations,
  };
}

function transfer(
  snapshot: DailyTransportSnapshot,
  group: VehicleGroup,
  from: TransportCycle,
  to: TransportCycle,
  startMinute: number,
  kind: 'continuation' | 'return',
): DailyTransportEvent | null {
  if (from.id === to.id) return null;
  const a = from.positions[0];
  const b = to.positions[0];
  const key = directedRoadKey(
    a.point,
    b.point,
    snapshot.context.roadSettings?.continuationStrategy ?? 32,
  );
  const road = snapshot.roads.find((entry) => entry.key === key)!;
  const duration = samePoint(a.point, b.point)
    ? 0
    : (road.distanceMeters / 1000 / group.speedKph!) * 60;
  return {
    id: '',
    kind,
    startMinute,
    endMinute: startMinute + duration,
    tripId: null,
    cycleId: to.id,
    fromPositionId: a.id,
    toPositionId: b.id,
    from: a.point,
    to: b.point,
    distanceMeters: road.distanceMeters,
    loadTonnes: 0,
    allocations: [],
    roadKey: key,
    durationSource: 'speed',
    measuredSegmentId: null,
  };
}

function loadForTrip(
  snapshot: DailyTransportSnapshot,
  group: VehicleGroup,
  cycle: TransportCycle,
  remaining: Map<string, number>,
): DailyTransportAllocation[] {
  const assigned = cycle.positions.slice(1).map(emptyTonnage);
  const allocations: DailyTransportAllocation[] = [];
  for (const demand of snapshot.context.transportDemands ?? []) {
    if (demand.cycleId !== cycle.id || !(remaining.get(demand.id)! > 0)) continue;
    const first = cycle.positions.findIndex((position) => position.id === demand.loadingPositionId);
    const last = cycle.positions.findIndex(
      (position) => position.id === demand.unloadingPositionId,
    );
    let tonnes = remaining.get(demand.id)!;
    for (let index = first; index < last; index++)
      tonnes = Math.min(tonnes, remainingTonnes(group.payloadTonnes!, assigned[index].total));
    if (!(tonnes > 0)) continue;
    allocations.push({ demandId: demand.id, tonnes });
    for (let index = first; index < last; index++)
      assigned[index] = addTonnes(assigned[index], tonnes);
  }
  return allocations;
}

function tripEvents(
  snapshot: DailyTransportSnapshot,
  group: VehicleGroup,
  cycle: TransportCycle,
  allocations: DailyTransportAllocation[],
  startMinute: number,
): { events: DailyTransportEvent[]; segments: DailyTransportSegment[]; endMinute: number } {
  const demands = new Map(snapshot.context.transportDemands!.map((demand) => [demand.id, demand]));
  const events: DailyTransportEvent[] = [];
  const segments: DailyTransportSegment[] = [];
  let time = startMinute;
  function operation(kind: 'loading' | 'unloading', index: number) {
    const position = cycle.positions[index];
    const handled = allocations.filter((allocation) => {
      const demand = demands.get(allocation.demandId)!;
      return (
        (kind === 'loading' ? demand.loadingPositionId : demand.unloadingPositionId) === position.id
      );
    });
    if (!handled.length) return;
    const duration = kind === 'loading' ? group.loadingMinutes! : group.unloadingMinutes!;
    events.push({
      id: '',
      kind,
      startMinute: time,
      endMinute: time + duration,
      tripId: '',
      cycleId: cycle.id,
      fromPositionId: position.id,
      toPositionId: position.id,
      from: position.point,
      to: position.point,
      distanceMeters: 0,
      loadTonnes: sumTonnes(handled),
      allocations: handled,
      roadKey: null,
      durationSource: 'operation',
      measuredSegmentId: null,
    });
    time += duration;
  }
  for (let index = 0; index < cycle.positions.length; index++) {
    operation('unloading', index);
    operation('loading', index);
    if (index === cycle.positions.length - 1) continue;
    const onboard = allocations.filter((allocation) => {
      const demand = demands.get(allocation.demandId)!;
      const first = cycle.positions.findIndex(
        (position) => position.id === demand.loadingPositionId,
      );
      const last = cycle.positions.findIndex(
        (position) => position.id === demand.unloadingPositionId,
      );
      return first <= index && index < last;
    });
    const segment = businessSegment(snapshot, group, cycle, index, onboard);
    segments.push(segment);
    const from = cycle.positions[index];
    const to = cycle.positions[index + 1];
    events.push({
      id: '',
      kind: 'transport',
      startMinute: time,
      endMinute: time + segment.durationMinutes,
      tripId: '',
      cycleId: cycle.id,
      fromPositionId: from.id,
      toPositionId: to.id,
      from: from.point,
      to: to.point,
      distanceMeters: segment.distanceMeters,
      loadTonnes: segment.loadTonnes,
      allocations: onboard,
      roadKey: segment.roadKey,
      durationSource: segment.durationSource,
      measuredSegmentId: segment.measuredSegmentId,
    });
    time += segment.durationMinutes;
  }
  return { events, segments, endMinute: time };
}

/** Finite, reproducible construction, not an optimality or infeasibility proof. */
export function generateDailyTransport(
  snapshot: DailyTransportSnapshot,
  onProgress?: (progress: DailyTransportProgress) => void,
  config: DailyTransportConfig = { seed: 1, maxRuntimeMs: 10 * 60 * 1000 },
): DailyTransportResult {
  const gaps = dailyTransportReadiness(snapshot);
  if (gaps.length) throw new Error(gaps.join('；'));
  const cycles = snapshot.context.transportCycles!;
  const groups = snapshot.context.operations!.vehicleGroups.filter((group) => group.count > 0);
  const targets = new Map(
    snapshot.context.transportDemands!.map((demand) => [demand.id, demand.dailyTonnes]),
  );
  const remaining = new Map(targets);
  const delivered = new Map<string, TonnageSum>();
  const totalTonnes = snapshot.context.transportDemands!.reduce(
    (total, demand) => total + demand.dailyTonnes,
    0,
  );
  const vehicles: DailyTransportVehicle[] = [];
  const states = groups.flatMap((group) =>
    group.vehicleIds.slice(0, group.count).map((vehicleId) => {
      const base = cycles.find((cycle) => cycle.id === group.baseCycleId)!;
      const shifts = [...group.shifts].sort((a, b) => a.startMinute - b.startMinute);
      const vehicle: DailyTransportVehicle = {
        vehicleId,
        vehicleGroupId: group.id,
        vehicleGroupName: group.name,
        baseCycleId: base.id,
        basePositionId: base.positions[0].id,
        payloadTonnes: group.payloadTonnes!,
        shifts,
        events: [],
        tripIds: [],
        workingMinutes: 0,
        totalDistanceMeters: 0,
        returnedToBase: true,
      };
      vehicles.push(vehicle);
      return { group, base, vehicle, shifts, shift: 0, time: shifts[0].startMinute, current: base };
    }),
  );
  const trips: DailyTransportTrip[] = [];
  let completedTonnes = 0;
  let eventNumber = 0;
  const begun = Date.now();
  const offset = (((config.seed - 1) % cycles.length) + cycles.length) % cycles.length;
  const orderedCycles = [...cycles.slice(offset), ...cycles.slice(0, offset)];
  const addEvent = (vehicle: DailyTransportVehicle, event: DailyTransportEvent) => {
    event.id = `event-${++eventNumber}`;
    vehicle.events.push(event);
  };
  while (states.some((state) => state.shift < state.shifts.length)) {
    if (Date.now() - begun > config.maxRuntimeMs)
      throw new Error('运输试算达到时限，未发布未完成校验的结果');
    type Candidate = {
      state: (typeof states)[number];
      cycle: TransportCycle;
      allocations: DailyTransportAllocation[];
      entry: DailyTransportEvent | null;
      plan: ReturnType<typeof tripEvents>;
    };
    let best: Candidate | undefined;
    for (const state of states) {
      while (state.shift < state.shifts.length) {
        let stateBest: Candidate | undefined;
        for (const cycle of orderedCycles) {
          const allocations = loadForTrip(snapshot, state.group, cycle, remaining);
          if (!allocations.length) continue;
          const entry = transfer(
            snapshot,
            state.group,
            state.current,
            cycle,
            state.time,
            'continuation',
          );
          const plan = tripEvents(
            snapshot,
            state.group,
            cycle,
            allocations,
            entry?.endMinute ?? state.time,
          );
          const home = transfer(snapshot, state.group, cycle, state.base, plan.endMinute, 'return');
          if ((home?.endMinute ?? plan.endMinute) > state.shifts[state.shift].endMinute + tolerance)
            continue;
          if (!stateBest || plan.endMinute < stateBest.plan.endMinute - tolerance)
            stateBest = { state, cycle, allocations, entry, plan };
        }
        if (stateBest) {
          if (!best || stateBest.plan.endMinute < best.plan.endMinute - tolerance) best = stateBest;
          break;
        }
        const home = transfer(
          snapshot,
          state.group,
          state.current,
          state.base,
          state.time,
          'return',
        );
        if (home) addEvent(state.vehicle, home);
        state.current = state.base;
        state.shift++;
        if (state.shift < state.shifts.length) state.time = state.shifts[state.shift].startMinute;
      }
    }
    if (!best) continue;
    const { state, cycle, allocations, entry, plan } = best;
    if (entry) addEvent(state.vehicle, entry);
    const tripId = `trip-${trips.length + 1}`;
    for (const event of plan.events) {
      event.tripId = tripId;
      addEvent(state.vehicle, event);
    }
    trips.push({
      id: tripId,
      vehicleId: state.vehicle.vehicleId,
      vehicleGroupId: state.group.id,
      cycleId: cycle.id,
      sequence: state.vehicle.tripIds.length + 1,
      startMinute: plan.events[0].startMinute,
      endMinute: plan.endMinute,
      allocations,
      segments: plan.segments,
      eventIds: plan.events.map((event) => event.id),
    });
    state.vehicle.tripIds.push(tripId);
    state.time = plan.endMinute;
    state.current = cycle;
    for (const { demandId, tonnes } of allocations) {
      const sum = addTonnes(delivered.get(demandId) ?? emptyTonnage(), tonnes);
      delivered.set(demandId, sum);
      remaining.set(demandId, remainingTonnes(targets.get(demandId)!, sum.total));
      completedTonnes += tonnes;
    }
    onProgress?.({ completedTrips: trips.length, completedTonnes, totalTonnes });
  }
  for (const vehicle of vehicles) {
    vehicle.workingMinutes = vehicle.events.reduce(
      (total, event) => total + event.endMinute - event.startMinute,
      0,
    );
    vehicle.totalDistanceMeters = vehicle.events.reduce(
      (total, event) => total + event.distanceMeters,
      0,
    );
    vehicle.returnedToBase =
      !vehicle.events.length ||
      samePoint(
        vehicle.events.at(-1)!.to,
        cycles.find((cycle) => cycle.id === vehicle.baseCycleId)!.positions[0].point,
      );
  }
  function shortfallReason(cycle: TransportCycle, allocation: DailyTransportAllocation): string {
    const fitsAnyShift = groups.some((group) => {
      const base = cycles.find((candidate) => candidate.id === group.baseCycleId)!;
      const departure = transfer(snapshot, group, base, cycle, 0, 'continuation');
      const trip = tripEvents(
        snapshot,
        group,
        cycle,
        [{ ...allocation, tonnes: Math.min(allocation.tonnes, group.payloadTonnes!) }],
        departure?.endMinute ?? 0,
      );
      const home = transfer(snapshot, group, cycle, base, trip.endMinute, 'return');
      return group.shifts.some(
        (shift) =>
          (home?.endMinute ?? trip.endMinute) <= shift.endMinute - shift.startMinute + tolerance,
      );
    });
    return fitsAnyShift
      ? '给定车队与班次下，本次构造未安排完成；未证明无解'
      : '现有车辆的班次均不足以完成一次该需求的循环及必要的接续、归位';
  }
  const demands: DailyTransportDemandResult[] = snapshot.context.transportDemands!.map(
    (demand) => ({
      demandId: demand.id,
      cycleId: demand.cycleId,
      loadingPositionId: demand.loadingPositionId,
      unloadingPositionId: demand.unloadingPositionId,
      requestedTonnes: demand.dailyTonnes,
      completedTonnes: demand.dailyTonnes - remaining.get(demand.id)!,
      missingTonnes: remaining.get(demand.id)!,
      reason:
        remaining.get(demand.id)! > 0
          ? shortfallReason(
              cycles.find((cycle) => cycle.id === demand.cycleId)!,
              {
                demandId: demand.id,
                tonnes: remaining.get(demand.id)!,
              },
            )
          : null,
    }),
  );
  const result: DailyTransportResult = {
    algorithmVersion: DAILY_TRANSPORT_ALGORITHM_VERSION,
    seed: config.seed,
    vehicles,
    trips,
    demands,
    totalCompletedTonnes: demands.reduce((total, demand) => total + demand.completedTonnes, 0),
    totalMissingTonnes: demands.reduce((total, demand) => total + demand.missingTonnes, 0),
    totalDistanceMeters: vehicles.reduce(
      (total, vehicle) => total + vehicle.totalDistanceMeters,
      0,
    ),
    validation: { valid: false, issues: [] },
    energyStatus: 'not-checked',
    physicalFeasibility: 'not-established',
    limitations: [
      '补能校核未完成，不能据此发布完整物理可行结论',
      '固定顺序贪心构造不保证最优，运输缺口不表示已证明无解',
      '装卸耗时按有作业的点位每次计入一次，不模拟装卸设备排队',
      '跨线接续与归位采用业务速度；仅业务有向区间采用有效实测时间覆盖',
      '未校验重卡限高、限重及货车限行',
    ],
  };
  result.validation = validateDailyTransport(snapshot, result);
  if (!result.validation.valid)
    throw new Error(`运输计划独立校验未通过：${result.validation.issues.join('；')}`);
  return result;
}

/** Rebuild conservation, road/time evidence and vehicle constraints from the published events. */
export function validateDailyTransport(
  snapshot: DailyTransportSnapshot,
  result: DailyTransportResult,
): DailyTransportValidation {
  const issues: string[] = dailyTransportReadiness(snapshot);
  const cycles = new Map(
    (snapshot.context.transportCycles ?? []).map((cycle) => [cycle.id, cycle]),
  );
  const inputs = new Map(
    (snapshot.context.transportDemands ?? []).map((demand) => [demand.id, demand]),
  );
  const groups = new Map(
    (snapshot.context.operations?.vehicleGroups ?? []).map((group) => [group.id, group]),
  );
  const roads = new Map(snapshot.roads.map((road) => [road.key, road]));
  const trips = new Map(result.trips.map((trip) => [trip.id, trip]));
  const vehicleMap = new Map(result.vehicles.map((vehicle) => [vehicle.vehicleId, vehicle]));
  const totals = new Map<string, number>();
  const eventIds = new Set<string>();
  function check(ok: boolean, message: string) {
    if (!ok) issues.push(message);
  }
  function allocationsEqual(
    actual: DailyTransportAllocation[],
    expected: DailyTransportAllocation[],
  ): boolean {
    return (
      actual.length === expected.length &&
      new Set(actual.map((entry) => entry.demandId)).size === actual.length &&
      expected.every((entry) =>
        actual.some(
          (other) => other.demandId === entry.demandId && close(other.tonnes, entry.tonnes),
        ),
      )
    );
  }
  check(trips.size === result.trips.length, '车次身份重复');
  check(vehicleMap.size === result.vehicles.length, '车辆身份重复');
  const availableIds = [...groups.values()].flatMap((group) =>
    group.vehicleIds.slice(0, group.count),
  );
  check(
    result.vehicles.length === availableIds.length &&
      availableIds.every((id) => vehicleMap.has(id)),
    '结果未严格采用给定可用车辆身份池',
  );
  for (const trip of result.trips) {
    const group = groups.get(trip.vehicleGroupId);
    const cycle = cycles.get(trip.cycleId);
    const vehicle = vehicleMap.get(trip.vehicleId);
    check(
      !!group && !!cycle && !!vehicle && vehicle.vehicleGroupId === trip.vehicleGroupId,
      `车次 ${trip.id} 归属无效`,
    );
    if (!group || !cycle || !vehicle) continue;
    check(
      trip.allocations.length > 0 &&
        new Set(trip.allocations.map((entry) => entry.demandId)).size === trip.allocations.length,
      `车次 ${trip.id} 未承运有效独立需求`,
    );
    const validAllocations = trip.allocations.filter((allocation) => {
      const input = inputs.get(allocation.demandId);
      const valid =
        !!input &&
        input.cycleId === cycle.id &&
        positive(allocation.tonnes) &&
        transportDemandIssue(input, [...cycles.values()]) === null;
      check(valid, `车次 ${trip.id} 需求身份或装卸顺序无效`);
      if (valid)
        totals.set(allocation.demandId, (totals.get(allocation.demandId) ?? 0) + allocation.tonnes);
      return valid;
    });
    check(
      trip.segments.length === cycle.positions.length - 1,
      `车次 ${trip.id} 未覆盖完整运输循环`,
    );
    const actualEvents = vehicle.events.filter((event) => event.tripId === trip.id);
    check(allocationsEqual(trip.allocations, validAllocations), `车次 ${trip.id} 有无效需求分配`);
    check(
      trip.eventIds.length === actualEvents.length &&
        actualEvents.every((event, index) => event.id === trip.eventIds[index]),
      `车次 ${trip.id} 事件关联不一致`,
    );
    check(
      actualEvents.length > 0 &&
        close(trip.startMinute, actualEvents[0]?.startMinute ?? NaN) &&
        close(trip.endMinute, actualEvents.at(-1)?.endMinute ?? NaN),
      `车次 ${trip.id} 起止时间不一致`,
    );
    let cursor = 0;
    for (let positionIndex = 0; positionIndex < cycle.positions.length; positionIndex++) {
      const position = cycle.positions[positionIndex];
      for (const kind of ['unloading', 'loading'] as const) {
        const expected = validAllocations.filter((allocation) => {
          const demand = inputs.get(allocation.demandId)!;
          return (
            (kind === 'loading' ? demand.loadingPositionId : demand.unloadingPositionId) ===
            position.id
          );
        });
        if (!expected.length) continue;
        const event = actualEvents[cursor++];
        const duration = kind === 'loading' ? group.loadingMinutes : group.unloadingMinutes;
        check(
          !!event &&
            event.kind === kind &&
            event.fromPositionId === position.id &&
            event.toPositionId === position.id &&
            event.cycleId === cycle.id &&
            samePoint(event.from, position.point) &&
            samePoint(event.to, position.point) &&
            event.distanceMeters === 0 &&
            event.roadKey === null &&
            event.durationSource === 'operation' &&
            event.measuredSegmentId === null &&
            close(event.endMinute - event.startMinute, duration ?? NaN) &&
            allocationsEqual(event.allocations, expected) &&
            close(event.loadTonnes, sumTonnes(expected)),
          `车次 ${trip.id} 装卸事件或耗时不完整`,
        );
      }
      if (positionIndex === cycle.positions.length - 1) continue;
      const to = cycle.positions[positionIndex + 1];
      const expected = validAllocations.filter((allocation) => {
        const input = inputs.get(allocation.demandId)!;
        const first = cycle.positions.findIndex((entry) => entry.id === input.loadingPositionId);
        const last = cycle.positions.findIndex((entry) => entry.id === input.unloadingPositionId);
        return first <= positionIndex && positionIndex < last;
      });
      const load = sumTonnes(expected);
      check(load <= (group.payloadTonnes ?? 0) + tolerance, `车次 ${trip.id} 区间超载`);
      const key = directedRoadKey(position.point, to.point, cycle.strategy);
      const road = roads.get(key);
      const measured = snapshot.context.operations?.measuredSegments.find(
        (entry) =>
          entry.vehicleGroupId === group.id &&
          entry.cycleId === cycle.id &&
          entry.fromPositionId === position.id &&
          entry.toPositionId === to.id &&
          entry.durationMinutes !== null &&
          measuredSegmentIssue(
            entry,
            snapshot.context.operations!,
            [...cycles.values()],
            'travel-time',
          ) === null,
      );
      const duration =
        measured?.durationMinutes ??
        ((road?.distanceMeters ?? NaN) / 1000 / (group.speedKph ?? NaN)) * 60;
      const source = measured ? 'measured' : 'speed';
      const segment = trip.segments[positionIndex];
      check(
        !!road &&
          !!segment &&
          segment.fromPositionId === position.id &&
          segment.toPositionId === to.id &&
          segment.roadKey === key &&
          segment.distanceMeters === road.distanceMeters &&
          close(segment.durationMinutes, duration) &&
          segment.durationSource === source &&
          segment.measuredSegmentId === (measured?.id ?? null) &&
          close(segment.loadTonnes, load) &&
          allocationsEqual(segment.allocations, expected),
        `车次 ${trip.id} 区间载荷或道路时间依据不一致`,
      );
      const event = actualEvents[cursor++];
      check(
        !!event &&
          event.kind === 'transport' &&
          event.fromPositionId === position.id &&
          event.toPositionId === to.id &&
          event.cycleId === cycle.id &&
          samePoint(event.from, position.point) &&
          samePoint(event.to, to.point) &&
          event.roadKey === key &&
          event.distanceMeters === road?.distanceMeters &&
          close(event.endMinute - event.startMinute, duration) &&
          event.durationSource === source &&
          event.measuredSegmentId === (measured?.id ?? null) &&
          close(event.loadTonnes, load) &&
          allocationsEqual(event.allocations, expected),
        `车次 ${trip.id} 行驶事件未对应完整循环或实测依据`,
      );
    }
    check(cursor === actualEvents.length, `车次 ${trip.id} 存在重复或多余事件`);
    check(
      actualEvents.every(
        (event, index) =>
          index === 0 || close(event.startMinute, actualEvents[index - 1].endMinute),
      ),
      `车次 ${trip.id} 事件不连续`,
    );
  }
  for (const vehicle of result.vehicles) {
    const group = groups.get(vehicle.vehicleGroupId);
    const base = cycles.get(group?.baseCycleId ?? '');
    check(
      !!group && !!base && group.vehicleIds.slice(0, group.count).includes(vehicle.vehicleId),
      `车辆 ${vehicle.vehicleId} 不可用或归属无效`,
    );
    if (!group || !base) continue;
    check(
      vehicle.baseCycleId === base.id &&
        vehicle.basePositionId === base.positions[0].id &&
        vehicle.payloadTonnes === group.payloadTonnes,
      `车辆 ${vehicle.vehicleId} 基准或载重依据不一致`,
    );
    check(
      vehicle.shifts.length === group.shifts.length &&
        vehicle.shifts.every((shift) =>
          group.shifts.some(
            (entry) =>
              entry.startMinute === shift.startMinute && entry.endMinute === shift.endMinute,
          ),
        ),
      `车辆 ${vehicle.vehicleId} 班次依据不一致`,
    );
    const vehicleTrips = result.trips.filter((trip) => trip.vehicleId === vehicle.vehicleId);
    check(
      vehicle.tripIds.length === vehicleTrips.length &&
        new Set(vehicle.tripIds).size === vehicleTrips.length &&
        vehicleTrips.every(
          (trip, index) => vehicle.tripIds[index] === trip.id && trip.sequence === index + 1,
        ),
      `车辆 ${vehicle.vehicleId} 车次关联不一致`,
    );
    let previousPoint = base.positions[0].point;
    let previousMinute = -Infinity;
    let currentCycle = base;
    let lastShift: OperatingShift | undefined;
    for (const event of vehicle.events) {
      check(!eventIds.has(event.id), '车辆事件身份重复');
      eventIds.add(event.id);
      const shift = group.shifts.find(
        (entry) =>
          event.startMinute >= entry.startMinute - tolerance &&
          event.endMinute <= entry.endMinute + tolerance,
      );
      check(
        !!shift &&
          nonnegative(event.endMinute - event.startMinute) &&
          event.startMinute >= previousMinute - tolerance,
        `车辆 ${vehicle.vehicleId} 事件重叠或超出工作窗口`,
      );
      if (lastShift && shift !== lastShift)
        check(
          samePoint(previousPoint, base.positions[0].point),
          `车辆 ${vehicle.vehicleId} 班次间未归位`,
        );
      check(samePoint(previousPoint, event.from), `车辆 ${vehicle.vehicleId} 事件位置不连续`);
      if (event.kind === 'continuation' || event.kind === 'return') {
        const target = cycles.get(event.cycleId);
        const key = target
          ? directedRoadKey(
              currentCycle.positions[0].point,
              target.positions[0].point,
              snapshot.context.roadSettings?.continuationStrategy ?? 32,
            )
          : '';
        const road = roads.get(key);
        const duration =
          target && samePoint(currentCycle.positions[0].point, target.positions[0].point)
            ? 0
            : ((road?.distanceMeters ?? NaN) / 1000 / (group.speedKph ?? NaN)) * 60;
        check(
          !!target &&
            !!road &&
            event.tripId === null &&
            event.fromPositionId === currentCycle.positions[0].id &&
            event.toPositionId === target.positions[0].id &&
            samePoint(event.from, currentCycle.positions[0].point) &&
            samePoint(event.to, target.positions[0].point) &&
            (event.kind !== 'return' || target.id === base.id) &&
            event.roadKey === key &&
            event.distanceMeters === road.distanceMeters &&
            event.loadTonnes === 0 &&
            event.allocations.length === 0 &&
            event.durationSource === 'speed' &&
            event.measuredSegmentId === null &&
            close(event.endMinute - event.startMinute, duration),
          `车辆 ${vehicle.vehicleId} 接续或归位空驶未正确计时计里程`,
        );
        if (target) currentCycle = target;
      } else {
        const trip = trips.get(event.tripId ?? '');
        check(
          !!trip && trip.vehicleId === vehicle.vehicleId && trip.eventIds.includes(event.id),
          `车辆 ${vehicle.vehicleId} 存在未关联车次的作业事件`,
        );
        const cycle = cycles.get(event.cycleId);
        if (cycle) currentCycle = cycle;
      }
      previousPoint = event.to;
      previousMinute = event.endMinute;
      lastShift = shift;
    }
    check(
      samePoint(previousPoint, base.positions[0].point) && vehicle.returnedToBase,
      `车辆 ${vehicle.vehicleId} 未收车归位`,
    );
    check(
      close(
        vehicle.workingMinutes,
        vehicle.events.reduce((total, event) => total + event.endMinute - event.startMinute, 0),
      ),
      `车辆 ${vehicle.vehicleId} 工时汇总不一致`,
    );
    check(
      close(
        vehicle.totalDistanceMeters,
        vehicle.events.reduce((total, event) => total + event.distanceMeters, 0),
      ),
      `车辆 ${vehicle.vehicleId} 里程汇总不一致`,
    );
  }
  check(
    result.demands.length === inputs.size &&
      new Set(result.demands.map((demand) => demand.demandId)).size === inputs.size,
    '需求完成量条目不完整或重复',
  );
  for (const input of inputs.values()) {
    const actual = result.demands.find((demand) => demand.demandId === input.id);
    const completed = totals.get(input.id) ?? 0;
    check(
      completed <= input.dailyTonnes + tolerance && completed >= 0,
      `需求 ${input.id} 超计完成吨数`,
    );
    check(
      !!actual &&
        actual.cycleId === input.cycleId &&
        actual.loadingPositionId === input.loadingPositionId &&
        actual.unloadingPositionId === input.unloadingPositionId &&
        close(actual.requestedTonnes, input.dailyTonnes) &&
        close(actual.completedTonnes, completed) &&
        close(actual.missingTonnes, Math.max(0, input.dailyTonnes - completed)),
      `需求 ${input.id} 完成量或缺口不守恒`,
    );
  }
  check(
    close(
      result.totalCompletedTonnes,
      [...totals.values()].reduce((a, b) => a + b, 0),
    ),
    '总完成吨数不一致',
  );
  check(
    close(
      result.totalMissingTonnes,
      [...inputs.values()].reduce(
        (total, input) => total + Math.max(0, input.dailyTonnes - (totals.get(input.id) ?? 0)),
        0,
      ),
    ),
    '总运输缺口不一致',
  );
  check(
    close(
      result.totalDistanceMeters,
      result.vehicles.reduce((total, vehicle) => total + vehicle.totalDistanceMeters, 0),
    ),
    '总里程不一致',
  );
  check(
    result.energyStatus === 'not-checked' && result.physicalFeasibility === 'not-established',
    '运输试算不能发布完整物理可行结论',
  );
  return { valid: issues.length === 0, issues: [...new Set(issues)] };
}
