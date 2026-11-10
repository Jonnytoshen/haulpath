import {
  dailyTransportEventShifts,
  type DailyTransportConfig,
  type DailyTransportProgress,
  type DailyTransportResult,
  type DailyTransportSnapshot,
  type DailyTransportValidation,
  type DailyTransportVehicle,
} from './daily-transport';
import type { OperatingShift } from './fleet-operations';
import { buildSharedPowerLedger, validateSharedPower } from './shared-power';
import {
  createStationTurnover,
  stationTurnoverReadiness,
  validateStationTurnover,
  type StationSwapEvent,
} from './station-turnover';
import {
  generateVehicleEnergy,
  validateVehicleEnergy,
  VEHICLE_ENERGY_ALGORITHM_VERSION,
  type VehicleEnergyEvent,
  type VehicleEnergyTimeline,
} from './vehicle-energy';

export const DAILY_STATION_TURNOVER_ALGORITHM_VERSION = 'daily-station-turnover-1';
export const DAILY_SHARED_POWER_ALGORITHM_VERSION = 'daily-shared-power-1';

interface VehicleSchedule {
  vehicle: DailyTransportVehicle;
  timeline: VehicleEnergyTimeline;
  shifts: Map<string, OperatingShift | undefined>;
  index: number;
  shift?: OperatingShift;
  delay: number;
  lastDelayedSwap?: Pick<StationSwapEvent, 'arrivalMinute' | 'waitReasons'> & { siteName: string };
}

interface NextVisit {
  schedule: VehicleSchedule;
  event: VehicleEnergyEvent;
  arrivalMinute: number;
  vehicleOrder: number;
}

const TIME_TOLERANCE = 1e-7;
const waitLabels = {
  'service-window': '服务窗口',
  bay: '换电工位拥堵',
  'full-battery': '满电库存不足',
} as const;

function compareArrivals(a: NextVisit, b: NextVisit): number {
  return a.arrivalMinute - b.arrivalMinute || a.vehicleOrder - b.vehicleOrder;
}

/** Only the next arrival per vehicle is known until its previous station visit is scheduled. */
class Arrivals {
  private heap: NextVisit[] = [];

  push(visit: NextVisit): void {
    const heap = this.heap;
    let index = heap.length;
    heap.push(visit);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareArrivals(visit, heap[parent]) >= 0) break;
      heap[index] = heap[parent];
      index = parent;
    }
    heap[index] = visit;
  }

  pop(): NextVisit | undefined {
    const heap = this.heap;
    const first = heap[0];
    const last = heap.pop();
    if (!last || heap.length === 0) return first;
    let index = 0;
    for (let child = 1; child < heap.length; child = index * 2 + 1) {
      const right = child + 1;
      if (right < heap.length && compareArrivals(heap[right], heap[child]) < 0) child = right;
      if (compareArrivals(last, heap[child]) <= 0) break;
      heap[index] = heap[child];
      index = child;
    }
    heap[index] = last;
    return first;
  }
}

function checkShift(schedule: VehicleSchedule, event: VehicleEnergyEvent, endMinute: number): void {
  if (schedule.shift && endMinute <= schedule.shift.endMinute + TIME_TOLERANCE) return;
  const wait = schedule.lastDelayedSwap;
  const delay = wait
    ? `站址“${wait.siteName}”第 ${wait.arrivalMinute.toFixed(2)} 分钟到站，因${wait.waitReasons.map((reason) => waitLabels[reason]).join('、')}等候。`
    : '';
  const label =
    event.kind === 'return'
      ? '归位空驶'
      : event.kind === 'swap'
        ? '换电服务'
        : `${event.from.name} → ${event.to.name}`;
  throw new Error(
    `车辆 ${schedule.vehicle.vehicleId}（${schedule.vehicle.vehicleGroupName}）的${label}超出班次（第 ${endMinute.toFixed(2)} 分钟结束，班次至第 ${schedule.shift?.endMinute ?? '未知'} 分钟）。${delay}本次未找到通过站内周转校核的安排。`,
  );
}

function advance(schedule: VehicleSchedule, vehicleOrder: number): NextVisit | null {
  const events = schedule.timeline.events;
  for (; schedule.index < events.length; schedule.index++) {
    const event = events[schedule.index];
    const shift = schedule.shifts.get(event.baselineEventId);
    if (shift !== schedule.shift) {
      // Each planned shift starts at the base point, independently of the previous shift.
      schedule.shift = shift;
      schedule.delay = 0;
      schedule.lastDelayedSwap = undefined;
    }
    const startMinute = event.startMinute + schedule.delay;
    if (event.kind === 'swap') {
      checkShift(schedule, event, startMinute);
      return { schedule, event, arrivalMinute: startMinute, vehicleOrder };
    }
    const endMinute = event.endMinute + schedule.delay;
    checkShift(schedule, event, endMinute);
    events[schedule.index] = { ...event, startMinute, endMinute };
  }
  return null;
}

export function generateDailyStationTurnover(
  snapshot: DailyTransportSnapshot,
  onProgress?: (progress: DailyTransportProgress) => void,
  config: DailyTransportConfig = { seed: 1, maxRuntimeMs: 10 * 60 * 1000 },
): DailyTransportResult {
  return generateStationPlan(snapshot, onProgress, config, false);
}

export function generateDailySharedPower(
  snapshot: DailyTransportSnapshot,
  onProgress?: (progress: DailyTransportProgress) => void,
  config: DailyTransportConfig = { seed: 1, maxRuntimeMs: 10 * 60 * 1000 },
): DailyTransportResult {
  return generateStationPlan(snapshot, onProgress, config, true);
}

