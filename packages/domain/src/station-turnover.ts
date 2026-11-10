import type { DailyTransportSnapshot, DailyTransportValidation } from './daily-transport';
import type { OperatingShift } from './fleet-operations';
import { REPRESENTATIVE_DAY_MINUTES, representativeDayIntervals } from './operating-windows';
import { stationNetworkReadiness } from './station-network';
import type { VehicleEnergyEvent, VehicleEnergyResult } from './vehicle-energy';
import { createSharedPowerCalendar, powerFits } from './shared-power';

export type StationSwapWaitReason = 'service-window' | 'bay' | 'full-battery';
export type StationChargeWaitReason =
  'charge-window' | 'charging-slot' | 'local-power' | 'shared-power' | 'horizon';

export interface StationSwapArrival {
  stationId: string;
  vehicleId: string;
  eventId: string;
  arrivalMinute: number;
  returnedKwh: number;
}

export interface StationSwapEvent extends StationSwapArrival {
  serviceStartMinute: number;
  endMinute: number;
  bay: number;
  waitReasons: StationSwapWaitReason[];
  fullBatteriesAfterStart: number;
}

export interface StationChargeEvent {
  swapEventId: string;
  returnedMinute: number;
  returnedKwh: number;
  startMinute: number | null;
  endMinute: number | null;
  gridPowerKw: number;
  /** Full-session energy. With no start minute, this is the unscheduled requirement. */
  gridEnergyKwh: number;
  addedKwh: number;
  efficiency: number;
  statusAtHorizon: 'full' | 'pending' | 'charging';
  waitReasons: StationChargeWaitReason[];
}

export interface StationTurnoverLedger {
  stationId: string;
  stationName: string;
  stationTypeId: string;
  stationTypeName: string;
  powerSourceId: string;
  bays: number;
  chargingSlots: number;
  stationPowerKw: number;
  sitePowerKw: number;
  initialFullBatteries: number;
  horizonInventory: { full: number; pending: number; charging: number };
  swaps: StationSwapEvent[];
  charges: StationChargeEvent[];
}

export interface StationTurnoverResult {
  horizonMinute: number;
  initialBatterySocPercent: 100;
  stations: StationTurnoverLedger[];
}

type StationBasis = Omit<StationTurnoverLedger, 'horizonInventory' | 'swaps' | 'charges'>;
type StationCalendar = {
  basis: StationBasis;
  swapMinutes: number;
  serviceWindows: OperatingShift[];
  chargeWindows: OperatingShift[];
};
type ExpectedSwap = { vehicleId: string; event: VehicleEnergyEvent };
type StationTurnoverInput = {
  capacityKwh: number;
  gridPowerKw: number;
  efficiency: number;
  horizonMinute: number;
  stations: StationCalendar[];
};

const TIME_TOLERANCE = 1e-7;

export function stationTurnoverReadiness(snapshot: DailyTransportSnapshot): string[] {
  return stationNetworkReadiness(snapshot.context);
}

function stationTurnoverInput(snapshot: DailyTransportSnapshot): StationTurnoverInput {
  const { operations, stationNetwork } = snapshot.context;
  const battery = operations!.battery!;
  const network = stationNetwork!;
  let horizonMinute = REPRESENTATIVE_DAY_MINUTES;
  for (const group of operations!.vehicleGroups)
    if (group.count > 0)
      for (const shift of group.shifts) horizonMinute = Math.max(horizonMinute, shift.endMinute);
  return {
    capacityKwh: battery.capacityKwh!,
    gridPowerKw: battery.chargePowerKw!,
    efficiency: battery.chargeEfficiency!,
    horizonMinute,
    stations: network.fixedLayout.map(({ siteId, stationTypeId }) => {
      const site = network.sites.find((candidate) => candidate.id === siteId)!;
      const type = network.stationTypes.find((candidate) => candidate.id === stationTypeId)!;
      return {
        basis: {
          stationId: siteId,
          stationName: site.name,
          stationTypeId,
          stationTypeName: type.name,
          powerSourceId: site.connection!.powerSourceId,
          bays: type.bays!,
          chargingSlots: type.chargingSlots!,
          stationPowerKw: type.chargePowerKw!,
          sitePowerKw: site.connection!.availablePowerKw!,
          initialFullBatteries: type.batteryInventory!,
        },
        swapMinutes: type.swapMinutes!,
        serviceWindows: representativeDayIntervals(type.serviceWindows),
        chargeWindows: chargingIntervals(type.chargeWindows),
      };
    }),
  };
}

