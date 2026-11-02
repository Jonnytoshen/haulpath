import { randomUUID } from 'node:crypto';
import {
  cycleHasAdjacentOverlap,
  cycleIsClosed,
  type TransportCycle,
  type TransportCyclePosition,
} from '@haulpath/domain';
import { HttpError } from './http';
import { scenarioFields } from './scenario-validation';
import { pointOf } from './validation';

export function cyclePositions(input: unknown, cycle: TransportCycle): TransportCyclePosition[] {
  if (!Array.isArray(input)) throw new HttpError(400, '循环点位列表必须为数组');
  const seen = new Set<string>();
  return input.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new HttpError(400, '循环点位无效');
    const value = item as Record<string, unknown>;
    scenarioFields(value, ['id', 'point']);
    const existing =
      value.id === undefined
        ? undefined
        : cycle.positions.find((position) => position.id === value.id);
    if (value.id !== undefined && !existing) throw new HttpError(400, '循环点位位置标识无效');
    const id = existing?.id ?? randomUUID();
    if (seen.has(id)) throw new HttpError(400, '循环点位位置标识不能重复');
    seen.add(id);
    return { id, point: pointOf(value.point), sourcePointId: existing?.sourcePointId ?? null };
  });
}

export function confirmCycle(cycle: TransportCycle): void {
  if (!cycleIsClosed(cycle)) throw new HttpError(400, '请补齐闭合回程后再确认业务顺序');
  if (cycleHasAdjacentOverlap(cycle)) throw new HttpError(400, '相邻点位坐标重合，请调整后确认');
}
