import { randomUUID } from 'node:crypto';
import type { Point } from '@/lib/domain';
import { HttpError } from './http';
import { pointOf } from './validation';
import { amapJson, coordinateText, parsePosition } from './amap';

// This boundary accepts raw coordinates; callers pass already-normalized Point objects directly to storage.
export async function normalizeCoordinates(input: unknown): Promise<Point[]> {
  if (!Array.isArray(input)) throw new HttpError(400, '点位列表必须为数组');
  const points = input.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new HttpError(400, '点位无效');
    const value = item as Record<string, unknown>;
    return pointOf({
      ...value, id: randomUUID(), coordinateSystem: value.coordinateSystem ?? 'GCJ-02',
      originalLongitude: value.longitude, originalLatitude: value.latitude,
    });
  });
  const pending = points.filter((point) => point.coordinateSystem === 'WGS84');
  for (let offset = 0; offset < pending.length; offset += 40) {
    const batch = pending.slice(offset, offset + 40);
    const result = await amapJson('/v3/assistant/coordinate/convert', {
      coordsys: 'gps', locations: batch.map((point) => coordinateText(point.originalLongitude, point.originalLatitude)).join('|'),
    });
    const converted = typeof result.locations === 'string' ? result.locations.split(';') : [];
    if (converted.length !== batch.length) throw new HttpError(502, '高德坐标转换数量不匹配，请重试');
    const positions = converted.map(parsePosition);
    batch.forEach((point, index) => { [point.longitude, point.latitude] = positions[index]; });
  }
  return points;
}
