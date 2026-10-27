import { api } from '@/server/http';
import { previewImport, readImport } from '@/server/import';
import { storage } from '@/server/storage';
import { previewMap } from '@/server/map-import';

type Context = { params: Promise<{ projectId: string }> };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(request: Request, context: Context) {
  return api(async () => {
    storage.getProject((await context.params).projectId);
    const input = await readImport(request);
    if ('map' in input) return Response.json(await previewMap(input.map, input.form));
    const { rows, validCount, invalidCount } = previewImport(input.form, input.tables);
    return Response.json({ rows, validCount, invalidCount });
  });
}
