import { assetAmountCents, assetOwnerIncluded, type AssetCashflowResult } from './asset-cashflows';
import type { OperatingCashflowResult } from './operating-cashflows';
import type { PlanningScenarioContext } from './index';
import {
  taxInputIssues,
  validTaxRate,
  taxTargets,
  type TaxCashflowInput,
  type TaxCashflowYearResult,
  type TaxLineLedger,
  type TaxTarget,
  type TaxLossLot,
  type DepreciationLedger,
} from './tax-cashflows';

const limit = BigInt(Number.MAX_SAFE_INTEGER);
function safe(v: bigint): number | null {
  return v <= limit && v >= -limit ? Number(v) : null;
}
function sum(values: (number | null)[]): number | null {
  return values.some((v) => v === null)
    ? null
    : safe(values.reduce<bigint>((s, v) => s + BigInt(v!), 0n));
}
const negative = (v: number | null) => (v === null ? null : -v);
function rounded(n: bigint, d: bigint): number | null {
  return safe((n + d / 2n) / d);
}
function rateMicro(v: string | null): bigint | null {
  if (v === null || !validTaxRate(v)) return null;
  const [w, f = ''] = v.split('.');
  return BigInt(w) * 1000000n + BigInt(f.padEnd(6, '0'));
}
function multiply(v: number | null, rate: string | null): number | null {
  const r = rateMicro(rate);
  return v === null || r === null ? null : rounded(BigInt(v) * r, 1000000n);
}
function lineOf(target: TaxTarget, input: TaxCashflowInput, issues: string[]): TaxLineLedger {
  const rule = input.rules.find((r) => r.targetKey === target.key) ?? null;
  const fail = () => {
    issues.push(`${target.name}：含税、税率、抵扣、所得税处理或来源待核对`);
    return {
      ...target,
      rule,
      netCents: null,
      grossCents: null,
      vatCents: null,
      creditCents: null,
      incomeBasisCents: null,
    };
  };
  if (!rule?.source.trim() || !rule.pricing || !rule.incomeTax || target.amountCents === null)
    return fail();
  let net: number | null = target.amountCents,
    gross: number | null = target.amountCents,
    vat: number | null = 0;
  if (rule.pricing === 'not-applicable') {
    if (rule.vatRate !== null || rule.credit !== 'not-applicable') return fail();
  } else {
    const r = rateMicro(rule.vatRate);
    if (
      r === null ||
      (target.direction === 'income'
        ? rule.credit !== 'not-applicable'
        : rule.credit !== 'allowed' && rule.credit !== 'denied')
    )
      return fail();
    if (rule.pricing === 'inclusive') {
      net = rounded(BigInt(target.amountCents) * 1000000n, 1000000n + r);
      vat = sum([gross, negative(net)]);
    } else {
      vat = multiply(net, rule.vatRate);
      gross = sum([net, vat]);
    }
  }
  const credit = target.direction === 'expense' && rule.credit === 'allowed' ? vat : 0;
  const incomeBasis =
    rule.incomeTax === 'excluded'
      ? 0
      : target.direction === 'income'
        ? net
        : sum([gross, negative(credit)]);
  if ([net, gross, vat, credit, incomeBasis].some((v) => v === null))
    issues.push(`${target.name}：税务金额未知或超出安全整数分范围`);
  return {
    ...target,
    rule,
    netCents: net,
    grossCents: gross,
    vatCents: vat,
    creditCents: credit,
    incomeBasisCents: incomeBasis,
  };
}
interface Generation {
  year: number;
  startYear: number;
  years: number | null;
  remaining: number | null;
  residual: number | null;
  annual: number | null;
  source: string;
}
function generation(
  basis: number | null,
  residual: number | null,
  years: number | null,
  year: number,
  startYear: number,
  source: string,
): Generation {
  const depreciable = sum([basis, negative(residual)]);
  return {
    year,
    startYear,
    years,
    remaining: basis,
    residual,
    source,
    annual:
      years === null || depreciable === null || depreciable < 0
        ? null
        : years === 0
          ? 0
          : rounded(BigInt(depreciable), BigInt(years)),
  };
}
function depreciateAssets(
  input: TaxCashflowInput,
  assets: AssetCashflowResult,
  year: number,
  lines: TaxLineLedger[],
  generations: Map<string, Generation>,
  issues: string[],
): DepreciationLedger[] {
  const ledger: DepreciationLedger[] = [];
  const firstYear = assets.input.years[0];
  for (const asset of assets.input.assets.filter((a) =>
    assetOwnerIncluded(a.owner, assets.input.boundary),
  )) {
    const row = (
      g: Generation,
      expense: number | null,
      disposed: number | null,
      closing: number | null,
      disposalKind: 'disposal' | 'residual' | null = null,
    ): DepreciationLedger => ({
      assetId: asset.id,
      name: asset.name,
      category: asset.category,
      generationYear: g.year,
      source: g.source,
      openingBasisCents: g.remaining,
      depreciationCents: expense,
      disposedBasisCents: disposed,
      closingBasisCents: closing,
      disposalKind,
    });
    let current = generations.get(asset.id);
    if (year === firstYear && asset.acquisition === 'existing') {
      const h = input.historicalAssets.find((h) => h.assetId === asset.id);
      current = generation(
        assetAmountCents(h?.openingBasis ?? null),
        assetAmountCents(h?.residualBasis ?? null),
        h?.remainingYears ?? null,
        asset.serviceYear ?? firstYear,
        firstYear,
        h?.source ?? '',
      );
      generations.set(asset.id, current);
    }
    const purchase = lines.find((l) => l.assetId === asset.id && l.kind === 'investment');
    if (purchase) {
      if (current) ledger.push(row(current, 0, current.remaining, 0, 'disposal'));
      const rule = input.depreciation.find((r) => r.category === asset.category);
      const basis = purchase.incomeBasisCents;
      current = generation(
        basis,
        multiply(basis, rule?.residualRate ?? null),
        rule?.years ?? null,
        year,
        year + (rule?.start === 'next-year' ? 1 : 0),
        rule?.source ?? '',
      );
      if (!rule?.start) current.annual = null;
      generations.set(asset.id, current);
    }
    if (!current) {
      issues.push(`${asset.name}：资产税基代际依据缺失`);
      continue;
    }
    let expense: number | null = 0;
    if (
      !current.source.trim() ||
      current.annual === null ||
      current.remaining === null ||
      current.residual === null ||
      current.remaining < current.residual
    ) {
      expense = null;
      issues.push(`${asset.name}：分类折旧或历史剩余税基依据待核对`);
    } else if (
      year >= current.startYear &&
      current.years !== null &&
      current.years > 0 &&
      current.remaining > current.residual
    ) {
      const available = current.remaining - current.residual;
      expense =
        year >= current.startYear + current.years - 1
          ? available
          : Math.min(current.annual!, available);
    }
    const remaining = sum([current.remaining, negative(expense)]);
    const terminal = lines.some((l) => l.assetId === asset.id && l.eventKind === 'residual');
    ledger.push(
      row(
        current,
        expense,
        terminal ? remaining : 0,
        terminal ? 0 : remaining,
        terminal ? 'residual' : null,
      ),
    );
    current.remaining = terminal ? 0 : remaining;
  }
  return ledger;
}
export function calculateTaxCashflows(
  context: PlanningScenarioContext,
  operating: OperatingCashflowResult,
  assets: AssetCashflowResult,
) {
  const input = context.taxCashflows!;
  const issues = taxInputIssues(context);
  if (!operating.complete || !assets.complete) issues.push('采用的运营或资产账目不完整');
  const targets = taxTargets(operating, assets);
  for (const r of input.rules)
    if (!targets.some((t) => t.key === r.targetKey))
      issues.push(`税务明细目标失效：${r.targetKey}`);
  for (const h of input.historicalAssets)
    if (!assets.input.assets.some((a) => a.id === h.assetId && a.acquisition === 'existing'))
      issues.push(`历史税基目标失效：${h.assetId}`);
  for (const o of input.overrides)
    if (!assets.input.years.includes(o.year)) issues.push(`税费替代年份失效：${o.year}`);
  for (const l of input.openingLosses)
    if (l.originYear >= assets.input.years[0] || l.amount === null || !l.source.trim())
      issues.push('期初亏损须为本期之前的已确认剩余金额及来源');
  let vatCredit = assetAmountCents(input.openingVatCredit);
  let lots: TaxLossLot[] | null =
    input.lossCarryYears === null
      ? null
      : input.openingLosses.map((l) => ({
          originYear: l.originYear,
          expiresAfterYear: l.originYear + input.lossCarryYears!,
          amountCents: assetAmountCents(l.amount) ?? -1,
        }));
  if (lots?.some((l) => l.amountCents < 0)) lots = null;
  const generations = new Map<string, Generation>();
  let chainKnown = !issues.length && vatCredit !== null && lots !== null;
  const years: TaxCashflowYearResult[] = assets.input.years.map((year) => {
    const yearIssues = [...issues];
    const y = input.years.find((y) => y.year === year);
    const op = operating.years.find((y) => y.year === year);
    const capital = assets.years.find((y) => y.year === year)!;
    const physical = context.annualTransport?.some((y) => y.year === year) ?? false;
    if (
      !y?.activity ||
      !y.source.trim() ||
      (physical
        ? y.activity !== 'operating' || !op?.complete
        : y.activity !== 'non-operating' || !!op)
    )
      yearIssues.push(`${year}：运营证据或无运营年度声明不完整`);
    if (
      !y?.taxSource.trim() ||
      y.incomeTaxRate === null ||
      y.otherTax === null ||
      y.otherTaxDeductible === null
    )
      yearIssues.push(`${year}：所得税率、其他税费、扣除条件及来源待填写`);
    if (!capital.complete) yearIssues.push(`${year}：资本收付账目不完整`);
    if (!chainKnown) yearIssues.push(`${year}：前期税务或结转依据未知，不能跳年结转`);
    const lines = targets.filter((t) => t.year === year).map((t) => lineOf(t, input, yearIssues));
    const depreciation = depreciateAssets(input, assets, year, lines, generations, yearIssues);
    const dep = sum(depreciation.map((d) => d.depreciationCents));
    const outputVat = sum(lines.filter((l) => l.direction === 'income').map((l) => l.vatCents));
    const inputVat = sum(lines.map((l) => l.creditCents));
    const openingVat = chainKnown ? vatCredit : null;
    const netVat = sum([outputVat, negative(inputVat), negative(openingVat)]);
    const vatBase = netVat === null ? null : Math.max(0, netVat);
    const closingVat = netVat === null ? null : Math.max(0, -netVat);
    function payment(kind: 'vat' | 'income' | 'other', baseCents: number | null) {
      const override = input.overrides.find((o) => o.year === year && o.kind === kind) ?? null;
      return {
        kind,
        baseCents,
        adoptedCents: override ? assetAmountCents(override.amount) : baseCents,
        override,
      };
    }
    const other = payment('other', assetAmountCents(y?.otherTax ?? null));
    const taxable = sum([
      ...lines
        .filter((l) => l.kind === 'operating')
        .map((l) => (l.direction === 'income' ? l.incomeBasisCents : negative(l.incomeBasisCents))),
      negative(dep),
      ...lines
        .filter((l) => l.kind === 'recovery')
        .map((l) =>
          l.rule?.incomeTax === 'excluded'
            ? 0
            : sum([
                l.incomeBasisCents,
                negative(
                  sum(
                    depreciation
                      .filter((d) => d.assetId === l.assetId && d.disposalKind === l.eventKind)
                      .map((d) => d.disposedBasisCents),
                  ),
                ),
              ]),
        ),
      y?.otherTaxDeductible === null || y?.otherTaxDeductible === undefined
        ? null
        : y.otherTaxDeductible
          ? negative(other.adoptedCents)
          : 0,
    ]);
    const lossOpening = chainKnown && lots ? sum(lots.map((l) => l.amountCents)) : null;
    let expired: number | null = null,
      used: number | null = null,
      added: number | null = null,
      closingLoss: number | null = null,
      after: number | null = null;
    if (chainKnown && lots && taxable !== null && input.lossCarryYears !== null) {
      expired = sum(lots.filter((l) => l.expiresAfterYear < year).map((l) => l.amountCents));
      lots = lots
        .filter((l) => l.expiresAfterYear >= year)
        .sort((a, b) => a.expiresAfterYear - b.expiresAfterYear || a.originYear - b.originYear);
      let positive = Math.max(0, taxable);
      const availableBefore = sum(lots.map((l) => l.amountCents));
      for (const lot of lots) {
        const take = Math.min(lot.amountCents, positive);
        lot.amountCents -= take;
        positive -= take;
      }
      used = sum([availableBefore, negative(sum(lots.map((l) => l.amountCents)))]);
      added = input.lossCarryYears > 0 ? Math.max(0, -taxable) : 0;
      if (added)
        lots.push({
          originYear: year,
          expiresAfterYear: year + input.lossCarryYears,
          amountCents: added,
        });
      lots = lots.filter((l) => l.amountCents > 0);
      closingLoss = sum(lots.map((l) => l.amountCents));
      after = positive;
    }
    const payments = [
      payment('vat', vatBase),
      payment('income', multiply(after, y?.incomeTaxRate ?? null)),
      other,
    ];
    const operatingCash = sum(
      lines
        .filter((l) => l.kind === 'operating')
        .map((l) => (l.direction === 'income' ? l.grossCents : negative(l.grossCents))),
    );
    const capitalCash = sum(
      lines
        .filter((l) => l.kind !== 'operating')
        .map((l) => (l.direction === 'income' ? l.grossCents : negative(l.grossCents))),
    );
    const workingCapital = sum([
      capital.workingCapitalReleaseCents,
      negative(capital.workingCapitalIncreaseCents),
    ]);
    const cash = sum([
      operatingCash,
      capitalCash,
      workingCapital,
      ...payments.map((p) => negative(p.adoptedCents)),
    ]);
    if (
      [
        dep,
        taxable,
        outputVat,
        inputVat,
        openingVat,
        closingVat,
        lossOpening,
        expired,
        used,
        added,
        closingLoss,
        after,
        operatingCash,
        capitalCash,
        workingCapital,
        cash,
        ...payments.flatMap((p) => [p.baseCents, p.adoptedCents]),
      ].some((v) => v === null)
    )
      yearIssues.push(`${year}：税基、税款、现金流或结转金额未知或超出安全整数分范围`);
    const complete = !yearIssues.length;
    chainKnown = complete;
    vatCredit = complete ? closingVat : null;
    if (!complete) lots = null;
    return {
      year,
      period: year - assets.input.years[0],
      timing: 'year-end',
      complete,
      issues: yearIssues,
      lines,
      depreciation,
      depreciationCents: dep,
      taxableBeforeLossCents: taxable,
      taxableAfterLossCents: complete ? after : null,
      outputVatCents: outputVat,
      inputVatCents: inputVat,
      openingVatCreditCents: openingVat,
      closingVatCreditCents: complete ? closingVat : null,
      lossOpeningCents: lossOpening,
      lossExpiredCents: expired,
      lossUsedCents: used,
      lossAddedCents: added,
      lossClosingCents: complete ? closingLoss : null,
      lossLots: lots ? lots.map((l) => ({ ...l })) : null,
      payments,
      operatingCashflowCents: operatingCash,
      capitalCashflowCents: capitalCash,
      workingCapitalCashflowCents: workingCapital,
      projectCashflowCents: complete ? cash : null,
    };
  });
  return {
    issues,
    years,
    complete: !issues.length && !!years.length && years.every((y) => y.complete),
  };
}