function chargingIntervals(windows: OperatingShift[]): OperatingShift[] {
  // A charge started near the end of an overnight shift can extend into the next calendar day.
  const intervals = representativeDayIntervals(windows, 2);
  if (
    intervals.some(
      ({ startMinute, endMinute }) => endMinute - startMinute >= REPRESENTATIVE_DAY_MINUTES,
    )
  )
    return [{ startMinute: 0, endMinute: Infinity }];
  return intervals;
}

function chargingCapacity(basis: StationBasis, gridPowerKw: number): number {
  const limit = Math.min(basis.stationPowerKw, basis.sitePowerKw);
  const count = Math.min(basis.chargingSlots, Math.ceil(limit / gridPowerKw));
  return powerFits(count * gridPowerKw, limit) ? count : count - 1;
}

function nextWindowStart(
  windows: OperatingShift[],
  minute: number,
  duration: number,
): number | null {
  for (const window of windows) {
    const start = Math.max(minute, window.startMinute);
    if (start + duration <= window.endMinute + TIME_TOLERANCE) return start;
  }
  return null;
}

/** Allocate entries only as a resource is first needed, even for very large configured counts. */
function nextResource(releases: number[], count: number, minute: number) {
  let index = 0;
  for (let candidate = 1; candidate < releases.length; candidate++)
    if (releases[candidate] < releases[index]) index = candidate;
  if (!releases.length || (releases[index] > minute && releases.length < count))
    return { index: releases.length, readyMinute: 0 };
  return { index, readyMinute: releases[index] };
}

function failedSwap(station: StationCalendar, arrival: StationSwapArrival, reason: string): Error {
  return new Error(
    `车辆 ${arrival.vehicleId} 在第 ${arrival.arrivalMinute} 分钟抵达站址“${station.basis.stationName}”，本次未找到通过站内周转校核的安排：${reason}`,
  );
}

const swapWaitLabels: Record<StationSwapWaitReason, string> = {
  'service-window': '等待服务窗口',
  bay: '工位占用',
  'full-battery': '满电电池不足',
};
const chargeWaitLabels: Record<StationChargeWaitReason, string> = {
  'charge-window': '充电窗口无法安排连续充电',
  'charging-slot': '充电位占用',
  'local-power': '站内功率上限或站址可用功率不足',
  'shared-power': '共享电源功率占用或容量不足',
  horizon: '试算范围内未开始充电',
};

function chargeStatus(
  endMinute: number | null,
  horizonMinute: number,
): StationChargeEvent['statusAtHorizon'] {
  return endMinute === null ? 'pending' : endMinute <= horizonMinute ? 'full' : 'charging';
}

