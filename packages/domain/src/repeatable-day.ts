import {
  type DailyTransportConfig,
  type DailyTransportProgress,
  type DailyTransportResult,
  type DailyTransportSnapshot,
  type DailyTransportValidation,
} from './daily-transport';
import { scheduleStationVisits } from './daily-station-turnover';
import { buildSharedPowerLedger, validateSharedPower } from './shared-power';
import { validateStationTurnover, type StationTurnoverResult } from './station-turnover';
import {
  generateVehicleEnergy,
  validateVehicleEnergy,
  VEHICLE_ENERGY_ALGORITHM_VERSION,
  type VehicleEnergyTimeline,
} from './vehicle-energy';

export const REPEATABLE_DAY_ALGORITHM_VERSION = 'repeatable-day-1';
const DAY = 1440;
const MAX_ITERATIONS = 32;

export interface PeriodicStationState {
  stationId: string;
  full: number;
  storedKwh: number;
  packs: {
    kind: 'pending' | 'charging' | 'in-service';
    bay: number | null;
    kwh: number;
    returnedKwh: number;
    startInMinutes: number | null;
    endInMinutes: number | null;
  }[];
}

export interface PeriodicVehicleState {
  vehicleId: string;
  kwh: number;
  positionId: string;
  eventKind: string | null;
  elapsedMinutes: number;
  remainingMinutes: number;
}

export interface PeriodicBoundaryState {
  vehicles: PeriodicVehicleState[];
  stations: PeriodicStationState[];
}

export interface RepeatableDayResult {
  periodMinutes: 1440;
  initial: PeriodicBoundaryState;
  final: PeriodicBoundaryState;
  energy: {
    initialStoredKwh: number;
    finalStoredKwh: number;
    consumedKwh: number;
    gridEnergyKwh: number;
    addedKwh: number;
  };
  /** A bounded construction witness, never a daily reset or a multi-day execution model. */
  replay: {
    days: VehicleEnergyTimeline[][];
    stationTurnover: StationTurnoverResult;
  };
}

const initialCharges = (result: DailyTransportResult) =>
  new Map(result.vehicleEnergy!.vehicles.map((vehicle) => [vehicle.vehicleId, vehicle.initialKwh]));
const untag = (id: string) => id.replace(/^day\d+:/, '');
function moveTimeline(
  timeline: VehicleEnergyTimeline,
  offset: number,
  day?: number,
): VehicleEnergyTimeline {
  return {
    ...timeline,
    events: timeline.events.map((event) => ({
      ...event,
      id: day === undefined ? untag(event.id) : `day${day}:${event.id}`,
      startMinute: event.startMinute + offset,
      endMinute: event.endMinute + offset,
      detour: event.detour
        ? {
            ...event.detour,
            serviceStartMinute: event.detour.serviceStartMinute + offset,
          }
        : null,
    })),
  };
}

function numericEqual(a: unknown, b: unknown, key = ''): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    const tolerance = /Minute/.test(key)
      ? 1e-7
      : 32 * Number.EPSILON * Math.max(Math.abs(a), Math.abs(b));
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
  }
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((value, index) => numericEqual(value, b[index], key));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    return (
      Object.keys(left).length === Object.keys(right).length &&
      Object.keys(left).every(
        (name) => Object.hasOwn(right, name) && numericEqual(left[name], right[name], name),
      )
    );
  }
  return a === b;
}

