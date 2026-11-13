import type { ReactNode } from 'react';
import {
  operatingBases,
  operatingFlows,
  type OperatingCashflowResult,
  type OperatingCashflowYearResult,
} from '@haulpath/domain';
import { LedgerTable, stationClockTime } from './daily-transport-station-ledger';
import styles from './operating-cashflows.module.css';

export const cashflowNumber = (value: number | null) =>
  value === null ? '—' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 }).format(value);
export function cashflowMoney(cents: number | null): string {
  if (cents === null) return '—';
  if (!Number.isSafeInteger(cents)) return '超出金额范围';
  const value = BigInt(cents < 0 ? -cents : cents);
  return `${cents < 0 ? '-' : ''}${(value / 100n).toLocaleString('zh-CN')}.${String(value % 100n).padStart(2, '0')}`;
}
export function CashflowTable({
  label,
  columns,
  rows,
  numericColumns,
}: {
  label: string;
  columns: string[];
  rows: ReactNode[][];
  numericColumns?: number[];
}) {
  const alignment = (index: number) =>
    numericColumns
      ? { textAlign: numericColumns.includes(index) ? ('right' as const) : ('left' as const) }
      : undefined;
  return (
    <LedgerTable label={label}>
      <thead>
        <tr>
          {columns.map((col, index) => (
            <th key={col} scope="col" style={alignment(index)}>
              {col}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            {row.map((cell, j) =>
              j === 0 ? (
                <th key={j} scope="row" style={alignment(j)}>
                  {cell}
                </th>
              ) : (
                <td key={j} style={alignment(j)}>
                  {cell}
                </td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </LedgerTable>
  );
}
const treatments = { included: '计入', excluded: '边界外', eliminated: '内部抵销' };
export function OperatingYearLedger({
  result,
  year,
}: {
  result: OperatingCashflowResult;
  year: OperatingCashflowYearResult;
}) {
  const input = result.input.years.find((y) => y.year === year.year);
  const powers = [...new Set(year.electricity.map((e) => e.powerSourceId))];
  return (
    <section className={styles.yearResult} aria-label={`${year.year} 年运营收支账目`}>
      <h4>{year.year} 年收支依据</h4>
      <p className={styles.help}>
        运营 {year.operatingDays} 天 · 代表日证据：{year.evidenceYear ?? '未知'} 年 · 范围依据：
        {input?.scopeSource || '待填写'} · 站点运维：
        {input?.stationCostMode === 'station-types'
          ? '逐站站型年度运维'
          : input?.stationCostMode === 'annual-lines'
            ? '年度明细替代'
            : '待选择'}
      </p>
      {year.issues.length > 0 && (
        <ul className={styles.issues}>
          {year.issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
      <CashflowTable
        label={`${year.year} 年收支逐项账目`}
        columns={['项目', '归属', '计量依据', '年度数量', '元/单位', '金额（元）', '处理', '来源']}
        rows={year.lines.map((l) => [
          l.name,
          operatingFlows[l.flow],
          `${operatingBases[l.basis]}${l.stationId ? ` · ${year.electricity.find((e) => e.stationId === l.stationId)?.stationName ?? l.stationId}` : ''}`,
          cashflowNumber(l.quantity),
          l.rate ?? '—',
          cashflowMoney(l.amountCents),
          treatments[l.treatment],
          l.source || '缺来源',
        ])}
      />
      <h4>电源合计与逐站分摊</h4>
      <p className={styles.help}>
        电源合计只用于核对下方逐站分时费用之和，不重复计入支出。购电支出：
        {cashflowMoney(year.electricityTotalCents)} 元。
      </p>
      <CashflowTable
        label={`${year.year} 年电源费用核对`}
        columns={['电源', '年度购电（kWh）', '分摊费用合计（元）', '处理']}
        rows={powers.map((id) => {
          const rows = year.electricity.filter((e) => e.powerSourceId === id);
          return [
            rows[0].powerSourceName,
            rows.every((e) => e.quantityKwh !== null)
              ? cashflowNumber(rows.reduce((n, e) => n + e.quantityKwh!, 0))
              : '—',
            rows.every((e) => e.amountCents !== null)
              ? cashflowMoney(rows.reduce((n, e) => n + e.amountCents!, 0))
              : '—',
            treatments[rows[0].treatment],
          ];
        })}
      />
      <CashflowTable
        label={`${year.year} 年分时电费依据`}
        columns={[
          '电源 / 站址',
          '承担方',
          '电价窗口',
          '年度购电（kWh）',
          '元/kWh',
          '金额（元）',
          '处理',
          '来源',
        ]}
        rows={year.electricity.map((e) => [
          `${e.powerSourceName} / ${e.stationName}`,
          e.payer === 'station'
            ? '站方'
            : e.payer === 'transport'
              ? '运输方'
              : e.payer === 'external'
                ? '外部'
                : '待选择',
          `${stationClockTime(e.startMinute)}–${stationClockTime(e.endMinute)}${e.endMinute < e.startMinute ? '（跨午夜）' : ''}`,
          cashflowNumber(e.quantityKwh),
          e.rate ?? '—',
          cashflowMoney(e.amountCents),
          treatments[e.treatment],
          e.source || '缺来源',
        ])}
      />
      <details className={styles.trace}>
        <summary>实际购电区间交集与数值政策</summary>
        <p>
          数量按年度明细汇总后四舍五入至6位小数；单价最多6位小数，用十进制定点相乘，逐项年度金额四舍五入到分后求和。固定费用按整年计入。电费逐站逐电价窗口按年舍入，电源合计由分摊金额相加。未知和超范围金额不补零。
        </p>
        <p>
          政策：{result.policy}
          。数量的百万分之一须为安全整数，金额及汇总须在安全整数分位范围内。以下为代表日区间，乘本年运营天数计费。
        </p>
        <CashflowTable
          label={`${year.year} 年实际购电交集`}
          columns={['电源 / 站址', '开始分钟', '结束分钟', '电网功率（kW）']}
          rows={year.electricity.flatMap((e) =>
            e.intervals.map((i) => [
              `${e.powerSourceName} / ${e.stationName}`,
              cashflowNumber(i.startMinute),
              cashflowNumber(i.endMinute),
              cashflowNumber(i.gridPowerKw),
            ]),
          )}
        />
      </details>
    </section>
  );
}
