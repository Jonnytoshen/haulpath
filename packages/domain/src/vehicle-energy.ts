import type { Point, TransportCycle } from './index';
import {
  DAILY_TRANSPORT_ALGORITHM_VERSION,
  dailyTransportEventShifts,
  generateDailyTransport,
  validateDailyTransport,
} from './daily-transport';
import type {
  DailyTransportConfig,
  DailyTransportEvent,
  DailyTransportProgress,
  DailyTransportResult,
  DailyTransportSnapshot,
  DailyTransportValidation,
  DailyTransportVehicle,
} from './daily-transport';
import { representativeDayIntervals } from './operating-windows';
import { directedRoadKey } from './directed-roads';
import type { PreparedRoad } from './directed-roads';
import { measuredSegmentIssue } from './fleet-operations';
import type { OperatingShift, VehicleGroup } from './fleet-operations';
import {
  candidateSiteReadiness,
  sitingConstraintReadiness,
  stationBatteryMatches,
} from './station-network';
import type { CandidateSite } from './station-network';

export const VEHICLE_ENERGY_ALGORITHM_VERSION = 'daily-vehicle-energy-1';

export interface VehicleEnergyEvent extends Omit<DailyTransportEvent, 'kind'> {
  kind: DailyTransportEvent['kind'] | 'station-entry' | 'swap' | 'station-exit';
  baselineEventId: string;
  energyKwh: number;
  startKwh: number;
  endKwh: number;
  startSocPercent: number;
  endSocPercent: number;
  energySource: 'measured' | 'template' | 'none';
  measuredEnergySegmentId: string | null;
  stationId: string | null;
  detour: {
    extraMeters: number;
    extraMinutes: number;
    /** Calendar wait, if any, spans from event start until this minute. */
    serviceStartMinute: number;
  } | null;
}

export interface VehicleEnergyTimeline {
  vehicleId: string;
  initialKwh: number;
  finalKwh: number;
  safetyKwh: number;
  consumedKwh: number;
  workingMinutes: number;
  totalDistanceMeters: number;
  events: VehicleEnergyEvent[];
}

export interface VehicleEnergyResult {
  batteryCapacityKwh: number;
  initialSocPercent: 100 | 'periodic';
  replacementSocPercent: 100;
  totalDistanceMeters: number;
  swapCount: number;
  vehicles: VehicleEnergyTimeline[];
  stationCapacityStatus: 'not-checked' | 'checked';
  batteryInventoryStatus: 'not-checked' | 'checked';
  sharedPowerStatus: 'not-checked' | 'checked';
  periodicityStatus: 'not-checked' | 'checked';
}

type EnergyUse = Pick<VehicleEnergyEvent, 'energyKwh' | 'energySource' | 'measuredEnergySegmentId'>;
type EventBasis = Omit<
  VehicleEnergyEvent,
  | 'startMinute'
  | 'endMinute'
  | 'startKwh'
  | 'endKwh'
  | 'startSocPercent'
  | 'endSocPercent'
  | 'detour'
>;
type FixedStation = {
  site: CandidateSite;
  swapMinutes: number;
  windows: OperatingShift[];
};
type SwapOption = {
  station: FixedStation;
  entryRoad: PreparedRoad;
  exitRoad: PreparedRoad;
  entryMinutes: number;
  exitMinutes: number;
  entryEnergy: EnergyUse;
  exitEnergy: EnergyUse;
  extraMeters: number;
  extraMinutes: number;
};
type Step = {
  event: DailyTransportEvent;
  shift: OperatingShift;
  directMinutes: number;
  direct: EnergyUse | string;
  swaps: SwapOption[];
  stationIssues: string[];
  description: string;
};
type Charge = {
  usedKwh: number;
  correctionKwh: number;
};
type Label = {
  minute: number;
  charge: Charge;
  swapCount: number;
  previous: Label | null;
  visit: { option: SwapOption; serviceStartMinute: number } | null;
};

const TIME_TOLERANCE = 1e-7;
const fullCharge: Charge = { usedKwh: 0, correctionKwh: 0 };
const noEnergy: EnergyUse = { energyKwh: 0, energySource: 'none', measuredEnergySegmentId: null };

function nonnegative(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value >= 0;
}

function positive(value: number | null | undefined): value is number {
  return nonnegative(value) && value > 0;
}

function sameNumber(actual: number, expected: number, scale = expected): boolean {
  return (
    Number.isFinite(actual) &&
    Number.isFinite(expected) &&
    Math.abs(actual - expected) <=
      Number.EPSILON * 16 * Math.max(Math.abs(actual), Math.abs(expected), Math.abs(scale))
  );
}

function sameMinute(actual: number, expected: number): boolean {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= TIME_TOLERANCE;
}

