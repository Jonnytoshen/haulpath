import { randomUUID } from 'node:crypto';
import type {
  BatterySpecification,
  FleetOperations,
  MeasuredSegment,
  OperatingShift,
  PlanningScenario,
  VehicleGroup,
} from '@haulpath/domain';
import { HttpError } from './http';
import { scenarioFields } from './scenario-validation';
import { nameOf } from './validation';

// Resource guard for a locally expanded identity pool, not the representative fleet size.
const MAX_VEHICLE_IDENTITIES = 10_000;

function objectOf(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new HttpError(400, `${label}必须为对象`);
  return input as Record<string, unknown>;
}

function nullableNumber(
  input: unknown,
  label: string,
  minimum = 0,
  exclusiveMinimum = false,
  maximum = Number.MAX_VALUE,
): number | null {
  if (input === null) return null;
  if (
    typeof input !== 'number' ||
    !Number.isFinite(input) ||
    (exclusiveMinimum ? input <= minimum : input < minimum) ||
    input > maximum
  )
    throw new HttpError(400, `${label}须为有效范围内的数值，缺失时使用 null`);
  return input;
}

function sourceOf(input: unknown, required = false): string {
  if (typeof input !== 'string' || (required && !input.trim()))
    throw new HttpError(400, required ? '实测来源说明不能为空' : '参数来源说明须为文本');
  return input.trim();
}

function nullableId(input: unknown, label: string): string | null {
  if (input === null) return null;
  if (typeof input !== 'string' || !input.trim()) throw new HttpError(400, `${label}无效`);
  return input;
}

function refreshOf(input: unknown): boolean {
  if (input !== undefined && typeof input !== 'boolean')
    throw new HttpError(400, '重新确认标记必须为布尔值');
  return input === true;
}

function batteryOf(input: unknown): BatterySpecification | null {
  if (input === null) return null;
  const value = objectOf(input, '统一电池规格');
  scenarioFields(value, ['capacityKwh', 'chargePowerKw', 'chargeEfficiency', 'source']);
  return {
    capacityKwh: nullableNumber(value.capacityKwh, '电池容量', 0, true),
    chargePowerKw: nullableNumber(value.chargePowerKw, '等效充电功率', 0, true),
    chargeEfficiency: nullableNumber(value.chargeEfficiency, '充电效率', 0, true, 1),
    source: sourceOf(value.source),
  };
}

function shiftsOf(input: unknown): OperatingShift[] {
  if (!Array.isArray(input)) throw new HttpError(400, '班次作业窗口必须为数组');
  const intervals: [number, number][] = [];
  const shifts = input.map((item) => {
    const value = objectOf(item, '班次作业窗口');
    scenarioFields(value, ['startMinute', 'endMinute']);
    const start = value.startMinute;
    const end = value.endMinute;
    if (
      typeof start !== 'number' ||
      !Number.isInteger(start) ||
      start < 0 ||
      start >= 1440 ||
      typeof end !== 'number' ||
      !Number.isInteger(end) ||
      end <= start ||
      end > start + 1440
    )
      throw new HttpError(400, '班次须从当日分钟开始，时长大于零且不超过24小时');
    intervals.push([start, Math.min(end, 1440)]);
    if (end > 1440) intervals.push([0, end - 1440]);
    return { startMinute: start, endMinute: end };
  });
  intervals.sort((a, b) => a[0] - b[0]);
  if (intervals.some((interval, index) => index > 0 && interval[0] < intervals[index - 1][1]))
    throw new HttpError(400, '班次作业窗口不能重叠（含跨午夜的周期重叠）');
  return shifts;
}

