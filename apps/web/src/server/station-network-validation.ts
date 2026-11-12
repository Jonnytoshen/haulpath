import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  candidateSiteReadiness,
  sitingBudgetPriceReadiness,
  sitingConstraintReadiness,
  type SitingConstraints,
  emptyStationNetwork,
  stationTypeReadiness,
  type CandidateSite,
  type OperatingShift,
  type PlanningScenario,
  type PowerConnectionPointSet,
  type ScenarioPowerSource,
  type StationConnection,
  type StationNetwork,
  type StationType,
} from '@haulpath/domain';
import { HttpError } from './http';
import { normalizeCoordinates } from './coordinates';
import { powerConnectionPointsOf } from './power-connection-points-validation';
import { scenarioFields } from './scenario-validation';
import { nameOf, pointOf } from './validation';

function objectOf(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new HttpError(400, `${label}须为对象`);
  return input as Record<string, unknown>;
}
function listOf(input: unknown, label: string): unknown[] {
  if (!Array.isArray(input) || input.length > 1000)
    throw new HttpError(400, `${label}须为不超过1000项的列表`);
  return input;
}
function textOf(input: unknown, label: string): string {
  if (typeof input !== 'string' || input.length > 5000)
    throw new HttpError(400, `${label}须为不超过5000字的文本`);
  return input.trim();
}
function flagOf(input: unknown, optional = false): boolean {
  if (optional && input === undefined) return false;
  if (typeof input !== 'boolean') throw new HttpError(400, '确认或刷新标记须为布尔值');
  return input;
}
function numberOf(
  input: unknown,
  label: string,
  integer = false,
  allowZero = false,
): number | null {
  if (input === null) return null;
  if (
    typeof input !== 'number' ||
    !Number.isFinite(input) ||
    (allowZero ? input < 0 : input <= 0) ||
    (integer && !Number.isSafeInteger(input))
  )
    throw new HttpError(
      400,
      `${label}须为有效${allowZero ? '非负' : '正'}${integer ? '整数' : '数值'}，缺失时使用null`,
    );
  return input;
}
function windowsOf(input: unknown): OperatingShift[] {
  const intervals: [number, number][] = [];
  const windows = listOf(input, '作业窗口').map((item) => {
    const value = objectOf(item, '作业窗口');
    scenarioFields(value, ['startMinute', 'endMinute']);
    const start = value.startMinute;
    const end = value.endMinute;
    if (
      typeof start !== 'number' ||
      !Number.isInteger(start) ||
      start < 0 ||
      start >= 1440 ||
      typeof end !== 'number' ||
      !Number.isInteger(end) ||
      end <= start ||
      end > start + 1440
    )
      throw new HttpError(400, '窗口须从当日分钟开始，时长大于零且不超过24小时');
    intervals.push([start, Math.min(end, 1440)]);
    if (end > 1440) intervals.push([0, end - 1440]);
    return { startMinute: start, endMinute: end };
  });
  intervals.sort((a, b) => a[0] - b[0]);
  if (intervals.some((interval, index) => index > 0 && interval[0] < intervals[index - 1][1]))
    throw new HttpError(400, '作业窗口不能重叠（含跨午夜的周期重叠）');
  return windows;
}
function identity<T extends { id: string }>(
  value: Record<string, unknown>,
  existing: T[],
  seen: Set<string>,
  label: string,
): T | undefined {
  const previous = existing.find((item) => item.id === value.id);
  if (value.id !== undefined && !previous)
    throw new HttpError(400, `${label}标识不属于当前规划方案`);
  if (previous && seen.has(previous.id)) throw new HttpError(400, `${label}标识重复`);
  if (previous) seen.add(previous.id);
  return previous;
}
function stationTypeOf(input: unknown, scenario: PlanningScenario, seen: Set<string>): StationType {
  const value = objectOf(input, '站型');
  scenarioFields(value, [
    'id',
    'name',
    'bays',
    'swapMinutes',
    'batteryInventory',
    'chargingSlots',
    'chargePowerKw',
    'serviceWindows',
    'chargeWindows',
    'investment',
    'annualOperatingCost',
    'source',
    'refreshBattery',
  ]);
  const previous = identity(
    value,
    scenario.context.stationNetwork?.stationTypes ?? [],
    seen,
    '站型',
  );
  const refresh = flagOf(value.refreshBattery, true);
  return {
    id: previous?.id ?? randomUUID(),
    name: nameOf(value.name),
    bays: numberOf(value.bays, '换电工位', true),
    swapMinutes: numberOf(value.swapMinutes, '换电时间'),
    batteryInventory: numberOf(value.batteryInventory, '电池库存', true, true),
    chargingSlots: numberOf(value.chargingSlots, '充电位', true, true),
    chargePowerKw: numberOf(value.chargePowerKw, '站内总充电功率上限'),
    serviceWindows: windowsOf(value.serviceWindows),
    chargeWindows: windowsOf(value.chargeWindows),
    investment: numberOf(value.investment, '建站投资', false, true),
    annualOperatingCost: numberOf(value.annualOperatingCost, '年度运维费用', false, true),
    source: textOf(value.source, '站型来源'),
    batteryBasis:
      !previous || refresh ? (scenario.context.operations?.battery ?? null) : previous.batteryBasis,
  };
}
async function powerSourceOf(
  input: unknown,
  current: StationNetwork,
  powers: PowerConnectionPointSet,
  seen: Set<string>,
): Promise<ScenarioPowerSource> {
  const value = objectOf(input, '方案电源');
  scenarioFields(value, ['id', 'sourcePointId', 'refreshSource', 'point']);
  const previous = identity(value, current.powerSources, seen, '方案电源');
  if (
    typeof value.sourcePointId !== 'string' ||
    !value.sourcePointId.trim() ||
    (previous && previous.sourcePointId !== value.sourcePointId)
  )
    throw new HttpError(400, '方案电源来源标识无效或已改变');
  const refresh = flagOf(value.refreshSource, true);
  if (refresh && value.point !== undefined)
    throw new HttpError(400, '引入项目电源更新与方案内编辑不能同时执行');
  if (!previous || refresh) {
    if (!previous && value.point !== undefined)
      throw new HttpError(400, '首次引入电源须使用项目源资料');
    const point = powers.points.find((item) => item.id === value.sourcePointId);
    if (!point) throw new HttpError(404, '该项目下的电源接入点不存在，无法显式引入');
    return {
      id: previous?.id ?? randomUUID(),
      sourcePointId: point.id,
      sourceRevision: powers.revision,
      point,
    };
  }
  if (value.point === undefined) return previous;
  const pointInput = objectOf(value.point, '方案电源快照');
  if (pointInput.id !== undefined) throw new HttpError(400, '方案电源点位标识由服务端维护');
  const points = await powerConnectionPointsOf([{ ...pointInput, id: previous.point.id }], {
    projectId: powers.projectId,
    revision: previous.sourceRevision,
    points: [previous.point],
  });
  return { ...previous, point: points[0] };
}
function connectionOf(input: unknown): StationConnection | null {
  if (input === null) return null;
  const value = objectOf(input, '接电关系');
  scenarioFields(value, [
    'powerSourceId',
    'availablePowerKw',
    'connectionInvestment',
    'notes',
    'confirmed',
  ]);
  if (typeof value.powerSourceId !== 'string' || !value.powerSourceId.trim())
    throw new HttpError(400, '接电电源标识无效');
  return {
    powerSourceId: value.powerSourceId,
    availablePowerKw: numberOf(value.availablePowerKw, '站址可用功率', false, true),
    connectionInvestment: numberOf(value.connectionInvestment, '接电投资', false, true),
    notes: textOf(value.notes, '接电依据'),
    confirmed: flagOf(value.confirmed),
  };
}
function sameConnection(a: StationConnection | null, b: StationConnection | null): boolean {
  return isDeepStrictEqual(a && { ...a, confirmed: false }, b && { ...b, confirmed: false });
}
function rowError<T>(label: string, index: number, action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof HttpError)
      throw new HttpError(error.status, `${label}第 ${index + 1} 行：${error.message}`);
    throw error;
  }
}

