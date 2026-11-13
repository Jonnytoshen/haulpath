import type {
  DailyTransportConfig,
  DailyTransportResult,
  DailyTransportSnapshot,
  DailyTransportProgress,
} from './daily-transport';
import {
  initialDailyTransportSearch,
  searchDailyTransport,
  FIXED_LAYOUT_SEARCH_VERSION,
  improvesDailyTransport,
} from './daily-transport-search';
import { validateRepeatableDay, REPEATABLE_DAY_ALGORITHM_VERSION } from './repeatable-day';

import type { PlanningScenarioContext } from './index';
import { transportDemandIssue } from './transport-demands';

/** Explicit demand targets for a representative day; no implicit growth rate or calendar. */
export interface AnnualTransportYear {
  year: number;
  operatingDays: number;
  demands: { demandId: string; dailyTonnes: number }[];
}

export function annualTransportInputIssues(context: PlanningScenarioContext): string[] {
  const years = context.annualTransport ?? [];
  const demands = context.transportDemands ?? [];
  const issues: string[] = [];
  if (!years.length) issues.push('评价年份待配置');
  if (!demands.length) issues.push('运输需求待配置');
  const seen = new Set<number>();
  let totalAnnualTarget = 0;
  for (const year of years) {
    if (!Number.isInteger(year.year) || year.year < 1 || year.year > 9999 || seen.has(year.year))
      issues.push('评价年份须为1至9999的整数且不能重复');
    seen.add(year.year);
    if (!Number.isInteger(year.operatingDays) || year.operatingDays < 0 || year.operatingDays > 366)
      issues.push(`${year.year}：运营天数须为0至366的整数`);
    const ids = new Set<string>();
    let total = 0;
    for (const target of year.demands) {
      const demand = demands.find((d) => d.id === target.demandId);
      if (!demand || ids.has(target.demandId))
        issues.push(`${year.year}：需求关联失效或重复，请显式修复`);
      ids.add(target.demandId);
      if (!Number.isFinite(target.dailyTonnes) || target.dailyTonnes <= 0)
        issues.push(`${year.year}：代表日目标吨数须为有限正数`);
      total += target.dailyTonnes;
      if (demand && transportDemandIssue(demand, context.transportCycles ?? []))
        issues.push(`${year.year}：运输需求装卸关联失效，请修复`);
    }
    if (demands.some((d) => !ids.has(d.id)))
      issues.push(`${year.year}：须明确录入全部运输需求的日吨数`);
    totalAnnualTarget += total * year.operatingDays;
    if (
      !Number.isFinite(total) ||
      !Number.isFinite(total * year.operatingDays) ||
      !Number.isFinite(totalAnnualTarget)
    )
      issues.push(`${year.year}：目标吨数超出可表示范围`);
  }
  return [...new Set(issues)];
}

export const ANNUAL_TRANSPORT_ALGORITHM_VERSION = 'annual-fixed-resources-1';
export interface AnnualTransportYearResult {
  year: number;
  operatingDays: number;
  status: 'searching' | 'checked' | 'not-found';
  budgetMs: number;
  searchFinished: boolean;
  reusedFromYear: number | null;
  evidence: DailyTransportResult | null;
  dailyTargetTonnes: number;
  dailyCompletedTonnes: number | null;
  targetTonnes: number;
  completedTonnes: number | null;
  missingTonnes: number | null;
  completionRate: number | null;
  annualDistanceMeters: number | null;
  annualEmptyDistanceMeters: number | null;
  annualSwapCount: number | null;
  annualGridEnergyKwh: number | null;
  bottlenecks: string[];
}
export interface AnnualTransportResult {
  algorithmVersion: string;
  complete: boolean;
  economicStatus: 'not-ready';
  totalCompletedTonnes: number;
  years: AnnualTransportYearResult[];
}