/** Independent state replay at midnight, after releases/starts at that exact instant. */
function boundary(
  result: DailyTransportResult,
  replay: RepeatableDayResult['replay'],
  minute: number,
): PeriodicBoundaryState {
  const capacity = result.vehicleEnergy!.batteryCapacityKwh;
  const vehicles = result.vehicleEnergy!.vehicles.map((vehicle) => {
    const events = replay.days
      .flatMap((day) => day.find((v) => v.vehicleId === vehicle.vehicleId)!.events)
      .sort((a, b) => a.startMinute - b.startMinute);
    let kwh = vehicle.initialKwh;
    let positionId =
      result.vehicles.find((v) => v.vehicleId === vehicle.vehicleId)!.events[0]?.fromPositionId ??
      '';
    for (const event of events) {
      if (event.endMinute <= minute) {
        kwh = event.endKwh;
        positionId = event.toPositionId;
      } else if (event.startMinute <= minute) {
        kwh =
          event.kind === 'swap'
            ? event.startKwh
            : event.startKwh -
              event.energyKwh *
                ((minute - event.startMinute) / (event.endMinute - event.startMinute));
        return {
          vehicleId: vehicle.vehicleId,
          kwh,
          positionId: event.fromPositionId,
          eventKind: event.kind,
          elapsedMinutes: minute - event.startMinute,
          remainingMinutes: event.endMinute - minute,
        };
      } else break;
    }
    return {
      vehicleId: vehicle.vehicleId,
      kwh,
      positionId,
      eventKind: null,
      elapsedMinutes: 0,
      remainingMinutes: 0,
    };
  });
  const stations = replay.stationTurnover.stations.map((station) => {
    const packs: PeriodicStationState['packs'] = [];
    const charges = new Map(station.charges.map((charge) => [charge.swapEventId, charge]));
    for (const swap of station.swaps) {
      if (swap.serviceStartMinute > minute) continue;
      const charge = charges.get(swap.eventId)!;
      if (charge.endMinute !== null && charge.endMinute <= minute) continue;
      if (swap.endMinute > minute) {
        packs.push({
          kind: 'in-service',
          bay: swap.bay,
          kwh: capacity,
          returnedKwh: swap.returnedKwh,
          startInMinutes: swap.serviceStartMinute - minute,
          endInMinutes: swap.endMinute - minute,
        });
      } else {
        const charging = charge.startMinute !== null && charge.startMinute <= minute;
        packs.push({
          kind: charging ? 'charging' : 'pending',
          bay: null,
          returnedKwh: charge.returnedKwh,
          kwh:
            charge.returnedKwh +
            (charging
              ? ((minute - charge.startMinute!) * charge.gridPowerKw * charge.efficiency) / 60
              : 0),
          startInMinutes: charge.startMinute === null ? null : charge.startMinute - minute,
          endInMinutes: charge.endMinute === null ? null : charge.endMinute - minute,
        });
      }
    }
    packs.sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        (a.endInMinutes ?? Infinity) - (b.endInMinutes ?? Infinity) ||
        a.kwh - b.kwh,
    );
    const full = station.initialFullBatteries - packs.length;
    return {
      stationId: station.stationId,
      full,
      packs,
      storedKwh: full * capacity + packs.reduce((sum, pack) => sum + pack.kwh, 0),
    };
  });
  return { vehicles, stations };
}

function projectStationDay(
  replay: RepeatableDayResult['replay'],
  initial: PeriodicBoundaryState,
  final: PeriodicBoundaryState,
): StationTurnoverResult {
  const start = (replay.days.length - 2) * DAY;
  const end = start + DAY;
  return {
    horizonMinute: DAY,
    initialBatterySocPercent: 'periodic',
    stations: replay.stationTurnover.stations.map((station) => {
      const first = initial.stations.find((s) => s.stationId === station.stationId)!;
      const last = final.stations.find((s) => s.stationId === station.stationId)!;
      return {
        ...station,
        initialFullBatteries: first.full,
        horizonInventory: {
          full: last.full,
          inService: last.packs.filter((p) => p.kind === 'in-service').length,
          pending: last.packs.filter((p) => p.kind === 'pending').length,
          charging: last.packs.filter((p) => p.kind === 'charging').length,
        },
        swaps: station.swaps
          .filter((swap) => swap.endMinute > start && swap.serviceStartMinute < end)
          .map((swap) => ({
            ...swap,
            arrivalMinute: swap.arrivalMinute - start,
            serviceStartMinute: swap.serviceStartMinute - start,
            endMinute: swap.endMinute - start,
          })),
        charges: station.charges
          .filter(
            (charge) =>
              charge.returnedMinute < end &&
              (charge.endMinute === null || charge.endMinute > start),
          )
          .map((charge) => ({
            ...charge,
            returnedMinute: charge.returnedMinute - start,
            startMinute: charge.startMinute === null ? null : charge.startMinute - start,
            endMinute: charge.endMinute === null ? null : charge.endMinute - start,
            statusAtHorizon:
              charge.endMinute !== null && charge.endMinute <= end
                ? ('full' as const)
                : charge.startMinute === null || charge.startMinute >= end
                  ? ('pending' as const)
                  : ('charging' as const),
          })),
      };
    }),
  };
}

