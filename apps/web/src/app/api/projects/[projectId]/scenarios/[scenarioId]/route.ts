import { api, readJson } from '@/server/http';
import { storage } from '@/server/storage';

type Context = { params: Promise<{ projectId: string; scenarioId: string }> };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(_request: Request, context: Context) {
  return api(async () => {
    const { projectId, scenarioId } = await context.params;
    return Response.json(storage.getScenario(projectId, scenarioId));
  });
}

export function PATCH(request: Request, context: Context) {
  return api(async () => {
    const { projectId, scenarioId } = await context.params;
    return Response.json(storage.updateScenario(projectId, scenarioId, await readJson(request)));
  });
}

export function DELETE(request: Request, context: Context) {
  return api(async () => {
    const { projectId, scenarioId } = await context.params;
    const revision = new URL(request.url).searchParams.get('expectedRevision');
    storage.deleteScenario(projectId, scenarioId, revision === null ? undefined : Number(revision));
    return new Response(null, { status: 204 });
  });
}