/** All physical resources and scheduling inputs stay unchanged except explicit daily demand tonnes. */
export function annualDaySnapshot(
  snapshot: DailyTransportSnapshot,
  year: AnnualTransportYear,
): DailyTransportSnapshot {
  const targets = new Map(year.demands.map((d) => [d.demandId, d.dailyTonnes]));
  const context = { ...snapshot.context };
  delete context.annualTransport;
  // Operating prices do not alter dispatch, battery or power constraints.
  delete context.operatingCashflows;
  context.results = [];
  return {
    ...snapshot,
    context: {
      ...context,
      results: [],
      annual: snapshot.context.annual,
      transportDemands: snapshot.context.transportDemands!.map((d) => ({
        ...d,
        dailyTonnes: targets.get(d.id)!,
      })),
    },
  };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function annualDaysEquivalent(
  snapshot: DailyTransportSnapshot,
  a: AnnualTransportYear,
  b: AnnualTransportYear,
): boolean {
  return canonical(annualDaySnapshot(snapshot, a)) === canonical(annualDaySnapshot(snapshot, b));
}

/** Derive annual quantities from a validated representative day, never from target growth. */
export function annualYearAccounts(
  year: AnnualTransportYear,
  evidence: DailyTransportResult | null,
) {
  const dailyTargetTonnes = year.demands.reduce((sum, d) => sum + d.dailyTonnes, 0);
  const days = year.operatingDays;
  const completed = evidence?.totalCompletedTonnes ?? null;
  return {
    dailyTargetTonnes,
    dailyCompletedTonnes: completed,
    targetTonnes: dailyTargetTonnes * days,
    completedTonnes: completed === null ? null : completed * days,
    missingTonnes: completed === null ? null : Math.max(0, dailyTargetTonnes - completed) * days,
    completionRate: completed === null ? null : days === 0 ? 1 : completed / dailyTargetTonnes,
    annualDistanceMeters: evidence ? evidence.vehicleEnergy!.totalDistanceMeters * days : null,
    annualEmptyDistanceMeters: evidence
      ? evidence.vehicleEnergy!.vehicles.reduce(
          (sum, v) =>
            sum +
            v.events.filter((e) => e.loadTonnes === 0).reduce((n, e) => n + e.distanceMeters, 0),
          0,
        ) * days
      : null,
    annualSwapCount: evidence ? evidence.vehicleEnergy!.swapCount * days : null,
    annualGridEnergyKwh: evidence
      ? evidence.sharedPower!.sources.reduce((sum, s) => sum + s.gridEnergyKwh, 0) * days
      : null,
  };
}
export function annualTransportResult(
  years: AnnualTransportYearResult[],
  expectedYears: number,
): AnnualTransportResult {
  return {
    algorithmVersion: ANNUAL_TRANSPORT_ALGORITHM_VERSION,
    complete: years.length === expectedYears && years.every((y) => y.status === 'checked'),
    economicStatus: 'not-ready',
    totalCompletedTonnes: years.reduce((sum, y) => sum + (y.completedTonnes ?? 0), 0),
    years,
  };
}

/** Publication replays the year's exact daily input and independently derives annual quantities. */
export function validateAnnualYear(
  snapshot: DailyTransportSnapshot,
  config: DailyTransportConfig,
  result: AnnualTransportYearResult,
  previous: AnnualTransportYearResult[],
): void {
  const year = snapshot.context.annualTransport?.find((y) => y.year === result.year);
  if (
    !['searching', 'checked', 'not-found'].includes(result.status) ||
    typeof result.searchFinished !== 'boolean' ||
    !Array.isArray(result.bottlenecks) ||
    !result.bottlenecks.every((b) => typeof b === 'string')
  )
    throw new Error('年度结果状态无效');
  if (
    !year ||
    result.operatingDays !== year.operatingDays ||
    !Number.isFinite(result.budgetMs) ||
    result.budgetMs < 0 ||
    result.budgetMs > config.maxRuntimeMs
  )
    throw new Error('年度结果身份或预算与任务快照不匹配');
  if (
    (result.status === 'checked' && !result.evidence) ||
    (result.status === 'not-found' && result.evidence)
  )
    throw new Error('年度结果状态与周期证据不匹配');
  if (result.evidence) {
    const evidence = result.evidence;
    if (
      evidence.algorithmVersion !== REPEATABLE_DAY_ALGORITHM_VERSION ||
      evidence.seed !== config.seed ||
      evidence.physicalFeasibility !== 'feasible' ||
      !evidence.validation.valid ||
      !validateRepeatableDay(annualDaySnapshot(snapshot, year), evidence).valid
    )
      throw new Error('年度代表日独立组合校验未通过');
  }
  const accounts = annualYearAccounts(year, result.evidence);
  for (const key of Object.keys(accounts) as (keyof typeof accounts)[]) {
    if (accounts[key] !== result[key]) throw new Error('年度数量与代表日实际账目不一致');
    if (typeof accounts[key] === 'number' && !Number.isFinite(accounts[key]))
      throw new Error('年度账目超出可表示范围');
  }
  if (result.reusedFromYear !== null) {
    const sourceYear = snapshot.context.annualTransport!.find(
      (y) => y.year === result.reusedFromYear,
    );
    const source = previous.find((y) => y.year === result.reusedFromYear && y.status === 'checked');
    if (
      !sourceYear ||
      !source?.evidence ||
      !annualDaysEquivalent(snapshot, year, sourceYear) ||
      canonical(source.evidence) !== canonical(result.evidence)
    )
      throw new Error('年度复用缺少完整等价代表日证据');
  }
}

/** One Worker owns the complete evaluation budget. Years get a share of the remaining budget. */
export function generateAnnualTransport(
  snapshot: DailyTransportSnapshot,
  config: DailyTransportConfig,
  onYear: (year: AnnualTransportYearResult) => void,
  onProgress: (progress: DailyTransportProgress) => void,
  retained?: AnnualTransportResult | null,
): void {
  const years = snapshot.context.annualTransport!;
  const deadline = Date.now() + config.maxRuntimeMs;
  const completed: AnnualTransportYearResult[] = [];
  for (const [index, year] of years.entries()) {
    const budgetMs = Math.max(1, Math.floor((deadline - Date.now()) / (years.length - index)));
    if (Date.now() >= deadline) throw new Error('年度分析已达到总时限，已校核年度成果继续保留');
    const retainedYear = retained?.years.find((r) => r.year === year.year);
    if (retainedYear?.status === 'checked') {
      const row = { ...retainedYear, budgetMs: 0 };
      onYear(row);
      completed.push(row);
      continue;
    }
    const source = completed.find(
      (r) =>
        r.status === 'checked' &&
        annualDaysEquivalent(
          snapshot,
          year,
          years.find((y) => y.year === r.year)!,
        ),
    );
    let evidence: DailyTransportResult | null = retainedYear?.evidence ?? source?.evidence ?? null;
    let searchFinished = false;
    let reason = '';
    const publish = (status: AnnualTransportYearResult['status']) => {
      const row: AnnualTransportYearResult = {
        year: year.year,
        operatingDays: year.operatingDays,
        budgetMs,
        searchFinished,
        status,
        reusedFromYear: source?.year ?? null,
        evidence,
        ...annualYearAccounts(year, evidence),
        bottlenecks: [
          ...(reason ? [reason] : []),
          ...(evidence?.demands
            .filter((d) => d.missingTonnes > 0)
            .map((d) => d.reason ?? '固定车队、班次及站网下仍有运力缺口') ?? []),
        ],
      };
      onYear(row);
      return row;
    };
    publish('searching');
    if (source) searchFinished = source.searchFinished;
    else {
      const day = annualDaySnapshot(snapshot, year);
      try {
        searchDailyTransport(
          day,
          { ...config, stage: 'repeatable-day', maxRuntimeMs: budgetMs },
          `annual-${year.year}`,
          initialDailyTransportSearch(day),
          onProgress,
          (search, candidate) => {
            if (
              candidate &&
              improvesDailyTransport(
                candidate,
                evidence
                  ? {
                      sourceTaskId: '',
                      order: '',
                      foundAt: '',
                      completedTonnes: evidence.totalCompletedTonnes,
                      distanceMeters: evidence.vehicleEnergy!.totalDistanceMeters,
                    }
                  : null,
              )
            ) {
              evidence = candidate;
              publish('searching');
            }
            if (search.phase === 'finished') searchFinished = true;
          },
        );
      } catch (error) {
        reason = error instanceof Error ? error.message : '本次未找到可行代表日，不证明全局无解';
      }
    }
    completed.push(publish(evidence ? 'checked' : 'not-found'));
  }
}

// Include both versions in annual task provenance; changes invalidate compatibility.
export const ANNUAL_TRANSPORT_EVIDENCE_VERSION = `${REPEATABLE_DAY_ALGORITHM_VERSION}/${FIXED_LAYOUT_SEARCH_VERSION}`;