function periodicAccounts(
  snapshot: DailyTransportSnapshot,
  result: DailyTransportResult,
  replay: RepeatableDayResult['replay'],
) {
  const start = (replay.days.length - 2) * DAY;
  const initial = boundary(result, replay, start);
  const final = boundary(result, replay, start + DAY);
  const stationTurnover = projectStationDay(replay, initial, final);
  const sharedPower = buildSharedPowerLedger(snapshot, stationTurnover);
  const stored = (state: PeriodicBoundaryState) =>
    state.vehicles.reduce((sum, v) => sum + v.kwh, 0) +
    state.stations.reduce((sum, s) => sum + s.storedKwh, 0);
  const gridEnergyKwh = sharedPower.sources.reduce((sum, s) => sum + s.gridEnergyKwh, 0);
  const consumedKwh = replay.days
    .flat(1)
    .flatMap((v) => v.events)
    .reduce((sum, e) => {
      const duration = e.endMinute - e.startMinute;
      return (
        sum +
        (duration > 0
          ? (e.energyKwh *
              Math.max(0, Math.min(start + DAY, e.endMinute) - Math.max(start, e.startMinute))) /
            duration
          : 0)
      );
    }, 0);
  return {
    initial,
    final,
    stationTurnover,
    sharedPower,
    energy: {
      initialStoredKwh: stored(initial),
      finalStoredKwh: stored(final),
      consumedKwh,
      gridEnergyKwh,
      addedKwh: gridEnergyKwh * snapshot.context.operations!.battery!.chargeEfficiency!,
    },
  };
}

function vehicleReplay(
  snapshot: DailyTransportSnapshot,
  result: DailyTransportResult,
  timelines: VehicleEnergyTimeline[],
): DailyTransportValidation {
  return validateVehicleEnergy(
    snapshot,
    {
      ...result,
      algorithmVersion: VEHICLE_ENERGY_ALGORITHM_VERSION,
      physicalFeasibility: 'not-established',
      vehicleEnergy: {
        ...result.vehicleEnergy!,
        vehicles: timelines,
        stationCapacityStatus: 'not-checked',
        batteryInventoryStatus: 'not-checked',
        sharedPowerStatus: 'not-checked',
        periodicityStatus: 'not-checked',
      },
    },
    initialCharges(result),
  );
}

