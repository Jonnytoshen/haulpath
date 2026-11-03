import { api, HttpError, readJson } from '@/server/http';
import {
  powerConnectionPointsOf,
  powerResourceRevision,
} from '@/server/power-connection-points-validation';
import { storage } from '@/server/storage';

type Context = { params: Promise<{ projectId: string }> };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(_request: Request, context: Context) {
  return api(async () =>
    Response.json(storage.getPowerConnectionPoints((await context.params).projectId)),
  );
}

export function PUT(request: Request, context: Context) {
  return api(async () => {
    const projectId = (await context.params).projectId;
    const body = await readJson(request);
    if (Object.keys(body).some((key) => !['expectedRevision', 'points'].includes(key)))
      throw new HttpError(400, '电源接入点包含不支持或受保护的字段');
    const expectedRevision = powerResourceRevision(body.expectedRevision);
    const current = storage.getPowerConnectionPoints(projectId);
    if (expectedRevision !== current.revision)
      throw new HttpError(409, '电源接入点已被更新，请重新加载后编辑');
    const points = await powerConnectionPointsOf(body.points, current);
    return Response.json(storage.replacePowerConnectionPoints(projectId, expectedRevision, points));
  });
}