function createStationLedger(
  station: StationCalendar,
  input: StationTurnoverInput,
  sharedPower?: ReturnType<typeof createSharedPowerCalendar>,
) {
  const { basis } = station;
  const { capacityKwh, gridPowerKw, efficiency, horizonMinute } = input;
  const maxConcurrent = chargingCapacity(basis, gridPowerKw);
  const swaps: StationSwapEvent[] = [];
  const charges: StationChargeEvent[] = [];
  const bayReleases: number[] = [];
  const chargerReleases: number[] = [];
  // Only unclaimed completions remain here. Initial full batteries need no per-pack record.
  const unclaimedCompletions: number[] = [];
  const pendingReasons = new Set<StationChargeWaitReason>();
  let availableFull = basis.initialFullBatteries;

  function completionsBy(minute: number): number {
    let lower = 0;
    let upper = unclaimedCompletions.length;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (unclaimedCompletions[middle] <= minute) lower = middle + 1;
      else upper = middle;
    }
    return lower;
  }

  function acceptReturn(swap: StationSwapEvent) {
    const addedKwh = capacityKwh - swap.returnedKwh;
    const gridEnergyKwh = addedKwh / efficiency;
    if (!Number.isFinite(gridEnergyKwh))
      throw failedSwap(station, swap, '回收电池所需的购电量超出试算数值范围');
    const duration = (gridEnergyKwh / gridPowerKw) * 60;
    if (!Number.isFinite(duration)) throw failedSwap(station, swap, '充电时长超出试算数值范围');
    let startMinute: number | null = null;
    let endMinute: number | null = null;
    const waitReasons: StationChargeWaitReason[] = [];
    if (addedKwh === 0) {
      startMinute = endMinute = swap.endMinute;
    } else if (!maxConcurrent) {
      waitReasons.push('local-power');
    } else {
      const charger = nextResource(chargerReleases, maxConcurrent, swap.endMinute);
      const readyMinute = Math.max(swap.endMinute, charger.readyMinute);
      if (readyMinute > swap.endMinute)
        waitReasons.push(maxConcurrent < basis.chargingSlots ? 'local-power' : 'charging-slot');
      const reservation = sharedPower?.reserve(
        station.chargeWindows,
        readyMinute,
        duration,
        horizonMinute,
      );
      const start = reservation
        ? reservation.startMinute
        : nextWindowStart(station.chargeWindows, readyMinute, duration);
      if (reservation?.sharedWait) waitReasons.push('shared-power');
      if (reservation ? reservation.windowWait : start === null || start > readyMinute)
        waitReasons.push('charge-window');
      if (start !== null && start < horizonMinute) {
        const end = start + duration;
        if (!Number.isFinite(end)) throw failedSwap(station, swap, '充电结束时间超出试算数值范围');
        if (!(end > start)) throw failedSwap(station, swap, '充电时长小于试算时间精度');
        chargerReleases[charger.index] = end;
        startMinute = start;
        endMinute = end;
      } else if (start !== null) waitReasons.push('horizon');
    }
    if (endMinute === null) for (const reason of waitReasons) pendingReasons.add(reason);
    else {
      // Charge completions are ordered even when a full return follows an earlier depleted one.
      unclaimedCompletions.splice(completionsBy(endMinute), 0, endMinute);
    }
    charges.push({
      swapEventId: swap.eventId,
      returnedMinute: swap.endMinute,
      returnedKwh: swap.returnedKwh,
      startMinute,
      endMinute,
      gridPowerKw,
      gridEnergyKwh,
      addedKwh,
      efficiency,
      statusAtHorizon: chargeStatus(endMinute, horizonMinute),
      waitReasons,
    });
  }

  function scheduleSwap(
    arrival: StationSwapArrival,
    latestServiceEndMinute: number,
  ): StationSwapEvent {
    const { arrivalMinute } = arrival;
    const completed = completionsBy(arrivalMinute);
    if (completed) {
      availableFull += completed;
      unclaimedCompletions.splice(0, completed);
    }
    const batteryReady = availableFull > 0 ? 0 : unclaimedCompletions[0];
    if (batteryReady === undefined || batteryReady >= horizonMinute) {
      const reasons = [...pendingReasons].map((reason) => chargeWaitLabels[reason]);
      if (batteryReady !== undefined) reasons.push('试算范围内来不及充满');
      const detail = reasons.length ? `（${reasons.join('、')}）` : '';
      throw failedSwap(station, arrival, `满电电池不足${detail}`);
    }
    const bay = nextResource(bayReleases, basis.bays, arrivalMinute);
    const readyMinute = Math.max(arrivalMinute, bay.readyMinute, batteryReady);
    const serviceStartMinute = nextWindowStart(
      station.serviceWindows,
      readyMinute,
      station.swapMinutes,
    );
    const waitReasons: StationSwapWaitReason[] = [];
    if (bay.readyMinute > arrivalMinute) waitReasons.push('bay');
    if (batteryReady > arrivalMinute) waitReasons.push('full-battery');
    if (
      nextWindowStart(station.serviceWindows, arrivalMinute, station.swapMinutes) !==
        arrivalMinute ||
      serviceStartMinute !== readyMinute
    )
      waitReasons.push('service-window');
    if (
      serviceStartMinute === null ||
      serviceStartMinute + station.swapMinutes >
        Math.min(latestServiceEndMinute, horizonMinute) + TIME_TOLERANCE
    ) {
      const reasons = waitReasons
        .filter((reason) => reason !== 'service-window')
        .map((reason) => swapWaitLabels[reason]);
      if (waitReasons.includes('service-window')) reasons.push('服务窗口内无法完成换电');
      reasons.push('无法在车辆班次及试算范围内完成换电');
      throw failedSwap(station, arrival, reasons.join('、'));
    }
    const endMinute = Math.min(serviceStartMinute + station.swapMinutes, horizonMinute);
    if (!(endMinute > serviceStartMinute))
      throw failedSwap(station, arrival, '换电时长小于试算时间精度');
    if (availableFull > 0) availableFull--;
    else unclaimedCompletions.shift();
    const swap: StationSwapEvent = {
      ...arrival,
      serviceStartMinute,
      endMinute,
      bay: bay.index + 1,
      waitReasons,
      fullBatteriesAfterStart: availableFull + completionsBy(serviceStartMinute),
    };
    acceptReturn(swap);
    bayReleases[bay.index] = swap.endMinute;
    swaps.push(swap);
    return swap;
  }

  function finish(): StationTurnoverLedger {
    let pending = 0;
    let charging = 0;
    for (const charge of charges) {
      if (charge.statusAtHorizon === 'pending') pending++;
      if (charge.statusAtHorizon === 'charging') charging++;
    }
    return {
      ...basis,
      horizonInventory: {
        full: basis.initialFullBatteries - pending - charging,
        pending,
        charging,
      },
      swaps,
      charges,
    };
  }

  return { scheduleSwap, finish };
}