/** No warm-up count certifies a candidate: replay each phase and compare the complete boundary. */
export function validateRepeatableDay(
  snapshot: DailyTransportSnapshot,
  result: DailyTransportResult,
): DailyTransportValidation {
  const issues: string[] = [];
  const periodic = result.periodicity;
  const energy = result.vehicleEnergy;
  if (
    !periodic ||
    !energy ||
    result.algorithmVersion !== REPEATABLE_DAY_ALGORITHM_VERSION ||
    result.physicalFeasibility !== 'feasible' ||
    periodic.periodMinutes !== DAY ||
    energy.periodicityStatus !== 'checked' ||
    energy.stationCapacityStatus !== 'checked' ||
    energy.batteryInventoryStatus !== 'checked' ||
    energy.sharedPowerStatus !== 'checked' ||
    !result.stationTurnover ||
    !result.sharedPower
  )
    return { valid: false, issues: ['周期阶段、组合校验或周期证据缺失'] };
  const replay = periodic.replay;
  const count = replay.days.length;
  if (count < 4 || count > MAX_ITERATIONS)
    return { valid: false, issues: ['周期构造证据范围无效'] };
  for (const [day, timelines] of replay.days.entries()) {
    if (timelines.some((v) => v.events.some((e) => e.id !== `day${day}:${untag(e.id)}`)))
      issues.push('周期事件身份与所属日不一致');
    const checked = vehicleReplay(
      snapshot,
      result,
      timelines.map((v) => moveTimeline(v, -day * DAY)),
    );
    issues.push(...checked.issues);
  }
  const station = validateStationTurnover(
    snapshot,
    { ...energy, vehicles: replay.days.flat() },
    replay.stationTurnover,
    count,
  );
  issues.push(...station.issues);
  if (issues.length) return { valid: false, issues };
  const shared = validateSharedPower(
    snapshot,
    replay.stationTurnover,
    buildSharedPowerLedger(snapshot, replay.stationTurnover),
  );
  issues.push(...shared.issues);
  const phase = count - 2;
  const normalize = (day: number) => replay.days[day].map((v) => moveTimeline(v, -day * DAY));
  const candidate = normalize(phase);
  if (
    !numericEqual(candidate, normalize(phase - 1)) ||
    !numericEqual(candidate, normalize(phase + 1)) ||
    !numericEqual(candidate, energy.vehicles)
  )
    issues.push('相邻周期的车辆事件、等候或能量未重复');
  for (const vehicle of energy.vehicles) {
    if (
      !numericEqual(vehicle.initialKwh, vehicle.finalKwh) ||
      (vehicle.consumedKwh > 0 && !vehicle.events.some((e) => e.kind === 'swap'))
    )
      issues.push(`车辆 ${vehicle.vehicleId} 未恢复周期出发电量`);
    const events = replay.days
      .flatMap((day) => day.find((v) => v.vehicleId === vehicle.vehicleId)!.events)
      .sort((a, b) => a.startMinute - b.startMinute);
    if (events.some((e, i) => i > 0 && e.startMinute < events[i - 1].endMinute - 1e-7))
      issues.push(`车辆 ${vehicle.vehicleId} 的跨日作业重叠`);
  }
  for (const ledger of replay.stationTurnover.stations) {
    const program = (day: number) =>
      ledger.charges
        .filter((c) => c.swapEventId.startsWith(`day${day}:`))
        .map((c) => ({
          ...c,
          swapEventId: untag(c.swapEventId),
          returnedMinute: c.returnedMinute - day * DAY,
          startMinute: c.startMinute === null ? null : c.startMinute - day * DAY,
          endMinute: c.endMinute === null ? null : c.endMinute - day * DAY,
          statusAtHorizon: undefined,
        }));
    if (
      !numericEqual(program(phase), program(phase - 1)) ||
      !numericEqual(program(phase), program(phase + 1))
    )
      issues.push(`站址“${ledger.stationName}”的连续充电安排未形成重复周期`);
  }
  for (const ledger of replay.stationTurnover.stations) {
    const services = (day: number) =>
      ledger.swaps
        .filter((swap) => swap.eventId.startsWith(`day${day}:`))
        .map((swap) => ({
          eventId: untag(swap.eventId),
          bay: swap.bay,
          serviceStartMinute: swap.serviceStartMinute - day * DAY,
          endMinute: swap.endMinute - day * DAY,
        }));
    if (
      !numericEqual(services(phase), services(phase - 1)) ||
      !numericEqual(services(phase), services(phase + 1))
    )
      issues.push(`站址“${ledger.stationName}”的跨日工位分配未形成重复周期`);
  }
  const accounts = periodicAccounts(snapshot, result, replay);
  if (!numericEqual(accounts.initial, accounts.final))
    issues.push('车辆电量、站内库存、待充电量、在充进度或跨界服务未恢复周期初态');
  if (
    !numericEqual(periodic.initial, accounts.initial) ||
    !numericEqual(periodic.final, accounts.final) ||
    !numericEqual(periodic.energy, accounts.energy) ||
    !numericEqual(result.stationTurnover, accounts.stationTurnover) ||
    !numericEqual(result.sharedPower, accounts.sharedPower)
  )
    issues.push('周期初末态或日内购电账目与独立重放不一致');
  if (
    accounts.initial.stations.some((s) => s.full < 0) ||
    !numericEqual(accounts.energy.initialStoredKwh, accounts.energy.finalStoredKwh) ||
    !numericEqual(accounts.energy.consumedKwh, accounts.energy.addedKwh)
  )
    issues.push('周期能量或电池库存不守恒');
  const power = validateSharedPower(snapshot, accounts.stationTurnover, accounts.sharedPower);
  issues.push(...power.issues);
  return { valid: issues.length === 0, issues };
}