function consume(charge: Charge, use: EnergyUse, usableKwh: number): Charge | null {
  if (use.energyKwh === 0) return charge;
  // Sum since the last full charge so draws smaller than one ULP of the battery still count.
  const adjusted = use.energyKwh - charge.correctionKwh;
  const usedKwh = charge.usedKwh + adjusted;
  if (
    !Number.isFinite(usedKwh) ||
    usableKwh === 0 ||
    (usedKwh > usableKwh && !sameNumber(usedKwh, usableKwh))
  )
    return null;
  return { usedKwh, correctionKwh: usedKwh - charge.usedKwh - adjusted };
}

function remainingCharge(charge: Charge, capacityKwh: number, reserveKwh: number): number {
  return Math.max(reserveKwh, capacityKwh - charge.usedKwh);
}

function compareConsumption(a: Charge, b: Charge): number {
  return a.usedKwh - b.usedKwh || b.correctionKwh - a.correctionKwh;
}

function loadFraction(group: VehicleGroup, tonnes: number): number {
  return Math.min(1, tonnes / group.payloadTonnes!);
}

function interpolatedEnergy(
  empty: number | null,
  full: number | null,
  fraction: number,
): number | null {
  if (fraction === 0 && nonnegative(empty)) return empty;
  if (fraction === 1 && nonnegative(full)) return full;
  if (!nonnegative(empty) || !nonnegative(full) || full < empty) return null;
  return empty + (full - empty) * fraction;
}

function templateEnergy(group: VehicleGroup, metres: number, tonnes: number): EnergyUse | string {
  const perKm = interpolatedEnergy(
    group.emptyKwhPerKm,
    group.fullKwhPerKm,
    loadFraction(group, tonnes),
  );
  if (metres === 0) return { ...noEnergy, energySource: 'template' };
  if (perKm === null) return '缺少对应载荷的运营模板耗电';
  const energyKwh = perKm * (metres / 1000);
  if (!nonnegative(energyKwh) || (perKm > 0 && energyKwh === 0)) return '模板耗电超出可计算范围';
  return { energyKwh, energySource: 'template', measuredEnergySegmentId: null };
}

function directEnergy(
  snapshot: DailyTransportSnapshot,
  group: VehicleGroup,
  event: DailyTransportEvent,
  cycle: TransportCycle,
): EnergyUse | string {
  if (event.kind === 'loading' || event.kind === 'unloading') return noEnergy;
  const operations = snapshot.context.operations!;
  const measured =
    event.kind === 'transport'
      ? operations.measuredSegments.find(
          (entry) =>
            entry.vehicleGroupId === group.id &&
            entry.cycleId === event.cycleId &&
            entry.fromPositionId === event.fromPositionId &&
            entry.toPositionId === event.toPositionId &&
            (entry.emptyKwh !== null || entry.fullKwh !== null),
        )
      : undefined;
  if (!measured) return templateEnergy(group, event.distanceMeters, event.loadTonnes);
  const issue = measuredSegmentIssue(measured, operations, [cycle]);
  if (issue || measured.basis.payloadTonnes !== group.payloadTonnes) {
    const fallback = templateEnergy(group, event.distanceMeters, event.loadTonnes);
    const reason = issue ?? '实测满载依据已改变，须重新确认';
    return typeof fallback === 'string' ? `${reason}；${fallback}` : fallback;
  }
  if (
    !measured.source.trim() ||
    !nonnegative(measured.emptyKwh) ||
    !nonnegative(measured.fullKwh) ||
    measured.fullKwh < measured.emptyKwh
  )
    return '实测空满载耗电或来源无效';
  return {
    energyKwh:
      measured.emptyKwh +
      (measured.fullKwh - measured.emptyKwh) * loadFraction(group, event.loadTonnes),
    energySource: 'measured',
    measuredEnergySegmentId: measured.id,
  };
}

function fixedStations(snapshot: DailyTransportSnapshot): {
  stations: FixedStation[];
  issues: string[];
} {
  const stations: FixedStation[] = [];
  const issues: string[] = [];
  const network = snapshot.context.stationNetwork;
  const battery = snapshot.context.operations?.battery ?? null;
  if (!network) return { stations, issues };
  for (const selection of network.fixedLayout) {
    const site = network.sites.find((candidate) => candidate.id === selection.siteId);
    const type = network.stationTypes.find((candidate) => candidate.id === selection.stationTypeId);
    const label = `站址“${site?.name ?? selection.siteId}”`;
    if (!site || !type) {
      issues.push(`${label}：固定布局站址或站型已失效`);
      continue;
    }
    const siteIssues = candidateSiteReadiness(site, network);
    if (siteIssues.length) {
      issues.push(`${label}：${siteIssues.join('、')}`);
      continue;
    }
    if (!stationBatteryMatches(type.batteryBasis, battery)) {
      issues.push(`${label}：站型与统一电池规格不兼容，须重新关联`);
      continue;
    }
    if (!positive(type.swapMinutes) || !type.serviceWindows.length || !type.source.trim()) {
      issues.push(`${label}：换电时间、服务窗口或站型来源待完善`);
      continue;
    }
    stations.push({
      site,
      swapMinutes: type.swapMinutes,
      windows: representativeDayIntervals(type.serviceWindows),
    });
  }
  return { stations, issues };
}

