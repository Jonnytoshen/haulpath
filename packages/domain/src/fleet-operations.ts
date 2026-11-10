import type { PlanningScenarioContext, Strategy, TransportCycle } from './index';

export interface BatterySpecification {
  capacityKwh: number | null;
  /** Constant grid-side power for one battery. */
  chargePowerKw: number | null;
  chargeEfficiency: number | null;
  source: string;
}

/** Minutes relative to the representative day's midnight; end may be next day. */
export interface OperatingShift {
  startMinute: number;
  endMinute: number;
}

export interface BaseStartBasis {
  longitude: number;
  latitude: number;
}

export interface VehicleGroup {
  id: string;
  name: string;
  count: number;
  /** Historical identity pool; only the first count vehicles are available. */
  vehicleIds: string[];
  baseCycleId: string | null;
  baseStartPositionId: string | null;
  baseStartBasis: BaseStartBasis | null;
  payloadTonnes: number | null;
  speedKph: number | null;
  emptyKwhPerKm: number | null;
  fullKwhPerKm: number | null;
  safetySocPercent: number | null;
  shifts: OperatingShift[];
  loadingMinutes: number | null;
  unloadingMinutes: number | null;
  source: string;
}

export interface MeasuredSegmentBasis {
  strategy: Strategy;
  fromLongitude: number;
  fromLatitude: number;
  toLongitude: number;
  toLatitude: number;
  payloadTonnes: number | null;
}

export interface MeasuredSegment {
  id: string;
  vehicleGroupId: string;
  cycleId: string;
  fromPositionId: string;
  toPositionId: string;
  durationMinutes: number | null;
  emptyKwh: number | null;
  fullKwh: number | null;
  source: string;
  basis: MeasuredSegmentBasis;
}

export interface FleetOperations {
  battery: BatterySpecification | null;
  vehicleGroups: VehicleGroup[];
  measuredSegments: MeasuredSegment[];
}

export type VehicleGroupInput = Omit<VehicleGroup, 'id' | 'vehicleIds' | 'baseStartBasis'> & {
  id?: string;
  refreshBase?: boolean;
};
export type MeasuredSegmentInput = Omit<MeasuredSegment, 'id' | 'basis'> & {
  id?: string;
  refreshBasis?: boolean;
};
export interface FleetOperationsInput {
  battery: BatterySpecification | null;
  vehicleGroups: VehicleGroupInput[];
  measuredSegments: MeasuredSegmentInput[];
}

export function emptyFleetOperations(): FleetOperations {
  return { battery: null, vehicleGroups: [], measuredSegments: [] };
}

export function vehicleGroupIssue(group: VehicleGroup, cycles: TransportCycle[]): string | null {
  if (!group.baseCycleId || !group.baseStartPositionId || !group.baseStartBasis)
    return '基准循环起点待配置';
  const cycle = cycles.find((candidate) => candidate.id === group.baseCycleId);
  if (!cycle) return '基准运输循环已删除或不存在';
  const first = cycle.positions[0];
  if (!first || first.id !== group.baseStartPositionId) return '基准循环起点已改变或不存在';
  if (
    first.point.longitude !== group.baseStartBasis.longitude ||
    first.point.latitude !== group.baseStartBasis.latitude
  )
    return '基准循环起点坐标已改变，须重新确认';
  return null;
}

export function measuredSegmentIssue(
  measured: MeasuredSegment,
  operations: FleetOperations,
  cycles: TransportCycle[],
  scope: 'operations' | 'travel-time' = 'operations',
): string | null {
  const group = operations.vehicleGroups.find(
    (candidate) => candidate.id === measured.vehicleGroupId,
  );
  if (!group) return '实测所属车辆组已删除或不存在';
  const cycle = cycles.find((candidate) => candidate.id === measured.cycleId);
  if (!cycle) return '实测所属运输循环已删除或不存在';
  const fromIndex = cycle.positions.findIndex(
    (position) => position.id === measured.fromPositionId,
  );
  const from = cycle.positions[fromIndex];
  const to = cycle.positions[fromIndex + 1];
  if (fromIndex < 0 || !to || to.id !== measured.toPositionId)
    return '实测起止位置不再构成有向相邻区间';
  if (
    measured.basis.strategy !== cycle.strategy ||
    measured.basis.fromLongitude !== from.point.longitude ||
    measured.basis.fromLatitude !== from.point.latitude ||
    measured.basis.toLongitude !== to.point.longitude ||
    measured.basis.toLatitude !== to.point.latitude
  )
    return '实测区间坐标或规划偏好已改变，须重新确认';
  if (
    scope === 'operations' &&
    measured.emptyKwh !== null &&
    measured.basis.payloadTonnes !== group.payloadTonnes
  )
    return '实测满载依据已改变，须重新确认';
  return null;
}

export function fleetOperationsReadiness(context: PlanningScenarioContext): string[] {
  const operations = context.operations;
  if (!operations) return ['车辆、电池与运营模板待配置'];
  const gaps: string[] = [];
  const battery = operations.battery;
  if (battery?.capacityKwh == null) gaps.push('统一电池容量待配置');
  if (battery?.chargePowerKw == null) gaps.push('统一电池等效充电功率待配置');
  if (battery?.chargeEfficiency == null) gaps.push('统一电池充电效率待配置');
  if (!battery?.source.trim()) gaps.push('统一电池参数来源待填写');
  if (!operations.vehicleGroups.length) gaps.push('车辆组待配置');
  for (const group of operations.vehicleGroups) {
    const label = `车辆组“${group.name}”`;
    const issue = vehicleGroupIssue(group, context.transportCycles ?? []);
    if (issue) gaps.push(`${label}：${issue}`);
    const cycle = context.transportCycles?.find((candidate) => candidate.id === group.baseCycleId);
    if (cycle && !cycle.confirmed) gaps.push(`${label}：基准循环业务顺序与回程待确认`);
    for (const [field, name] of [
      ['payloadTonnes', '载重'],
      ['speedKph', '业务速度'],
      ['emptyKwhPerKm', '空载能耗'],
      ['fullKwhPerKm', '满载能耗'],
      ['safetySocPercent', '安全电量'],
      ['loadingMinutes', '装货耗时'],
      ['unloadingMinutes', '卸货耗时'],
    ] as const) {
      if (group[field] === null) gaps.push(`${label}：${name}待配置`);
    }
    if (!group.shifts.length) gaps.push(`${label}：班次作业窗口待配置`);
    if (!group.source.trim()) gaps.push(`${label}：模板参数来源待填写`);
  }
  for (const measured of operations.measuredSegments) {
    const issue = measuredSegmentIssue(measured, operations, context.transportCycles ?? []);
    if (issue) gaps.push(`区间实测：${issue}`);
  }
  return gaps;
}
