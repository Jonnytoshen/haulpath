import { api, readJson } from '@/server/http';
import { storage } from '@/server/storage';

type Context = { params: Promise<{ projectId: string }> };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(_request: Request, context: Context) {
  return api(async () => Response.json(storage.listScenarios((await context.params).projectId)));
}

export function POST(request: Request, context: Context) {
  return api(async () =>
    Response.json(
      storage.createScenario((await context.params).projectId, await readJson(request)),
      { status: 201 },
    ),
  );
}
