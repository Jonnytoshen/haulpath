import { api, readJson } from '@/server/http';
import { storage } from '@/server/storage';
type Context = { params: Promise<{ projectId: string; scenarioId: string }> };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function PUT(request: Request, context: Context) {
  return api(async () => {
    const { projectId, scenarioId } = await context.params;
    return Response.json(
      storage.replaceAssetCashflows(projectId, scenarioId, await readJson(request)),
    );
  });
}
export function GET(_request: Request, context: Context) {
  return api(async () => {
    const { projectId, scenarioId } = await context.params;
    return Response.json(storage.assetCashflows.getView(projectId, scenarioId));
  });
}
export function POST(request: Request, context: Context) {
  return api(async () => {
    const { projectId, scenarioId } = await context.params;
    return Response.json(
      storage.assetCashflows.calculate(projectId, scenarioId, await readJson(request)),
      { status: 201 },
    );
  });
}