function groupOf(input: unknown, scenario: PlanningScenario, seen: Set<string>): VehicleGroup {
  const value = objectOf(input, '车辆组');
  scenarioFields(value, [
    'id',
    'name',
    'count',
    'baseCycleId',
    'baseStartPositionId',
    'refreshBase',
    'payloadTonnes',
    'speedKph',
    'emptyKwhPerKm',
    'fullKwhPerKm',
    'safetySocPercent',
    'shifts',
    'loadingMinutes',
    'unloadingMinutes',
    'source',
  ]);
  const existing = scenario.context.operations?.vehicleGroups.find(
    (group) => group.id === value.id,
  );
  if (value.id !== undefined && (typeof value.id !== 'string' || !existing))
    throw new HttpError(400, '车辆组标识不属于当前规划方案');
  const id = existing?.id ?? randomUUID();
  if (seen.has(id)) throw new HttpError(400, '车辆组标识不能重复');
  seen.add(id);
  if (
    typeof value.count !== 'number' ||
    !Number.isSafeInteger(value.count) ||
    value.count < 0 ||
    value.count > MAX_VEHICLE_IDENTITIES
  )
    throw new HttpError(400, '当日数量上限须为非负整数；计划车辆身份池最多10000个');
  const baseCycleId = nullableId(value.baseCycleId, '基准循环');
  const baseStartPositionId = nullableId(value.baseStartPositionId, '基准循环起点');
  if ((baseCycleId === null) !== (baseStartPositionId === null))
    throw new HttpError(400, '基准循环和起点须同时配置或同时留空');
  const refreshBase = refreshOf(value.refreshBase);
  let baseStartBasis = existing?.baseStartBasis ?? null;
  const sameBase =
    existing?.baseCycleId === baseCycleId && existing?.baseStartPositionId === baseStartPositionId;
  if (baseCycleId === null) baseStartBasis = null;
  else if (!sameBase || refreshBase) {
    const cycle = scenario.context.transportCycles?.find(
      (candidate) => candidate.id === baseCycleId,
    );
    if (!cycle) throw new HttpError(400, '基准运输循环不属于当前规划方案');
    const first = cycle.positions[0];
    if (!first || first.id !== baseStartPositionId)
      throw new HttpError(400, '基准位置须为所属循环当前起点');
    baseStartBasis = { longitude: first.point.longitude, latitude: first.point.latitude };
  }
  const vehicleIds = [...(existing?.vehicleIds ?? [])];
  while (vehicleIds.length < value.count) vehicleIds.push(`V-${randomUUID()}`);
  const empty = nullableNumber(value.emptyKwhPerKm, '空载能耗');
  const full = nullableNumber(value.fullKwhPerKm, '满载能耗');
  if (empty !== null && full !== null && full < empty)
    throw new HttpError(400, '满载能耗不能低于空载能耗');
  return {
    id,
    name: nameOf(value.name),
    count: value.count,
    vehicleIds,
    baseCycleId,
    baseStartPositionId,
    baseStartBasis,
    payloadTonnes: nullableNumber(value.payloadTonnes, '额定载重', 0, true),
    speedKph: nullableNumber(value.speedKph, '业务速度', 0, true),
    emptyKwhPerKm: empty,
    fullKwhPerKm: full,
    safetySocPercent: nullableNumber(value.safetySocPercent, '安全电量百分比', 0, false, 100),
    shifts: shiftsOf(value.shifts),
    loadingMinutes: nullableNumber(value.loadingMinutes, '每次装货耗时'),
    unloadingMinutes: nullableNumber(value.unloadingMinutes, '每次卸货耗时'),
    source: sourceOf(value.source),
  };
}