function drivingMinutes(road: PreparedRoad, group: VehicleGroup): number {
  if (road.distanceMeters === 0) return 0;
  return positive(group.speedKph) ? (road.distanceMeters / 1000 / group.speedKph) * 60 : NaN;
}

function validRoad(road: PreparedRoad | undefined): road is PreparedRoad {
  return (
    !!road &&
    Number.isSafeInteger(road.distanceMeters) &&
    road.distanceMeters >= 0 &&
    road.key === directedRoadKey(road.from, road.to, road.strategy)
  );
}

function stationOption(
  snapshot: DailyTransportSnapshot,
  roads: Map<string, PreparedRoad>,
  cycle: TransportCycle,
  group: VehicleGroup,
  event: DailyTransportEvent,
  directMinutes: number,
  station: FixedStation,
): SwapOption | string {
  const entryRoad = roads.get(directedRoadKey(event.from, station.site, cycle.strategy));
  const exitRoad = roads.get(directedRoadKey(station.site, event.to, cycle.strategy));
  if (
    !validRoad(entryRoad) ||
    !validRoad(exitRoad) ||
    !Number.isSafeInteger(entryRoad.distanceMeters + exitRoad.distanceMeters)
  )
    return '缺少有效的有向进站或出站道路资料';
  const entryMinutes = drivingMinutes(entryRoad, group);
  const exitMinutes = drivingMinutes(exitRoad, group);
  const travelMinutes = entryMinutes + exitMinutes;
  if (!nonnegative(travelMinutes)) return '缺少可用的绕行行驶速度';
  const extraMeters = Math.max(
    0,
    entryRoad.distanceMeters + exitRoad.distanceMeters - event.distanceMeters,
  );
  const extraMinutes = sameNumber(travelMinutes, directMinutes)
    ? 0
    : Math.max(0, travelMinutes - directMinutes);
  const limits = snapshot.context.swapDetourLimits;
  if (limits?.maxExtraMeters != null && extraMeters > limits.maxExtraMeters)
    return `绕行超限：额外 ${extraMeters} 米，限额 ${limits.maxExtraMeters} 米`;
  if (
    limits?.maxExtraMinutes != null &&
    extraMinutes > limits.maxExtraMinutes &&
    !sameNumber(extraMinutes, limits.maxExtraMinutes, travelMinutes)
  )
    return `绕行超限：额外 ${extraMinutes} 分钟，限额 ${limits.maxExtraMinutes} 分钟`;
  const entryEnergy = templateEnergy(group, entryRoad.distanceMeters, event.loadTonnes);
  const exitEnergy = templateEnergy(group, exitRoad.distanceMeters, event.loadTonnes);
  if (typeof entryEnergy === 'string') return `进站${entryEnergy}`;
  if (typeof exitEnergy === 'string') return `出站${exitEnergy}`;
  return {
    station,
    entryRoad,
    exitRoad,
    entryMinutes,
    exitMinutes,
    entryEnergy,
    exitEnergy,
    extraMeters,
    extraMinutes,
  };
}

export function vehicleEnergyReadiness(snapshot: DailyTransportSnapshot): string[] {
  const battery = snapshot.context.operations?.battery;
  const gaps: string[] = sitingConstraintReadiness(snapshot.context);
  if (!positive(battery?.capacityKwh)) gaps.push('统一电池容量待配置');
  if (!battery?.source.trim()) gaps.push('统一电池参数来源待填写');
  return gaps;
}

function safetyKwh(group: VehicleGroup, capacityKwh: number): number | null {
  const percent = group.safetySocPercent;
  if (!nonnegative(percent) || percent > 100) return null;
  return percent === 0 ? 0 : Math.max(Number.MIN_VALUE, (percent / 100) * capacityKwh);
}

