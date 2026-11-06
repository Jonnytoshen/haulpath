import { after } from 'next/server';
import { api, readJson } from '@/server/http';
import { scenarioFields } from '@/server/scenario-validation';
import { dailyTransportConfig } from '@/server/daily-transport-storage';
import { runDailyTransportTask } from '@/server/daily-transport-planning';
import { storage } from '@/server/storage';

type Context = { params: Promise<{ projectId: string; scenarioId: string }> };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(_request: Request, context: Context) {
  return api(async () => {
    const { projectId, scenarioId } = await context.params;
    return Response.json(storage.dailyTransport.getView(projectId, scenarioId));
  });
}
export function PUT(request: Request, context: Context) {
  return api(async () => {
    const { projectId, scenarioId } = await context.params;
    return Response.json(
      storage.replaceSwapDetourLimits(projectId, scenarioId, await readJson(request)),
    );
  });
}
export function POST(request: Request, context: Context) {
  return api(async () => {
    const { projectId, scenarioId } = await context.params;
    const body = await readJson(request);
    scenarioFields(body, ['expectedRevision', 'config']);
    const task = storage.dailyTransport.begin(
      projectId,
      scenarioId,
      body.expectedRevision,
      dailyTransportConfig(body.config),
    );
    after(() => runDailyTransportTask(projectId, scenarioId, task.taskId));
    return Response.json(storage.dailyTransport.getView(projectId, scenarioId), { status: 202 });
  });
}
