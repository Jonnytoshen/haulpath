import { posix } from 'node:path';
import { crc32 } from 'node:zlib';
import { SaxesParser } from 'saxes';
import { fromBufferPromise, type Entry, type ZipFile } from 'yauzl';
import { HttpError } from './http';
import { importCoordinate } from './import-coordinate';

const namespace = 'http://www.opengis.net/kml/2.2';
const gxNamespace = 'http://www.google.com/kml/ext/2.2';
const maxUncompressed = 20 * 1024 * 1024;
const maxPreviewBytes = 20 * 1024 * 1024;
const maxEntries = 1024;
const maxDepth = 64;
const maxPoints = 10_000;

export interface MapImport { format: 'kml' | 'kmz'; name: string; data: Buffer }
interface Document { documentId: string; path: string }
interface MapEntry {
  entryId: string;
  sourceLabel: string;
  name: string;
  originalLongitude?: string | number;
  originalLatitude?: string | number;
  errors: string[];
}
export interface MapPreview { format: 'kml' | 'kmz'; entries: MapEntry[]; validCount: number; invalidCount: number; ignored: { kind: string; count: number }[] }

function badArchive(): HttpError { return new HttpError(400, '无法读取 KMZ，请检查压缩文件及所选 KML 是否完整'); }
function badXml(): HttpError { return new HttpError(400, '无法读取 KML，请重新导出标准 UTF-8 KML 2.2/2.3 文件'); }

async function withArchive<T>(data: Buffer, action: (zip: ZipFile, documents: (Document & { entry: Entry })[]) => Promise<T>): Promise<T> {
  let zip: ZipFile | undefined;
  try {
    zip = await fromBufferPromise(data, { autoClose: false, lazyEntries: true, strictFileNames: true, validateEntrySizes: true });
    if (zip.entryCount > maxEntries) throw new HttpError(400, `KMZ 归档不能超过 ${maxEntries} 个条目`);
    const paths = new Set<string>();
    const documents: (Document & { entry: Entry })[] = [];
    let index = 0;
    for await (const entry of zip.eachEntry()) {
      if (++index > maxEntries) throw new HttpError(400, `KMZ 归档不能超过 ${maxEntries} 个条目`);
      const path = entry.fileName;
      const normalized = posix.normalize(path).replace(/\/$/, '');
      if (!path || path.includes('\\') || path.startsWith('/') || path.split('/').includes('..') || normalized === '.' || paths.has(normalized)) {
        throw new HttpError(400, 'KMZ 包含无效或重复的归档路径');
      }
      paths.add(normalized);
      if (!path.endsWith('/') && path.toLowerCase().endsWith('.kml')) documents.push({ documentId: `d${index - 1}`, path, entry });
    }
    if (!documents.length) throw new HttpError(400, 'KMZ 中没有 KML 文件，请重新导出');
    return await action(zip, documents);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw badArchive();
  } finally {
    zip?.close();
  }
}

function selectedDocument<T extends Document>(documents: T[], requested: FormDataEntryValue | null): T {
  if (requested === null && documents.length === 1) return documents[0];
  if (typeof requested !== 'string') throw new HttpError(400, '请选择 KMZ 中需要导入的 KML 文件');
  const selected = documents.find((document) => document.documentId === requested);
  if (!selected) throw new HttpError(400, '所选 KML 文件不存在，请重新选择');
  return selected;
}

async function readDocument(zip: ZipFile, entry: Entry): Promise<Buffer> {
  if (entry.isEncrypted() || (entry.compressionMethod !== 0 && entry.compressionMethod !== 8)) throw new HttpError(400, '所选 KML 使用了加密或不支持的压缩方式');
  if (entry.uncompressedSize > maxUncompressed) throw new HttpError(400, 'KMZ 中的 KML 解压后不能超过 20 MiB');
  const stream = await zip.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  let size = 0;
  let checksum = 0;
  for await (const value of stream) {
    const chunk = Buffer.from(value as Buffer);
    size += chunk.length;
    if (size > maxUncompressed) {
      stream.destroy();
      throw new HttpError(400, 'KMZ 中的 KML 解压后不能超过 20 MiB');
    }
    checksum = crc32(chunk, checksum);
    chunks.push(chunk);
  }
  if (size !== entry.uncompressedSize || (checksum >>> 0) !== (entry.crc32 >>> 0)) throw badArchive();
  return Buffer.concat(chunks, size);
}