function stepsForVehicle(
  inputs: ReturnType<typeof inputMaps>,
  vehicle: DailyTransportVehicle,
  group: VehicleGroup,
): Step[] {
  const { snapshot, trips, roads, cycles, fixed } = inputs;
  const shifts = dailyTransportEventShifts(vehicle, trips);
  return vehicle.events.map((event) => {
    const shift = shifts.get(event.id);
    const cycle = cycles.get(event.cycleId)!;
    const segmentIndex = cycle.positions.findIndex(
      (position) => position.id === event.fromPositionId,
    );
    const description =
      event.kind === 'transport'
        ? `循环“${cycle.name}”第 ${segmentIndex + 1} 区间“${event.from.name} → ${event.to.name}”`
        : `${
            event.kind === 'return'
              ? '归位空驶'
              : event.kind === 'continuation'
                ? '跨线接续空驶'
                : event.kind === 'loading'
                  ? '装货'
                  : '卸货'
          }“${event.from.name} → ${event.to.name}”`;
    if (!shift) throw new Error(`车辆 ${vehicle.vehicleId} 的${description}缺少已核对的班次`);
    const swaps: SwapOption[] = [];
    const stationIssues: string[] = [];
    let directMinutes = event.endMinute - event.startMinute;
    if (event.kind === 'transport') {
      directMinutes = trips.get(event.tripId!)!.segments[segmentIndex].durationMinutes;
      stationIssues.push(...fixed.issues);
      if (!fixed.stations.length && !fixed.issues.length)
        stationIssues.push('固定布局没有可用的兼容换电站');
      for (const station of fixed.stations) {
        const option = stationOption(snapshot, roads, cycle, group, event, directMinutes, station);
        if (typeof option === 'string') stationIssues.push(`站址“${station.site.name}”：${option}`);
        else swaps.push(option);
      }
    }
    return {
      event,
      shift,
      directMinutes,
      direct: directEnergy(snapshot, group, event, cycle),
      swaps,
      stationIssues,
      description,
    };
  });
}

function earliestServiceStart(option: SwapOption, arrivalMinute: number): number | null {
  for (const window of option.station.windows) {
    const start = Math.max(arrivalMinute, window.startMinute);
    if (start + option.station.swapMinutes <= window.endMinute + TIME_TOLERANCE) return start;
  }
  return null;
}

function startOfStep(step: Step, previousStep: Step | undefined, previousMinute: number): number {
  return previousStep?.shift === step.shift ? previousMinute : step.shift.startMinute;
}

function preferredLabels(labels: Label[], requireSwap = false): Label[] {
  // Earlier arrival with at least as much energy and no additional swaps dominates.
  // Calendar waiting preserves that property even at a station that is not yet open.
  labels.sort(
    (a, b) =>
      a.minute - b.minute || a.swapCount - b.swapCount || compareConsumption(a.charge, b.charge),
  );
  const kept: Label[] = [];
  for (const label of labels) {
    if (
      !kept.some(
        (earlier) =>
          (!requireSwap || label.swapCount === 0 || earlier.swapCount > 0) &&
          earlier.swapCount <= label.swapCount &&
          compareConsumption(earlier.charge, label.charge) <= 0,
      )
    )
      kept.push(label);
  }
  return kept;
}

function solveVehicle(
  vehicle: DailyTransportVehicle,
  steps: Step[],
  capacityKwh: number,
  reserveKwh: number,
  deadline: number,
  initialKwh = capacityKwh,
  requireSwap = false,
): Label {
  const usableKwh = capacityKwh - reserveKwh;
  let frontier: Label[] = [
    {
      minute: 0,
      charge: { usedKwh: capacityKwh - initialKwh, correctionKwh: 0 },
      swapCount: 0,
      previous: null,
      visit: null,
    },
  ];
  for (const [index, step] of steps.entries()) {
    if (Date.now() > deadline) throw new Error('车辆电量试算达到时限，未发布阶段结果');
    const next: Label[] = [];
    const reasons = new Set<string>();
    for (const previous of frontier) {
      const start = startOfStep(step, steps[index - 1], previous.minute);
      if (typeof step.direct === 'string') reasons.add(`直达：${step.direct}`);
      else {
        const charge = consume(previous.charge, step.direct, usableKwh);
        const minute = start + step.directMinutes;
        if (charge === null) reasons.add('直达能量不足，行驶途中将低于安全电量');
        else if (minute > step.shift.endMinute + TIME_TOLERANCE)
          reasons.add('计入绕行及换电后，本事件超出班次窗口');
        else next.push({ minute, charge, swapCount: previous.swapCount, previous, visit: null });
      }
      for (const option of step.swaps) {
        const prefix = `站址“${option.station.site.name}”`;
        const arrival = start + option.entryMinutes;
        const serviceStartMinute = earliestServiceStart(option, arrival);
        const charge = consume(fullCharge, option.exitEnergy, usableKwh);
        if (consume(previous.charge, option.entryEnergy, usableKwh) === null)
          reasons.add(`${prefix}：无法到站，进站途中将低于安全电量`);
        else if (charge === null) reasons.add(`${prefix}：换电后驶离站点仍会低于安全电量`);
        else if (serviceStartMinute === null) reasons.add(`${prefix}：服务窗口内无法完成换电`);
        else {
          const minute = serviceStartMinute + option.station.swapMinutes + option.exitMinutes;
          if (minute > step.shift.endMinute + TIME_TOLERANCE)
            reasons.add(`${prefix}：绕行、服务窗口等待与换电超出班次`);
          else
            next.push({
              minute,
              charge,
              swapCount: previous.swapCount + 1,
              previous,
              visit: { option, serviceStartMinute },
            });
        }
      }
    }
    if (!next.length) {
      const details = [...reasons, ...step.stationIssues];
      const shown = details.slice(0, 8);
      if (details.length > shown.length)
        shown.push(`另有 ${details.length - shown.length} 项站址限制`);
      throw new Error(
        `车辆 ${vehicle.vehicleId}（${vehicle.vehicleGroupName}）${step.description}：本次未找到通过车辆电量校核的安排。${shown.join('；')}`,
      );
    }
    frontier = preferredLabels(next, requireSwap);
  }
  if (requireSwap) frontier = frontier.filter((label) => label.swapCount > 0);
  if (!frontier.length)
    throw new Error(`车辆 ${vehicle.vehicleId} 未找到可恢复周期电量的换电安排；不证明全局无解`);
  return frontier.reduce((preferred, label) =>
    label.swapCount < preferred.swapCount ? label : preferred,
  );
}