export function generateRepeatableDay(
  snapshot: DailyTransportSnapshot,
  onProgress?: (progress: DailyTransportProgress) => void,
  config: DailyTransportConfig = { seed: 1, maxRuntimeMs: 600000 },
  onPhase?: (phase: 'constructing' | 'validating') => void,
  notBefore?: ReadonlyMap<string, number>,
): DailyTransportResult {
  onPhase?.('constructing');
  const deadline = Date.now() + config.maxRuntimeMs;
  let initialKwh = new Map<string, number>();
  let result: DailyTransportResult | undefined;
  let reason = '未恢复周期初态';
  try {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      if (Date.now() >= deadline) throw new Error('已达到周期求解时限');
      result = generateVehicleEnergy(
        snapshot,
        onProgress,
        { ...config, maxRuntimeMs: deadline - Date.now() },
        { initialKwh, requireSwap: true, notBefore },
      );
      const next = new Map(result.vehicleEnergy!.vehicles.map((v) => [v.vehicleId, v.finalKwh]));
      if (result.vehicleEnergy!.vehicles.every((v) => numericEqual(v.initialKwh, v.finalKwh)))
        break;
      initialKwh = next;
      result = undefined;
    }
    if (!result) throw new Error('车辆首尾电量未收敛');
    for (const repetitions of [4, 8, 16, MAX_ITERATIONS]) {
      const witness = JSON.parse(JSON.stringify(result)) as DailyTransportResult;
      witness.vehicleEnergy!.vehicles = Array.from({ length: repetitions }, (_, day) =>
        result!.vehicleEnergy!.vehicles.map((v) => moveTimeline(v, day * DAY, day)),
      ).flat();
      scheduleStationVisits(snapshot, witness, true, repetitions, deadline);
      const days = Array.from({ length: repetitions }, (_, day) =>
        witness.vehicleEnergy!.vehicles.slice(
          day * result!.vehicleEnergy!.vehicles.length,
          (day + 1) * result!.vehicleEnergy!.vehicles.length,
        ),
      );
      const replay = { days, stationTurnover: witness.stationTurnover! };
      const candidate = JSON.parse(JSON.stringify(result)) as DailyTransportResult;
      candidate.vehicleEnergy!.vehicles = days[repetitions - 2].map((v) =>
        moveTimeline(v, -(repetitions - 2) * DAY),
      );
      candidate.vehicleEnergy!.stationCapacityStatus = 'checked';
      candidate.vehicleEnergy!.batteryInventoryStatus = 'checked';
      candidate.vehicleEnergy!.sharedPowerStatus = 'checked';
      candidate.vehicleEnergy!.periodicityStatus = 'checked';
      candidate.algorithmVersion = REPEATABLE_DAY_ALGORITHM_VERSION;
      candidate.physicalFeasibility = 'feasible';
      const accounts = periodicAccounts(snapshot, candidate, replay);
      candidate.stationTurnover = accounts.stationTurnover;
      candidate.sharedPower = accounts.sharedPower;
      candidate.periodicity = {
        periodMinutes: DAY,
        initial: accounts.initial,
        final: accounts.final,
        energy: accounts.energy,
        replay,
      };
      candidate.limitations = [
        '已独立校核载重、工时、能量、工位、库存、连续充电、共享电源及可重复的 24 小时边界。',
        '周期初态由有限构造求得，车辆与站内电池不按日重置为满电；跨午夜作业和充电按相邻周期连接。',
        '沿固定车次、班次及换电访问求周期状态，不保证最优；未找到闭合状态不证明全局无解。财务尚未校核。',
        ...result.limitations.slice(3),
      ];
      onPhase?.('validating');
      candidate.validation = validateRepeatableDay(snapshot, candidate);
      if (candidate.validation.valid) return candidate;
      reason = candidate.validation.issues.slice(0, 4).join('；');
    }
  } catch (error) {
    reason = error instanceof Error ? error.message : '周期构造未完成';
  }
  throw new Error(`本次未找到闭合的24小时周期，不证明全局无解：${reason}`);
}
