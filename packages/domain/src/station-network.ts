import type {
  BatterySpecification,
  OperatingShift,
  PlanningScenarioContext,
  Point,
  PowerConnectionPoint,
  PowerConnectionPointInput,
} from './index';
import { powerConnectionPointReadiness } from './power-connection-points';

export interface StationType {
  id: string;
  name: string;
  bays: number | null;
  swapMinutes: number | null;
  batteryInventory: number | null;
  chargingSlots: number | null;
  /** Total station charging power ceiling; the battery retains its per-battery equivalent power. */
  chargePowerKw: number | null;
  serviceWindows: OperatingShift[];
  chargeWindows: OperatingShift[];
  investment: number | null;
  annualOperatingCost: number | null;
  source: string;
  batteryBasis: BatterySpecification | null;
}
export type StationTypeInput = Omit<StationType, 'id' | 'batteryBasis'> & {
  id?: string;
  refreshBattery?: boolean;
};
export interface ScenarioPowerSource {
  id: string;
  sourcePointId: string;
  sourceRevision: number;
  point: PowerConnectionPoint;
}
export interface ScenarioPowerSourceInput {
  id?: string;
  sourcePointId: string;
  refreshSource?: boolean;
  point?: Omit<PowerConnectionPointInput, 'id'>;
}
export interface StationConnection {
  powerSourceId: string;
  availablePowerKw: number | null;
  connectionInvestment: number | null;
  notes: string;
  confirmed: boolean;
}
export interface CandidateSite extends Point {
  siteNotes: string;
  siteConfirmed: boolean;
  connection: StationConnection | null;
}
export interface CandidateSiteInput {
  id?: string;
  name: string;
  longitude: number;
  latitude: number;
  coordinateSystem: Point['coordinateSystem'];
  source?: Point['source'];
  siteNotes: string;
  siteConfirmed: boolean;
  connection: StationConnection | null;
}
export interface FixedStationSelection {
  siteId: string;
  stationTypeId: string;
}
export interface StationNetwork {
  stationTypes: StationType[];
  sites: CandidateSite[];
  powerSources: ScenarioPowerSource[];
  fixedLayout: FixedStationSelection[];
}
export interface StationNetworkInput {
  stationTypes: StationTypeInput[];
  sites: CandidateSiteInput[];
  powerSources: ScenarioPowerSourceInput[];
  fixedLayout: FixedStationSelection[];
}
export function emptyStationNetwork(): StationNetwork {
  return { stationTypes: [], sites: [], powerSources: [], fixedLayout: [] };
}
function sameBattery(a: BatterySpecification | null, b: BatterySpecification | null): boolean {
  return (
    !!a &&
    !!b &&
    a.capacityKwh === b.capacityKwh &&
    a.chargePowerKw === b.chargePowerKw &&
    a.chargeEfficiency === b.chargeEfficiency &&
    a.source === b.source
  );
}
export function stationTypeReadiness(
  type: StationType,
  battery: BatterySpecification | null,
): string[] {
  const gaps: string[] = [];
  if (!sameBattery(type.batteryBasis, battery))
    gaps.push('统一电池规格未关联或已改变，须显式重新关联');
  if (
    battery?.capacityKwh == null ||
    battery.chargePowerKw == null ||
    battery.chargeEfficiency == null ||
    !battery.source.trim()
  )
    gaps.push('统一电池参数或来源待完善');
  for (const [field, label] of [
    ['bays', '换电工位'],
    ['swapMinutes', '换电时间'],
    ['batteryInventory', '电池库存'],
    ['chargingSlots', '充电位'],
    ['chargePowerKw', '站内总充电功率上限'],
  ] as const) {
    if (type[field] === null) gaps.push(`${label}待填写`);
    else if (type[field] === 0) gaps.push(`${label}为0，当前不能服务`);
  }
  if (!type.serviceWindows.length) gaps.push('服务窗口待填写');
  if (!type.chargeWindows.length) gaps.push('充电窗口待填写');
  if (!type.source.trim()) gaps.push('站型参数来源待填写');
  return gaps;
}
export function candidateSiteReadiness(site: CandidateSite, network: StationNetwork): string[] {
  const gaps: string[] = [];
  if (!site.siteConfirmed) gaps.push('场地待确认');
  const connection = site.connection;
  if (!connection) return [...gaps, '接电关系待配置'];
  const power = network.powerSources.find((item) => item.id === connection.powerSourceId);
  if (!power) gaps.push('接电电源快照已删除或不存在');
  else {
    gaps.push(...powerConnectionPointReadiness(power.point));
    if (
      connection.availablePowerKw !== null &&
      power.point.availableCapacityKw !== null &&
      connection.availablePowerKw > power.point.availableCapacityKw
    )
      gaps.push('站址可用功率超过所选电源可用容量');
  }
  if (connection.availablePowerKw === null || connection.availablePowerKw <= 0)
    gaps.push('站址可用功率待明确');
  if (!connection.notes.trim()) gaps.push('接电确认依据待填写');
  if (!connection.confirmed) gaps.push('接电关系待确认');
  return gaps;
}
export function stationNetworkReadiness(context: PlanningScenarioContext): string[] {
  const network = context.stationNetwork;
  if (!network) return ['站网资料待配置'];
  const gaps: string[] = [];
  if (!network.fixedLayout.length) gaps.push('尚未选择固定布局（空布局不表示已完成试算）');
  for (const selection of network.fixedLayout) {
    const site = network.sites.find((item) => item.id === selection.siteId);
    const type = network.stationTypes.find((item) => item.id === selection.stationTypeId);
    if (!site) gaps.push('固定布局的站址已删除或不存在');
    else gaps.push(...candidateSiteReadiness(site, network).map((gap) => `${site.name}：${gap}`));
    if (!type) gaps.push('固定布局的站型已删除或不存在');
    else
      gaps.push(
        ...stationTypeReadiness(type, context.operations?.battery ?? null).map(
          (gap) => `${type.name}：${gap}`,
        ),
      );
  }
  return gaps;
}
export function stationNetworkFinancialReadiness(network: StationNetwork): string[] {
  const gaps: string[] = [];
  for (const selection of network.fixedLayout) {
    const site = network.sites.find((item) => item.id === selection.siteId);
    const type = network.stationTypes.find((item) => item.id === selection.stationTypeId);
    if (type?.investment === null) gaps.push(`${type.name}：建站投资待填写`);
    if (type?.annualOperatingCost === null) gaps.push(`${type.name}：年度运维费用待填写`);
    if (site?.connection?.connectionInvestment === null) gaps.push(`${site.name}：接电投资待填写`);
  }
  return gaps;
}
