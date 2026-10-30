import { api, readJson } from '@/server/http';
import { storage } from '@/server/storage';
type Context = { params: Promise<{ projectId: string }> };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(_request: Request, context: Context) { return api(async () => Response.json(storage.getProject((await context.params).projectId))); }
export function PATCH(request: Request, context: Context) { return api(async () => Response.json(storage.updateProject((await context.params).projectId, await readJson(request)))); }
export function DELETE(_request: Request, context: Context) { return api(async () => {
  storage.deleteProject((await context.params).projectId);
  return new Response(null, { status: 204 });
}); }