/** The caller submits actual arrivals in time order, breaking simultaneous ties consistently. */
export function createStationTurnover(snapshot: DailyTransportSnapshot, sharedPower = false) {
  const gaps = stationTurnoverReadiness(snapshot);
  if (gaps.length) throw new Error(gaps.join('；'));
  const input = stationTurnoverInput(snapshot);
  const sources = new Map(
    sharedPower
      ? snapshot.context.stationNetwork!.powerSources.map((source) => [
          source.id,
          createSharedPowerCalendar(source.point.availableCapacityKw!, input.gridPowerKw),
        ])
      : [],
  );
  const stations = new Map(
    input.stations.map((station) => [
      station.basis.stationId,
      createStationLedger(station, input, sources.get(station.basis.powerSourceId)),
    ]),
  );
  return {
    scheduleSwap(
      arrival: StationSwapArrival,
      latestServiceEndMinute = input.horizonMinute,
    ): StationSwapEvent {
      const station = stations.get(arrival.stationId);
      if (!station) throw new Error(`换电访问的站址 ${arrival.stationId} 不属于固定布局`);
      return station.scheduleSwap(arrival, latestServiceEndMinute);
    },
    finish(): StationTurnoverResult {
      return {
        horizonMinute: input.horizonMinute,
        initialBatterySocPercent: 100,
        stations: [...stations.values()].map((station) => station.finish()),
      };
    },
  };
}

function withinWindow(windows: OperatingShift[], startMinute: number, endMinute: number) {
  return windows.some(
    (window) => startMinute >= window.startMinute && endMinute <= window.endMinute + TIME_TOLERANCE,
  );
}

function validWaitReasons<T extends string>(reasons: T[], known: Record<T, string>) {
  return (
    new Set(reasons).size === reasons.length &&
    reasons.every((reason) => Object.hasOwn(known, reason))
  );
}

function validateCharge(
  charge: StationChargeEvent,
  swap: StationSwapEvent,
  input: StationTurnoverInput,
  chargeWindows: OperatingShift[],
): boolean {
  const { capacityKwh, gridPowerKw, efficiency, horizonMinute } = input;
  const { startMinute, endMinute, waitReasons } = charge;
  const addedKwh = capacityKwh - swap.returnedKwh;
  if (
    charge.returnedMinute !== swap.endMinute ||
    charge.returnedKwh !== swap.returnedKwh ||
    charge.gridPowerKw !== gridPowerKw ||
    charge.efficiency !== efficiency ||
    charge.addedKwh !== addedKwh ||
    !Number.isFinite(charge.gridEnergyKwh) ||
    charge.gridEnergyKwh !== addedKwh / efficiency ||
    charge.statusAtHorizon !== chargeStatus(endMinute, horizonMinute) ||
    !validWaitReasons(waitReasons, chargeWaitLabels)
  )
    return false;
  if (addedKwh === 0)
    return startMinute === swap.endMinute && endMinute === startMinute && !waitReasons.length;
  if (startMinute === null || endMinute === null)
    return startMinute === null && endMinute === null && waitReasons.length > 0;
  const duration = (charge.gridEnergyKwh / gridPowerKw) * 60;
  return (
    Number.isFinite(startMinute) &&
    Number.isFinite(endMinute) &&
    startMinute >= swap.endMinute &&
    startMinute < horizonMinute &&
    endMinute > startMinute &&
    Math.abs(endMinute - (startMinute + duration)) <= TIME_TOLERANCE &&
    withinWindow(chargeWindows, startMinute, endMinute) &&
    waitReasons.length > 0 === startMinute > swap.endMinute
  );
}