function generateStationPlan(
  snapshot: DailyTransportSnapshot,
  onProgress: ((progress: DailyTransportProgress) => void) | undefined,
  config: DailyTransportConfig,
  sharedPower: boolean,
): DailyTransportResult {
  const deadline = Date.now() + config.maxRuntimeMs;
  const gaps = stationTurnoverReadiness(snapshot);
  if (gaps.length) throw new Error(gaps.join('；'));
  const result = generateVehicleEnergy(snapshot, onProgress, config);
  const energy = result.vehicleEnergy!;
  const station = createStationTurnover(snapshot, sharedPower);
  const sites = new Map(snapshot.context.stationNetwork?.sites.map((site) => [site.id, site.name]));
  const trips = new Map(result.trips.map((trip) => [trip.id, trip]));
  const vehicles = new Map(result.vehicles.map((vehicle) => [vehicle.vehicleId, vehicle]));
  const arrivals = new Arrivals();

  energy.vehicles.forEach((timeline, vehicleOrder) => {
    const vehicle = vehicles.get(timeline.vehicleId)!;
    const schedule: VehicleSchedule = {
      vehicle,
      timeline,
      shifts: dailyTransportEventShifts(vehicle, trips),
      index: 0,
      delay: 0,
    };
    const visit = advance(schedule, vehicleOrder);
    if (visit) arrivals.push(visit);
  });

  for (let visit = arrivals.pop(); visit; visit = arrivals.pop()) {
    if (Date.now() >= deadline) throw new Error('站内周转试算达到时限，未发布阶段结果');
    const { schedule, event, arrivalMinute, vehicleOrder } = visit;
    const service = station.scheduleSwap(
      {
        stationId: event.stationId!,
        vehicleId: schedule.vehicle.vehicleId,
        eventId: event.id,
        arrivalMinute,
        returnedKwh: event.startKwh,
      },
      schedule.shift!.endMinute,
    );
    if (service.endMinute > event.endMinute + schedule.delay + TIME_TOLERANCE) {
      schedule.lastDelayedSwap = {
        ...service,
        siteName: sites.get(service.stationId) ?? service.stationId,
      };
    }
    checkShift(schedule, event, service.endMinute);
    schedule.timeline.events[schedule.index++] = {
      ...event,
      startMinute: arrivalMinute,
      endMinute: service.endMinute,
      detour: { ...event.detour!, serviceStartMinute: service.serviceStartMinute },
    };
    schedule.delay = service.endMinute - event.endMinute;
    const next = advance(schedule, vehicleOrder);
    if (next) arrivals.push(next);
  }

  for (const timeline of energy.vehicles)
    timeline.workingMinutes = timeline.events.reduce(
      (sum, event) => sum + (event.endMinute - event.startMinute),
      0,
    );
  result.algorithmVersion = sharedPower
    ? DAILY_SHARED_POWER_ALGORITHM_VERSION
    : DAILY_STATION_TURNOVER_ALGORITHM_VERSION;
  energy.stationCapacityStatus = 'checked';
  energy.batteryInventoryStatus = 'checked';
  result.stationTurnover = station.finish();
  if (sharedPower) {
    energy.sharedPowerStatus = 'checked';
    result.sharedPower = buildSharedPowerLedger(snapshot, result.stationTurnover);
  }
  result.limitations = [
    sharedPower
      ? '已校核车辆、换电工位、库存、连续充电及共享电源。24 小时周期尚待校核。'
      : '已校核车辆、换电工位、满电库存和站内充电。共享电源与 24 小时周期尚待校核。',
    '首日车辆与站内备电池按满电起算，后续按实际事件延续。',
    '沿车辆电量试算选定的车次、班次及换电访问，按实际到站顺序安排站内服务。试算失败不证明布局无解。',
    ...(sharedPower
      ? [
          '按实际到站顺序预订完整连续充电区间，跨站可填补已有预订之前的空档；不重排已预订区间。购电仅统计账目截止前的实际占用，未按电价优化。',
        ]
      : []),
    ...result.limitations.slice(3),
  ];
  result.validation = validateDailyStationTurnover(snapshot, result, sharedPower);
  if (!result.validation.valid)
    throw new Error(`站内周转独立校验未通过：${result.validation.issues.join('；')}`);
  return result;
}

function validateDailyStationTurnover(
  snapshot: DailyTransportSnapshot,
  result: DailyTransportResult,
  sharedPower: boolean,
): DailyTransportValidation {
  const energy = result.vehicleEnergy;
  const ledger = result.stationTurnover;
  if (
    result.algorithmVersion !==
      (sharedPower
        ? DAILY_SHARED_POWER_ALGORITHM_VERSION
        : DAILY_STATION_TURNOVER_ALGORITHM_VERSION) ||
    !energy ||
    !ledger ||
    energy.stationCapacityStatus !== 'checked' ||
    energy.batteryInventoryStatus !== 'checked' ||
    energy.sharedPowerStatus !== (sharedPower ? 'checked' : 'not-checked') ||
    (sharedPower ? !result.sharedPower : result.sharedPower !== undefined)
  )
    return { valid: false, issues: ['站内周转阶段依据不一致'] };

  const vehicles = validateVehicleEnergy(snapshot, {
    ...result,
    algorithmVersion: VEHICLE_ENERGY_ALGORITHM_VERSION,
    stationTurnover: undefined,
    sharedPower: undefined,
    vehicleEnergy: {
      ...energy,
      stationCapacityStatus: 'not-checked',
      batteryInventoryStatus: 'not-checked',
      sharedPowerStatus: 'not-checked',
    },
  });
  if (!vehicles.valid) return vehicles;
  const stations = validateStationTurnover(snapshot, energy, ledger);
  if (!stations.valid || !sharedPower) return stations;
  return validateSharedPower(snapshot, ledger, result.sharedPower!);
}