function directBasis(event: DailyTransportEvent, use: EnergyUse): EventBasis {
  return { ...event, ...use, baselineEventId: event.id, stationId: null };
}

function visitBases(
  event: DailyTransportEvent,
  option: SwapOption,
): [EventBasis, EventBasis, EventBasis] {
  const { site } = option.station;
  const shared = {
    ...event,
    baselineEventId: event.id,
    stationId: site.id,
    measuredSegmentId: null,
  };
  return [
    {
      ...shared,
      ...option.entryEnergy,
      id: `${event.id}-station-entry`,
      kind: 'station-entry',
      to: site,
      toPositionId: site.id,
      distanceMeters: option.entryRoad.distanceMeters,
      roadKey: option.entryRoad.key,
      durationSource: 'speed',
    },
    {
      ...shared,
      ...noEnergy,
      id: `${event.id}-swap`,
      kind: 'swap',
      from: site,
      to: site,
      fromPositionId: site.id,
      toPositionId: site.id,
      distanceMeters: 0,
      roadKey: null,
      durationSource: 'operation',
    },
    {
      ...shared,
      ...option.exitEnergy,
      id: `${event.id}-station-exit`,
      kind: 'station-exit',
      from: site,
      fromPositionId: site.id,
      distanceMeters: option.exitRoad.distanceMeters,
      roadKey: option.exitRoad.key,
      durationSource: 'speed',
    },
  ];
}

function timedEvent(
  basis: EventBasis,
  startMinute: number,
  endMinute: number,
  startKwh: number,
  endKwh: number,
  capacityKwh: number,
  detour: VehicleEnergyEvent['detour'] = null,
): VehicleEnergyEvent {
  return {
    ...basis,
    startMinute,
    endMinute,
    startKwh,
    endKwh,
    startSocPercent: (startKwh / capacityKwh) * 100,
    endSocPercent: (endKwh / capacityKwh) * 100,
    detour,
  };
}

function timeline(
  vehicleId: string,
  steps: Step[],
  last: Label,
  capacityKwh: number,
  reserveKwh: number,
  initialKwh = capacityKwh,
): VehicleEnergyTimeline {
  const usableKwh = capacityKwh - reserveKwh;
  const chargeKwh = (charge: Charge) => remainingCharge(charge, capacityKwh, reserveKwh);
  const labels: Label[] = [];
  for (let label = last; label.previous; label = label.previous) labels.push(label);
  labels.reverse();
  const events = labels.flatMap((label, index) => {
    const step = steps[index];
    const previous = label.previous!;
    const start = startOfStep(step, steps[index - 1], previous.minute);
    if (!label.visit)
      return [
        timedEvent(
          directBasis(step.event, step.direct as EnergyUse),
          start,
          label.minute,
          chargeKwh(previous.charge),
          chargeKwh(label.charge),
          capacityKwh,
        ),
      ];
    const { option, serviceStartMinute } = label.visit;
    const [entry, swap, exit] = visitBases(step.event, option);
    const arrival = start + option.entryMinutes;
    const atStation = chargeKwh(consume(previous.charge, option.entryEnergy, usableKwh)!);
    const departure = serviceStartMinute + option.station.swapMinutes;
    return [
      timedEvent(entry, start, arrival, chargeKwh(previous.charge), atStation, capacityKwh),
      timedEvent(swap, arrival, departure, atStation, capacityKwh, capacityKwh, {
        extraMeters: option.extraMeters,
        extraMinutes: option.extraMinutes,
        serviceStartMinute,
      }),
      timedEvent(exit, departure, label.minute, capacityKwh, chargeKwh(label.charge), capacityKwh),
    ];
  });
  return {
    vehicleId,
    initialKwh,
    finalKwh: chargeKwh(last.charge),
    safetyKwh: reserveKwh,
    consumedKwh: events.reduce((sum, event) => sum + event.energyKwh, 0),
    workingMinutes: events.reduce((sum, event) => sum + (event.endMinute - event.startMinute), 0),
    totalDistanceMeters: events.reduce((sum, event) => sum + event.distanceMeters, 0),
    events,
  };
}

