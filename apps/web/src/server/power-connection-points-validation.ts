import { randomUUID } from 'node:crypto';
import type { Point, PowerConnectionPoint, PowerConnectionPointSet } from '@haulpath/domain';
import { normalizeCoordinates } from './coordinates';
import { HttpError } from './http';
import { pointOf } from './validation';

export function powerResourceRevision(input: unknown): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1)
    throw new HttpError(400, '电源接入点修订号无效');
  return input;
}

function textOf(input: unknown, label: string): string {
  if (input === undefined) return '';
  if (typeof input !== 'string' || input.length > 5000)
    throw new HttpError(400, `${label}须为不超过 5000 字的文本`);
  return input.trim();
}

/** Validate every row and ownership before making any external coordinate requests. */
export async function powerConnectionPointsOf(
  input: unknown,
  current: PowerConnectionPointSet,
): Promise<PowerConnectionPoint[]> {
  if (!Array.isArray(input) || input.length > 1000)
    throw new HttpError(400, '电源接入点须为不超过 1000 项的列表');
  const ids = new Set<string>();
  const rows = input.map((item, index) => {
    const prefix = `第 ${index + 1} 行：`;
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new HttpError(400, `${prefix}电源接入点无效`);
    const value = item as Record<string, unknown>;
    if (
      Object.keys(value).some(
        (key) =>
          ![
            'id',
            'name',
            'longitude',
            'latitude',
            'coordinateSystem',
            'source',
            'availableCapacityKw',
            'capacitySource',
            'connectionNotes',
          ].includes(key),
      )
    )
      throw new HttpError(400, `${prefix}电源接入点包含不支持或受保护的字段`);
    const existing =
      value.id === undefined ? undefined : current.points.find((point) => point.id === value.id);
    if (value.id !== undefined && !existing)
      throw new HttpError(404, `${prefix}该项目下的电源接入点不存在`);
    if (existing && ids.has(existing.id)) throw new HttpError(400, `${prefix}电源接入点标识重复`);
    const id = existing?.id ?? randomUUID();
    ids.add(id);
    let point: Point;
    try {
      point = pointOf({
        ...value,
        id,
        coordinateSystem: value.coordinateSystem ?? 'GCJ-02',
        source: value.source ?? existing?.source ?? 'manual',
        originalLongitude: value.longitude,
        originalLatitude: value.latitude,
      });
    } catch (error) {
      if (error instanceof HttpError) throw new HttpError(error.status, prefix + error.message);
      throw error;
    }
    const capacity = value.availableCapacityKw ?? null;
    if (
      capacity !== null &&
      (typeof capacity !== 'number' || !Number.isFinite(capacity) || capacity < 0)
    )
      throw new HttpError(400, `${prefix}可用容量须为非负有限数值，缺失时留空`);
    const unchangedCoordinates =
      existing &&
      point.coordinateSystem === existing.coordinateSystem &&
      point.originalLongitude === existing.originalLongitude &&
      point.originalLatitude === existing.originalLatitude;
    return {
      point: {
        ...point,
        ...(unchangedCoordinates
          ? { longitude: existing.longitude, latitude: existing.latitude }
          : {}),
      },
      needsNormalization: !unchangedCoordinates,
      availableCapacityKw: capacity as number | null,
      capacitySource: textOf(value.capacitySource, `${prefix}容量来源`),
      connectionNotes: textOf(value.connectionNotes, `${prefix}接入说明`),
    };
  });
  const pending = rows.filter((row) => row.needsNormalization);
  const normalized = await normalizeCoordinates(pending.map((row) => row.point));
  pending.forEach((row, index) => {
    row.point = { ...normalized[index], id: row.point.id };
  });
  return rows.map(({ point, availableCapacityKw, capacitySource, connectionNotes }) => ({
    ...point,
    projectId: current.projectId,
    availableCapacityKw,
    capacitySource,
    connectionNotes,
  }));
}
