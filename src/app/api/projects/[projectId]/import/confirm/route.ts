import { normalizeCoordinates } from '@/server/coordinates';
import { api, HttpError } from '@/server/http';
import { previewImport, readImport } from '@/server/import';
import { storage } from '@/server/storage';
import { previewMap } from '@/server/map-import';

type Context = { params: Promise<{ projectId: string }> };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(request: Request, context: Context) {
  return api(async () => {
    const { projectId } = await context.params;
    storage.getProject(projectId);
    const input = await readImport(request);
    const { form } = input;
    if ('map' in input) {
      const preview = await previewMap(input.map, form);
      let selectedEntries: unknown;
      try { selectedEntries = JSON.parse(String(form.get('selectedEntries'))); }
      catch { throw new HttpError(400, '请明确选择需要导入的有效点位'); }
      if (!Array.isArray(selectedEntries) || !selectedEntries.length
        || selectedEntries.some((entry) => typeof entry !== 'string' || !entry)
        || new Set(selectedEntries).size !== selectedEntries.length) {
        throw new HttpError(400, '请选择不重复的有效点位');
      }
      const selection = new Set(selectedEntries);
      const entries = preview.entries.filter((entry) => selection.has(entry.entryId));
      if (entries.length !== selection.size) throw new HttpError(400, '所选点位不存在，请重新预览');
      if (entries.some((entry) => entry.errors.length)) throw new HttpError(400, '所选点位包含错误，请重新选择有效点位');
      const normalized = await normalizeCoordinates(entries.map((entry) => ({
        name: entry.name, longitude: entry.originalLongitude, latitude: entry.originalLatitude,
        coordinateSystem: 'WGS84', source: 'import',
      })));
      const points = storage.addPoints(projectId, normalized);
      return Response.json({ points, importedCount: points.length }, { status: 201 });
    }
    const preview = previewImport(form, input.tables);
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
