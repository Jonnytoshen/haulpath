import { api } from '@/server/http';
import { readImport } from '@/server/import';
import { storage } from '@/server/storage';

type Context = { params: Promise<{ projectId: string }> };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(request: Request, context: Context) {
  return api(async () => {
    storage.getProject((await context.params).projectId);
    const { tables } = await readImport(request);
    return Response.json({ sheets: tables.map(({ name, headers }) => ({ name, headers })) });
  });
}
