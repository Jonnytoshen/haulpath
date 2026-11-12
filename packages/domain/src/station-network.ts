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
  generationBasis?: CandidateGenerationBasis;
  siteNotes: string;
  siteConfirmed: boolean;
  connection: StationConnection | null;
}
export interface CandidateSiteInput {
  generationBasis?: CandidateGenerationBasis;
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
export interface CandidateGenerationBasis {
  algorithm: 'input-locations-v1';
  origins: { key: string; label: string }[];
}
export interface SitingConstraints {
  maxInvestment: number | null;
  maxStations: number | null;
  requiredSiteIds: string[];
  excludedSiteIds: string[];
}
export interface StationNetwork {
  constraints?: SitingConstraints;
  stationTypes: StationType[];
  sites: CandidateSite[];
  powerSources: ScenarioPowerSource[];
  fixedLayout: FixedStationSelection[];
}
export interface StationNetworkInput {
  constraints?: SitingConstraints;
  stationTypes: StationTypeInput[];
  sites: CandidateSiteInput[];
  powerSources: ScenarioPowerSourceInput[];
  fixedLayout: FixedStationSelection[];
}
export function emptyStationNetwork(): StationNetwork {
  return { stationTypes: [], sites: [], powerSources: [], fixedLayout: [] };
}
export function stationBatteryMatches(
  a: BatterySpecification | null,
  b: BatterySpecification | null,
): boolean {
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
  if (!stationBatteryMatches(type.batteryBasis, battery))
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
export function stationNetworkReadiness(
  context: PlanningScenarioContext,
  stage: 'station-operations' | 'transport' = 'station-operations',
): string[] {
  const network = context.stationNetwork;
  if (!network) return ['站网资料待配置'];
  const gaps: string[] = sitingConstraintReadiness(context);
  if (!network.fixedLayout.length) gaps.push('尚未选择固定布局（空布局不表示已完成试算）');
  for (const selection of network.fixedLayout) {
    const site = network.sites.find((item) => item.id === selection.siteId);
    const type = network.stationTypes.find((item) => item.id === selection.stationTypeId);
    if (!site) gaps.push('固定布局的站址已删除或不存在');
    else gaps.push(...candidateSiteReadiness(site, network).map((gap) => `${site.name}：${gap}`));
    if (!type) gaps.push('固定布局的站型已删除或不存在');
    else if (stage === 'station-operations')
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

export function emptySitingConstraints(): SitingConstraints {
  return { maxInvestment: null, maxStations: null, requiredSiteIds: [], excludedSiteIds: [] };
}

/** Formal eligibility is derived from current confirmations, never from a view filter. */
export function formalCandidateSites(network: StationNetwork): CandidateSite[] {
  const excluded = new Set(network.constraints?.excludedSiteIds ?? []);
  return network.sites.filter(
    (site) => !excluded.has(site.id) && !candidateSiteReadiness(site, network).length,
  );
}

/** Each supplied investment is rounded to cents before aggregation. No missing price becomes zero. */
function investmentCents(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  const [coefficient, exponent = '0'] = value.toString().split('e');
  const cents = Math.round(Number(`${coefficient}e${Number(exponent) + 2}`));
  return Number.isSafeInteger(cents) ? cents : null;
}

export function sitingBudgetPriceReadiness(context: PlanningScenarioContext): string[] {
  const network = context.stationNetwork;
  if (!network || network.constraints?.maxInvestment == null) return [];
  const gaps: string[] = [];
  if (investmentCents(network.constraints.maxInvestment) === null)
    gaps.push('新增投资上限超出可核对的金额范围');
  const selected = new Set(network.fixedLayout.map((selection) => selection.siteId));
  const formal = new Set(formalCandidateSites(network).map((site) => site.id));
  for (const site of network.sites.filter((site) => formal.has(site.id) || selected.has(site.id)))
    if (investmentCents(site.connection?.connectionInvestment) === null)
      gaps.push(`${site.name}：接电投资待填写或超出金额范围，不能启用预算上限`);
  const types = network.stationTypes.filter(
    (type) =>
      network.fixedLayout.some((selection) => selection.stationTypeId === type.id) ||
      !stationTypeReadiness(type, context.operations?.battery ?? null).length,
  );
  if (formal.size && !types.length) gaps.push('正式候选缺少可用站型及建站投资，不能启用预算上限');
  for (const type of types)
    if (investmentCents(type.investment) === null)
      gaps.push(`${type.name}：建站投资待填写或超出金额范围，不能启用预算上限`);
  return gaps;
}

/** Draft conflicts remain repairable, but every adoption and calculation must satisfy these limits. */
export function sitingConstraintReadiness(context: PlanningScenarioContext): string[] {
  const network = context.stationNetwork;
  const constraints = network?.constraints;
  if (!network || !constraints) return [];
  const priceGaps = sitingBudgetPriceReadiness(context);
  const gaps = [...priceGaps];
  const selected = new Set(network.fixedLayout.map((selection) => selection.siteId));
  const excluded = new Set(constraints.excludedSiteIds);
  if (constraints.maxStations !== null) {
    if (constraints.requiredSiteIds.length > constraints.maxStations)
      gaps.push('必选站址数量超过新建站数上限');
    if (selected.size > constraints.maxStations) gaps.push('固定布局超过新建站数上限');
  }
  for (const id of constraints.requiredSiteIds) {
    const site = network.sites.find((site) => site.id === id);
    const label = `必选站址「${site?.name ?? id}」`;
    if (!site) gaps.push(`${label}已删除，须修复必选约束`);
    else if (candidateSiteReadiness(site, network).length)
      gaps.push(`${label}尚未进入正式候选集，须修复确认条件`);
    if (excluded.has(id)) gaps.push(`${label}同时禁选`);
    if (!selected.has(id)) gaps.push(`${label}未纳入固定布局`);
  }
  for (const id of selected)
    if (excluded.has(id))
      gaps.push(
        `固定布局包含禁选站址「${network.sites.find((site) => site.id === id)?.name ?? id}」`,
      );
  if (constraints.maxInvestment !== null && !priceGaps.length) {
    let cents = 0;
    for (const selection of network.fixedLayout) {
      const site = network.sites.find((site) => site.id === selection.siteId);
      const type = network.stationTypes.find((type) => type.id === selection.stationTypeId);
      const construction = investmentCents(type?.investment);
      const connection = investmentCents(site?.connection?.connectionInvestment);
      if (construction === null || connection === null) {
        gaps.push('固定布局缺少建站或接电投资，无法核对新增投资上限');
        return gaps;
      }
      cents += construction + connection;
    }
    if (!Number.isSafeInteger(cents) || cents > investmentCents(constraints.maxInvestment)!)
      gaps.push('固定布局总新增投资超过上限（逐站建站投资＋接电投资）');
  }
  return gaps;
}