/** All incoming coordinates are declared originals. Normalize outside the SQLite write transaction. */
export async function stationNetworkOf(
  input: unknown,
  scenario: PlanningScenario,
  powers: PowerConnectionPointSet,
): Promise<StationNetwork> {
  const value = objectOf(input, '站网');
  scenarioFields(value, ['stationTypes', 'sites', 'powerSources', 'fixedLayout', 'constraints']);
  const current = scenario.context.stationNetwork ?? emptyStationNetwork();
  const typesSeen = new Set<string>();
  const stationTypes = listOf(value.stationTypes, '站型').map((item, index) =>
    rowError('站型', index, () => stationTypeOf(item, scenario, typesSeen)),
  );
  const powerSeen = new Set<string>();
  const sourcePointIds = new Set<string>();
  const powerSources: ScenarioPowerSource[] = [];
  for (const [index, item] of listOf(value.powerSources, '方案电源').entries()) {
    try {
      const source = await powerSourceOf(item, current, powers, powerSeen);
      if (sourcePointIds.has(source.sourcePointId))
        throw new HttpError(400, '同一项目电源接入点在方案中只能引入一次');
      sourcePointIds.add(source.sourcePointId);
      powerSources.push(source);
    } catch (error) {
      if (error instanceof HttpError)
        throw new HttpError(error.status, `方案电源第 ${index + 1} 行：${error.message}`);
      throw error;
    }
  }
  const sitesSeen = new Set<string>();
  const pending: CandidateSite[] = [];
  const sites = listOf(value.sites, '候选站址').map((item, index) =>
    rowError('候选站址', index, () => {
      const row = objectOf(item, '候选站址');
      scenarioFields(row, [
        'id',
        'name',
        'longitude',
        'latitude',
        'coordinateSystem',
        'source',
        'siteNotes',
        'siteConfirmed',
        'connection',
        'generationBasis',
      ]);
      const previous = identity(row, current.sites, sitesSeen, '候选站址');
      if (
        row.generationBasis !== undefined &&
        !isDeepStrictEqual(row.generationBasis, previous?.generationBasis)
      )
        throw new HttpError(400, '候选生成依据由服务端维护，不可改写');
      if (row.source === 'generated' && !previous?.generationBasis)
        throw new HttpError(400, '系统候选须通过生成入口创建');
      const id = previous?.id ?? randomUUID();
      const point = pointOf({
        ...row,
        id,
        originalLongitude: row.longitude,
        originalLatitude: row.latitude,
        source: row.source ?? previous?.source ?? 'manual',
      });
      const unchangedCoordinates =
        !!previous &&
        point.coordinateSystem === previous.coordinateSystem &&
        point.originalLongitude === previous.originalLongitude &&
        point.originalLatitude === previous.originalLatitude;
      const siteNotes = textOf(row.siteNotes, '场地确认依据');
      const changedSite = !previous || !unchangedCoordinates || siteNotes !== previous.siteNotes;
      const requestedSiteConfirmation = flagOf(row.siteConfirmed);
      const siteConfirmed = !changedSite && requestedSiteConfirmation;
      if (siteConfirmed && !siteNotes) throw new HttpError(400, '确认场地须填写场地条件依据');
      const connection = connectionOf(row.connection);
      if (connection) {
        const power = powerSources.find((source) => source.id === connection.powerSourceId);
        const previousPower = current.powerSources.find(
          (source) => source.id === connection.powerSourceId,
        );
        const unchangedAssociation =
          previous?.connection?.powerSourceId === connection.powerSourceId;
        if (!power && !unchangedAssociation)
          throw new HttpError(400, '接电关系的电源不属于当前规划方案');
        const changedPower = !isDeepStrictEqual(power?.point, previousPower?.point);
        if (
          changedSite ||
          !sameConnection(connection, previous?.connection ?? null) ||
          changedPower ||
          !power
        )
          connection.confirmed = false;
        if (connection.confirmed) {
          const gaps = candidateSiteReadiness(
            { ...point, siteNotes, siteConfirmed: true, connection },
            { stationTypes, powerSources, sites: [], fixedLayout: [] },
          );
          if (gaps.length) throw new HttpError(400, `接电条件尚未齐备：${gaps.join('；')}`);
        }
      }
      const site: CandidateSite = {
        ...point,
        ...(unchangedCoordinates
          ? { longitude: previous.longitude, latitude: previous.latitude }
          : {}),
        siteNotes,
        siteConfirmed,
        connection,
        ...(previous?.generationBasis ? { generationBasis: previous.generationBasis } : {}),
      };
      if (!unchangedCoordinates) pending.push(site);
      return site;
    }),
  );
  const network: StationNetwork = { stationTypes, powerSources, sites, fixedLayout: [] };
  const selectedSites = new Set<string>();
  network.fixedLayout = listOf(value.fixedLayout, '固定布局').map((item, index) =>
    rowError('固定布局', index, () => {
      const row = objectOf(item, '固定布局');
      scenarioFields(row, ['siteId', 'stationTypeId']);
      if (typeof row.siteId !== 'string' || typeof row.stationTypeId !== 'string')
        throw new HttpError(400, '站址与站型标识无效');
      if (selectedSites.has(row.siteId)) throw new HttpError(400, '固定布局内同一站址只能出现一次');
      selectedSites.add(row.siteId);
      const previous = current.fixedLayout.some(
        (selection) =>
          selection.siteId === row.siteId && selection.stationTypeId === row.stationTypeId,
      );
      const site = sites.find((candidate) => candidate.id === row.siteId);
      const type = stationTypes.find((candidate) => candidate.id === row.stationTypeId);
      if (!previous) {
        if (!site || !type) throw new HttpError(400, '固定布局引用的站址或站型不属于当前规划方案');
        const gaps = [
          ...candidateSiteReadiness(site, network),
          ...stationTypeReadiness(type, scenario.context.operations?.battery ?? null),
        ];
        if (gaps.length) throw new HttpError(400, `固定布局资料未就绪：${gaps.join('；')}`);
      }
      return { siteId: row.siteId, stationTypeId: row.stationTypeId };
    }),
  );
  const constraints = constraintsOf(value.constraints, current, sites);
  if (constraints) network.constraints = constraints;
  const updatedContext = { ...scenario.context, stationNetwork: network };
  const prices = sitingBudgetPriceReadiness(updatedContext);
  if (prices.length) throw new HttpError(400, prices.join('；'));
  // Editing inputs/constraints may invalidate a retained layout. Adding/changing a selection is adoption.
  const adopts = network.fixedLayout.some(
    (selection) =>
      !current.fixedLayout.some(
        (previous) =>
          previous.siteId === selection.siteId &&
          previous.stationTypeId === selection.stationTypeId,
      ),
  );
  const conflicts = sitingConstraintReadiness(updatedContext);
  if (adopts && conflicts.length)
    throw new HttpError(400, `固定布局违反选址硬约束：${conflicts.join('；')}`);
  const normalized = await normalizeCoordinates(pending);
  pending.forEach((site, index) => {
    site.longitude = normalized[index].longitude;
    site.latitude = normalized[index].latitude;
  });
  return network;
}

