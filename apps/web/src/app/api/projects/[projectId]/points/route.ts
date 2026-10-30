import { api, readJson } from '@/server/http';
import { storage } from '@/server/storage';
import { pointsOf } from '@/server/validation';
type Context = { params: Promise<{ projectId: string }> };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(_request: Request, context: Context) { return api(async () => Response.json(storage.listPoints((await context.params).projectId))); }
export function POST(request: Request, context: Context) { return api(async () => {
  const body = await readJson(request);
  return Response.json(storage.addPoints((await context.params).projectId, pointsOf(body.points)), { status: 201 });
}); }
