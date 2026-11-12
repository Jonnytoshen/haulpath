import type { JsonValue, PlanningScenario, PlanningScenarioContext } from './index';

export interface ScenarioInputDifference {
  kind: 'added' | 'removed' | 'changed';
  section: string;
  path: string;
  label: string;
  left: JsonValue | null;
  right: JsonValue | null;
}

export interface ScenarioComparison {
  left: PlanningScenario;
  right: PlanningScenario;
  differences: ScenarioInputDifference[];
}

const fieldLabels: Record<string, string> = {
  id: '标识',
  name: '名称',
  resources: '其他资源',
  annual: '年度参数',
  annualTransport: '年度运输能力',
  operatingDays: '年运营天数（天）',
  demandId: '运输需求',
  demands: '年度需求',
  transportCycles: '运输循环',
  transportDemands: '运输需求',
  operations: '车辆与运营',
  stationNetwork: '站网配置',
  roadSettings: '道路准备',
  continuationStrategy: '跨线接续驾车偏好',
  swapDetourLimits: '换电绕行限额',
  maxExtraMeters: '额外行驶距离上限（米）',
  maxExtraMinutes: '额外行驶时间上限（分钟）',
  positions: '业务点位顺序',
  point: '点位资料',
  source: '来源',
  sourcePointId: '来源点位',
  routeId: '来源线路',
  inputVersion: '输入版本',
  importedAt: '引入时间',
  points: '来源点位顺序',
  strategy: '规划偏好',
  snapshot: '路线方案快照',
  roads: '有向道路资料',
  fromPositionId: '起始位置',
  toPositionId: '终止位置',
  leg: '区间资料',
  confirmed: '已确认',
  confirmedAt: '确认时间',
  longitude: '经度',
  latitude: '纬度',
  coordinateSystem: '坐标系',
  originalLongitude: '原始经度',
  originalLatitude: '原始纬度',
  originalCoordinateSystem: '原始坐标系',
  address: '地址',
  distanceMeters: '距离（米）',
  durationSeconds: '行驶时间（秒）',
  polyline: '道路折线',
  steps: '道路步骤',
  cycleId: '所属运输循环',
  loadingPositionId: '装货位置',
  unloadingPositionId: '卸货位置',
  dailyTonnes: '日吨数（吨/日）',
  battery: '统一电池',
  capacityKwh: '容量（kWh）',
  chargePowerKw: '充电功率（kW）',
  chargeEfficiency: '充电效率',
  vehicleGroups: '车辆组',
  measuredSegments: '区间实测',
  count: '当日数量上限（辆）',
  vehicleIds: '计划车辆标识',
  baseCycleId: '基准循环',
  baseStartPositionId: '基准循环起点',
  baseStartBasis: '基准起点依据',
  payloadTonnes: '载重（吨）',
  speedKph: '业务速度（km/h）',
  emptyKwhPerKm: '空载能耗（kWh/km）',
  fullKwhPerKm: '满载能耗（kWh/km）',
  safetySocPercent: '安全电量（%）',
  shifts: '班次窗口',
  startMinute: '开始（当日分钟）',
  endMinute: '结束（当日分钟）',
  loadingMinutes: '装货耗时（分钟/次）',
  unloadingMinutes: '卸货耗时（分钟/次）',
  vehicleGroupId: '所属车辆组',
  durationMinutes: '行驶时间（分钟）',
  emptyKwh: '空载耗电（kWh）',
  fullKwh: '满载耗电（kWh）',
  basis: '实测依据',
  fromLongitude: '起点经度',
  fromLatitude: '起点纬度',
  toLongitude: '终点经度',
  toLatitude: '终点纬度',
  stationTypes: '站型',
  sites: '候选站址',
  powerSources: '电源快照',
  fixedLayout: '固定布局',
  constraints: '选址硬约束',
  maxInvestment: '总新增投资上限（元）',
  maxStations: '新建站数上限',
  requiredSiteIds: '必选站址',
  excludedSiteIds: '禁选站址',
  generationBasis: '初步候选生成依据',
  algorithm: '生成算法',
  origins: '建议来源',
  key: '来源身份',
  label: '来源说明',
  bays: '换电工位（个）',
  swapMinutes: '换电时间（分钟）',
  batteryInventory: '电池库存（块）',
  chargingSlots: '充电位（个）',
  serviceWindows: '服务窗口',
  chargeWindows: '充电窗口',
  investment: '建站投资（元）',
  annualOperatingCost: '年度运维费用（元）',
  batteryBasis: '统一电池关联依据',
  sourceRevision: '来源修订号',
  siteNotes: '场地依据',
  siteConfirmed: '场地已确认',
  connection: '接电关系',
  powerSourceId: '接电电源',
  availablePowerKw: '站址可用功率（kW）',
  connectionInvestment: '接电投资（元）',
  notes: '确认依据',
  siteId: '站址',
  stationTypeId: '站型',
  availableCapacityKw: '可用容量（kW）',
  capacitySource: '容量来源',
  connectionNotes: '接电说明',
  from: '起点',
  to: '终点',
  distance: '距离',
  namePath: '道路名称',
  legs: '区间',
  createdAt: '创建时间',
  updatedAt: '保存时间',
  plannedAt: '测算时间',
  totalDistanceMeters: '总距离（米）',
  index: '区间顺序',
  projectId: '所属项目',
  calculatedAt: '测算时间',
  year: '年份',
};

/** Shared input vocabulary; station totals and per-battery equivalent power remain distinct. */
export function scenarioInputFieldLabel(key: string, path = ''): string {
  if (key === 'chargePowerKw')
    return path.includes('stationTypes') && !path.includes('batteryBasis')
      ? '站内总充电功率上限（kW）'
      : '单电池等效充电功率（kW）';
  return Object.hasOwn(fieldLabels, key) ? fieldLabels[key] : key;
}