function constraintsOf(
  input: unknown,
  current: StationNetwork,
  sites: CandidateSite[],
): SitingConstraints | undefined {
  if (input === undefined) return current.constraints;
  const value = objectOf(input, '选址硬约束');
  scenarioFields(value, ['maxInvestment', 'maxStations', 'requiredSiteIds', 'excludedSiteIds']);
  function ids(field: 'requiredSiteIds' | 'excludedSiteIds'): string[] {
    const seen = new Set<string>();
    const rows = listOf(value[field], '站址约束');
    for (const id of rows) {
      if (typeof id !== 'string' || !id.trim() || seen.has(id))
        throw new HttpError(400, '站址约束标识无效或重复');
      if (!sites.some((site) => site.id === id) && !current.constraints?.[field].includes(id))
        throw new HttpError(400, '站址约束标识不属于当前规划方案');
      seen.add(id);
    }
    return [...seen].sort();
  }
  const constraints: SitingConstraints = {
    maxInvestment: numberOf(value.maxInvestment, '总新增投资上限', false, true),
    maxStations: numberOf(value.maxStations, '新建站数上限', true, true),
    requiredSiteIds: ids('requiredSiteIds'),
    excludedSiteIds: ids('excludedSiteIds'),
  };
  if (constraints.requiredSiteIds.some((id) => constraints.excludedSiteIds.includes(id)))
    throw new HttpError(400, '同一站址不能同时必选与禁选');
  if (
    constraints.maxInvestment === null &&
    constraints.maxStations === null &&
    !constraints.requiredSiteIds.length &&
    !constraints.excludedSiteIds.length
  )
    return undefined;
  return constraints;
}
