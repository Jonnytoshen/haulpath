import type { BusinessBoundary } from './operating-cashflows';
import type { PlanningScenarioContext, StationNetwork } from './index';

export const assetCategories = {
  vehicle: '车辆',
  battery: '电池',
  station: '站点设备及建设',
  connection: '接电工程',
  other: '其他资产',
};
export const assetOwners = { station: '站方', transport: '运输方', external: '外部承担/取得' };
export type AssetOwner = keyof typeof assetOwners;
export type AssetEventKind = 'initial' | 'replacement' | 'disposal' | 'residual';
export const assetEventNames: Record<AssetEventKind, string> = {
  initial: '初始新增投资',
  replacement: '更换投资',
  disposal: '更换处置回收',
  residual: '期末残值回收',
};
export interface AssetEntry {
  id: string;
  name: string;
  category: keyof typeof assetCategories;
  owner: AssetOwner | null;
  acquisition: 'new' | 'existing' | null;
  /** Historical acquisition or initial new investment; decimal CNY, never an automatic cash expense. */
  amount: string | null;
  serviceYear: number | null;
  source: string;
  notes: string;
  siteId: string | null;
  budgetBucket: 'station' | 'connection' | null;
  replacements: { year: number; amount: string | null; disposal: string | null; source: string }[];
  residual: { year: number; amount: string | null; source: string } | null;
}
export interface AssetOverride {
  assetId: string;
  year: number;
  kind: AssetEventKind;
  amount: string | null;
  reason: string;
  source: string;
}
export interface WorkingCapitalAccount {
  owner: AssetOwner;
  openingBalance: string | null;
  source: string;
  years: { year: number; balance: string | null; source: string }[];
}
export interface AssetCashflowInput {
  boundary: BusinessBoundary | null;
  initialYear: number | null;
  /** Explicit capital evaluation years, including construction; no dependence on physical results. */
  years: number[];
  scopeSource: string;
  assets: AssetEntry[];
  workingCapital: WorkingCapitalAccount[];
  overrides: AssetOverride[];
}
export interface AssetEventLedger {
  assetId: string;
  name: string;
  category: AssetEntry['category'];
  owner: AssetOwner | null;
  kind: AssetEventKind;
  year: number;
  included: boolean;
  baseAmount: string | null;
  amountCents: number | null;
  source: string;
  override: AssetOverride | null;
}
export interface WorkingCapitalLedger {
  owner: AssetOwner;
  included: boolean;
  openingCents: number | null;
  closingCents: number | null;
  increaseCents: number | null;
  releaseCents: number | null;
  source: string;
}
export interface AssetCashflowYearResult {
  year: number;
  complete: boolean;
  issues: string[];
  events: AssetEventLedger[];
  workingCapital: WorkingCapitalLedger[];
  investmentCents: number | null;
  replacementCents: number | null;
  disposalCents: number | null;
  residualCents: number | null;
  workingCapitalIncreaseCents: number | null;
  workingCapitalReleaseCents: number | null;
  outflowCents: number | null;
  inflowCents: number | null;
  balanceCents: number | null;
}
export interface AssetBudgetReconciliation {
  siteId: string;
  siteName: string;
  bucket: 'station' | 'connection';
  budgetCents: number | null;
  classifiedCents: number | null;
  differenceCents: number | null;
}
export const ASSET_CASHFLOW_POLICY = 'cny-asset-line-half-up-6-2-v1';
export interface AssetCashflowResult {
  id: string;
  projectId: string;
  scenarioId: string;
  inputVersion: number;
  createdAt: string;
  policy: typeof ASSET_CASHFLOW_POLICY;
  input: AssetCashflowInput;
  /** Adopted complete station investment basis, never added as a second cash expense. */
  stationNetwork: StationNetwork | null;
  complete: boolean;
  economicStatus: 'not-ready';
  issues: string[];
  assets: (AssetEntry & { historicalCostCents: number | null })[];
  reconciliation: AssetBudgetReconciliation[];
  years: AssetCashflowYearResult[];
}
export interface AssetCashflowView {
  inputVersion: number;
  issues: string[];
  results: AssetCashflowResult[];
}
export function validAssetAmount(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^\d{1,12}(\.\d{1,6})?$/.test(value));
}
/** Parse and round once per capital item/balance. All later arithmetic is integer cents. */
export function assetAmountCents(value: string | null): number | null {
  if (value === null || !validAssetAmount(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const micro = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  const cents = (micro + 5000n) / 10000n;
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}
export function assetOwnerIncluded(owner: AssetOwner | null, boundary: BusinessBoundary | null) {
  return (
    owner !== null && owner !== 'external' && (boundary === 'integrated' || owner === 'station')
  );
}
export function assetInputIssues(context: PlanningScenarioContext): string[] {
  const input = context.assetCashflows;
  if (!input) return ['资产与资金输入待配置'];
  const issues: string[] = [];
  if (!input.boundary) issues.push('资产业务边界待选择');
  if (!input.scopeSource.trim())
    issues.push('全部资产及营运资金的范围依据待填写（无项目也须明确说明）');
  if (!input.years.length) issues.push('资产评价年份待填写');
  if (input.initialYear === null || input.initialYear !== input.years[0])
    issues.push('初始建设年份须为评价首年');
  const physicalYears = context.annualTransport?.map((y) => y.year) ?? [];
  if (
    physicalYears.some((y) => !input.years.includes(y)) ||
    input.years.some(
      (y) => y !== input.initialYear && physicalYears.length && !physicalYears.includes(y),
    )
  )
    issues.push('资产评价年份与年度能力年份不一致，请显式核对（允许首年建设期）');
  if (
    context.operatingCashflows?.boundary &&
    context.operatingCashflows.boundary !== input.boundary
  )
    issues.push('资产与运营收支业务边界不一致，请显式统一后再作联合评价');
  for (const asset of input.assets) {
    if (!asset.owner) issues.push(`${asset.name}：投资及回收归属待选择`);
    if (!asset.acquisition) issues.push(`${asset.name}：新增或已发生待选择`);
    if (!asset.source.trim() || !asset.notes.trim())
      issues.push(`${asset.name}：资产范围及来源待填写`);
    if (asset.amount === null) issues.push(`${asset.name}：投资或历史取得金额未知`);
    if (
      asset.serviceYear === null ||
      (asset.acquisition === 'new' && asset.serviceYear !== input.initialYear) ||
      (asset.acquisition === 'existing' &&
        input.initialYear !== null &&
        asset.serviceYear >= input.initialYear)
    )
      issues.push(`${asset.name}：投运年份待核对（新建一次投运，已有资产早于本期）`);
    if (asset.siteId && !context.stationNetwork?.fixedLayout.some((s) => s.siteId === asset.siteId))
      issues.push(`${asset.name}：关联站址已退出固定布局，请显式修复`);
    if (!asset.residual) issues.push(`${asset.name}：末期残值计划未知；无回收须显式填零`);
    else if (asset.residual.year !== input.years.at(-1))
      issues.push(`${asset.name}：残值年份须为评价末年`);
    for (const r of asset.replacements) {
      if (
        !input.years.includes(r.year) ||
        r.year <= (asset.serviceYear ?? Infinity) ||
        r.year === input.initialYear
      )
        issues.push(`${asset.name}：更换年份 ${r.year} 不在投运后的评价年份内`);
    }
  }
  for (const override of input.overrides) {
    const asset = input.assets.find((a) => a.id === override.assetId);
    const target =
      asset &&
      (override.kind === 'initial'
        ? asset.acquisition === 'new' && override.year === input.initialYear
        : override.kind === 'residual'
          ? asset.residual?.year === override.year
          : asset.replacements.some((r) => r.year === override.year));
    if (!target)
      issues.push(
        `覆盖目标失效：${asset?.name ?? override.assetId} ${override.year} ${assetEventNames[override.kind]}`,
      );
  }
  for (const account of input.workingCapital) {
    if (account.openingBalance === null || !account.source.trim())
      issues.push(`${assetOwners[account.owner]}：营运资金期初余额及来源待填写`);
    for (const y of account.years)
      if (!input.years.includes(y.year)) issues.push(`${y.year}：营运资金年份关联失效`);
  }
  return issues;
}
