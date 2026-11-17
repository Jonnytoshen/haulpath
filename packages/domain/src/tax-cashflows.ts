import type { AssetCashflowResult, AssetEntry, AssetEventKind } from './asset-cashflows';
import { assetCategories, assetEventNames } from './asset-cashflows';
import type { OperatingCashflowResult } from './operating-cashflows';
import type { PlanningScenarioContext } from './index';

export const TAX_CASHFLOW_POLICY = 'cny-tax-annual-half-up-6-2-v1';
export const taxPricingNames = {
  inclusive: '含税',
  exclusive: '不含税',
  'not-applicable': '明确不适用',
};
export const taxCreditNames = {
  allowed: '允许抵扣',
  denied: '不允许抵扣',
  'not-applicable': '不适用抵扣',
};
export const taxPaymentNames = { vat: '增值税应缴', income: '所得税应缴', other: '其他税费' };
export interface TaxRule {
  targetKey: string;
  pricing: keyof typeof taxPricingNames | null;
  vatRate: string | null;
  credit: keyof typeof taxCreditNames | null;
  incomeTax: 'included' | 'excluded' | null;
  source: string;
}
export interface TaxYearInput {
  year: number;
  activity: 'operating' | 'non-operating' | null;
  source: string;
  incomeTaxRate: string | null;
  otherTax: string | null;
  otherTaxDeductible: boolean | null;
  taxSource: string;
}
export interface TaxDepreciationRule {
  category: AssetEntry['category'];
  years: number | null;
  residualRate: string | null;
  start: 'service-year' | 'next-year' | null;
  source: string;
}
export interface HistoricalTaxAsset {
  assetId: string;
  openingBasis: string | null;
  remainingYears: number | null;
  residualBasis: string | null;
  source: string;
}
export interface TaxOverride {
  year: number;
  kind: keyof typeof taxPaymentNames;
  amount: string | null;
  reason: string;
  source: string;
}
export interface TaxCashflowInput {
  scopeSource: string;
  openingVatCredit: string | null;
  openingVatSource: string;
  lossCarryYears: number | null;
  lossSource: string;
  openingLosses: { originYear: number; amount: string | null; source: string }[];
  years: TaxYearInput[];
  rules: TaxRule[];
  depreciation: TaxDepreciationRule[];
  historicalAssets: HistoricalTaxAsset[];
  overrides: TaxOverride[];
}
export interface TaxTarget {
  key: string;
  year: number;
  name: string;
  amountCents: number | null;
  direction: 'income' | 'expense';
  kind: 'operating' | 'investment' | 'recovery';
  assetId: string | null;
  eventKind: AssetEventKind | null;
}
export interface TaxLineLedger extends TaxTarget {
  rule: TaxRule | null;
  netCents: number | null;
  grossCents: number | null;
  vatCents: number | null;
  creditCents: number | null;
  incomeBasisCents: number | null;
}
export interface DepreciationLedger {
  assetId: string;
  name: string;
  category: AssetEntry['category'];
  generationYear: number;
  source: string;
  openingBasisCents: number | null;
  depreciationCents: number | null;
  disposedBasisCents: number | null;
  disposalKind: 'disposal' | 'residual' | null;
  closingBasisCents: number | null;
}
export interface TaxLossLot {
  originYear: number;
  expiresAfterYear: number;
  amountCents: number;
}
export interface TaxCashflowYearResult {
  year: number;
  period: number;
  timing: 'year-end';
  complete: boolean;
  issues: string[];
  lines: TaxLineLedger[];
  depreciation: DepreciationLedger[];
  depreciationCents: number | null;
  taxableBeforeLossCents: number | null;
  taxableAfterLossCents: number | null;
  outputVatCents: number | null;
  inputVatCents: number | null;
  openingVatCreditCents: number | null;
  closingVatCreditCents: number | null;
  lossOpeningCents: number | null;
  lossExpiredCents: number | null;
  lossUsedCents: number | null;
  lossAddedCents: number | null;
  lossClosingCents: number | null;
  lossLots: TaxLossLot[] | null;
  payments: {
    kind: keyof typeof taxPaymentNames;
    baseCents: number | null;
    adoptedCents: number | null;
    override: TaxOverride | null;
  }[];
  operatingCashflowCents: number | null;
  capitalCashflowCents: number | null;
  workingCapitalCashflowCents: number | null;
  projectCashflowCents: number | null;
}
export interface TaxCashflowResult {
  id: string;
  projectId: string;
  scenarioId: string;
  inputVersion: number;
  createdAt: string;
  policy: typeof TAX_CASHFLOW_POLICY;
  input: TaxCashflowInput;
  operatingResult: OperatingCashflowResult;
  assetResult: AssetCashflowResult;
  complete: boolean;
  economicStatus: 'not-ready';
  financingStatus: 'not-evaluated';
  /** Unlevered taxable basis is the explicit interface for 21; never includes interest. */
  financingTaxInterface: 'unlevered-income-before-loss-v1';
  issues: string[];
  years: TaxCashflowYearResult[];
}
export interface TaxCashflowView {
  inputVersion: number;
  issues: string[];
  results: TaxCashflowResult[];
}
/** Stable identities, including the actual electricity tariff intersection; eliminated rows stay out. */
export function taxTargets(
  operating: OperatingCashflowResult,
  assets: AssetCashflowResult,
): TaxTarget[] {
  const targets: TaxTarget[] = [];
  for (const y of operating.years) {
    for (const l of y.lines.filter((l) => l.treatment === 'included'))
      targets.push({
        key: `operating:${y.year}:${l.id}`,
        year: y.year,
        name: l.name,
        amountCents: l.amountCents,
        direction: l.direction,
        kind: 'operating',
        assetId: null,
        eventKind: null,
      });
    for (const l of y.electricity.filter((l) => l.treatment === 'included'))
      targets.push({
        key: `electricity:${y.year}:${l.powerSourceId}:${l.stationId}:${l.startMinute}:${l.endMinute}`,
        year: y.year,
        name: `${l.stationName} · ${l.powerSourceName} ${l.startMinute}–${l.endMinute}`,
        amountCents: l.amountCents,
        direction: 'expense',
        kind: 'operating',
        assetId: null,
        eventKind: null,
      });
  }
  for (const y of assets.years)
    for (const e of y.events.filter((e) => e.included)) {
      const investment = e.kind === 'initial' || e.kind === 'replacement';
      targets.push({
        key: `capital:${y.year}:${e.assetId}:${e.kind}`,
        year: y.year,
        name: `${e.name} · ${assetEventNames[e.kind]}`,
        amountCents: e.amountCents,
        direction: investment ? 'expense' : 'income',
        kind: investment ? 'investment' : 'recovery',
        assetId: e.assetId,
        eventKind: e.kind,
      });
    }
  return targets;
}
export function validTaxRate(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' && /^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/.test(value))
  );
}
export function taxInputIssues(context: PlanningScenarioContext): string[] {
  const input = context.taxCashflows;
  if (!input) return ['税务与项目现金流输入待配置'];
  const issues: string[] = [];
  if (!input.scopeSource.trim())
    issues.push('税务范围依据待填写（含其他税费、无前期亏损声明及支持规则适用性）');
  if (input.openingVatCredit === null || !input.openingVatSource.trim())
    issues.push('期初进项留抵金额及来源待填写');
  if (input.lossCarryYears === null || !input.lossSource.trim())
    issues.push('亏损结转年数及来源待填写');
  const years = context.assetCashflows?.years ?? [];
  if (!years.length) issues.push('请先配置资产评价年份');
  if (years.some((y, i) => i > 0 && y !== years[i - 1] + 1))
    issues.push('评价年份存在空档；本版完整税务结转要求连续财年，不将空档补零');
  if (input.years.some((y) => !years.includes(y.year))) issues.push('税务年份关联失效，请显式修复');
  for (const year of years) {
    const y = input.years.find((y) => y.year === year);
    if (!y) {
      issues.push(`${year}：年度税率及运营声明待配置`);
      continue;
    }
    if (!y.activity || !y.source.trim()) issues.push(`${year}：运营/非运营声明及来源待填写`);
    if (
      (context.annualTransport?.some((a) => a.year === year) ?? false) !==
      (y.activity === 'operating')
    )
      issues.push(`${year}：运营声明与实际年度能力年份不一致`);
    if (
      y.incomeTaxRate === null ||
      y.otherTax === null ||
      y.otherTaxDeductible === null ||
      !y.taxSource.trim()
    )
      issues.push(`${year}：所得税率、其他税费、扣除条件及来源待填写`);
  }
  for (const lot of input.openingLosses)
    if (lot.originYear >= (years[0] ?? 0) || lot.amount === null || !lot.source.trim())
      issues.push(`${lot.originYear}：期初剩余亏损依据无效或未知`);
  for (const d of input.depreciation)
    if (d.years === null || d.residualRate === null || !d.start || !d.source.trim())
      issues.push(`${assetCategories[d.category]}：分类折旧规则待填写`);
  for (const h of input.historicalAssets)
    if (
      h.openingBasis === null ||
      h.remainingYears === null ||
      h.residualBasis === null ||
      !h.source.trim()
    )
      issues.push(`${h.assetId}：历史剩余税基及年限未知`);
  for (const o of input.overrides)
    if (!years.includes(o.year)) issues.push(`${o.year}：税费替代年份关联失效`);
  return issues;
}
