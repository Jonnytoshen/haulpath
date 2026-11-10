import { useState, type ReactNode } from 'react';
import type {
  OperatingShift,
  StationNetwork,
  StationChargeEvent,
  StationSwapEvent,
  StationTurnoverResult,
} from '@haulpath/domain';
import { NativeSelect } from '@/components/ui/native-select';
import { energyNumber, percent } from './daily-transport-soc-trace';
import styles from './daily-transport.module.css';

export const serviceWaitLabels: Record<StationSwapEvent['waitReasons'][number], string> = {
  'service-window': '等待服务窗口',
  bay: '工位占用',
  'full-battery': '满电库存不足',
};

const chargingWaitLabels: Record<StationChargeEvent['waitReasons'][number], string> = {
  'charge-window': '充电窗口',
  'charging-slot': '充电位占用',
  'local-power': '站内可用功率',
  horizon: '试算范围内未开始充电',
};

const chargeStatuses = {
  full: '已充满',
  pending: '待充',
  charging: '在充',
};

export function stationClockTime(minute: number) {
  const total = Math.round(minute * 60);
  const day = Math.floor(total / 86400);
  const hour = String(Math.floor((total % 86400) / 3600)).padStart(2, '0');
  const minuteOfHour = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const second = total % 60;
  const dayLabel = day === 0 ? '' : day === 1 ? '次日 ' : `第 ${day + 1} 日 `;
  return `${dayLabel}${hour}:${minuteOfHour}${second ? `:${String(second).padStart(2, '0')}` : ''}`;
}

function windowsText(windows: OperatingShift[]) {
  return windows
    .map(
      (window) => `${stationClockTime(window.startMinute)}–${stationClockTime(window.endMinute)}`,
    )
    .join('、');
}

function LedgerTable({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      className={styles.tableScroll}
      role="region"
      aria-label={`${label}表格滚动区`}
      tabIndex={0}
    >
      <table aria-label={label}>{children}</table>
    </div>
  );
}

