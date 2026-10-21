import { api } from '@/server/http';
import { previewImport, readImport } from '@/server/import';
import { storage } from '@/server/storage';

type Context = { params: Promise<{ projectId: string }> };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(request: Request, context: Context) {
  return api(async () => {
    storage.getProject((await context.params).projectId);
    const { form, tables } = await readImport(request);
    const { rows, validCount, invalidCount } = previewImport(form, tables);
    return Response.json({ rows, validCount, invalidCount });
  });
}
