import { api } from '@/server/http';
import { storage } from '@/server/storage';
type Context = { params: Promise<{ projectId: string; scenarioId: string; resultId: string }> };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(_request: Request, context: Context) {
  return api(async () => {
    const { projectId, scenarioId, resultId } = await context.params;
    return Response.json(storage.assetCashflows.getResult(projectId, scenarioId, resultId));
  });
}