const sections: [keyof PlanningScenarioContext, string][] = [
  ['transportCycles', '运输循环'],
  ['transportDemands', '运输需求'],
  ['operations', '车辆与运营'],
  ['stationNetwork', '站网配置'],
  ['roadSettings', '道路准备'],
  ['swapDetourLimits', '换电绕行限额'],
  ['resources', '其他资源'],
  ['annual', '年度参数'],
  ['annualTransport', '年度运输能力'],
];

function object(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identity(value: JsonValue, path: string): string | null {
  if (!object(value)) return null;
  if (typeof value.id === 'string') return value.id;
  if (typeof value.siteId === 'string') return value.siteId;
  if (path === 'annualTransport' && typeof value.year === 'number') return String(value.year);
  if (path.startsWith('annualTransport[') && typeof value.demandId === 'string')
    return value.demandId;
  if (typeof value.fromPositionId === 'string' && typeof value.toPositionId === 'string')
    return `${value.fromPositionId}:${value.toPositionId}`;
  return null;
}

function itemName(
  value: JsonValue,
  fallback: string,
  names: Map<string, string>,
  path: string,
): string {
  if (!object(value)) return fallback;
  if (typeof value.name === 'string') return value.name;
  if (path === 'annualTransport' && typeof value.year === 'number') return `${value.year} 年`;
  if (path.startsWith('annualTransport[') && typeof value.demandId === 'string')
    return names.get(value.demandId) ?? value.demandId;
  if (object(value.point) && typeof value.point.name === 'string') return value.point.name;
  if (typeof value.loadingPositionId === 'string' && typeof value.unloadingPositionId === 'string')
    return `${names.get(value.loadingPositionId) ?? value.loadingPositionId} → ${names.get(value.unloadingPositionId) ?? value.unloadingPositionId}`;
  if (typeof value.fromPositionId === 'string' && typeof value.toPositionId === 'string')
    return `${names.get(value.fromPositionId) ?? value.fromPositionId} → ${names.get(value.toPositionId) ?? value.toPositionId}`;
  if (typeof value.siteId === 'string') return names.get(value.siteId) ?? value.siteId;
  return names.get(fallback) ?? fallback;
}

/** Compare input values, aligning local resource identities and keeping order as a separate change. */
export function scenarioInputDifferences(
  left: PlanningScenarioContext,
  right: PlanningScenarioContext,
): ScenarioInputDifference[] {
  const differences: ScenarioInputDifference[] = [];
  const names = new Map<string, string>();
  function collectNames(value: unknown) {
    if (Array.isArray(value)) return value.forEach(collectNames);
    if (!value || typeof value !== 'object') return;
    const row = value as Record<string, unknown>;
    if (typeof row.id === 'string') {
      if (typeof row.name === 'string') names.set(row.id, row.name);
      else if (row.point && typeof row.point === 'object') {
        const point = row.point as Record<string, unknown>;
        if (typeof point.name === 'string') names.set(row.id, point.name);
      }
    }
    Object.values(row).forEach(collectNames);
  }
  collectNames(left);
  collectNames(right);
  function visit(
    before: JsonValue | undefined,
    after: JsonValue | undefined,
    section: string,
    path: string,
    label: string,
  ) {
    if (before === after) return;
    if (Array.isArray(before) && Array.isArray(after)) {
      const beforeIds = before.map((value) => identity(value, path));
      const afterIds = after.map((value) => identity(value, path));
      if (
        beforeIds.every((id) => id !== null) &&
        afterIds.every((id) => id !== null) &&
        new Set(beforeIds).size === before.length &&
        new Set(afterIds).size === after.length
      ) {
        if (JSON.stringify(beforeIds) !== JSON.stringify(afterIds)) {
          const order = (values: JsonValue[]) =>
            values.map((value) => ({
              id: identity(value, path)!,
              name: itemName(value, identity(value, path)!, names, path),
            }));
          differences.push({
            kind: 'changed',
            section,
            path: `${path}.order`,
            label: `${label} · 顺序`,
            left: order(before),
            right: order(after),
          });
        }
        const beforeItems = new Map(before.map((value) => [identity(value, path)!, value]));
        const afterItems = new Map(after.map((value) => [identity(value, path)!, value]));
        for (const id of new Set([...beforeItems.keys(), ...afterItems.keys()])) {
          const oldValue = beforeItems.get(id);
          const newValue = afterItems.get(id);
          const name = itemName(newValue ?? oldValue!, id, names, path);
          visit(oldValue, newValue, section, `${path}[${id}]`, `${label} · ${name}`);
        }
        return;
      }
      if (JSON.stringify(before) === JSON.stringify(after)) return;
      // Primitive arrays, windows and coordinates carry their meaning in their order.
      differences.push({ kind: 'changed', section, path, label, left: before, right: after });
      return;
    }
    if (object(before) && object(after)) {
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        // These timestamps describe when a snapshot was taken or confirmed, not its input basis.
        if (
          section === '运输循环' &&
          (key === 'importedAt' || key === 'confirmedAt' || key === 'calculatedAt')
        )
          continue;
        const field = scenarioInputFieldLabel(key, path);
        visit(before[key], after[key], section, `${path}.${key}`, `${label} · ${field}`);
      }
      return;
    }
    differences.push({
      kind: before === undefined ? 'added' : after === undefined ? 'removed' : 'changed',
      section,
      path,
      label,
      left: before ?? null,
      right: after ?? null,
    });
  }
  for (const [key, label] of sections) {
    visit(left[key] as unknown as JsonValue, right[key] as unknown as JsonValue, label, key, label);
  }
  return differences;
}
