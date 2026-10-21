import type { Point, Strategy } from '@/lib/domain';
import { HttpError } from './http';

export function nameOf(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) throw new HttpError(400, '名称不能为空');
  return input.trim();
}

export function strategyOf(input: unknown): Strategy {
  if (input !== 32 && input !== 34 && input !== 36) throw new HttpError(400, '规划偏好无效');
  return input;
}

export function pointOf(input: unknown): Point {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '点位无效');
  const value = input as Record<string, unknown>;
  const id = typeof value.id === 'string' && value.id.trim() ? value.id : undefined;
  if (!id) throw new HttpError(400, '点位缺少标识');
  for (const [key, limit] of [['longitude', 180], ['latitude', 90], ['originalLongitude', 180], ['originalLatitude', 90]] as const) {
    const coordinate = value[key];
    if (typeof coordinate !== 'number' || !Number.isFinite(coordinate) || Math.abs(coordinate) > limit) throw new HttpError(400, '点位经纬度必须为范围内的数值');
  }
  if (value.coordinateSystem !== 'GCJ-02' && value.coordinateSystem !== 'WGS84') throw new HttpError(400, '点位坐标系无效');
  if (!['manual', 'map', 'search', 'import', 'library'].includes(value.source as string)) throw new HttpError(400, '点位来源无效');
  if (value.poiId !== undefined && typeof value.poiId !== 'string') throw new HttpError(400, '地点标识无效');
  return {
    id, name: nameOf(value.name), longitude: value.longitude as number, latitude: value.latitude as number,
    originalLongitude: value.originalLongitude as number, originalLatitude: value.originalLatitude as number,
    coordinateSystem: value.coordinateSystem, source: value.source as Point['source'],
    ...(value.poiId === undefined ? {} : { poiId: value.poiId as string }),
  };
}

export function pointsOf(input: unknown): Point[] {
  if (!Array.isArray(input)) throw new HttpError(400, '点位列表必须为数组');
  return input.map(pointOf);
}