function inputMaps(snapshot: DailyTransportSnapshot, result: DailyTransportResult) {
  return {
    snapshot,
    groups: new Map(snapshot.context.operations!.vehicleGroups.map((group) => [group.id, group])),
    trips: new Map(result.trips.map((trip) => [trip.id, trip])),
    roads: new Map(snapshot.roads.map((road) => [road.key, road])),
    cycles: new Map(snapshot.context.transportCycles!.map((cycle) => [cycle.id, cycle])),
    fixed: fixedStations(snapshot),
  };
}

export interface VehicleEnergyStart {
  initialKwh: ReadonlyMap<string, number>;
  requireSwap: boolean;
  notBefore?: ReadonlyMap<string, number>;
}

/** Keep the checked 09 schedule as the direct basis, then look ahead along each vehicle's work. */
export function generateVehicleEnergy(
  snapshot: DailyTransportSnapshot,
  onProgress?: (progress: DailyTransportProgress) => void,
  config: DailyTransportConfig = { seed: 1, maxRuntimeMs: 10 * 60 * 1000 },
  start?: VehicleEnergyStart,
): DailyTransportResult {
  const deadline = Date.now() + config.maxRuntimeMs;
  const gaps = vehicleEnergyReadiness(snapshot);
  if (gaps.length) throw new Error(gaps.join('；'));
  const baseline = generateDailyTransport(snapshot, onProgress, config, start?.notBefore);
  const inputs = inputMaps(snapshot, baseline);
  const capacityKwh = snapshot.context.operations!.battery!.capacityKwh!;
  const vehicles: VehicleEnergyTimeline[] = [];
  for (const vehicle of baseline.vehicles) {
    const group = inputs.groups.get(vehicle.vehicleGroupId)!;
    const reserveKwh = safetyKwh(group, capacityKwh);
    if (reserveKwh === null) {
      if (!vehicle.events.length) continue;
      throw new Error(`车辆 ${vehicle.vehicleId}（${group.name}）安全电量待配置`);
    }
    const steps = stepsForVehicle(inputs, vehicle, group);
    const initialKwh = start?.initialKwh.get(vehicle.vehicleId) ?? capacityKwh;
    if (!Number.isFinite(initialKwh) || initialKwh < reserveKwh || initialKwh > capacityKwh)
      throw new Error(`车辆 ${vehicle.vehicleId} 的周期出发电量无效`);
    const requireSwap =
      start?.requireSwap &&
      steps.some((step) => typeof step.direct !== 'string' && step.direct.energyKwh > 0);
    const plan = solveVehicle(
      vehicle,
      steps,
      capacityKwh,
      reserveKwh,
      deadline,
      initialKwh,
      requireSwap,
    );
    vehicles.push(timeline(vehicle.vehicleId, steps, plan, capacityKwh, reserveKwh, initialKwh));
  }
  const result: DailyTransportResult = {
    ...baseline,
    algorithmVersion: VEHICLE_ENERGY_ALGORITHM_VERSION,
    energyStatus: 'checked',
    vehicleEnergy: {
      batteryCapacityKwh: capacityKwh,
      initialSocPercent: start ? 'periodic' : 100,
      replacementSocPercent: 100,
      totalDistanceMeters: vehicles.reduce((sum, vehicle) => sum + vehicle.totalDistanceMeters, 0),
      swapCount: vehicles.reduce(
        (sum, vehicle) => sum + vehicle.events.filter((event) => event.kind === 'swap').length,
        0,
      ),
      vehicles,
      stationCapacityStatus: 'not-checked',
      batteryInventoryStatus: 'not-checked',
      sharedPowerStatus: 'not-checked',
      periodicityStatus: 'not-checked',
    },
    limitations: [
      '车辆电量已校核。工位、库存及充电周转、共享电源和 24 小时周期尚待校核。',
      '首日出发与每次换入按满电试算，班次间延续实际剩余电量。',
      '沿已构造的车次及班次查找插站安排，每个业务区间至多插入一站；本次构造不证明全局无解。',
      ...baseline.limitations.slice(1),
    ],
  };
  result.validation = validateVehicleEnergy(snapshot, result, start?.initialKwh);
  if (!result.validation.valid)
    throw new Error(`车辆电量独立校验未通过：${result.validation.issues.join('；')}`);
  return result;
}

