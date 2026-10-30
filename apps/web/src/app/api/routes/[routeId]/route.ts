import { api, projectIdFrom, readJson } from '@/server/http';
import { storage } from '@/server/storage';
type Context = { params: Promise<{ routeId: string }> };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request, context: Context) { return api(async () => Response.json(storage.getRoute((await context.params).routeId, projectIdFrom(request)))); }
export function PATCH(request: Request, context: Context) { return api(async () => Response.json(storage.updateRoute((await context.params).routeId, projectIdFrom(request), await readJson(request)))); }
export function DELETE(request: Request, context: Context) { return api(async () => {
  storage.deleteRoute((await context.params).routeId, projectIdFrom(request));
  return new Response(null, { status: 204 });
}); }