function measuredOf(
  input: unknown,
  scenario: PlanningScenario,
  groups: VehicleGroup[],
  seen: Set<string>,
  associations: Set<string>,
): MeasuredSegment {
  const value = objectOf(input, '区间实测');
  scenarioFields(value, [
    'id',
    'vehicleGroupId',
    'cycleId',
    'fromPositionId',
    'toPositionId',
    'durationMinutes',
    'emptyKwh',
    'fullKwh',
    'source',
    'refreshBasis',
  ]);
  const existing = scenario.context.operations?.measuredSegments.find(
    (item) => item.id === value.id,
  );
  if (value.id !== undefined && (typeof value.id !== 'string' || !existing))
    throw new HttpError(400, '实测标识不属于当前规划方案');
  const id = existing?.id ?? randomUUID();
  if (seen.has(id)) throw new HttpError(400, '实测标识不能重复');
  seen.add(id);
  for (const key of ['vehicleGroupId', 'cycleId', 'fromPositionId', 'toPositionId']) {
    if (typeof value[key] !== 'string' || !(value[key] as string).trim())
      throw new HttpError(400, '请选择实测所属车辆组、循环及有向区间');
  }
  const association = JSON.stringify([
    value.vehicleGroupId,
    value.cycleId,
    value.fromPositionId,
    value.toPositionId,
  ]);
  if (associations.has(association)) throw new HttpError(400, '同一车辆组的有向区间实测不能重复');
  associations.add(association);
  const durationMinutes = nullableNumber(value.durationMinutes, '实测行驶时长', 0, true);
  const emptyKwh = nullableNumber(value.emptyKwh, '实测空载耗电');
  const fullKwh = nullableNumber(value.fullKwh, '实测满载耗电');
  if ((emptyKwh === null) !== (fullKwh === null))
    throw new HttpError(400, '实测空满载耗电须成对填写或同时留空');
  if (emptyKwh !== null && fullKwh !== null && fullKwh < emptyKwh)
    throw new HttpError(400, '实测满载耗电不能低于空载耗电');
  if (durationMinutes === null && emptyKwh === null)
    throw new HttpError(400, '实测须填写行驶时长或成对的空满载耗电');
  const refreshBasis = refreshOf(value.refreshBasis);
  const sameAssociation =
    existing?.vehicleGroupId === value.vehicleGroupId &&
    existing?.cycleId === value.cycleId &&
    existing?.fromPositionId === value.fromPositionId &&
    existing?.toPositionId === value.toPositionId;
  let basis = existing?.basis;
  if (!sameAssociation || refreshBasis) {
    const group = groups.find((candidate) => candidate.id === value.vehicleGroupId);
    if (!group) throw new HttpError(400, '实测车辆组不属于当前规划方案');
    const cycle = scenario.context.transportCycles?.find(
      (candidate) => candidate.id === value.cycleId,
    );
    if (!cycle) throw new HttpError(400, '实测循环不属于当前规划方案');
    const fromIndex = cycle.positions.findIndex((position) => position.id === value.fromPositionId);
    const from = cycle.positions[fromIndex];
    const to = cycle.positions[fromIndex + 1];
    if (fromIndex < 0 || !to || to.id !== value.toPositionId)
      throw new HttpError(400, '实测起止位置须为所属循环中的有向相邻区间');
    basis = {
      strategy: cycle.strategy,
      fromLongitude: from.point.longitude,
      fromLatitude: from.point.latitude,
      toLongitude: to.point.longitude,
      toLatitude: to.point.latitude,
      payloadTonnes: group.payloadTonnes,
    };
  }
  return {
    id,
    vehicleGroupId: value.vehicleGroupId as string,
    cycleId: value.cycleId as string,
    fromPositionId: value.fromPositionId as string,
    toPositionId: value.toPositionId as string,
    durationMinutes,
    emptyKwh,
    fullKwh,
    source: sourceOf(value.source, true),
    basis: basis!,
  };
}

export function fleetOperationsOf(input: unknown, scenario: PlanningScenario): FleetOperations {
  const value = objectOf(input, '车辆与运营资料');
  scenarioFields(value, ['battery', 'vehicleGroups', 'measuredSegments']);
  if (!Array.isArray(value.vehicleGroups) || !Array.isArray(value.measuredSegments))
    throw new HttpError(400, '车辆组与实测资料须为数组');
  const groupsSeen = new Set<string>();
  let totalIdentities = 0;
  const vehicleGroups = value.vehicleGroups.map((item, index) => {
    try {
      const group = groupOf(item, scenario, groupsSeen);
      totalIdentities += group.vehicleIds.length;
      if (totalIdentities > MAX_VEHICLE_IDENTITIES)
        throw new HttpError(400, '方案计划车辆历史身份池合计不能超过10000个');
      return group;
    } catch (error) {
      if (error instanceof HttpError)
        throw new HttpError(error.status, `车辆组第 ${index + 1} 行：${error.message}`);
      throw error;
    }
  });
  const measurementsSeen = new Set<string>();
  const associations = new Set<string>();
  const measuredSegments = value.measuredSegments.map((item, index) => {
    try {
      return measuredOf(item, scenario, vehicleGroups, measurementsSeen, associations);
    } catch (error) {
      if (error instanceof HttpError)
        throw new HttpError(error.status, `实测第 ${index + 1} 行：${error.message}`);
      throw error;
    }
  });
  return { battery: batteryOf(value.battery), vehicleGroups, measuredSegments };
}