function samePoint(actual: Point, expected: Point): boolean {
  return (
    actual.id === expected.id &&
    actual.name === expected.name &&
    actual.longitude === expected.longitude &&
    actual.latitude === expected.latitude &&
    actual.originalLongitude === expected.originalLongitude &&
    actual.originalLatitude === expected.originalLatitude &&
    actual.coordinateSystem === expected.coordinateSystem &&
    actual.source === expected.source &&
    actual.poiId === expected.poiId
  );
}

function matchesEventBasis(event: VehicleEnergyEvent, expected: EventBasis): boolean {
  return (
    event.id === expected.id &&
    event.baselineEventId === expected.baselineEventId &&
    event.kind === expected.kind &&
    event.tripId === expected.tripId &&
    event.cycleId === expected.cycleId &&
    event.fromPositionId === expected.fromPositionId &&
    event.toPositionId === expected.toPositionId &&
    samePoint(event.from, expected.from) &&
    samePoint(event.to, expected.to) &&
    event.stationId === expected.stationId &&
    event.roadKey === expected.roadKey &&
    event.distanceMeters === expected.distanceMeters &&
    event.loadTonnes === expected.loadTonnes &&
    event.allocations.length === expected.allocations.length &&
    event.allocations.every(
      (allocation, index) =>
        allocation.demandId === expected.allocations[index].demandId &&
        allocation.tonnes === expected.allocations[index].tonnes,
    ) &&
    event.durationSource === expected.durationSource &&
    event.measuredSegmentId === expected.measuredSegmentId &&
    event.energySource === expected.energySource &&
    event.measuredEnergySegmentId === expected.measuredEnergySegmentId &&
    sameNumber(event.energyKwh, expected.energyKwh)
  );
}

