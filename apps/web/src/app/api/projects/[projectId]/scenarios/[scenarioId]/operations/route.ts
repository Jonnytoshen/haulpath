import { api, readJson } from '@/server/http';
import { storage } from '@/server/storage';

type Context = { params: Promise<{ projectId: string; scenarioId: string }> };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function PUT(request: Request, context: Context) {
  return api(async () => {
    const { projectId, scenarioId } = await context.params;
    return Response.json(
      storage.replaceFleetOperations(projectId, scenarioId, await readJson(request)),
    );
  });
}
