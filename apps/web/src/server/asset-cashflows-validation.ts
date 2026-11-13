import { randomUUID } from 'node:crypto';
import {
  assetCategories,
  assetOwners,
  assetEventNames,
  validAssetAmount,
  type AssetCashflowInput,
  type AssetEntry,
  type PlanningScenarioContext,
} from '@haulpath/domain';
import { HttpError } from './http';
import { scenarioFields } from './scenario-validation';

function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, '资产输入须为对象');
  const result = value as Record<string, unknown>;
  scenarioFields(result, fields);
  return result;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 1000)
    throw new HttpError(400, '资产或年度列表须为最多1000项的数组');
  return value;
}
function text(value: unknown, required = false): string {
  if (typeof value !== 'string' || value.length > 2000 || (required && !value.trim()))
    throw new HttpError(400, '资产名称、身份或来源文本无效');
  return value.trim();
}
function year(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 9999)
    throw new HttpError(400, '年份须为1至9999的整数');
  return value;
}
function amount(value: unknown): string | null {
  if (!validAssetAmount(value))
    throw new HttpError(400, '金额须为非负十进制文本，最多12位整数、6位小数；未知请留空');
  return value;
}
function unique(values: (string | number)[]) {
  if (new Set(values).size !== values.length)
    throw new HttpError(400, '资产身份、年份或覆盖目标不能重复');
}
function owner(value: unknown, nullable = true) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !Object.hasOwn(assetOwners, value))
    throw new HttpError(400, '资产收付归属无效');
  return value as keyof typeof assetOwners;
}
export function assetCashflowInputOf(
  value: unknown,
  context: PlanningScenarioContext,
): AssetCashflowInput {
  const input = object(value, [
    'boundary',
    'initialYear',
    'years',
    'scopeSource',
    'assets',
    'workingCapital',
    'overrides',
  ]);
  if (
    input.boundary !== null &&
    input.boundary !== 'integrated' &&
    input.boundary !== 'station-only'
  )
    throw new HttpError(400, '业务边界无效');
  const years = list(input.years)
    .map(year)
    .sort((a, b) => a - b);
  unique(years);
  const old = context.assetCashflows;
  const assets = list(input.assets).map((entry) => {
    const a = object(entry, [
      'id',
      'name',
      'category',
      'owner',
      'acquisition',
      'amount',
      'serviceYear',
      'source',
      'notes',
      'siteId',
      'budgetBucket',
      'replacements',
      'residual',
    ]);
    const id = a.id === undefined || a.id === '' ? randomUUID() : text(a.id, true);
    const prior = old?.assets.find((a) => a.id === id);
    if (a.id && !prior) throw new HttpError(400, '资产身份不属于本方案；新增资产请省略身份');
    if (typeof a.category !== 'string' || !Object.hasOwn(assetCategories, a.category))
      throw new HttpError(400, '资产分类无效');
    if (a.acquisition !== null && a.acquisition !== 'new' && a.acquisition !== 'existing')
      throw new HttpError(400, '资产取得方式无效');
    const siteId = a.siteId === null ? null : text(a.siteId, true);
    if (
      siteId &&
      !context.stationNetwork?.fixedLayout.some((s) => s.siteId === siteId) &&
      prior?.siteId !== siteId
    )
      throw new HttpError(400, '资产关联站址不属于本方案固定布局');
    if (a.budgetBucket !== null && a.budgetBucket !== 'station' && a.budgetBucket !== 'connection')
      throw new HttpError(400, '预算对账分类无效');
    if (
      (a.budgetBucket && !siteId) ||
      (a.budgetBucket === 'connection' && a.category !== 'connection') ||
      (a.budgetBucket === 'station' && !['station', 'battery', 'other'].includes(a.category)) ||
      (siteId &&
        ['station', 'battery', 'connection'].includes(a.category) &&
        a.budgetBucket !== (a.category === 'connection' ? 'connection' : 'station'))
    )
      throw new HttpError(400, '站点建设、备电池及接电资产须归入对应站址预算，避免重复投资');
    if (['station', 'connection'].includes(a.category) && !siteId)
      throw new HttpError(400, '站点及接电资产须显式关联固定布局站址');
    const replacements = list(a.replacements)
      .map((entry) => {
        const r = object(entry, ['year', 'amount', 'disposal', 'source']);
        return {
          year: year(r.year),
          amount: amount(r.amount),
          disposal: amount(r.disposal),
          source: text(r.source),
        };
      })
      .sort((a, b) => a.year - b.year);
    unique(replacements.map((r) => r.year));
    const residual = a.residual === null ? null : object(a.residual, ['year', 'amount', 'source']);
    return {
      id,
      name: text(a.name, true),
      category: a.category,
      owner: owner(a.owner),
      acquisition: a.acquisition,
      amount: amount(a.amount),
      serviceYear: a.serviceYear === null ? null : year(a.serviceYear),
      source: text(a.source),
      notes: text(a.notes),
      siteId,
      budgetBucket: a.budgetBucket,
      replacements,
      residual: residual
        ? {
            year: year(residual.year),
            amount: amount(residual.amount),
            source: text(residual.source),
          }
        : null,
    } as AssetEntry;
  });
  unique(assets.map((a) => a.id));
  const workingCapital = list(input.workingCapital).map((entry) => {
    const w = object(entry, ['owner', 'openingBalance', 'source', 'years']);
    const rows = list(w.years)
      .map((entry) => {
        const y = object(entry, ['year', 'balance', 'source']);
        return { year: year(y.year), balance: amount(y.balance), source: text(y.source) };
      })
      .sort((a, b) => a.year - b.year);
    unique(rows.map((r) => r.year));
    return {
      owner: owner(w.owner, false)!,
      openingBalance: amount(w.openingBalance),
      source: text(w.source),
      years: rows,
    };
  });
  unique(workingCapital.map((w) => w.owner));
  const overrides = list(input.overrides).map((entry) => {
    const o = object(entry, ['assetId', 'year', 'kind', 'amount', 'reason', 'source']);
    const assetId = text(o.assetId, true);
    if (!assets.some((a) => a.id === assetId) && !old?.overrides.some((o) => o.assetId === assetId))
      throw new HttpError(400, '覆盖目标资产不属于本方案');
    if (typeof o.kind !== 'string' || !Object.hasOwn(assetEventNames, o.kind))
      throw new HttpError(400, '覆盖资本收付项目无效');
    return {
      assetId,
      year: year(o.year),
      kind: o.kind,
      amount: amount(o.amount),
      reason: text(o.reason, true),
      source: text(o.source, true),
    } as AssetCashflowInput['overrides'][number];
  });
  unique(overrides.map((o) => `${o.assetId}:${o.year}:${o.kind}`));
  return {
    boundary: input.boundary,
    initialYear: input.initialYear === null ? null : year(input.initialYear),
    years,
    scopeSource: text(input.scopeSource),
    assets,
    workingCapital,
    overrides,
  } as AssetCashflowInput;
}