export async function inspectMap(map: MapImport): Promise<{ format: MapImport['format']; documents: Document[] }> {
  if (map.format === 'kml') return { format: map.format, documents: [{ documentId: 'd0', path: map.name }] };
  return withArchive(map.data, async (_zip, documents) => ({ format: map.format, documents: documents.map(({ documentId, path }) => ({ documentId, path })) }));
}

interface Folder { name: string; parent?: Folder }
interface Placemark { name: string; folder?: Folder; geometryCount: number }
interface RawPoint { mark: Placemark; coordinates?: string; coordinateCount: number }
type Kind = 'container' | 'placemark' | 'geometry' | 'point' | 'folderName' | 'placemarkName' | 'coordinates' | 'skip';
interface Frame { kind: Kind; folder?: Folder; isFolder?: boolean; mark?: Placemark; point?: RawPoint; text?: string }

function folderPath(folder?: Folder): string[] {
  const result: string[] = [];
  for (let item = folder; item; item = item.parent) result.unshift(item.name.trim() || '未命名文件夹');
  return result;
}

function extractPoints(data: Buffer, document: Document, format: MapImport['format']): MapPreview {
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(data); }
  catch { throw badXml(); }

  const frames: Frame[] = [];
  const points: RawPoint[] = [];
  const ignored = new Map<string, number>();
  const addIgnored = (kind: string) => ignored.set(kind, (ignored.get(kind) ?? 0) + 1);
  const parser = new SaxesParser({ xmlns: true });
  parser.on('xmldecl', (declaration) => {
    if (declaration.encoding && declaration.encoding.toLowerCase() !== 'utf-8') throw badXml();
  });
  parser.on('doctype', () => { throw badXml(); });
  parser.on('opentag', (tag) => {
    if (frames.length >= maxDepth) throw new HttpError(400, `KML XML 嵌套不能超过 ${maxDepth} 层`);
    const parent = frames.at(-1);
    if (!parent) {
      if (tag.uri !== namespace || tag.local !== 'kml') throw badXml();
      frames.push({ kind: 'container' });
      return;
    }
    const next: Frame = { kind: 'skip' };
    if (tag.uri === namespace && parent.kind === 'container') {
      if (tag.local === 'Document') Object.assign(next, { kind: 'container', folder: parent.folder });
      else if (tag.local === 'Folder') Object.assign(next, { kind: 'container', folder: { name: '', parent: parent.folder }, isFolder: true });
      else if (tag.local === 'Placemark') Object.assign(next, { kind: 'placemark', mark: { name: '', folder: parent.folder, geometryCount: 0 } });
      else if (tag.local === 'name' && parent.isFolder && parent.folder) Object.assign(next, { kind: 'folderName', folder: parent.folder, text: '' });
      else if (tag.local === 'NetworkLink') addIgnored('网络链接');
      else if (['GroundOverlay', 'ScreenOverlay', 'PhotoOverlay'].includes(tag.local)) addIgnored('其他');
    } else if (tag.uri === gxNamespace && tag.local === 'Tour' && parent.kind === 'container') {
      addIgnored('其他');
    } else if ((parent.kind === 'placemark' || parent.kind === 'geometry') && parent.mark) {
      if (tag.uri === namespace && parent.kind === 'placemark' && tag.local === 'name') {
        Object.assign(next, { kind: 'placemarkName', mark: parent.mark, text: '' });
      } else if (tag.uri === namespace && tag.local === 'MultiGeometry') {
        Object.assign(next, { kind: 'geometry', mark: parent.mark });
      } else if (tag.uri === namespace && tag.local === 'Point') {
        if (points.length >= maxPoints) throw new HttpError(400, `KML 不能超过 ${maxPoints} 个 Point`);
        parent.mark.geometryCount++;
        const point: RawPoint = { mark: parent.mark, coordinateCount: 0 };
        points.push(point);
        Object.assign(next, { kind: 'point', point });
      } else if (tag.uri === namespace && (tag.local === 'LineString' || tag.local === 'LinearRing')) {
        parent.mark.geometryCount++; addIgnored('线');
      } else if (tag.uri === namespace && tag.local === 'Polygon') {
        parent.mark.geometryCount++; addIgnored('面');
      } else if (tag.uri === gxNamespace && (tag.local === 'Track' || tag.local === 'MultiTrack')) {
        parent.mark.geometryCount++; addIgnored('轨迹');
      } else if (tag.uri === namespace && tag.local === 'Model') {
        parent.mark.geometryCount++; addIgnored('其他');
      }
    } else if (parent.kind === 'point' && parent.point && tag.uri === namespace && tag.local === 'coordinates') {
      parent.point.coordinateCount++;
      Object.assign(next, { kind: 'coordinates', point: parent.point, text: '' });
    }
    frames.push(next);
  });
  const appendText = (text: string) => {
    const frame = frames.at(-1);
    if (frame && (frame.kind === 'folderName' || frame.kind === 'placemarkName' || frame.kind === 'coordinates')) frame.text += text;
  };
  parser.on('text', appendText);
  parser.on('cdata', appendText);
  parser.on('closetag', () => {
    const frame = frames.pop();
    if (frame?.kind === 'folderName' && frame.folder) frame.folder.name = frame.text ?? '';
    if (frame?.kind === 'placemarkName' && frame.mark) frame.mark.name = frame.text ?? '';
    if (frame?.kind === 'coordinates' && frame.point) frame.point.coordinates = frame.text ?? '';
    if (frame?.kind === 'placemark' && frame.mark && frame.mark.geometryCount === 0) addIgnored('其他');
  });
  try { parser.write(content).close(); }
  catch (error) { if (error instanceof HttpError) throw error; throw badXml(); }

  const ignoredSummary = Array.from(ignored, ([kind, count]) => ({ kind, count }));
  // Start with the JSON array delimiters and the smallest possible fixed response fields.
  // This permits early rejection without rejecting an exact-boundary response.
  let entriesBytes = 2;
  const minimumOverhead = Buffer.byteLength(JSON.stringify({ format, entries: [], validCount: 0, invalidCount: 0, ignored: ignoredSummary })) - 2;
  const entries: MapEntry[] = [];
  let validCount = 0;
  for (const [index, point] of points.entries()) {
    const errors: string[] = [];
    const name = point.mark.name;
    if (!name.trim()) errors.push('名称缺失');
    const coordinates = point.coordinates?.trim();
    const tuples = coordinates ? coordinates.split(/\s+/, 2) : [];
    const parts = tuples.length === 1 ? tuples[0].split(',', 4) : [];
    if (point.coordinateCount > 1 || tuples.length > 1 || (tuples.length === 1 && (parts.length < 2 || parts.length > 3 || (parts.length === 3 && (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(parts[2]) || !Number.isFinite(Number(parts[2]))))))) errors.push('Point 坐标必须为单个经度、纬度及可选高程元组');
    const originalLongitude = importCoordinate(parts[0], '经度', 180, errors);
    const originalLatitude = importCoordinate(parts[1], '纬度', 90, errors);
    const entry: MapEntry = { entryId: `${document.documentId}:p${index}`, sourceLabel: [document.path, ...folderPath(point.mark.folder), `第 ${index + 1} 项`].join(' / '), name, originalLongitude, originalLatitude, errors };
    entriesBytes += (index ? 1 : 0) + Buffer.byteLength(JSON.stringify(entry));
    if (entriesBytes + minimumOverhead > maxPreviewBytes) throw new HttpError(400, 'KML/KMZ 预览内容不能超过 20 MiB，请缩短名称或拆分文件');
    entries.push(entry);
    if (!errors.length) validCount++;
  }
  const invalidCount = entries.length - validCount;
  const fixedOverhead = Buffer.byteLength(JSON.stringify({ format, entries: [], validCount, invalidCount, ignored: ignoredSummary })) - 2;
  if (entriesBytes + fixedOverhead > maxPreviewBytes) throw new HttpError(400, 'KML/KMZ 预览内容不能超过 20 MiB，请缩短名称或拆分文件');
  return { format, entries, validCount, invalidCount, ignored: ignoredSummary };
}

export async function previewMap(map: MapImport, form: FormData): Promise<MapPreview> {
  const system = form.get('coordinateSystem');
  if (system !== null && system !== 'WGS84') throw new HttpError(400, 'KML/KMZ 仅支持 WGS84 坐标系');
  if (map.format === 'kml') {
    const document = selectedDocument([{ documentId: 'd0', path: map.name }], form.get('documentId'));
    return extractPoints(map.data, document, map.format);
  }
  return withArchive(map.data, async (zip, documents) => {
    const document = selectedDocument(documents, form.get('documentId'));
    return extractPoints(await readDocument(zip, document.entry), document, map.format);
  });
}
