import {
  assetCategories,
  validAssetAmount,
  validTaxRate,
  taxPricingNames,
  taxCreditNames,
  taxPaymentNames,
  type TaxCashflowInput,
  type PlanningScenarioContext,
} from '@haulpath/domain';
import { HttpError } from './http';
import { scenarioFields } from './scenario-validation';
function object(v: unknown, fields: string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, '税务输入须为对象');
  scenarioFields(v as Record<string, unknown>, fields);
  return v as Record<string, unknown>;
}
function list(v: unknown, limit = 1000): unknown[] {
  if (!Array.isArray(v) || v.length > limit)
    throw new HttpError(
      400,
      Number.isFinite(limit) ? '税务列表须为最多1000项的数组' : '税务规则须为数组',
    );
  return v;
}
function text(v: unknown, required = false): string {
  if (typeof v !== 'string' || v.length > 2000 || (required && !v.trim()))
    throw new HttpError(400, '税务身份或来源文本无效');
  return v.trim();
}
function integer(v: unknown, min: number, max = 9999): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
    throw new HttpError(400, '税务年份或年限无效');
  return v;
}
function money(v: unknown): string | null {
  if (!validAssetAmount(v)) throw new HttpError(400, '金额须为非负十进制文本，最多12整数/6小数');
  return v;
}
function rate(v: unknown): string | null {
  if (v === null) return null;
  if (!validTaxRate(v)) throw new HttpError(400, '税率或残值率须为0至1的小数，最多6位小数');
  return v;
}
function choice<T extends string>(
  v: unknown,
  names: Record<T, unknown>,
  nullable = true,
): T | null {
  if (nullable && v === null) return null;
  if (typeof v !== 'string' || !Object.hasOwn(names, v)) throw new HttpError(400, '税务选择值无效');
  return v as T;
}
function unique(v: (string | number)[]) {
  if (new Set(v).size !== v.length)
    throw new HttpError(400, '税务年份、身份、分类或替代目标不能重复');
}
export function taxCashflowInputOf(v: unknown, context: PlanningScenarioContext): TaxCashflowInput {
  if (Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8') > 8 * 1024 * 1024)
    throw new HttpError(400, '税务输入超过8 MiB资源限制，请减少重复或过长资料');
  const a = object(v, [
    'scopeSource',
    'openingVatCredit',
    'openingVatSource',
    'lossCarryYears',
    'lossSource',
    'openingLosses',
    'years',
    'rules',
    'depreciation',
    'historicalAssets',
    'overrides',
  ]);
  const years = list(a.years)
    .map((v) => {
      const y = object(v, [
        'year',
        'activity',
        'source',
        'incomeTaxRate',
        'otherTax',
        'otherTaxDeductible',
        'taxSource',
      ]);
      if (y.otherTaxDeductible !== null && typeof y.otherTaxDeductible !== 'boolean')
        throw new HttpError(400, '其他税费扣除条件无效');
      return {
        year: integer(y.year, 1),
        activity: choice(y.activity, { operating: '', 'non-operating': '' }),
        source: text(y.source),
        incomeTaxRate: rate(y.incomeTaxRate),
        otherTax: money(y.otherTax),
        otherTaxDeductible: y.otherTaxDeductible as boolean | null,
        taxSource: text(y.taxSource),
      };
    })
    .sort((a, b) => a.year - b.year);
  unique(years.map((y) => y.year));
  const rules = list(a.rules, Infinity).map((v) => {
    const r = object(v, ['targetKey', 'pricing', 'vatRate', 'credit', 'incomeTax', 'source']);
    return {
      targetKey: text(r.targetKey, true),
      pricing: choice(r.pricing, taxPricingNames),
      vatRate: rate(r.vatRate),
      credit: choice(r.credit, taxCreditNames),
      incomeTax: choice(r.incomeTax, { included: '', excluded: '' }),
      source: text(r.source),
    };
  });
  unique(rules.map((r) => r.targetKey));
  const depreciation = list(a.depreciation).map((v) => {
    const d = object(v, ['category', 'years', 'residualRate', 'start', 'source']);
    return {
      category: choice(d.category, assetCategories, false)!,
      years: d.years === null ? null : integer(d.years, 0),
      residualRate: rate(d.residualRate),
      start: choice(d.start, { 'service-year': '', 'next-year': '' }),
      source: text(d.source),
    };
  });
  unique(depreciation.map((d) => d.category));
  const old = context.taxCashflows;
  const historicalAssets = list(a.historicalAssets).map((v) => {
    const h = object(v, ['assetId', 'openingBasis', 'remainingYears', 'residualBasis', 'source']);
    const assetId = text(h.assetId, true);
    if (
      !context.assetCashflows?.assets.some(
        (a) => a.id === assetId && a.acquisition === 'existing',
      ) &&
      !old?.historicalAssets.some((h) => h.assetId === assetId)
    )
      throw new HttpError(400, '历史税基资产不属于本方案历史资产');
    return {
      assetId,
      openingBasis: money(h.openingBasis),
      remainingYears: h.remainingYears === null ? null : integer(h.remainingYears, 0),
      residualBasis: money(h.residualBasis),
      source: text(h.source),
    };
  });
  unique(historicalAssets.map((h) => h.assetId));
  const openingLosses = list(a.openingLosses)
    .map((v) => {
      const l = object(v, ['originYear', 'amount', 'source']);
      return {
        originYear: integer(l.originYear, 1),
        amount: money(l.amount),
        source: text(l.source),
      };
    })
    .sort((a, b) => a.originYear - b.originYear);
  unique(openingLosses.map((l) => l.originYear));
  const overrides = list(a.overrides)
    .map((v) => {
      const o = object(v, ['year', 'kind', 'amount', 'reason', 'source']);
      return {
        year: integer(o.year, 1),
        kind: choice(o.kind, taxPaymentNames, false)!,
        amount: money(o.amount),
        reason: text(o.reason, true),
        source: text(o.source, true),
      };
    })
    .sort((a, b) => a.year - b.year || a.kind.localeCompare(b.kind));
  unique(overrides.map((o) => `${o.year}:${o.kind}`));
  return {
    scopeSource: text(a.scopeSource),
    openingVatCredit: money(a.openingVatCredit),
    openingVatSource: text(a.openingVatSource),
    lossCarryYears: a.lossCarryYears === null ? null : integer(a.lossCarryYears, 0),
    lossSource: text(a.lossSource),
    openingLosses,
    years,
    rules,
    depreciation,
    historicalAssets,
    overrides,
  };
}
