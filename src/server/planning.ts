import type { Leg, Point, Route, Strategy } from '@/lib/domain';
import { amapJson, coordinateText, parsePosition } from './amap';
import { HttpError } from './http';
import { storage } from './storage';

type PlanningSlots = { active: number; waiting: (() => void)[] };
const planningGlobal = globalThis as typeof globalThis & { haulpathPlanningSlots?: PlanningSlots };
async function withPlanningSlot<T>(operation: () => Promise<T>): Promise<T> {
  const slots = planningGlobal.haulpathPlanningSlots ??= { active: 0, waiting: [] };
  if (slots.active >= 2) await new Promise<void>((resolve) => { slots.waiting.push(resolve); });
  else slots.active++;
  try { return await operation(); }
  finally {
    const next = slots.waiting.shift();
    if (next) next();
    else slots.active--;
  }
}

async function planLeg(from: Point, to: Point, index: number, strategy: Strategy): Promise<Leg> {
  const data = await amapJson('/v5/direction/driving', {
    origin: coordinateText(from.longitude, from.latitude), destination: coordinateText(to.longitude, to.latitude),
    strategy: String(strategy), show_fields: 'polyline',
  });
  const route = data.route as { paths?: { distance?: unknown; steps?: { polyline?: unknown }[] }[] } | undefined;
  const path = route?.paths?.[0];
  if (!path) throw new HttpError(502, '高德没有返回可用路线，请检查点位后重试');
  const distance = typeof path.distance === 'string' && /^\d+$/.test(path.distance) ? Number(path.distance) : path.distance;
  if (typeof distance !== 'number' || !Number.isSafeInteger(distance) || distance < 0) throw new HttpError(502, '高德返回的区间距离无效，请重试');
  if (!Array.isArray(path.steps) || !path.steps.length) throw new HttpError(502, '高德没有返回路线折线，请重试');
  const polyline = path.steps.flatMap((step) => {
    if (typeof step.polyline !== 'string' || !step.polyline) throw new HttpError(502, '高德返回的路线折线无效，请重试');
    return step.polyline.split(';').map(parsePosition);
  });
  if (polyline.length < 2) throw new HttpError(502, '高德返回的路线折线不完整，请重试');
  return { index, from, to, distanceMeters: distance, polyline };
}

export async function planRoute(routeId: string, projectId: string): Promise<Route> {
  const route = storage.beginPlanning(routeId, projectId);
  const { taskId, inputVersion } = route.planning!;
  const legs: Leg[] = [];
  let currentIndex = 1;
  try {
    for (let index = 1; index < route.points.length; index++) {
      currentIndex = index;
      legs.push(await withPlanningSlot(async () => {
        if (!storage.updatePlanning(routeId, projectId, taskId, inputVersion, index - 1)) throw superseded();
        return planLeg(route.points[index - 1], route.points[index], index, route.strategy);
      }));
      if (!storage.updatePlanning(routeId, projectId, taskId, inputVersion, index)) throw superseded();
    }
    const totalDistanceMeters = legs.reduce((total, leg) => total + leg.distanceMeters, 0);
    if (!Number.isSafeInteger(totalDistanceMeters)) throw new HttpError(502, '线路总距离超出可用范围，请拆分线路');
    const saved = storage.completePlanning(routeId, projectId, taskId, inputVersion, {
      inputVersion, points: route.points, strategy: route.strategy, legs, totalDistanceMeters, calculatedAt: new Date().toISOString(),
    });
    if (!saved) throw superseded();
    return storage.getRoute(routeId, projectId);
  } catch (error) {
    const cause = error instanceof HttpError ? error.message : '高德返回的路线数据无效，请重试';
    const message = `第${currentIndex}个区间（${route.points[currentIndex - 1].name} → ${route.points[currentIndex].name}）测算失败：${cause}`;
    if (!storage.failPlanning(routeId, projectId, taskId, inputVersion, message)) throw superseded();
    throw new HttpError(error instanceof HttpError ? error.status : 502, message);
  }
}

function superseded(): HttpError {
  return new HttpError(409, '线路已更新或本次测算已被新任务取代，请查看当前线路');
}
