import {
  assetAmountCents,
  assetEventNames,
  assetInputIssues,
  assetOwnerIncluded,
  assetOwners,
  type AssetBudgetReconciliation,
  type AssetCashflowYearResult,
  type AssetEventKind,
  type AssetEventLedger,
  type WorkingCapitalLedger,
} from './asset-cashflows';
import type { PlanningScenarioContext } from './index';

function sumCents(values: (number | null)[]): number | null {
  if (values.some((v) => v === null)) return null;
  const total = values.reduce<bigint>((sum, v) => sum + BigInt(v!), 0n);
  return total <= BigInt(Number.MAX_SAFE_INTEGER) && total >= -BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(total)
    : null;
}
/** Preserve the existing siting policy for number-valued station prices. */
function budgetCents(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  const [coefficient, exponent = '0'] = value.toString().split('e');
  const result = Math.round(Number(`${coefficient}e${Number(exponent) + 2}`));
  return Number.isSafeInteger(result) ? result : null;
}
export function calculateAssetCashflows(context: PlanningScenarioContext) {
  const input = context.assetCashflows!;
  const issues = assetInputIssues(context);
  const allEvents: AssetEventLedger[] = [];
  for (const asset of input.assets) {
    function event(kind: AssetEventKind, year: number, amount: string | null, source: string) {
      const override =
        input.overrides.find((o) => o.assetId === asset.id && o.year === year && o.kind === kind) ??
        null;
      allEvents.push({
        assetId: asset.id,
        name: asset.name,
        category: asset.category,
        owner: asset.owner,
        kind,
        year,
        included: assetOwnerIncluded(asset.owner, input.boundary),
        baseAmount: amount,
        amountCents: assetAmountCents(override ? override.amount : amount),
        source,
        override,
      });
    }
    if (asset.acquisition === 'new' && input.initialYear !== null)
      event('initial', input.initialYear, asset.amount, asset.source);
    for (const replacement of asset.replacements) {
      event('replacement', replacement.year, replacement.amount, replacement.source);
      event('disposal', replacement.year, replacement.disposal, replacement.source);
    }
    if (asset.residual)
      event('residual', asset.residual.year, asset.residual.amount, asset.residual.source);
  }
  const reconciliation: AssetBudgetReconciliation[] = [];
  for (const layout of context.stationNetwork?.fixedLayout ?? []) {
    const network = context.stationNetwork!;
    const site = network.sites.find((s) => s.id === layout.siteId);
    const stationType = network.stationTypes.find((t) => t.id === layout.stationTypeId);
    for (const bucket of ['station', 'connection'] as const) {
      const assets = input.assets.filter(
        (a) => a.siteId === layout.siteId && a.budgetBucket === bucket && a.acquisition === 'new',
      );
      const classifiedCents = assets.length
        ? sumCents(
            assets.map(
              (a) =>
                allEvents.find((e) => e.assetId === a.id && e.kind === 'initial')?.amountCents ??
                null,
            ),
          )
        : null;
      const expected = budgetCents(
        bucket === 'station' ? stationType?.investment : site?.connection?.connectionInvestment,
      );
      const differenceCents =
        classifiedCents === null || expected === null
          ? null
          : sumCents([classifiedCents, -expected]);
      reconciliation.push({
        siteId: layout.siteId,
        siteName: site?.name ?? layout.siteId,
        bucket,
        budgetCents: expected,
        classifiedCents,
        differenceCents,
      });
      if (differenceCents !== 0)
        issues.push(
          `${site?.name ?? layout.siteId}：${bucket === 'station' ? '完整建站配置（含备电池）' : '接电工程'}资产与站网预算${differenceCents === null ? '资料未齐' : '不相符'}；预算只作对账，不再次扣款`,
        );
    }
  }
  // Global completeness problems apply to all annual totals; known line items remain visible.
  const years: AssetCashflowYearResult[] = input.years.map((year) => {
    const yearIssues = [...issues];
    const events = allEvents.filter((e) => e.year === year);
    for (const event of events) {
      if (!event.included) continue;
      if (event.amountCents === null)
        yearIssues.push(`${event.name}：${assetEventNames[event.kind]}金额未知或超范围`);
      if (!(event.override?.source ?? event.source).trim())
        yearIssues.push(`${event.name}：${assetEventNames[event.kind]}来源待填写`);
    }
    const workingCapital: WorkingCapitalLedger[] = input.workingCapital.map((account) => {
      const index = input.years.indexOf(year);
      const previous =
        index === 0 ? null : account.years.find((y) => y.year === input.years[index - 1]);
      const current = account.years.find((y) => y.year === year);
      const openingCents = assetAmountCents(
        index === 0 ? account.openingBalance : (previous?.balance ?? null),
      );
      const closingCents = assetAmountCents(current?.balance ?? null);
      const included = assetOwnerIncluded(account.owner, input.boundary);
      const delta =
        openingCents === null || closingCents === null
          ? null
          : sumCents([closingCents, -openingCents]);
      if (
        included &&
        (delta === null || !current?.source.trim() || (index > 0 && !previous?.source.trim()))
      )
        yearIssues.push(`${assetOwners[account.owner]}：${year} 营运资金期初/期末余额或来源未知`);
      return {
        owner: account.owner,
        included,
        openingCents,
        closingCents,
        increaseCents: delta === null ? null : Math.max(0, delta),
        releaseCents: delta === null ? null : Math.max(0, -delta),
        source: current?.source ?? '',
      };
    });
    const total = (kind: AssetEventKind) =>
      sumCents(events.filter((e) => e.included && e.kind === kind).map((e) => e.amountCents));
    const investmentCents = total('initial'),
      replacementCents = total('replacement'),
      disposalCents = total('disposal'),
      residualCents = total('residual');
    const workingCapitalIncreaseCents = sumCents(
      workingCapital.filter((w) => w.included).map((w) => w.increaseCents),
    );
    const workingCapitalReleaseCents = sumCents(
      workingCapital.filter((w) => w.included).map((w) => w.releaseCents),
    );
    const outflow = sumCents([investmentCents, replacementCents, workingCapitalIncreaseCents]);
    const inflow = sumCents([disposalCents, residualCents, workingCapitalReleaseCents]);
    const balance = outflow === null || inflow === null ? null : sumCents([inflow, -outflow]);
    if (outflow === null || inflow === null || balance === null)
      yearIssues.push('年度资本收付汇总未知或超出安全整数分位范围');
    return {
      year,
      complete: !yearIssues.length,
      issues: [...new Set(yearIssues)],
      events,
      workingCapital,
      investmentCents,
      replacementCents,
      disposalCents,
      residualCents,
      workingCapitalIncreaseCents,
      workingCapitalReleaseCents,
      outflowCents: yearIssues.length ? null : outflow,
      inflowCents: yearIssues.length ? null : inflow,
      balanceCents: yearIssues.length ? null : balance,
    };
  });
  return {
    issues: [...new Set(issues)],
    reconciliation,
    years,
    complete: !issues.length && !!years.length && years.every((y) => y.complete),
    assets: input.assets.map((a) => ({
      ...a,
      historicalCostCents: a.acquisition === 'existing' ? assetAmountCents(a.amount) : null,
    })),
  };
}
