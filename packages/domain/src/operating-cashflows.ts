import type { PlanningScenarioContext } from './index';

export type BusinessBoundary = 'integrated' | 'station-only';
export type OperatingFlow =
  | 'transport-revenue'
  | 'external-station-revenue'
  | 'internal-swap'
  | 'transport-cost'
  | 'station-cost';
export type OperatingBasis =
  'tonne' | 'tonne-km' | 'vehicle-km' | 'empty-km' | 'swap' | 'grid-kwh' | 'year';
export interface OperatingPriceLine {
  id: string;
  name: string;
  flow: OperatingFlow;
  basis: OperatingBasis;
  /** CNY per named unit, decimal text with at most six fractional digits; null is unknown. */
  rate: string | null;
  source: string;
  stationId: string | null;
}
export interface ElectricityPrice {
  powerSourceId: string;
  payer: 'transport' | 'station' | 'external' | null;
  windows: { startMinute: number; endMinute: number; rate: string | null; source: string }[];
}
export interface OperatingCashflowYear {
  year: number;
  /** Explicit attestation of scope, including omitted/zero operating items. */
  scopeSource: string;
  stationCostMode: 'station-types' | 'annual-lines' | null;
  lines: OperatingPriceLine[];
  electricity: ElectricityPrice[];
}
export interface OperatingCashflowInput {
  boundary: BusinessBoundary | null;
  years: OperatingCashflowYear[];
}
export const operatingFlows: Record<OperatingFlow, string> = {
  'transport-revenue': '外部→运输方收入',
  'external-station-revenue': '外部→站方收入',
  'internal-swap': '运输方→站方内部换电结算',
  'transport-cost': '运输方→外部费用',
  'station-cost': '站方→外部费用',
};
export const operatingBases: Record<OperatingBasis, string> = {
  tonne: '实际完成吨数',
  'tonne-km': '实际载荷吨公里',
  'vehicle-km': '实际行驶公里',
  'empty-km': '实际空驶公里',
  swap: '实际换电次数',
  'grid-kwh': '实际购电 kWh',
  year: '年度固定金额',
};
export const operatingFlowBases: Record<OperatingFlow, OperatingBasis[]> = {
  'transport-revenue': ['tonne', 'tonne-km', 'vehicle-km', 'year'],
  'external-station-revenue': ['swap', 'grid-kwh', 'year'],
  'internal-swap': ['swap'],
  'transport-cost': ['vehicle-km', 'empty-km', 'tonne', 'tonne-km', 'year'],
  'station-cost': ['swap', 'grid-kwh', 'year'],
};
export function operatingInputIssues(context: PlanningScenarioContext): string[] {
  const input = context.operatingCashflows;
  if (!input) return ['运营收支输入待配置'];
  const issues: string[] = [];
  if (!context.annualTransport?.length) issues.push('评价年份待配置');
  if (!input.boundary) issues.push('业务边界待选择');
  for (const physical of context.annualTransport ?? []) {
    const year = input.years.find((y) => y.year === physical.year);
    if (!year) {
      issues.push(`${physical.year}：运营收支输入待配置`);
      continue;
    }
    if (!year.scopeSource.trim()) issues.push(`${year.year}：全部收入和运营费用的范围依据待填写`);
    if (!year.stationCostMode) issues.push(`${year.year}：站点运维口径待选择`);
    for (const line of year.lines) {
      if (operatingTreatment(line.flow, input.boundary) !== 'included') continue;
      if (line.rate === null) issues.push(`${year.year}：${line.name}单价待填写`);
      if (!line.source.trim()) issues.push(`${year.year}：${line.name}来源待填写`);
      if (
        line.stationId &&
        !context.stationNetwork?.fixedLayout.some((s) => s.siteId === line.stationId)
      )
        issues.push(`${year.year}：${line.name}关联站址已退出固定布局`);
    }
  }
  for (const year of input.years) {
    if (!context.annualTransport?.some((y) => y.year === year.year))
      issues.push(`${year.year}：评价年份关联失效，请显式修复`);
  }
  return issues;
}

export type OperatingTreatment = 'included' | 'eliminated' | 'excluded';
export interface OperatingLineLedger extends OperatingPriceLine {
  quantity: number | null;
  amountCents: number | null;
  direction: 'income' | 'expense';
  treatment: OperatingTreatment;
}
export interface ElectricityChargeLedger {
  powerSourceId: string;
  powerSourceName: string;
  stationId: string;
  stationName: string;
  payer: ElectricityPrice['payer'];
  startMinute: number;
  endMinute: number;
  rate: string | null;
  source: string;
  quantityKwh: number | null;
  amountCents: number | null;
  treatment: OperatingTreatment;
  /** Actual representative-day intersections, never reservations outside [0,1440). */
  intervals: { startMinute: number; endMinute: number; gridPowerKw: number }[];
}
export interface OperatingCashflowYearResult {
  year: number;
  operatingDays: number;
  evidenceYear: number | null;
  complete: boolean;
  issues: string[];
  lines: OperatingLineLedger[];
  electricity: ElectricityChargeLedger[];
  electricityTotalCents: number | null;
  incomeCents: number | null;
  expenseCents: number | null;
  balanceCents: number | null;
}
export const OPERATING_CASHFLOW_POLICY = 'cny-annual-line-half-up-6-2-v1';
export interface OperatingCashflowResult {
  id: string;
  projectId: string;
  scenarioId: string;
  inputVersion: number;
  createdAt: string;
  sourceTaskId: string;
  sourceInputVersion: number;
  sourceStatus: string;
  sourceComplete: boolean;
  policy: typeof OPERATING_CASHFLOW_POLICY;
  input: OperatingCashflowInput;
  annualInputs: import('./annual-transport').AnnualTransportYear[];
  complete: boolean;
  economicStatus: 'not-ready';
  issues: string[];
  years: OperatingCashflowYearResult[];
}
export interface OperatingCashflowView {
  projectId: string;
  scenarioId: string;
  inputVersion: number;
  issues: string[];
  results: OperatingCashflowResult[];
}
export function operatingTreatment(
  flow: OperatingFlow,
  boundary: BusinessBoundary | null,
): OperatingTreatment {
  if (flow === 'internal-swap') return boundary === 'integrated' ? 'eliminated' : 'included';
  return boundary === 'station-only' && flow.startsWith('transport') ? 'excluded' : 'included';
}

/** Decimal prices are shared by form previews and the authoritative input boundary. */
export function validOperatingRate(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^\d{1,12}(\.\d{1,6})?$/.test(value));
}
export function tariffWindowPieces(window: { startMinute: number; endMinute: number }): number[][] {
  return window.startMinute < window.endMinute
    ? [[window.startMinute, window.endMinute]]
    : [
        [window.startMinute, 1440],
        [0, window.endMinute],
      ];
}
export function tariffWindowIssue(
  windows: { startMinute: number; endMinute: number }[],
): string | null {
  if (
    windows.some(
      (w) =>
        !Number.isInteger(w.startMinute) ||
        !Number.isInteger(w.endMinute) ||
        w.startMinute < 0 ||
        w.startMinute >= 1440 ||
        w.endMinute < 0 ||
        w.endMinute > 1440 ||
        w.startMinute === w.endMinute,
    )
  )
    return '电价窗口须为日内整数分钟；跨午夜可结束早于开始';
  const pieces = windows
    .flatMap(tariffWindowPieces)
    .filter(([a, b]) => a < b)
    .sort(([a], [b]) => a - b);
  return pieces.some((p, i) => i > 0 && p[0] < pieces[i - 1][1]) ? '电价窗口不能重叠' : null;
}
