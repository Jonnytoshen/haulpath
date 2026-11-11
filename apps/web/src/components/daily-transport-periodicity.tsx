import type {
  DailyTransportResult,
  PeriodicStationState,
  PeriodicVehicleState,
} from '@haulpath/domain';
import { energyNumber } from './daily-transport-soc-trace';
import { LedgerTable } from './daily-transport-station-ledger';
import styles from './daily-transport.module.css';

const packKinds = { pending: '待充', charging: '在充', 'in-service': '服务中' };
function inventory(state: PeriodicStationState) {
  return `${state.full} 满电 / ${state.packs.filter((p) => p.kind === 'pending').length} 待充 / ${state.packs.filter((p) => p.kind === 'charging').length} 在充 / ${state.packs.filter((p) => p.kind === 'in-service').length} 服务中`;
}
function vehicleState(state: PeriodicVehicleState) {
  return state.eventKind ? `跨界作业，剩余 ${energyNumber(state.remainingMinutes)} 分钟` : '停驻';
}

export function PeriodicityLedger({ result }: { result: DailyTransportResult }) {
  const periodic = result.periodicity;
  if (!periodic) return null;
  const { initial, final, energy } = periodic;
  const names = new Map(result.stationTurnover?.stations.map((s) => [s.stationId, s.stationName]));
  return (
    <section className={styles.block} aria-label="24 小时周期账目">
      <h4>24 小时周期账目</h4>
      <p className={styles.caption}>
        周期闭合，完整物理校核通过。以下比较本日 00:00 与次日
        00:00；车辆出发与归位电量另见逐车事件。
        跨午夜的行驶、工位服务、待充和在充状态均延续，财务尚未校核。
      </p>
      <dl className={styles.inventory}>
        <div>
          <dt>周期初 / 末总储能</dt>
          <dd>
            {energyNumber(energy.initialStoredKwh)} / {energyNumber(energy.finalStoredKwh)} kWh
          </dd>
        </div>
        <div>
          <dt>日内行驶耗电</dt>
          <dd>{energyNumber(energy.consumedKwh)} kWh</dd>
        </div>
        <div>
          <dt>日内充入电量</dt>
          <dd>{energyNumber(energy.addedKwh)} kWh</dd>
        </div>
        <div>
          <dt>日内实际购电</dt>
          <dd>{energyNumber(energy.gridEnergyKwh)} kWh</dd>
        </div>
      </dl>
      <p className={styles.tableHint}>横向滚动可并排核对初末态与跨界进度。</p>
      <LedgerTable label="周期车辆初末态">
        <thead>
          <tr>
            <th scope="col">计划车辆</th>
            <th scope="col">本日 00:00</th>
            <th scope="col">次日 00:00</th>
            <th scope="col">边界作业</th>
          </tr>
        </thead>
        <tbody>
          {initial.vehicles.map((vehicle) => {
            const end = final.vehicles.find((v) => v.vehicleId === vehicle.vehicleId)!;
            return (
              <tr key={vehicle.vehicleId}>
                <th scope="row">{vehicle.vehicleId}</th>
                <td className={styles.num}>{energyNumber(vehicle.kwh)} kWh</td>
                <td className={styles.num}>{energyNumber(end.kwh)} kWh</td>
                <td>
                  {vehicleState(vehicle)} / {vehicleState(end)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </LedgerTable>
      <LedgerTable label="周期站内初末态">
        <thead>
          <tr>
            <th scope="col">站址</th>
            <th scope="col">本日 00:00</th>
            <th scope="col">次日 00:00</th>
            <th scope="col">初 / 末储能（kWh）</th>
          </tr>
        </thead>
        <tbody>
          {initial.stations.map((station) => {
            const end = final.stations.find((s) => s.stationId === station.stationId)!;
            return (
              <tr key={station.stationId}>
                <th scope="row">{names.get(station.stationId)}</th>
                <td>{inventory(station)}</td>
                <td>{inventory(end)}</td>
                <td className={styles.num}>
                  {energyNumber(station.storedKwh)} / {energyNumber(end.storedKwh)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </LedgerTable>
      {initial.stations.some((s) => s.packs.length > 0) && (
        <details className={styles.ledgerSection} open>
          <summary>跨界电池状态与剩余进度</summary>
          <LedgerTable label="跨界电池状态">
            <thead>
              <tr>
                <th scope="col">站址</th>
                <th scope="col">状态</th>
                <th scope="col">边界电量（kWh）</th>
                <th scope="col">距开始（分钟）</th>
                <th scope="col">距完成（分钟）</th>
              </tr>
            </thead>
            <tbody>
              {initial.stations.flatMap((station) =>
                station.packs.map((pack, index) => (
                  <tr key={`${station.stationId}-${index}`}>
                    <th scope="row">{names.get(station.stationId)}</th>
                    <td>{packKinds[pack.kind]}</td>
                    <td className={styles.num}>{energyNumber(pack.kwh)}</td>
                    <td className={styles.num}>
                      {pack.startInMinutes === null ? '未安排' : energyNumber(pack.startInMinutes)}
                    </td>
                    <td className={styles.num}>
                      {pack.endInMinutes === null ? '未安排' : energyNumber(pack.endInMinutes)}
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </LedgerTable>
          <p className={styles.caption}>负数表示在零点前已开始；次日零点具有相同状态和剩余进度。</p>
        </details>
      )}
    </section>
  );
}
