import { api, projectIdFrom } from '@/server/http';
import { planRoute } from '@/server/planning';

export const runtime = 'nodejs';
type Context = { params: Promise<{ routeId: string }> };
export function POST(request: Request, context: Context) {
  return api(async () => Response.json(await planRoute((await context.params).routeId, projectIdFrom(request))));
}