function verifyChargingOccupancy(ledger: StationTurnoverLedger, gridPowerKw: number): boolean {
  const changes = ledger.charges.flatMap(({ startMinute, endMinute }) =>
    startMinute === null || endMinute === null || startMinute === endMinute
      ? []
      : [
          { minute: startMinute, change: 1 },
          { minute: endMinute, change: -1 },
        ],
  );
  // Release a charger before admitting another at the same instant.
  changes.sort((a, b) => a.minute - b.minute || a.change - b.change);
  let active = 0;
  for (const { change } of changes) {
    active += change;
    if (
      active < 0 ||
      active > ledger.chargingSlots ||
      !powerFits(active * gridPowerKw, ledger.stationPowerKw) ||
      !powerFits(active * gridPowerKw, ledger.sitePowerKw)
    )
      return false;
  }
  return active === 0;
}

function verifyBatteryInventory(ledger: StationTurnoverLedger, horizonMinute: number): boolean {
  const completions = ledger.charges
    .flatMap(({ endMinute }) => (endMinute === null ? [] : [endMinute]))
    .sort((a, b) => a - b);
  let completed = 0;
  let available = ledger.initialFullBatteries;
  function collect(minute: number) {
    while (completed < completions.length && completions[completed] <= minute) {
      available++;
      completed++;
    }
  }
  // The swap rows are in service order. A completion at the start of service is usable.
  for (const swap of ledger.swaps) {
    collect(swap.serviceStartMinute);
    available--;
    if (available < 0 || swap.fullBatteriesAfterStart !== available) return false;
  }
  collect(horizonMinute);
  const pending = ledger.charges.filter((charge) => charge.startMinute === null).length;
  const charging = completions.length - completed;
  return (
    ledger.horizonInventory.full === available &&
    ledger.horizonInventory.pending === pending &&
    ledger.horizonInventory.charging === charging &&
    available + pending + charging === ledger.initialFullBatteries
  );
}

