import { after } from 'next/server';
import { api, readJson } from '@/server/http';
import { scenarioFields } from '@/server/scenario-validation';
import { runDailyTransportTask } from '@/server/daily-transport-planning';
import { storage } from '@/server/storage';
type Context = { params: Promise<{ projectId: string; scenarioId: string; taskId: string }> };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(request: Request, context: Context) {
  return api(async () => {
    const { projectId, scenarioId, taskId } = await context.params;
    const body = await readJson(request);
    scenarioFields(body, ['expectedRevision', 'maxRuntimeMs']);
    const task = storage.dailyTransport.continue(
      projectId,
      scenarioId,
      taskId,
      body.expectedRevision,
      body.maxRuntimeMs,
    );
    after(() => runDailyTransportTask(projectId, scenarioId, task.taskId));
    return Response.json(
      storage.dailyTransport.getView(
        projectId,
        scenarioId,
        storage.dailyTransport.getSummary(projectId, scenarioId, taskId).config.stage ===
          'annual-transport',
      ),
      { status: 202 },
    );
  });
}
