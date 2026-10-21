import { normalizeCoordinates } from '@/server/coordinates';
import { api, HttpError } from '@/server/http';
import { previewImport, readImport } from '@/server/import';
import { storage } from '@/server/storage';

type Context = { params: Promise<{ projectId: string }> };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(request: Request, context: Context) {
  return api(async () => {
    const { projectId } = await context.params;
    storage.getProject(projectId);
    const { form, tables } = await readImport(request);
    const preview = previewImport(form, tables);
    let selectedRows: unknown;
    try { selectedRows = JSON.parse(String(form.get('selectedRows'))); }
    catch { throw new HttpError(400, '请明确选择需要导入的有效行'); }
    if (!Array.isArray(selectedRows) || !selectedRows.length
      || selectedRows.some((row) => !Number.isInteger(row) || row < 2)
      || new Set(selectedRows).size !== selectedRows.length) {
      throw new HttpError(400, '请选择不重复的有效原始行号');
    }
    const selection = new Set(selectedRows);
    const rows = preview.rows.filter((row) => selection.has(row.rowNumber));
    if (rows.length !== selection.size) throw new HttpError(400, '所选行不存在或为空行，请重新预览');
    const invalidRows = rows.filter((row) => row.errors.length);
    if (invalidRows.length) throw new HttpError(400, `所选行包含错误：第 ${invalidRows.map((row) => row.rowNumber).join('、')} 行，请重新选择有效行`);
    const normalized = await normalizeCoordinates(rows.map((row) => ({
      name: row.name, longitude: row.originalLongitude, latitude: row.originalLatitude,
      coordinateSystem: preview.coordinateSystem, source: 'import',
    })));
    const points = storage.addPoints(projectId, normalized);
    return Response.json({ points, importedCount: points.length }, { status: 201 });
  });
}
