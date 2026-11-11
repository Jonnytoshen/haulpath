import { useState } from 'react';
import type { SharedPowerResult, StationTurnoverResult } from '@haulpath/domain';
import { NativeSelect } from '@/components/ui/native-select';
import { energyNumber } from './daily-transport-soc-trace';
import { LedgerTable, stationClockTime } from './daily-transport-station-ledger';
import styles from './daily-transport.module.css';

export function SharedPowerLedger({
  power,
  turnover,
}: {
  power: SharedPowerResult;
  turnover: StationTurnoverResult;
}) {
  const [sourceId, setSourceId] = useState('');
  const source = power.sources.find((s) => s.powerSourceId === sourceId) ?? power.sources[0];
  if (!source) return null;
  const stations = turnover.stations.filter((s) => s.powerSourceId === source.powerSourceId);
  const names = new Map(stations.map((s) => [s.stationId, s.stationName]));
  const waiting = stations
    .flatMap((s) => s.charges)
    .filter((c) => c.waitReasons.includes('shared-power')).length;
  const pending = stations.reduce((sum, s) => sum + s.horizonInventory.pending, 0);
  return (
    <section className={styles.block} aria-label="共享电源账目">
      <div className={styles.subheading}>
        <h4>共享电源账目</h4>
        {power.sources.length > 1 && (
          <label>
            电源
            <NativeSelect
              aria-label="电源"
              value={source.powerSourceId}
              onChange={(event) => setSourceId(event.target.value)}
            >
              {power.sources.map((s) => (
                <option key={s.powerSourceId} value={s.powerSourceId}>
                  {s.powerSourceName}
                </option>
              ))}
            </NativeSelect>
          </label>
        )}
      </div>
      <p className={styles.stationBasis}>
        <strong>{source.powerSourceName}</strong>
        <span>{stations.length} 个站共同占用，容量按任务快照核对</span>
      </p>
      <dl className={`${styles.inventory} ${styles.powerSummary}`}>
        <div>
          <dt>共享可用容量</dt>
          <dd>{energyNumber(source.availableCapacityKw)} kW</dd>
        </div>
        <div>
          <dt>完整充电排程峰值</dt>
          <dd>{energyNumber(source.peakPowerKw)} kW</dd>
        </div>
        <div>
          <dt>截止前实际购电</dt>
          <dd>{energyNumber(source.gridEnergyKwh)} kWh</dd>
        </div>
      </dl>
      <p className={styles.caption}>
        {waiting
          ? `${waiting} 条回收电池充电因共享电源占用或容量不足等待。`
          : '本次充电未因共享电源等待。'}
        {pending > 0 && `截止时仍有 ${pending} 块电池待充，需结合站账核对窗口与功率。`}
        {turnover.initialBatterySocPercent === 'periodic'
          ? '按已闭合的 24 小时周期核对购电。'
          : '24 小时周期尚未校核。'}
      </p>
      <details className={styles.ledgerSection} open>
        <summary>电源下各站占用</summary>
        <p className={styles.tableHint}>横向滚动可核对各站峰值、购电与等待。</p>
        <LedgerTable label="电源下各站占用">
          <thead>
            <tr>
              <th scope="col">站址</th>
              <th scope="col" className={styles.num}>
                峰值（kW）
              </th>
              <th scope="col" className={styles.num}>
                购电（kWh）
              </th>
              <th scope="col" className={styles.num}>
                共享功率等待（条）
              </th>
            </tr>
          </thead>
          <tbody>
            {stations.map((station) => {
              const usage = source.intervals.flatMap((i) =>
                i.stations.filter((s) => s.stationId === station.stationId),
              );
              const peak = usage.reduce((max, row) => Math.max(max, row.gridPowerKw), 0);
              return (
                <tr key={station.stationId}>
                  <td>
                    <strong>{station.stationName}</strong>
                    <small>
                      站内 {energyNumber(station.stationPowerKw)} / 接电{' '}
                      {energyNumber(station.sitePowerKw)} kW
                    </small>
                  </td>
                  <td className={styles.num}>{energyNumber(peak)}</td>
                  <td className={styles.num}>
                    {energyNumber(usage.reduce((sum, u) => sum + u.gridEnergyKwh, 0))}
                  </td>
                  <td className={styles.num}>
                    {station.charges.filter((c) => c.waitReasons.includes('shared-power')).length}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </LedgerTable>
      </details>
      <details className={styles.ledgerSection} open>
        <summary>分时购电与功率</summary>
        <p className={styles.caption}>
          统计 00:00 至 {stationClockTime(power.horizonMinute)}{' '}
          的实际取电。充电连续完成，截止后的完整占用保留在站内充电账目中。未按电价优化。
        </p>
        <p className={styles.tableHint}>横向滚动可核对各站占用与购电量。</p>
        <LedgerTable label="分时购电与功率">
          <thead>
            <tr>
              <th scope="col">取电时段</th>
              <th scope="col" className={styles.num}>
                电源功率（kW）
              </th>
              <th scope="col">站点功率（kW）</th>
              <th scope="col" className={styles.num}>
                购电（kWh）
              </th>
            </tr>
          </thead>
          <tbody>
            {source.intervals.map((interval) => (
              <tr key={interval.startMinute}>
                <td>
                  {stationClockTime(interval.startMinute)}–{stationClockTime(interval.endMinute)}
                </td>
                <td className={styles.num}>{energyNumber(interval.gridPowerKw)}</td>
                <td>
                  {interval.stations.length
                    ? interval.stations.map((s) => (
                        <small key={s.stationId}>
                          {names.get(s.stationId)} · {energyNumber(s.gridPowerKw)}
                        </small>
                      ))
                    : '无充电占用'}
                </td>
                <td className={styles.num}>{energyNumber(interval.gridEnergyKwh)}</td>
              </tr>
            ))}
          </tbody>
        </LedgerTable>
      </details>
    </section>
  );
}
