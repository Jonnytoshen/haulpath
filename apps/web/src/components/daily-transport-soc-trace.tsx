import type { VehicleEnergyResult } from '@haulpath/domain';
import styles from './daily-transport.module.css';

export const energyNumber = (value: number) =>
  value.toLocaleString('zh-CN', { maximumFractionDigits: 3 });
export const percent = (value: number) => `${energyNumber(value)}%`;

export function BatteryTrace({
  vehicle,
  capacityKwh,
  start,
  span,
}: {
  vehicle: VehicleEnergyResult['vehicles'][number];
  capacityKwh: number;
  start: number;
  span: number;
}) {
  const width = 1000;
  const initial = (vehicle.initialKwh / capacityKwh) * 100;
  const final = (vehicle.finalKwh / capacityKwh) * 100;
  const safety = (vehicle.safetyKwh / capacityKwh) * 100;
  const lowest = vehicle.events.reduce(
    (value, event) => Math.min(value, event.startSocPercent, event.endSocPercent),
    initial,
  );
  const x = (minute: number) => ((minute - start) / span) * width;
  const points = [
    `0,${100 - initial}`,
    ...vehicle.events.flatMap((event) => {
      const from = `${x(event.startMinute)},${100 - event.startSocPercent}`;
      const to = `${x(event.endMinute)},${100 - event.endSocPercent}`;
      return event.kind === 'swap'
        ? [from, `${x(event.endMinute)},${100 - event.startSocPercent}`, to]
        : [from, to];
    }),
    `${width},${100 - final}`,
  ].join(' ');
  return (
    <div className={`${styles.lane} ${styles.socLane}`}>
      <div className={styles.socLabel}>
        <strong>所选车辆 SOC</strong>
        <span>
          最低 {percent(lowest)} · 安全线 {percent(safety)}
        </span>
      </div>
      <div className={styles.socPlot}>
        <svg
          viewBox={`0 0 ${width} 100`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`车辆 ${vehicle.vehicleId} 的 SOC 变化，起始 ${percent(initial)}，最低 ${percent(lowest)}，结束 ${percent(final)}，安全线 ${percent(safety)}`}
        >
          <line
            className={styles.socSafety}
            x1="0"
            x2={width}
            y1={100 - safety}
            y2={100 - safety}
            vectorEffect="non-scaling-stroke"
          />
          <polyline className={styles.socLine} points={points} vectorEffect="non-scaling-stroke" />
        </svg>
        <span aria-hidden="true">100%</span>
        <span aria-hidden="true">0%</span>
      </div>
    </div>
  );
}
