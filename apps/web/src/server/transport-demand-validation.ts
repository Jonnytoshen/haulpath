import { randomUUID } from 'node:crypto';
import {
  transportDemandIssue,
  type PlanningScenario,
  type TransportDemand,
} from '@haulpath/domain';
import { HttpError } from './http';
import { scenarioFields } from './scenario-validation';

export function transportDemandsOf(input: unknown, scenario: PlanningScenario): TransportDemand[] {
  if (!Array.isArray(input)) throw new HttpError(400, '运输需求列表必须为数组');
  const existing = new Set((scenario.context.transportDemands ?? []).map((demand) => demand.id));
  const seen = new Set<string>();
  let total = 0;
  return input.map((item: unknown, index) => {
    try {
      if (!item || typeof item !== 'object' || Array.isArray(item))
        throw new HttpError(400, '运输需求必须为对象');
      const value = item as Record<string, unknown>;
      scenarioFields(value, [
        'id',
        'cycleId',
        'loadingPositionId',
        'unloadingPositionId',
        'dailyTonnes',
      ]);
      if (value.id !== undefined && (typeof value.id !== 'string' || !existing.has(value.id)))
        throw new HttpError(400, '运输需求标识不属于当前规划方案');
      const id = value.id === undefined ? randomUUID() : (value.id as string);
      if (seen.has(id)) throw new HttpError(400, '运输需求标识不能重复');
      seen.add(id);
      if (
        typeof value.cycleId !== 'string' ||
        !value.cycleId ||
        typeof value.loadingPositionId !== 'string' ||
        !value.loadingPositionId ||
        typeof value.unloadingPositionId !== 'string' ||
        !value.unloadingPositionId
      )
        throw new HttpError(400, '请选择所属循环、装货位置和卸货位置');
      if (
        typeof value.dailyTonnes !== 'number' ||
        !Number.isFinite(value.dailyTonnes) ||
        value.dailyTonnes <= 0
      )
        throw new HttpError(400, '每日目标吨数必须为有限正数');
      const demand: TransportDemand = {
        id,
        cycleId: value.cycleId,
        loadingPositionId: value.loadingPositionId,
        unloadingPositionId: value.unloadingPositionId,
        dailyTonnes: value.dailyTonnes,
      };
      const issue = transportDemandIssue(demand, scenario.context.transportCycles ?? []);
      if (issue) throw new HttpError(400, issue);
      total += demand.dailyTonnes;
      if (!Number.isFinite(total)) throw new HttpError(400, '每日目标吨数合计超出可表示范围');
      return demand;
    } catch (error) {
      if (error instanceof HttpError)
        throw new HttpError(error.status, `第 ${index + 1} 行：${error.message}`);
      throw error;
    }
  });
}
