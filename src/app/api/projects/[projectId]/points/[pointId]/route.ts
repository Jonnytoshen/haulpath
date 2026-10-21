import type { Point } from '@/lib/domain';
import { api, readJson } from '@/server/http';
import { storage } from '@/server/storage';
type Context = { params: Promise<{ projectId: string; pointId: string }> };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function PATCH(request: Request, context: Context) { return api(async () => {
  const { projectId, pointId } = await context.params;
  return Response.json(storage.updatePoint(projectId, pointId, await readJson(request) as Partial<Point>));
}); }
export function DELETE(_request: Request, context: Context) { return api(async () => {
  const { projectId, pointId } = await context.params;
  storage.deletePoint(projectId, pointId);
  return new Response(null, { status: 204 });
}); }
