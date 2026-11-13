import type { AnnualTransportYear, AnnualTransportYearResult } from './annual-transport';
import type { PlanningScenarioContext } from './index';
import type { DailyTransportResult } from './daily-transport';
import {
  operatingTreatment,
  tariffWindowPieces,
  type OperatingBasis,
  type OperatingCashflowYear,
  type OperatingCashflowYearResult,
  type OperatingLineLedger,
  type ElectricityChargeLedger,
} from './operating-cashflows';

const scale = 1_000_000;
/** Six decimal quantity units, then exact decimal rate multiplication and annual-line cents rounding. */
function microQuantity(value: number): bigint {
  const units = Math.round(value * scale);
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(units))
    throw new Error('年度计量超出安全六位小数范围');
  return BigInt(units);
}
function priceCents(quantity: bigint, rate: string): number {
  const [whole, fraction = ''] = rate.split('.');
  const price = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  const denominator = 10_000_000_000n;
  const cents = (quantity * price + denominator / 2n) / denominator;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('年度金额超出安全整数分位范围');
  return Number(cents);
}
function sumCents(values: number[]): number {
  const sum = values.reduce((n, value) => n + BigInt(value), 0n);
  if (sum > BigInt(Number.MAX_SAFE_INTEGER) || sum < -BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('年度汇总超出安全整数分位范围');
  return Number(sum);
}
function annualQuantity(
  basis: OperatingBasis,
  evidence: DailyTransportResult,
  days: number,
  stationId: string | null,
): number {
  const events = evidence.vehicleEnergy!.vehicles.flatMap((v) => v.events);
  switch (basis) {
    case 'year':
      return 1;
    case 'tonne':
      return evidence.totalCompletedTonnes * days;
    case 'tonne-km':
      return events.reduce((n, e) => n + (e.distanceMeters * e.loadTonnes) / 1000, 0) * days;
    case 'vehicle-km':
      return (evidence.vehicleEnergy!.totalDistanceMeters / 1000) * days;
    case 'empty-km':
      return (
        events.filter((e) => e.loadTonnes === 0).reduce((n, e) => n + e.distanceMeters / 1000, 0) *
        days
      );
    case 'swap':
      return (
        events.filter((e) => e.kind === 'swap' && (!stationId || e.stationId === stationId))
          .length * days
      );
    case 'grid-kwh':
      return (
        evidence.sharedPower!.sources.reduce(
          (n, p) =>
            n +
            (stationId
              ? p.intervals.reduce(
                  (n, i) =>
                    n +
                    i.stations
                      .filter((s) => s.stationId === stationId)
                      .reduce((n, s) => n + s.gridEnergyKwh, 0),
                  0,
                )
              : p.gridEnergyKwh),
          0,
        ) * days
      );
  }
}

export function calculateOperatingYear(
  context: PlanningScenarioContext,
  physical: AnnualTransportYear,
  result: AnnualTransportYearResult | undefined,
): OperatingCashflowYearResult {
  const boundary = context.operatingCashflows?.boundary ?? null;
  const input = context.operatingCashflows?.years.find((y) => y.year === physical.year);
  const evidence = result?.evidence ?? null;
  const issues: string[] = [];
  const lines: OperatingLineLedger[] = [];
  const electricity: ElectricityChargeLedger[] = [];
  const network = context.stationNetwork;
  if (!boundary) issues.push('业务边界待选择');
  if (!input) issues.push('本年运营收支输入待配置');
  if (!input?.scopeSource.trim()) issues.push('全部收入和运营费用的范围依据待填写');
  if (!input?.stationCostMode) issues.push('站点运维口径待选择');
  if (!evidence) issues.push('本年缺少已校验的完整代表日证据，实际业务量未知');
  function pricedLine(line: import('./operating-cashflows').OperatingPriceLine) {
    const treatment = operatingTreatment(line.flow, boundary);
    const included = treatment === 'included';
    if (included && line.rate === null) issues.push(`${line.name}：单价待填写`);
    if (included && !line.source.trim()) issues.push(`${line.name}：来源待填写`);
    const validStation =
      !line.stationId || !!network?.fixedLayout.some((s) => s.siteId === line.stationId);
    if (included && !validStation) issues.push(`${line.name}：站址关联失效`);
    let quantity: number | null = null;
    let amountCents: number | null = null;
    try {
      if (evidence && validStation) {
        const micro = microQuantity(
          annualQuantity(line.basis, evidence, physical.operatingDays, line.stationId),
        );
        quantity = Number(micro) / scale;
        if (line.rate !== null && line.source.trim()) amountCents = priceCents(micro, line.rate);
      }
    } catch (error) {
      if (included) issues.push(`${line.name}：${(error as Error).message}`);
    }
    lines.push({
      ...line,
      direction: line.flow.endsWith('cost') ? 'expense' : 'income',
      treatment,
      quantity,
      amountCents,
    });
  }
  for (const line of input?.lines ?? []) pricedLine(line);
  if (input?.stationCostMode === 'station-types') {
    for (const fixed of network?.fixedLayout ?? []) {
      const type = network?.stationTypes.find((t) => t.id === fixed.stationTypeId);
      const cost = type?.annualOperatingCost;
      // Stored station-type costs are already explicit numeric input, not a market fallback.
      const rate = cost == null || cost > Number.MAX_SAFE_INTEGER / 100 ? null : cost.toFixed(6);
      pricedLine({
        id: `station-type:${fixed.siteId}`,
        name: `${network?.sites.find((s) => s.id === fixed.siteId)?.name ?? fixed.siteId}站型年度运维`,
        flow: 'station-cost',
        basis: 'year',
        rate,
        source: type?.source ?? '',
        stationId: fixed.siteId,
      });
    }
  }
  if (evidence && input) electricityLedger(input);
  function electricityLedger(input: OperatingCashflowYear) {
    for (const power of evidence!.sharedPower!.sources) {
      // The shared-power ledger also records idle gaps; only actual purchases need prices.
      const purchased = power.intervals.filter(
        (interval) => interval.gridPowerKw > 0 && interval.endMinute > interval.startMinute,
      );
      if (!purchased.length) continue;
      const tariff = input.electricity.find((p) => p.powerSourceId === power.powerSourceId);
      const payer = tariff?.payer ?? null;
      const treatment =
        payer === 'external' || (payer === 'transport' && boundary === 'station-only')
          ? 'excluded'
          : 'included';
      const included = treatment === 'included';
      if (included && !payer) issues.push(`${power.powerSourceName}：购电承担方待选择`);
      for (const interval of purchased) {
        let covered = 0;
        for (const [windowIndex, window] of (tariff?.windows ?? []).entries()) {
          const pieces = tariffWindowPieces(window);
          for (const [start, end] of pieces) {
            const from = Math.max(0, start, interval.startMinute);
            const to = Math.min(1440, end, interval.endMinute);
            if (to <= from) continue;
            covered += to - from;
            for (const station of interval.stations) {
              let row = electricity.find(
                (r) =>
                  r.powerSourceId === power.powerSourceId &&
                  r.stationId === station.stationId &&
                  r.startMinute === window.startMinute &&
                  r.endMinute === window.endMinute,
              );
              if (!row) {
                row = {
                  powerSourceId: power.powerSourceId,
                  powerSourceName: power.powerSourceName,
                  stationId: station.stationId,
                  stationName:
                    network?.sites.find((s) => s.id === station.stationId)?.name ??
                    station.stationId,
                  payer,
                  startMinute: window.startMinute,
                  endMinute: window.endMinute,
                  rate: window.rate,
                  source: window.source,
                  quantityKwh: 0,
                  amountCents: null,
                  treatment,
                  intervals: [],
                };
                electricity.push(row);
                if (included && window.rate === null)
                  issues.push(`${power.powerSourceName}电价窗口${windowIndex + 1}：单价待填写`);
                if (included && !window.source.trim())
                  issues.push(`${power.powerSourceName}电价窗口${windowIndex + 1}：来源待填写`);
              }
              row.quantityKwh! +=
                (((to - from) * station.gridPowerKw) / 60) * physical.operatingDays;
              row.intervals.push({
                startMinute: from,
                endMinute: to,
                gridPowerKw: station.gridPowerKw,
              });
            }
          }
        }
        if (included && interval.endMinute - interval.startMinute - covered > 1e-7)
          issues.push(`${power.powerSourceName}：实际购电区间缺少电价覆盖`);
      }
    }
    for (const row of electricity) {
      try {
        const micro = microQuantity(row.quantityKwh!);
        row.quantityKwh = Number(micro) / scale;
        if (row.rate !== null && row.source.trim()) row.amountCents = priceCents(micro, row.rate);
      } catch (error) {
        if (row.treatment === 'included')
          issues.push(`${row.powerSourceName}：${(error as Error).message}`);
      }
    }
    const usedSources = new Set(evidence!.sharedPower!.sources.map((p) => p.powerSourceId));
    if (input.electricity.some((p) => !usedSources.has(p.powerSourceId)))
      issues.push('电价存在不属于本年实际电源的失效关联');
  }
  let incomeCents: number | null = null,
    expenseCents: number | null = null,
    balanceCents: number | null = null,
    electricityTotalCents: number | null = null;
  try {
    const includedElectricity = electricity.filter((l) => l.treatment === 'included');
    if (
      evidence &&
      includedElectricity.every((l) => l.amountCents !== null) &&
      !issues.some((i) => /购电|电价/.test(i))
    )
      electricityTotalCents = sumCents(includedElectricity.map((l) => l.amountCents!));
    if (!issues.length && electricityTotalCents !== null) {
      const included = lines.filter((l) => l.treatment === 'included');
      incomeCents = sumCents(
        included.filter((l) => l.direction === 'income').map((l) => l.amountCents!),
      );
      expenseCents = sumCents([
        ...included.filter((l) => l.direction === 'expense').map((l) => l.amountCents!),
        electricityTotalCents,
      ]);
      balanceCents = sumCents([incomeCents, -expenseCents]);
    }
  } catch (error) {
    issues.push((error as Error).message);
    incomeCents = expenseCents = balanceCents = null;
  }
  return {
    year: physical.year,
    operatingDays: physical.operatingDays,
    evidenceYear: evidence ? physical.year : null,
    complete: !issues.length && balanceCents !== null,
    issues: [...new Set(issues)],
    lines,
    electricity,
    electricityTotalCents,
    incomeCents,
    expenseCents,
    balanceCents,
  };
}