function verifyStationLedger(
  station: StationCalendar,
  ledger: StationTurnoverLedger,
  expectedSwaps: Map<string, ExpectedSwap>,
  input: StationTurnoverInput,
): string[] {
  const { basis, swapMinutes, serviceWindows, chargeWindows } = station;
  const issues: string[] = [];
  if ((Object.keys(basis) as (keyof StationBasis)[]).some((key) => basis[key] !== ledger[key]))
    issues.push('站址、站型或可用资源依据与输入不一致');
  if (expectedSwaps.size !== ledger.swaps.length || ledger.swaps.length !== ledger.charges.length)
    issues.push('车辆换电、工位服务与回收电池账目数量不一致');
  const charges = new Map(ledger.charges.map((charge) => [charge.swapEventId, charge]));
  const bayReleases = new Map<number, number>();
  let previousArrival = 0;
  let previousServiceStart = 0;
  for (const swap of ledger.swaps) {
    const { eventId, arrivalMinute, serviceStartMinute, endMinute, bay, waitReasons } = swap;
    const charge = charges.get(eventId);
    const expected = expectedSwaps.get(eventId);
    const event = expected?.event;
    if (
      expected?.vehicleId !== swap.vehicleId ||
      !event ||
      swap.stationId !== basis.stationId ||
      arrivalMinute !== event.startMinute ||
      serviceStartMinute !== event.detour?.serviceStartMinute ||
      endMinute !== event.endMinute ||
      swap.returnedKwh !== event.startKwh ||
      swap.returnedKwh < 0 ||
      swap.returnedKwh > input.capacityKwh
    )
      issues.push(`换电 ${eventId} 与实际车辆事件不一致`);
    if (
      !Number.isFinite(arrivalMinute) ||
      !Number.isFinite(serviceStartMinute) ||
      !Number.isFinite(endMinute) ||
      arrivalMinute < previousArrival ||
      serviceStartMinute <
        Math.max(arrivalMinute, previousServiceStart, bayReleases.get(bay) ?? 0) ||
      endMinute <= serviceStartMinute ||
      Math.abs(endMinute - (serviceStartMinute + swapMinutes)) > TIME_TOLERANCE ||
      endMinute > input.horizonMinute ||
      !withinWindow(serviceWindows, serviceStartMinute, endMinute) ||
      !Number.isInteger(bay) ||
      bay < 1 ||
      bay > basis.bays ||
      !validWaitReasons(waitReasons, swapWaitLabels) ||
      waitReasons.length > 0 !== serviceStartMinute > arrivalMinute
    )
      issues.push(`换电 ${eventId} 的排队顺序、工位占用或服务窗口无效`);
    if (!charge || !validateCharge(charge, swap, input, chargeWindows))
      issues.push(`换电 ${eventId} 的回收电池、充电窗口或电量账目不一致`);
    expectedSwaps.delete(eventId);
    charges.delete(eventId);
    previousArrival = arrivalMinute;
    previousServiceStart = serviceStartMinute;
    bayReleases.set(bay, endMinute);
  }
  if (expectedSwaps.size || charges.size) issues.push('有车辆换电或回收电池未对账');
  if (!issues.length) {
    if (!verifyChargingOccupancy(ledger, input.gridPowerKw))
      issues.push('充电位或本地同时充电功率超限');
    if (!verifyBatteryInventory(ledger, input.horizonMinute))
      issues.push('满电库存不足或电池流转数量不守恒');
  }
  return issues;
}

/** Replay resource occupancy and inventory conservation from the published events. */
export function validateStationTurnover(
  snapshot: DailyTransportSnapshot,
  energy: VehicleEnergyResult,
  ledger: StationTurnoverResult,
): DailyTransportValidation {
  const issues = stationTurnoverReadiness(snapshot);
  if (issues.length) return { valid: false, issues };
  const input = stationTurnoverInput(snapshot);
  const stations = new Map(input.stations.map((station) => [station.basis.stationId, station]));
  const ledgers = new Map(ledger.stations.map((station) => [station.stationId, station]));
  if (
    ledger.horizonMinute !== input.horizonMinute ||
    ledger.initialBatterySocPercent !== 100 ||
    ledgers.size !== stations.size ||
    ledgers.size !== ledger.stations.length
  )
    return { valid: false, issues: ['固定布局、试算范围或站内初始库存口径不一致'] };
  const swapsByStation = new Map<string, Map<string, ExpectedSwap>>();
  const swapIds = new Set<string>();
  for (const vehicle of energy.vehicles) {
    for (const event of vehicle.events) {
      if (event.kind !== 'swap') continue;
      const stationId = event.stationId;
      if (stationId === null || !stations.has(stationId) || swapIds.has(event.id)) {
        issues.push(`车辆 ${vehicle.vehicleId} 的换电站址无效或事件身份重复`);
        continue;
      }
      const expectedSwaps = swapsByStation.get(stationId) ?? new Map<string, ExpectedSwap>();
      expectedSwaps.set(event.id, { vehicleId: vehicle.vehicleId, event });
      swapsByStation.set(stationId, expectedSwaps);
      swapIds.add(event.id);
    }
  }
  for (const [stationId, station] of stations) {
    const stationLedger = ledgers.get(stationId);
    const prefix = `站址“${station.basis.stationName}”`;
    if (!stationLedger) {
      issues.push(`${prefix}的站内周转账目缺失`);
      continue;
    }
    const expectedSwaps = swapsByStation.get(stationId) ?? new Map<string, ExpectedSwap>();
    const ledgerIssues = verifyStationLedger(station, stationLedger, expectedSwaps, input);
    issues.push(...ledgerIssues.map((issue) => `${prefix}：${issue}`));
  }
  return { valid: issues.length === 0, issues };
}
