import type { DailyTransportSnapshot, DailyTransportValidation } from './daily-transport';
import type { OperatingShift } from './fleet-operations';
import type { StationTurnoverResult } from './station-turnover';

export interface SharedPowerStationUsage {
  stationId: string;
  gridPowerKw: number;
  gridEnergyKwh: number;
}

export interface SharedPowerInterval {
  startMinute: number;
  endMinute: number;
  gridPowerKw: number;
  gridEnergyKwh: number;
  stations: SharedPowerStationUsage[];
}

export interface SharedPowerSourceLedger {
  powerSourceId: string;
  powerSourceName: string;
  availableCapacityKw: number;
  /** Peak over complete reservations, including charging after the accounting cutoff. */
  peakPowerKw: number;
  /** Purchased energy in [0, horizonMinute), excluding pending and post-cutoff energy. */
  gridEnergyKwh: number;
  intervals: SharedPowerInterval[];
}

export interface SharedPowerResult {
  horizonMinute: number;
  sources: SharedPowerSourceLedger[];
}

export function powerFits(powerKw: number, limitKw: number): boolean {
  return (
    Number.isFinite(powerKw) &&
    (powerKw <= limitKw || powerKw - limitKw <= limitKw * (4 * Number.EPSILON))
  );
}

type Reservation = { startMinute: number; endMinute: number };
interface ChargingCalendar {
  conflictEnd(start: number, end: number): number | null;
  book(startMinute: number, endMinute: number): void;
}

/** Immutable reservations may arrive out of release order across stations. Search all gaps. */
export function createSharedPowerCalendar(capacityKw: number, gridPowerKw: number) {
  const upper = Math.ceil(capacityKw / gridPowerKw);
  const capacity = powerFits(upper * gridPowerKw, capacityKw) ? upper : upper - 1;
  const reservations: Reservation[] = [];

  function conflictEnd(start: number, end: number): number | null {
    const overlapping = reservations.filter((r) => r.startMinute < end && r.endMinute > start);
    const boundaries = [start, ...overlapping.map((r) => r.startMinute).filter((m) => m > start)];
    boundaries.sort((a, b) => a - b);
    for (const minute of boundaries) {
      const active = overlapping.filter((r) => r.startMinute <= minute && r.endMinute > minute);
      if (active.length >= capacity) return Math.min(...active.map((r) => r.endMinute));
    }
    return null;
  }

  function book(startMinute: number, endMinute: number) {
    reservations.push({ startMinute, endMinute });
  }

  return {
    conflictEnd,
    book,
    reserve(
      windows: OperatingShift[],
      ready: number,
      duration: number,
      horizon: number,
      local?: ChargingCalendar,
    ) {
      let sharedWait = capacity < 1;
      let localWait = false;
      if (sharedWait) return { startMinute: null, sharedWait, localWait, windowWait: false };
      for (const window of windows) {
        let start = Math.max(ready, window.startMinute);
        while (start + duration <= window.endMinute + 1e-7) {
          const end = start + duration;
          const conflict = conflictEnd(start, end);
          const localConflict = local?.conflictEnd(start, end) ?? null;
          if (conflict === null && localConflict === null) {
            if (start < horizon) {
              book(start, end);
              local?.book(start, end);
            }
            return {
              startMinute: start,
              sharedWait,
              localWait,
              windowWait: window.startMinute > ready,
            };
          }
          if (conflict !== null) sharedWait = true;
          if (localConflict !== null) localWait = true;
          start = Math.max(conflict ?? start, localConflict ?? start);
        }
      }
      return { startMinute: null, sharedWait, localWait, windowWait: true };
    },
  };
}

type Session = Reservation & { stationId: string; gridPowerKw: number };

function sourceSessions(turnover: StationTurnoverResult, sourceId: string): Session[] {
  return turnover.stations
    .filter((s) => s.powerSourceId === sourceId)
    .flatMap((station) =>
      station.charges.flatMap((charge) => {
        const { startMinute, endMinute, gridPowerKw } = charge;
        return startMinute === null || endMinute === null || endMinute <= startMinute
          ? []
          : [{ stationId: station.stationId, startMinute, endMinute, gridPowerKw }];
      }),
    );
}

function usedSources(snapshot: DailyTransportSnapshot) {
  const network = snapshot.context.stationNetwork!;
  const ids = new Set(
    network.fixedLayout.map(
      ({ siteId }) => network.sites.find((s) => s.id === siteId)!.connection!.powerSourceId,
    ),
  );
  return network.powerSources.filter((s) => ids.has(s.id));
}