export function StationTurnoverLedger({
  turnover,
  network,
}: {
  turnover: StationTurnoverResult;
  network: StationNetwork | undefined;
}) {
  const [stationId, setStationId] = useState('');
  const station =
    turnover.stations.find((entry) => entry.stationId === stationId) ??
    turnover.stations.find((entry) => entry.swaps.length > 0) ??
    turnover.stations[0];
  if (!station) return null;
  const power = network?.powerSources.find((source) => source.id === station.powerSourceId);
  const stationType = network?.stationTypes.find((type) => type.id === station.stationTypeId);
  const swapReferences = new Map(
    station.swaps.map((swap, index) => [
      swap.eventId,
      { label: `第 ${index + 1} 次换电`, vehicleId: swap.vehicleId },
    ]),
  );
  const inventory = [
    ...station.swaps.map((swap) => ({
      id: `${swap.eventId}-take`,
      eventId: swap.eventId,
      minute: swap.serviceStartMinute,
      action: '领用满电池',
      order: 3,
      change: '满电 −1',
      full: swap.fullBatteriesAfterStart,
    })),
    ...station.charges.flatMap((charge) => {
      const { swapEventId: eventId, returnedMinute, startMinute, endMinute } = charge;
      const alreadyFull = startMinute != null && startMinute === endMinute;
      const returned = {
        id: `${eventId}-return`,
        eventId,
        minute: returnedMinute,
        action: alreadyFull ? '接收满电池' : '接收换下电池',
        order: 1,
        change: alreadyFull ? '满电 +1' : '待充 +1',
        full: null,
      };
      if (alreadyFull || startMinute == null || endMinute == null) return [returned];
      return [
        returned,
        {
          id: `${eventId}-charge`,
          eventId,
          minute: startMinute,
          action: '开始充电',
          order: 2,
          change: '待充 −1，在充 +1',
          full: null,
        },
        {
          id: `${eventId}-full`,
          eventId,
          minute: endMinute,
          action: '充满入库',
          order: 0,
          change: '在充 −1，满电 +1',
          full: null,
        },
      ];
    }),
  ]
    .filter((event) => event.minute <= turnover.horizonMinute)
    .sort((a, b) => a.minute - b.minute || a.order - b.order);
  const { full, pending, charging } = station.horizonInventory;

  return (
    <section className={styles.block} aria-label="站内周转账目">
      <div className={styles.subheading}>
        <h4>站内周转账目</h4>
        {turnover.stations.length > 1 && (
          <label>
            站址
            <NativeSelect
              value={station.stationId}
              onChange={(event) => setStationId(event.target.value)}
            >
              {turnover.stations.map((entry) => (
                <option key={entry.stationId} value={entry.stationId}>
                  {entry.stationName}
                </option>
              ))}
            </NativeSelect>
          </label>
        )}
      </div>
      <p className={styles.stationBasis}>
        <strong>{station.stationName}</strong>
        <span>
          {station.stationTypeName} · {station.bays} 个工位 · {station.chargingSlots} 个充电位
        </span>
        <span>
          站内上限 {energyNumber(station.stationPowerKw)} kW · 接电上限{' '}
          {energyNumber(station.sitePowerKw)} kW
          {power && ` · 电源 ${power.point.name}`}
        </span>
      </p>
      <dl className={styles.inventory}>
        <div>
          <dt>首日 00:00 满电</dt>
          <dd>{energyNumber(station.initialFullBatteries)} 块</dd>
        </div>
        <div>
          <dt>截止时满电</dt>
          <dd>{energyNumber(full)} 块</dd>
        </div>
        <div>
          <dt>截止时待充</dt>
          <dd>{energyNumber(pending)} 块</dd>
        </div>
        <div>
          <dt>截止时在充</dt>
          <dd>{energyNumber(charging)} 块</dd>
        </div>
      </dl>
      <p className={styles.caption}>
        首日站内备电按 {percent(turnover.initialBatterySocPercent)} SOC 起算，账目截至{' '}
        {stationClockTime(turnover.horizonMinute)}。换电开始领用满电池，服务结束接收换下电池。
      </p>
      {stationType && (
        <details className={styles.ledgerSection}>
          <summary>站型窗口与参数依据</summary>
          <p className={styles.caption}>
            服务窗口 {windowsText(stationType.serviceWindows)} · 单次换电 {stationType.swapMinutes}{' '}
            分钟
          </p>
          <p className={styles.caption}>充电窗口 {windowsText(stationType.chargeWindows)}</p>
          <p className={styles.caption}>站型来源 {stationType.source}</p>
        </details>
      )}
      <p className={styles.tableHint}>横向滚动可核对完整账目。</p>
      <details className={styles.ledgerSection} open>
        <summary>换电与等待（{station.swaps.length} 次）</summary>
        {station.swaps.length ? (
          <LedgerTable label="换电与等待">
            <thead>
              <tr>
                <th scope="col">换电 / 计划车辆</th>
                <th scope="col" className={styles.num}>
                  到站
                </th>
                <th scope="col" className={styles.num}>
                  工位占用
                </th>
                <th scope="col" className={styles.num}>
                  换下电量（kWh）
                </th>
                <th scope="col" className={styles.num}>
                  领用后满电（块）
                </th>
              </tr>
            </thead>
            <tbody>
              {station.swaps.map((swap) => (
                <tr key={swap.eventId}>
                  <td>
                    <strong>
                      {swapReferences.get(swap.eventId)?.label} · {swap.vehicleId}
                    </strong>
                    <small>
                      等待 {energyNumber(swap.serviceStartMinute - swap.arrivalMinute)} 分钟
                      {swap.waitReasons.length > 0 &&
                        ` · ${swap.waitReasons.map((reason) => serviceWaitLabels[reason]).join('、')}`}
                    </small>
                  </td>
                  <td className={styles.num}>{stationClockTime(swap.arrivalMinute)}</td>
                  <td className={styles.num}>
                    {stationClockTime(swap.serviceStartMinute)}–{stationClockTime(swap.endMinute)}
                    <small>工位 {swap.bay}</small>
                  </td>
                  <td className={styles.num}>{energyNumber(swap.returnedKwh)}</td>
                  <td className={styles.num}>{energyNumber(swap.fullBatteriesAfterStart)}</td>
                </tr>
              ))}
            </tbody>
          </LedgerTable>
        ) : (
          <p className={styles.caption}>本次试算未安排车辆在此站换电。</p>
        )}
      </details>
      <details className={styles.ledgerSection}>
        <summary>恒功率充电（{station.charges.length} 条）</summary>
        <p className={styles.caption}>
          取电功率按电网侧计量，补入电量为购电量乘以效率。跨过账目截止时间的充电列完整排程电量，待充项列需求。
        </p>
        {station.charges.length ? (
          <LedgerTable label="恒功率充电">
            <thead>
              <tr>
                <th scope="col">返回电池 / 充电状态</th>
                <th scope="col" className={styles.num}>
                  返回时间
                </th>
                <th scope="col" className={styles.num}>
                  连续充电时段
                </th>
                <th scope="col" className={styles.num}>
                  取电功率（kW）
                </th>
                <th scope="col" className={styles.num}>
                  购电 / 补入（kWh）
                </th>
              </tr>
            </thead>
            <tbody>
              {station.charges.map((charge) => {
                const swap = swapReferences.get(charge.swapEventId);
                const { startMinute, endMinute } = charge;
                return (
                  <tr key={charge.swapEventId}>
                    <td>
                      <strong>
                        {swap?.label} · {swap?.vehicleId}
                      </strong>
                      <small>
                        {chargeStatuses[charge.statusAtHorizon]}
                        {charge.waitReasons.length > 0 &&
                          ` · ${charge.waitReasons.map((reason) => chargingWaitLabels[reason]).join('、')}`}
                      </small>
                    </td>
                    <td className={styles.num}>
                      {stationClockTime(charge.returnedMinute)}
                      <small>{energyNumber(charge.returnedKwh)} kWh</small>
                    </td>
                    <td className={styles.num}>
                      {startMinute == null || endMinute == null
                        ? '截止前未排入'
                        : startMinute === endMinute
                          ? '返回时已满电'
                          : `${stationClockTime(startMinute)}–${stationClockTime(endMinute)}`}
                    </td>
                    <td className={styles.num}>
                      {energyNumber(charge.gridPowerKw)}
                      <small>效率 {percent(charge.efficiency * 100)}</small>
                    </td>
                    <td className={styles.num}>
                      {energyNumber(charge.gridEnergyKwh)} / {energyNumber(charge.addedKwh)}
                      {startMinute == null && <small>所需电量</small>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </LedgerTable>
        ) : (
          <p className={styles.caption}>此站没有换下电池进入周转。</p>
        )}
      </details>
      <details className={styles.ledgerSection}>
        <summary>库存流水（{inventory.length} 条）</summary>
        {inventory.length ? (
          <LedgerTable label="库存流水">
            <thead>
              <tr>
                <th scope="col">换电 / 计划车辆</th>
                <th scope="col" className={styles.num}>
                  时刻
                </th>
                <th scope="col">事件</th>
                <th scope="col" className={styles.num}>
                  库存变化（块）
                </th>
              </tr>
            </thead>
            <tbody>
              {inventory.map((event) => {
                const swap = swapReferences.get(event.eventId);
                return (
                  <tr key={event.id}>
                    <td>
                      <strong>
                        {swap?.label} · {swap?.vehicleId}
                      </strong>
                    </td>
                    <td className={styles.num}>{stationClockTime(event.minute)}</td>
                    <td>{event.action}</td>
                    <td className={styles.num}>
                      {event.change}
                      {event.full != null && (
                        <small>领用后满电 {energyNumber(event.full)} 块</small>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </LedgerTable>
        ) : (
          <p className={styles.caption}>截止前库存没有变动。</p>
        )}
      </details>
    </section>
  );
}
