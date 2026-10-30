import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import type { CoordinateSystem } from '@haulpath/domain';
import { HttpError } from './http';
import { importCoordinate } from './import-coordinate';
import type { MapImport } from './map-import';

interface Table {
  name: string;
  headers: string[];
  rows: { rowNumber: number; values: (string | number)[] }[];
}
interface PreviewRow {
  rowNumber: number;
  name: string;
  originalLongitude?: string | number;
  originalLatitude?: string | number;
  errors: string[];
}

export type ImportFile = { form: FormData; format: 'csv' | 'xlsx'; tables: Table[] } | { form: FormData; format: 'kml' | 'kmz'; map: MapImport };

export async function readImport(request: Request): Promise<ImportFile> {
  let form: FormData;
  try { form = await request.formData(); }
  catch { throw new HttpError(400, '请使用表单上传点位文件'); }
  const file = form.get('file');
  if (!(file instanceof File) || !file.size) throw new HttpError(400, '请选择非空的点位文件');
  const extension = file.name.split('.').at(-1)?.toLowerCase();
  if (extension !== 'csv' && extension !== 'xlsx' && extension !== 'kml' && extension !== 'kmz') throw new HttpError(400, '仅支持 .xlsx、UTF-8 CSV、.kml 和 .kmz 文件');
  if ((extension === 'kml' || extension === 'kmz') && file.size > 10 * 1024 * 1024) throw new HttpError(400, 'KML/KMZ 文件不能超过 10 MiB');
  const data = await file.arrayBuffer();
  if (extension === 'kml' || extension === 'kmz') return { form, format: extension, map: { format: extension, name: file.name, data: Buffer.from(data) } };
  try {
    if (extension === 'csv') {
      const content = new TextDecoder('utf-8', { fatal: true }).decode(data);
      const values = parse(content, { bom: true, relax_column_count: true, skip_empty_lines: false }) as string[][];
      return { form, format: 'csv', tables: [tableOf('CSV', values)] };
    }
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(data);
    const tables = workbook.worksheets.map((sheet) => {
      const values: (string | number)[][] = [];
      for (let index = 1; index <= sheet.rowCount; index++) {
        const row = sheet.getRow(index);
        values.push(Array.from({ length: sheet.columnCount }, (_value, column) => {
          const cell = row.getCell(column + 1);
          const value = cell.value;
          if (value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value) && value.result === undefined) {
            return `=${'formula' in value ? value.formula : value.sharedFormula}`;
          }
          return typeof value === 'number' ? value : cell.text;
        }));
      }
      return tableOf(sheet.name, values);
    });
    if (!tables.length) throw new HttpError(400, '文件中没有可选择的工作表');
    return { form, format: 'xlsx', tables };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, extension === 'csv' ? '无法读取 CSV，请确认文件为有效的 UTF-8 CSV' : '无法读取 Excel，请确认文件为有效的 .xlsx 工作簿');
  }
}

function tableOf(name: string, values: (string | number)[][]): Table {
  const width = values.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  return {
    name, headers: Array.from({ length: width }, (_value, index) => String(values[0]?.[index] ?? '')),
    rows: values.slice(1).map((row, index) => ({ rowNumber: index + 2, values: row })),
  };
}

function columnOf(form: FormData, key: string, table: Table): number {
  const value = form.get(key);
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) >= table.headers.length) {
    throw new HttpError(400, '请选择工作表中有效的名称、经度和纬度列');
  }
  return Number(value);
}

export function previewImport(form: FormData, tables: Table[]): { rows: PreviewRow[]; validCount: number; invalidCount: number; coordinateSystem: CoordinateSystem } {
  const table = tables.find((item) => item.name === form.get('sheet'));
  if (!table) throw new HttpError(400, '请选择文件中存在的工作表');
  const nameColumn = columnOf(form, 'nameColumn', table);
  const longitudeColumn = columnOf(form, 'longitudeColumn', table);
  const latitudeColumn = columnOf(form, 'latitudeColumn', table);
  if (new Set([nameColumn, longitudeColumn, latitudeColumn]).size !== 3) throw new HttpError(400, '名称、经度和纬度必须选择不同列');
  const coordinateSystem = form.get('coordinateSystem') ?? 'GCJ-02';
  if (coordinateSystem !== 'GCJ-02' && coordinateSystem !== 'WGS84') throw new HttpError(400, '请选择 GCJ-02 或 WGS84 坐标系');
  const rows = table.rows.filter((row) => row.values.some((value) => typeof value === 'number' || value.trim() !== '')).map((row) => {
    const errors: string[] = [];
    const name = String(row.values[nameColumn] ?? '');
    if (!name.trim()) errors.push('名称缺失');
    const originalLongitude = importCoordinate(row.values[longitudeColumn], '经度', 180, errors);
    const originalLatitude = importCoordinate(row.values[latitudeColumn], '纬度', 90, errors);
    return { rowNumber: row.rowNumber, name, originalLongitude, originalLatitude, errors };
  });
  const validCount = rows.filter((row) => row.errors.length === 0).length;
  return { rows, validCount, invalidCount: rows.length - validCount, coordinateSystem };
}