export function buildSharedPowerLedger(
  snapshot: DailyTransportSnapshot,
  turnover: StationTurnoverResult,
): SharedPowerResult {
  const horizon = turnover.horizonMinute;
  return {
    horizonMinute: horizon,
    sources: usedSources(snapshot).map((source) => {
      const sessions = sourceSessions(turnover, source.id);
      // Full reservations determine peak; accounting is clipped separately below.
      const changes = sessions
        .flatMap((s) => [
          { minute: s.startMinute, change: s.gridPowerKw },
          { minute: s.endMinute, change: -s.gridPowerKw },
        ])
        .sort((a, b) => a.minute - b.minute || a.change - b.change);
      let power = 0;
      let peakPowerKw = 0;
      for (const { change } of changes) {
        power += change;
        peakPowerKw = Math.max(peakPowerKw, power);
      }
      const cuts = new Set([0, horizon]);
      for (let midnight = 1440; midnight < horizon; midnight += 1440) cuts.add(midnight);
      for (const session of sessions) {
        if (session.startMinute > 0 && session.startMinute < horizon) cuts.add(session.startMinute);
        if (session.endMinute > 0 && session.endMinute < horizon) cuts.add(session.endMinute);
      }
      const boundaries = [...cuts].sort((a, b) => a - b);
      const intervals = boundaries.slice(0, -1).map((startMinute, index) => {
        const endMinute = boundaries[index + 1];
        const byStation = new Map<string, number>();
        for (const s of sessions)
          if (s.startMinute <= startMinute && s.endMinute > startMinute)
            byStation.set(s.stationId, (byStation.get(s.stationId) ?? 0) + s.gridPowerKw);
        const stations = [...byStation].map(([stationId, gridPowerKw]) => ({
          stationId,
          gridPowerKw,
          gridEnergyKwh: gridPowerKw * ((endMinute - startMinute) / 60),
        }));
        const gridPowerKw = stations.reduce((sum, s) => sum + s.gridPowerKw, 0);
        return {
          startMinute,
          endMinute,
          gridPowerKw,
          gridEnergyKwh: gridPowerKw * ((endMinute - startMinute) / 60),
          stations,
        };
      });
      return {
        powerSourceId: source.id,
        powerSourceName: source.point.name,
        availableCapacityKw: source.point.availableCapacityKw!,
        peakPowerKw,
        gridEnergyKwh: intervals.reduce((sum, i) => sum + i.gridEnergyKwh, 0),
        intervals,
      };
    }),
  };
}

function close(actual: number, expected: number) {
  return (
    Number.isFinite(actual) &&
    Math.abs(actual - expected) <= 1e-7 + 32 * Number.EPSILON * Math.abs(expected)
  );
}

/** Independent replay: capacity at each session boundary, and energy by clipped session overlap. */
export function validateSharedPower(
  snapshot: DailyTransportSnapshot,
  turnover: StationTurnoverResult,
  result: SharedPowerResult,
): DailyTransportValidation {
  const issues: string[] = [];
  const sources = usedSources(snapshot);
  if (
    result.horizonMinute !== turnover.horizonMinute ||
    result.sources.length !== sources.length ||
    new Set(result.sources.map((s) => s.powerSourceId)).size !== sources.length
  )
    return { valid: false, issues: ['共享电源身份或购电统计范围不一致'] };
  for (const source of sources) {
    const ledger = result.sources.find((s) => s.powerSourceId === source.id);
    const prefix = `电源“${source.point.name}”`;
    if (
      !ledger ||
      ledger.powerSourceName !== source.point.name ||
      ledger.availableCapacityKw !== source.point.availableCapacityKw
    ) {
      issues.push(`${prefix}容量依据与任务快照不一致`);
      continue;
    }
    const sessions = sourceSessions(turnover, source.id);
    let peak = 0;
    for (const session of sessions) {
      const power = sessions
        .filter((s) => s.startMinute <= session.startMinute && s.endMinute > session.startMinute)
        .reduce((sum, s) => sum + s.gridPowerKw, 0);
      peak = Math.max(peak, power);
      if (!powerFits(power, ledger.availableCapacityKw))
        issues.push(`${prefix}瞬时充电功率超过可用容量`);
    }
    const horizon = result.horizonMinute;
    const purchased = sessions.reduce(
      (sum, s) =>
        sum +
        s.gridPowerKw *
          (Math.max(0, Math.min(horizon, s.endMinute) - Math.max(0, s.startMinute)) / 60),
      0,
    );
    if (!close(ledger.peakPowerKw, peak) || !close(ledger.gridEnergyKwh, purchased))
      issues.push(`${prefix}峰值或截止前购电量不一致`);
    let previousEnd = 0;
    let intervalEnergy = 0;
    for (const interval of ledger.intervals) {
      const { startMinute: start, endMinute: end } = interval;
      if (start !== previousEnd || !Number.isFinite(end) || end <= start || end > horizon) {
        issues.push(`${prefix}分时账目有缺口、重复或无效区间`);
        break;
      }
      // A constant-power row may not hide a start/end inside it, even if its mean would fit.
      if (
        sessions.some(
          (s) =>
            (s.startMinute > start && s.startMinute < end) ||
            (s.endMinute > start && s.endMinute < end),
        )
      )
        issues.push(`${prefix}分时账目跨越充电功率变化`);
      const active = sessions.filter((s) => s.startMinute <= start && s.endMinute > start);
      const stationIds = new Set(active.map((s) => s.stationId));
      if (
        interval.stations.length !== stationIds.size ||
        new Set(interval.stations.map((s) => s.stationId)).size !== stationIds.size
      )
        issues.push(`${prefix}站点购电账目身份不一致`);
      let power = 0;
      for (const id of stationIds) {
        const usage = interval.stations.find((s) => s.stationId === id);
        const stationPower = active
          .filter((s) => s.stationId === id)
          .reduce((sum, s) => sum + s.gridPowerKw, 0);
        power += stationPower;
        if (
          !usage ||
          !close(usage.gridPowerKw, stationPower) ||
          !close(usage.gridEnergyKwh, stationPower * ((end - start) / 60))
        )
          issues.push(`${prefix}站点功率或购电量不一致`);
      }
      if (
        !close(interval.gridPowerKw, power) ||
        !close(interval.gridEnergyKwh, power * ((end - start) / 60))
      )
        issues.push(`${prefix}分时功率或购电量不一致`);
      previousEnd = end;
      intervalEnergy += interval.gridEnergyKwh;
    }
    if (previousEnd !== horizon || !close(intervalEnergy, purchased))
      issues.push(`${prefix}分时账目未覆盖完整统计范围`);
  }
  return { valid: issues.length === 0, issues };
}