/** Replay the published proposal against checked cargo anchors and immutable road/energy inputs. */
export function validateVehicleEnergy(
  snapshot: DailyTransportSnapshot,
  result: DailyTransportResult,
  initialKwh?: ReadonlyMap<string, number>,
): DailyTransportValidation {
  const { issues } = validateDailyTransport(snapshot, {
    ...result,
    algorithmVersion: DAILY_TRANSPORT_ALGORITHM_VERSION,
    energyStatus: 'not-checked',
    physicalFeasibility: 'not-established',
    vehicleEnergy: undefined,
  });
  issues.push(...vehicleEnergyReadiness(snapshot));
  if (issues.length) return { valid: false, issues };
  const capacityKwh = snapshot.context.operations!.battery!.capacityKwh!;
  const energy = result.vehicleEnergy;
  if (
    !energy ||
    result.algorithmVersion !== VEHICLE_ENERGY_ALGORITHM_VERSION ||
    result.energyStatus !== 'checked' ||
    result.physicalFeasibility !== 'not-established' ||
    energy.batteryCapacityKwh !== capacityKwh ||
    energy.initialSocPercent !== (initialKwh ? 'periodic' : 100) ||
    energy.replacementSocPercent !== 100 ||
    energy.stationCapacityStatus !== 'not-checked' ||
    energy.batteryInventoryStatus !== 'not-checked' ||
    energy.sharedPowerStatus !== 'not-checked' ||
    energy.periodicityStatus !== 'not-checked'
  )
    return { valid: false, issues: ['电池规格、初始电量或阶段校核口径不一致'] };
  const inputs = inputMaps(snapshot, result);
  const reported = new Map(energy.vehicles.map((vehicle) => [vehicle.vehicleId, vehicle]));
  let expectedVehicles = 0;
  let swapCount = 0;
  let totalDistanceMeters = 0;
  const ids = new Set<string>();
  for (const vehicle of result.vehicles) {
    const group = inputs.groups.get(vehicle.vehicleGroupId)!;
    const reserve = safetyKwh(group, capacityKwh);
    if (reserve === null && !vehicle.events.length) continue;
    expectedVehicles++;
    const actual = reported.get(vehicle.vehicleId);
    const prefix = `车辆 ${vehicle.vehicleId}`;
    if (reserve === null || !actual) {
      issues.push(`${prefix}安全电量或逐车电量账目缺失`);
      continue;
    }
    const initial = initialKwh?.get(vehicle.vehicleId) ?? capacityKwh;
    if (
      !Number.isFinite(initial) ||
      initial < reserve ||
      initial > capacityKwh ||
      actual.initialKwh !== initial ||
      actual.safetyKwh !== reserve
    )
      issues.push(`${prefix}初始电量或安全余量不一致`);
    const steps = stepsForVehicle(inputs, vehicle, group);
    let cursor = 0;
    let previousMinute = 0;
    const usableKwh = capacityKwh - reserve;
    const chargeKwh = (charge: Charge) => remainingCharge(charge, capacityKwh, reserve);
    let charge = { usedKwh: capacityKwh - initial, correctionKwh: 0 };
    let consumedKwh = 0;
    let workingMinutes = 0;
    let distanceMeters = 0;
    for (const [index, step] of steps.entries()) {
      const reason = `${prefix}${step.description}`;
      const event = actual.events[cursor];
      const start = startOfStep(step, steps[index - 1], previousMinute);
      function checkEvent(
        actualEvent: VehicleEnergyEvent | undefined,
        basis: EventBasis,
        startMinute: number,
        endMinute: number,
      ) {
        const startKwh = chargeKwh(charge);
        const endCharge = basis.kind === 'swap' ? fullCharge : consume(charge, basis, usableKwh);
        const endKwh = endCharge === null ? null : chargeKwh(endCharge);
        if (
          !actualEvent ||
          !matchesEventBasis(actualEvent, basis) ||
          ids.has(actualEvent.id) ||
          !sameMinute(actualEvent.startMinute, startMinute) ||
          !sameMinute(actualEvent.endMinute, endMinute) ||
          actualEvent.endMinute < actualEvent.startMinute ||
          actualEvent.startMinute < step.shift.startMinute - TIME_TOLERANCE ||
          actualEvent.endMinute > step.shift.endMinute + TIME_TOLERANCE ||
          endKwh === null ||
          !sameNumber(actualEvent.startKwh, startKwh, capacityKwh) ||
          !sameNumber(actualEvent.endKwh, endKwh, capacityKwh) ||
          !sameNumber(actualEvent.startSocPercent, (startKwh / capacityKwh) * 100, 100) ||
          !sameNumber(actualEvent.endSocPercent, (endKwh / capacityKwh) * 100, 100) ||
          (basis.kind !== 'swap' && actualEvent.detour !== null)
        )
          issues.push(`${reason}事件、班次或安全电量依据不一致`);
        if (actualEvent) ids.add(actualEvent.id);
        if (endCharge !== null) charge = endCharge;
        consumedKwh += basis.energyKwh;
        distanceMeters += basis.distanceMeters;
        workingMinutes += endMinute - startMinute;
        previousMinute = endMinute;
      }

      if (event?.kind === 'station-entry') {
        const option = step.swaps.find((swap) => swap.station.site.id === event.stationId);
        const swapEvent = actual.events[cursor + 1];
        const detour = swapEvent?.detour;
        if (!option || !detour) {
          issues.push(`${reason}换电站或绕行依据无效`);
          break;
        }
        const arrival = start + option.entryMinutes;
        const serviceStart = detour.serviceStartMinute;
        const departure = serviceStart + option.station.swapMinutes;
        if (
          detour.extraMeters !== option.extraMeters ||
          !sameMinute(detour.extraMinutes, option.extraMinutes) ||
          !Number.isFinite(serviceStart) ||
          serviceStart < arrival - TIME_TOLERANCE ||
          !option.station.windows.some(
            (window) =>
              serviceStart >= window.startMinute - TIME_TOLERANCE &&
              departure <= window.endMinute + TIME_TOLERANCE,
          )
        )
          issues.push(`${reason}绕行限额、服务等待或服务窗口不一致`);
        const [entry, swap, exit] = visitBases(step.event, option);
        checkEvent(event, entry, start, arrival);
        checkEvent(swapEvent, swap, arrival, departure);
        checkEvent(actual.events[cursor + 2], exit, departure, departure + option.exitMinutes);
        swapCount++;
        cursor += 3;
      } else {
        if (typeof step.direct === 'string') {
          issues.push(`${reason}直达依据无效：${step.direct}`);
          break;
        }
        checkEvent(event, directBasis(step.event, step.direct), start, start + step.directMinutes);
        cursor++;
      }
    }
    if (
      cursor !== actual.events.length ||
      !sameNumber(actual.finalKwh, chargeKwh(charge), capacityKwh) ||
      !sameNumber(actual.consumedKwh, consumedKwh) ||
      !sameMinute(actual.workingMinutes, workingMinutes) ||
      !Number.isSafeInteger(distanceMeters) ||
      actual.totalDistanceMeters !== distanceMeters
    )
      issues.push(`${prefix}事件数量、电量、里程或工时账目不一致`);
    totalDistanceMeters += distanceMeters;
  }
  if (
    expectedVehicles !== reported.size ||
    reported.size !== energy.vehicles.length ||
    energy.swapCount !== swapCount ||
    !Number.isSafeInteger(totalDistanceMeters) ||
    energy.totalDistanceMeters !== totalDistanceMeters
  )
    issues.push('车辆电量结果的车辆、里程或换电次数汇总不一致');
  return { valid: issues.length === 0, issues };
}
