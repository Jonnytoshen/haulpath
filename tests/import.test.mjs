import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { crc32, deflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import { startApplication, jsonRequest } from './helpers/application.mjs';

let application;
let upstream;
let handleUpstream;
const upstreamRequests = [];
before(async () => {
  upstream = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    upstreamRequests.push(url);
    handleUpstream(url, response);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  application = await startApplication({ HAULPATH_TEST_MODE: '1', AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, AMAP_WEB_SERVICE_KEY: 'test-import-key' });
});
after(async () => {
  await application?.stop(); await application?.cleanup();
  if (upstream) await new Promise((resolve) => upstream.close(resolve));
});
const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);

async function upload(projectId, action, file, fields = {}) {
  const form = new FormData();
  form.set('file', file);
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const response = await fetch(`${application.baseUrl}/api/projects/${projectId}/import/${action}`, { method: 'POST', body: form });
  const content = await response.text();
  return { status: response.status, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(content) : content };
}

const kml = (body, prefix = '') => `<?xml version="1.0" encoding="UTF-8"?><${prefix}kml xmlns${prefix ? `:${prefix.slice(0, -1)}` : ''}="http://www.opengis.net/kml/2.2">${body}</${prefix}kml>`;
const point = (name, coordinates) => `<Placemark><name>${name}</name><Point><coordinates>${coordinates}</coordinates></Point></Placemark>`;

// Build real ZIP archives without relying on the import implementation or external fixtures.
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, contents, compressed = false, checksum, encrypted = false, method } of entries) {
    const nameBytes = Buffer.from(name);
    const raw = Buffer.from(contents);
    const body = compressed ? deflateRawSync(raw) : raw;
    const crc = checksum ?? crc32(raw);
    const flags = 0x800 | (encrypted ? 1 : 0);
    const compressionMethod = method ?? (compressed ? 8 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(compressionMethod, 8); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, body);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(compressionMethod, 10); header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20); header.writeUInt32LE(raw.length, 24); header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42); central.push(header, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('KML previews only real placemark points with source labels and actionable errors', async () => {
  const project = (await request('/api/projects', 'POST', { name: 'KML项目' })).body;
  const file = new File([`\uFEFF${kml(`<Document><Folder><name>仓库</name><visibility>0</visibility>
    <Placemark><name><![CDATA[上海 & 一号]]></name><MultiGeometry><Point><coordinates>121.471234567,31.231234567,20</coordinates></Point><Point><coordinates>120,30</coordinates></Point><LineString><coordinates>1,2 3,4</coordinates></LineString></MultiGeometry></Placemark>
    ${point('', '121,31')}${point('越界', '181,90')}${point('多坐标', '121,31 122,32')}
    <Placemark><name>面</name><Polygon><outerBoundaryIs><LinearRing><coordinates>1,2 3,4</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
    <NetworkLink><Link><href>https://example.invalid/data.kml</href></Link></NetworkLink>
    <ExtendedData><Placemark><name>伪点</name><Point><coordinates>121,31</coordinates></Point></Placemark></ExtendedData>
  </Folder></Document>`)}`], '地点.kml');
  const requestsBefore = upstreamRequests.length;
  const inspected = await upload(project.id, 'inspect', file);
  assert.equal(inspected.status, 200);
  assert.equal(inspected.body.format, 'kml');
  assert.equal(inspected.body.documents.length, 1);
  const documentId = inspected.body.documents[0].documentId;
  const preview = await upload(project.id, 'preview', file, { documentId });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.validCount, 2);
  assert.equal(preview.body.invalidCount, 3);
  assert.deepEqual(preview.body.entries.map((item) => item.name), ['上海 & 一号', '上海 & 一号', '', '越界', '多坐标']);
  assert.equal(preview.body.entries[0].originalLongitude, 121.471234567);
  assert.equal(preview.body.entries[0].originalLatitude, 31.231234567);
  assert.match(preview.body.entries[0].sourceLabel, /仓库/);
  assert.notEqual(preview.body.entries[0].entryId, preview.body.entries[1].entryId);
  assert.match(preview.body.entries[2].errors.join(' '), /名称/);
  assert.match(preview.body.entries[3].errors.join(' '), /范围/);
  assert.ok(preview.body.entries[4].errors.length);
  assert.ok(preview.body.ignored.some((item) => item.kind === '线' && item.count === 1));
  assert.ok(preview.body.ignored.some((item) => item.kind === '面' && item.count === 1));
  assert.ok(preview.body.ignored.some((item) => item.kind === '网络链接' && item.count === 1));
  assert.equal(upstreamRequests.length, requestsBefore);
  assert.deepEqual((await request(`/api/projects/${project.id}/points`)).body, []);
});

test('KML confirms only selected points in source order, fixes WGS84, and appends on repeat', async () => {
  const project = (await request('/api/projects', 'POST', { name: 'KML确认项目' })).body;
  const other = (await request('/api/projects', 'POST', { name: 'KML其他项目' })).body;
  const file = new File([kml(`<Document>${point('同名', '121.471234567,31.231234567')}${point('同名', '120,30')}${point('', '121,31')}</Document>`)], 'points.kml');
  const preview = await upload(project.id, 'preview', file);
  assert.equal(preview.status, 200);
  const [first, second, invalid] = preview.body.entries.map((entry) => entry.entryId);
  const fields = { selectedEntries: JSON.stringify([second, first]) };
  for (const selectedEntries of ['[]', JSON.stringify([first, first]), JSON.stringify([invalid]), '["missing"]', 'null', 'not-json']) {
    const rejected = await upload(project.id, 'confirm', file, { selectedEntries });
    assert.equal(rejected.status, 400, selectedEntries);
  }
  assert.equal((await upload(project.id, 'preview', file, { coordinateSystem: 'GCJ-02' })).status, 400);
  assert.equal((await upload(project.id, 'confirm', file, { ...fields, coordinateSystem: 'GCJ-02' })).status, 400);
  const conversions = [];
  handleUpstream = (url, response) => {
    const locations = url.searchParams.get('locations').split('|');
    conversions.push({ system: url.searchParams.get('coordsys'), locations });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ status: '1', locations: locations.map(() => '121.476,31.236').join(';') }));
  };
  const success = await upload(project.id, 'confirm', file, fields);
  assert.equal(success.status, 201);
  assert.equal(success.body.importedCount, 2);
  assert.equal(success.body.points[0].originalLongitude, 121.471234567);
  assert.equal(success.body.points[0].coordinateSystem, 'WGS84');
  assert.equal(success.body.points[0].source, 'import');
  assert.deepEqual(conversions, [{ system: 'gps', locations: ['121.471235,31.231235', '120.000000,30.000000'] }]);
  assert.notEqual(success.body.points[0].id, success.body.points[1].id);
  assert.equal((await upload(project.id, 'confirm', file, fields)).status, 201);
  assert.equal((await request(`/api/projects/${project.id}/points`)).body.length, 4);
  assert.deepEqual((await request(`/api/projects/${other.id}/points`)).body, []);
});

test('KMZ requires a document choice, keeps candidates independent, and rejects damaged archives', async () => {
  const project = (await request('/api/projects', 'POST', { name: 'KMZ项目' })).body;
  const file = new File([zip([
    { name: 'one/doc.kml', contents: kml(point('一', '121,31')) },
    { name: 'two/doc.kml', contents: kml(point('二', '120,30')), compressed: true },
    { name: 'icon.png', contents: 'unused' },
  ])], 'map.kmz');
  const inspected = await upload(project.id, 'inspect', file);
  assert.equal(inspected.status, 200);
  assert.equal(inspected.body.format, 'kmz');
  assert.deepEqual(inspected.body.documents.map((doc) => doc.path), ['one/doc.kml', 'two/doc.kml']);
  assert.equal((await upload(project.id, 'preview', file)).status, 400);
  const [first, second] = inspected.body.documents;
  const firstPreview = await upload(project.id, 'preview', file, { documentId: first.documentId });
  const secondPreview = await upload(project.id, 'preview', file, { documentId: second.documentId });
  assert.equal(firstPreview.body.entries[0].name, '一');
  assert.equal(secondPreview.body.entries[0].name, '二');
  assert.equal((await upload(project.id, 'confirm', file, { documentId: second.documentId, selectedEntries: JSON.stringify([firstPreview.body.entries[0].entryId]) })).status, 400);
  const damaged = new File([zip([{ name: 'doc.kml', contents: kml(point('损坏', '121,31')), checksum: 1 }])], 'bad.kmz');
  assert.equal((await upload(project.id, 'preview', damaged)).status, 400);
  const unsafe = new File([zip([{ name: '../doc.kml', contents: kml('') }])], 'unsafe.kmz');
  assert.equal((await upload(project.id, 'inspect', unsafe)).status, 400);
  assert.deepEqual((await request(`/api/projects/${project.id}/points`)).body, []);
});

test('KML rejects malformed XML, unsafe XML, unsupported namespaces and non-UTF8 without partial results', async () => {
  const project = (await request('/api/projects', 'POST', { name: '坏KML项目' })).body;
  for (const [content, name] of [
    [kml(point('成功', '121,31')).slice(0, -5), 'truncated.kml'],
    ['<!DOCTYPE kml [<!ENTITY secret SYSTEM "file:///etc/passwd">]><kml xmlns="http://www.opengis.net/kml/2.2">&secret;</kml>', 'doctype.kml'],
    ['<kml><Placemark/></kml>', 'namespace.kml'],
    ['<kml xmlns="http://earth.google.com/kml/2.1"/>', 'old.kml'],
    [new Uint8Array([0xff, 0xfe, 0xff]), 'encoding.kml'],
    ['<?xml version="1.0" encoding="UTF-16"?><kml xmlns="http://www.opengis.net/kml/2.2"/>', 'declaration.kml'],
  ]) {
    const rejected = await upload(project.id, 'preview', new File([content], name));
    assert.equal(rejected.status, 400, name);
    assert.equal(typeof rejected.body.error, 'string');
  }
  assert.deepEqual((await request(`/api/projects/${project.id}/points`)).body, []);
});

test('KML conversion failure in a later batch leaves no partial project data', async () => {
  const project = (await request('/api/projects', 'POST', { name: 'KML分批项目' })).body;
  const file = new File([kml(`<Document>${Array.from({ length: 41 }, (_, index) => point(`点${index}`, '121,31')).join('')}</Document>`)], 'batch.kml');
  const preview = await upload(project.id, 'preview', file);
  assert.equal(preview.status, 200);
  const fields = { selectedEntries: JSON.stringify(preview.body.entries.map((entry) => entry.entryId).reverse()) };
  let batch = 0;
  handleUpstream = (url, response) => {
    const locations = url.searchParams.get('locations').split('|');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(++batch === 2 ? { status: '0', infocode: '10001' } : { status: '1', locations: locations.map(() => '121.5,31.2').join(';') }));
  };
  assert.equal((await upload(project.id, 'confirm', file, fields)).status, 502);
  assert.deepEqual((await request(`/api/projects/${project.id}/points`)).body, []);
  handleUpstream = (url, response) => {
    const locations = url.searchParams.get('locations').split('|');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ status: '1', locations: locations.map(() => '121.5,31.2').join(';') }));
  };
  const success = await upload(project.id, 'confirm', file, fields);
  assert.equal(success.status, 201);
  assert.equal(success.body.points.length, 41);
  assert.equal(success.body.points[0].name, '点0');
  assert.equal(success.body.points[40].name, '点40');
});

test('KML/KMZ limits accept the boundary and reject larger inputs without writing', async () => {
  const project = (await request('/api/projects', 'POST', { name: 'KML限制项目' })).body;
  const prefix = '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><description>';
  const suffix = `</description>${point('边界', '121,31')}</Document></kml>`;
  const sized = (bytes) => `${prefix}${'x'.repeat(bytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix))}${suffix}`;
  const maxUpload = 10 * 1024 * 1024;
  const maxExtracted = 20 * 1024 * 1024;
  const exactUpload = await upload(project.id, 'inspect', new File([sized(maxUpload)], 'exact.kml'));
  assert.equal(exactUpload.status, 200, JSON.stringify(exactUpload.body));
  assert.equal((await upload(project.id, 'inspect', new File([sized(maxUpload + 1)], 'large.kml'))).status, 400);
  const exactArchive = new File([zip([{ name: 'doc.kml', contents: sized(maxExtracted), compressed: true }])], 'exact.kmz');
  const largeArchive = new File([zip([{ name: 'doc.kml', contents: sized(maxExtracted + 1), compressed: true }])], 'large.kmz');
  assert.equal((await upload(project.id, 'preview', exactArchive)).body.validCount, 1);
  assert.equal((await upload(project.id, 'preview', largeArchive)).status, 400);
  const archiveEntries = [{ name: 'doc.kml', contents: kml(point('点', '121,31')) }, ...Array.from({ length: 1023 }, (_, index) => ({ name: `files/${index}.txt`, contents: '' }))];
  assert.equal((await upload(project.id, 'inspect', new File([zip(archiveEntries)], 'exact-count.kmz'))).status, 200);
  assert.equal((await upload(project.id, 'inspect', new File([zip([...archiveEntries, { name: 'extra.txt', contents: '' }])], 'large-count.kmz'))).status, 400);
  const nested = (depth) => kml(`${'<Folder>'.repeat(depth)}${point('点', '121,31')}${'</Folder>'.repeat(depth)}`);
  assert.equal((await upload(project.id, 'preview', new File([nested(60)], 'exact-depth.kml'))).body.validCount, 1);
  assert.equal((await upload(project.id, 'preview', new File([nested(61)], 'large-depth.kml'))).status, 400);
  const onePoint = point('点', '121,31');
  assert.equal((await upload(project.id, 'preview', new File([kml(onePoint.repeat(10000))], 'exact-points.kml'))).body.validCount, 10000);
  assert.equal((await upload(project.id, 'preview', new File([kml(onePoint.repeat(10001))], 'large-points.kml'))).status, 400);
  assert.deepEqual((await request(`/api/projects/${project.id}/points`)).body, []);
});

test('KML preserves nested folder labels, handles track and rejects duplicate archive paths', async () => {
  const project = (await request('/api/projects', 'POST', { name: '文件夹与轨迹项目' })).body;
  const content = kml(`<Folder><name>真实文件夹</name><Document><name>文档名称</name>${point('地图点', '-1.21e2,+31.5,1e3')}<Placemark><name>轨迹</name><gx:Track/></Placemark></Document></Folder>`)
    .replace('<kml ', '<kml xmlns:gx="http://www.google.com/kml/ext/2.2" ');
  const result = await upload(project.id, 'preview', new File([content], 'folder.kml'));
  assert.equal(result.status, 200);
  assert.match(result.body.entries[0].sourceLabel, /真实文件夹/);
  assert.doesNotMatch(result.body.entries[0].sourceLabel, /文档名称/);
  assert.equal(result.body.entries[0].originalLongitude, -121);
  assert.equal(result.body.entries[0].originalLatitude, 31.5);
  assert.deepEqual(result.body.ignored, [{ kind: '轨迹', count: 1 }]);
  const duplicate = zip([{ name: 'same.kml', contents: content }, { name: 'same.kml', contents: content }]);
  assert.equal((await upload(project.id, 'inspect', new File([duplicate], 'duplicate.kmz'))).status, 400);
  assert.deepEqual((await request(`/api/projects/${project.id}/points`)).body, []);
});

test('KML preview enforces the exact UTF-8 JSON response limit without partial data', async () => {
  const project = (await request('/api/projects', 'POST', { name: '预览响应大小项目' })).body;
  const limit = 20 * 1024 * 1024;
  const count = 1000;
  const folder = `路径"${'仓'.repeat(6800)}`;
  const name = '点"\n甲';
  const entries = Array.from({ length: count }, (_, index) => ({
    entryId: `d0:p${index}`,
    sourceLabel: `boundary.kml / ${folder} / 第 ${index + 1} 项`,
    name,
    originalLongitude: 121,
    originalLatitude: 31,
    errors: [],
  }));
  const expected = { format: 'kml', entries, validCount: count, invalidCount: 0, ignored: [{ kind: '网络链接', count: 1 }] };
  const padding = limit - Buffer.byteLength(JSON.stringify(expected));
  assert.ok(padding > 0);
  const source = (extra) => kml(`<Folder><name>${folder}</name><NetworkLink/>${Array.from({ length: count }, (_, index) => point(index === count - 1 ? `${name}${'x'.repeat(padding + extra)}` : name, '121,31')).join('')}</Folder>`);
  const exact = source(0);
  assert.ok(Buffer.byteLength(exact) < 10 * 1024 * 1024);
  const accepted = await upload(project.id, 'preview', new File([exact], 'boundary.kml'));
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.validCount, count);
  assert.equal(Buffer.byteLength(JSON.stringify(accepted.body)), limit);
  const rejected = await upload(project.id, 'preview', new File([source(1)], 'boundary.kml'));
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /20 MiB/);
  assert.equal('entries' in rejected.body, false);
  const archive = new File([zip([{ name: 'boundary.kml', contents: source(1), compressed: true }])], 'boundary.kmz');
  const archiveRejected = await upload(project.id, 'preview', archive);
  assert.equal(archiveRejected.status, 400);
  assert.match(archiveRejected.body.error, /20 MiB/);
  const beforeConversion = upstreamRequests.length;
  assert.equal((await upload(project.id, 'confirm', archive, { selectedEntries: '["d0:p0"]' })).status, 400);
  assert.equal(upstreamRequests.length, beforeConversion);
  assert.deepEqual((await request(`/api/projects/${project.id}/points`)).body, []);
});

test('KML reports a gx:Tour as other content without extracting its children', async () => {
  const project = (await request('/api/projects', 'POST', { name: '游览内容项目' })).body;
  const content = kml(`<Document><gx:Tour><gx:Playlist>${point('内部伪点', '121,31')}</gx:Playlist></gx:Tour>${point('实际点', '120,30')}</Document>`)
    .replace('<kml ', '<kml xmlns:gx="http://www.google.com/kml/ext/2.2" ');
  const preview = await upload(project.id, 'preview', new File([content], 'tour.kml'));
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.entries.map((entry) => entry.name), ['实际点']);
  assert.deepEqual(preview.body.ignored, [{ kind: '其他', count: 1 }]);
});

test('long invalid KML coordinate lists do not prevent selecting valid sibling points', async () => {
  const project = (await request('/api/projects', 'POST', { name: '长坐标项目' })).body;
  const content = kml(`<Placemark><name>仓库</name><MultiGeometry><Point><coordinates>${'121,31 '.repeat(300_000)}</coordinates></Point><Point><coordinates>${'1,'.repeat(1_000_000)}</coordinates></Point><Point><coordinates>121,31</coordinates></Point></MultiGeometry></Placemark>`);
  const file = new File([content], 'long-coordinates.kml');
  const preview = await upload(project.id, 'preview', file);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.validCount, 1);
  assert.equal(preview.body.invalidCount, 2);
  assert.match(preview.body.entries[0].errors.join(' '), /单个/);
  assert.match(preview.body.entries[1].errors.join(' '), /单个/);
  handleUpstream = (url, response) => {
    assert.equal(url.searchParams.get('locations'), '121.000000,31.000000');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ status: '1', locations: '121.5,31.2' }));
  };
  const confirmed = await upload(project.id, 'confirm', file, { selectedEntries: JSON.stringify([preview.body.entries[2].entryId]) });
  assert.equal(confirmed.status, 201);
  assert.equal(confirmed.body.importedCount, 1);
});

test('KMZ rejects encrypted and unsupported compressed KML without writing points', async () => {
  const project = (await request('/api/projects', 'POST', { name: 'KMZ压缩方式项目' })).body;
  const content = kml(point('点', '121,31'));
  for (const options of [{ encrypted: true }, { method: 99 }]) {
    const archive = new File([zip([{ name: 'doc.kml', contents: content, ...options }])], 'unsupported.kmz');
    const rejected = await upload(project.id, 'preview', archive);
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /加密|压缩/);
  }
  assert.deepEqual((await request(`/api/projects/${project.id}/points`)).body, []);
});

test('Excel inspection and preview preserve chosen sheet, column mapping and original error row numbers without saving', async () => {
  const project = (await request('/api/projects', 'POST', { name: 'Excel导入项目' })).body;
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('说明').addRow(['不作为点位导入']);
  const points = workbook.addWorksheet('仓点清单');
  points.addRows([
    ['辅助列', 'Y坐标', '地点', 'X坐标'], ['第一行', 31.23, '上海仓', 121.47], [],
    ['名称缺失', 32.06, '', 118.79], ['坐标错误', 91, '错误点', '不是数字'], ['经度缺失', 30.27, '杭州仓'],
  ]);
  const file = new File([await workbook.xlsx.writeBuffer()], '任意列名.xlsx');
  const inspected = await upload(project.id, 'inspect', file);
  assert.equal(inspected.status, 200);
  assert.deepEqual(inspected.body.sheets, [
    { name: '说明', headers: ['不作为点位导入'] },
    { name: '仓点清单', headers: ['辅助列', 'Y坐标', '地点', 'X坐标'] },
  ]);
  const previewed = await upload(project.id, 'preview', file, { sheet: '仓点清单', nameColumn: '2', longitudeColumn: '3', latitudeColumn: '1' });
  assert.equal(previewed.status, 200);
  assert.equal(previewed.body.validCount, 1);
  assert.equal(previewed.body.invalidCount, 3);
  assert.deepEqual(previewed.body.rows.map((row) => row.rowNumber), [2, 4, 5, 6]);
  assert.equal(previewed.body.rows[0].name, '上海仓');
  assert.equal(previewed.body.rows[0].originalLongitude, 121.47);
  assert.equal(previewed.body.rows[0].originalLatitude, 31.23);
  assert.deepEqual(previewed.body.rows[0].errors, []);
  assert.match(previewed.body.rows[1].errors.join(' '), /名称/);
  assert.match(previewed.body.rows[2].errors.join(' '), /经度.*数值/);
  assert.match(previewed.body.rows[2].errors.join(' '), /纬度.*范围/);
  assert.match(previewed.body.rows[3].errors.join(' '), /经度.*缺失/);
  assert.deepEqual((await request(`/api/projects/${project.id}/points`)).body, []);
});

test('UTF-8 CSV confirmation saves only explicitly selected valid rows into the current project library', async () => {
  const project = (await request('/api/projects', 'POST', { name: 'CSV导入项目' })).body;
  const other = (await request('/api/projects', 'POST', { name: '其他项目' })).body;
  const file = new File(['\uFEFF任意名称,经度值,纬度值\r\n"上海,一号仓",121.471234567,31.231234567\r\n\r\n错误,,30\r\n杭州仓,120.15,30.27\r\n'], '坐标.csv');
  const mapping = { sheet: 'CSV', nameColumn: '0', longitudeColumn: '1', latitudeColumn: '2' };
  const inspected = await upload(project.id, 'inspect', file);
  assert.equal(inspected.status, 200);
  assert.deepEqual(inspected.body.sheets, [{ name: 'CSV', headers: ['任意名称', '经度值', '纬度值'] }]);
  const previewed = await upload(project.id, 'preview', file, mapping);
  assert.equal(previewed.status, 200);
  assert.equal(previewed.body.validCount, 2);
  assert.equal(previewed.body.invalidCount, 1);
  assert.deepEqual(previewed.body.rows.map((row) => row.rowNumber), [2, 4, 5]);
  assert.equal(previewed.body.rows[0].name, '上海,一号仓');
  assert.deepEqual((await request(`/api/projects/${project.id}/points`)).body, []);
  const confirmed = await upload(project.id, 'confirm', file, { ...mapping, selectedRows: '[5]' });
  assert.equal(confirmed.status, 201);
  assert.equal(confirmed.body.importedCount, 1);
  assert.equal(confirmed.body.points[0].name, '杭州仓');
  assert.equal(confirmed.body.points[0].longitude, 120.15);
  assert.equal(confirmed.body.points[0].latitude, 30.27);
  assert.equal(confirmed.body.points[0].originalLongitude, 120.15);
  assert.equal(confirmed.body.points[0].originalLatitude, 30.27);
  assert.equal(confirmed.body.points[0].coordinateSystem, 'GCJ-02');
  assert.equal(confirmed.body.points[0].source, 'import');
  const saved = await request(`/api/projects/${project.id}/points`);
  assert.deepEqual(saved.body, confirmed.body.points);
  assert.deepEqual((await request(`/api/projects/${other.id}/points`)).body, []);
  for (const selectedRows of ['[]', '[2,4]', '[3]', '[999]', '[2,2]', 'null', '["2"]', 'not-json']) {
    const rejected = await upload(project.id, 'confirm', file, { ...mapping, selectedRows });
    assert.equal(rejected.status, 400, selectedRows);
    assert.equal(typeof rejected.body.error, 'string');
  }
  assert.deepEqual((await request(`/api/projects/${project.id}/points`)).body, saved.body);
});

test('the standard template downloads as a usable Excel workbook for the same import flow', async () => {
  const response = await fetch(`${application.baseUrl}/api/import-template`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(response.headers.get('content-disposition'), /^attachment;.*\.xlsx/);
  const data = await response.arrayBuffer();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data);
  assert.deepEqual(workbook.getWorksheet(1).getRow(1).values.slice(1), ['名称', '经度', '纬度']);
  const project = (await request('/api/projects', 'POST', { name: '模板项目' })).body;
  const inspected = await upload(project.id, 'inspect', new File([data], '点位模板.xlsx'));
  assert.equal(inspected.status, 200);
  assert.deepEqual(inspected.body.sheets[0].headers, ['名称', '经度', '纬度']);
});

test('WGS84 preview stays read-only and a later conversion batch failure never partially imports points', async () => {
  const project = (await request('/api/projects', 'POST', { name: 'GPS导入项目' })).body;
  const rows = Array.from({ length: 41 }, (_, index) => [`GPS ${index}`, '121.471234567', '31.231234567'].join(','));
  const file = new File([['名称,经度,纬度', ...rows].join('\n')], 'GPS.csv');
  const mapping = { sheet: 'CSV', nameColumn: '0', longitudeColumn: '1', latitudeColumn: '2', coordinateSystem: 'WGS84' };
  const selectedRows = JSON.stringify(Array.from({ length: 41 }, (_, index) => 42 - index));
  const beforeCount = upstreamRequests.length;
  const preview = await upload(project.id, 'preview', file, mapping);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.validCount, 41);
  assert.equal(upstreamRequests.length, beforeCount);
  assert.deepEqual((await request(`/api/projects/${project.id}/points`)).body, []);
  let batch = 0;
  handleUpstream = (url, response) => {
    assert.equal(url.pathname, '/v3/assistant/coordinate/convert');
    assert.equal(url.searchParams.get('coordsys'), 'gps');
    const locations = url.searchParams.get('locations').split('|');
    assert.ok(locations.length <= 40);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(++batch === 2 ? { status: '0', infocode: '10001' }
      : { status: '1', locations: locations.map(() => '121.476,31.236').join(';') }));
  };
  const failed = await upload(project.id, 'confirm', file, { ...mapping, selectedRows });
  assert.equal(failed.status, 502);
  assert.match(failed.body.error, /密钥|权限/);
  assert.equal(batch, 2);
  assert.deepEqual((await request(`/api/projects/${project.id}/points`)).body, []);
  handleUpstream = (url, response) => {
    const locations = url.searchParams.get('locations').split('|');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ status: '1', locations: locations.map(() => '121.476,31.236').join(';') }));
  };
  const success = await upload(project.id, 'confirm', file, { ...mapping, selectedRows });
  assert.equal(success.status, 201);
  assert.equal(success.body.importedCount, 41);
  assert.equal(success.body.points[0].name, 'GPS 0');
  assert.equal(success.body.points[40].name, 'GPS 40');
  assert.equal(success.body.points[0].longitude, 121.476);
  assert.equal(success.body.points[0].latitude, 31.236);
  assert.equal(success.body.points[0].originalLongitude, 121.471234567);
  assert.equal(success.body.points[0].originalLatitude, 31.231234567);
  assert.equal(success.body.points[0].coordinateSystem, 'WGS84');
  assert.equal(success.body.points[0].source, 'import');
  assert.deepEqual((await request(`/api/projects/${project.id}/points`)).body, success.body.points);
});

test('a nonempty Excel row with an uncached formula stays visible as an invalid row', async () => {
  const project = (await request('/api/projects', 'POST', { name: '公式表项目' })).body;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('公式');
  sheet.addRow(['名称', '经度', '纬度']);
  sheet.addRow([{ formula: 'SUM(1,1)' }]);
  const file = new File([await workbook.xlsx.writeBuffer()], '未计算公式.xlsx');
  const preview = await upload(project.id, 'preview', file, { sheet: '公式', nameColumn: '0', longitudeColumn: '1', latitudeColumn: '2' });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.invalidCount, 1);
  assert.equal(preview.body.rows[0].rowNumber, 2);
  assert.match(preview.body.rows[0].errors.join(' '), /经度.*缺失/);
});

test('bad files, missing sheets and invalid mappings return clear errors without changing a project library', async () => {
  const project = (await request('/api/projects', 'POST', { name: '失败导入项目' })).body;
  for (const file of [
    new File(['名称,经度,纬度'], '旧文件.xls'), new File(['不是Excel'], '损坏.xlsx'),
    new File([new Uint8Array([0xff, 0xfe, 0xff])], '非UTF8.csv'),
    new File(['名称,经度,纬度\n"未闭合,121,31'], '损坏.csv'), new File([], '空文件.csv'),
  ]) {
    const rejected = await upload(project.id, 'inspect', file);
    assert.equal(rejected.status, 400, file.name);
    assert.equal(typeof rejected.body.error, 'string');
  }
  const file = new File(['名称,经度,纬度\n仓库,121,31'], '点位.csv');
  const mapping = { sheet: 'CSV', nameColumn: '0', longitudeColumn: '1', latitudeColumn: '2' };
  for (const override of [{ sheet: '不存在' }, { nameColumn: '-1' }, { nameColumn: '3' }, { nameColumn: '1' }, { latitudeColumn: 'not-number' }, { coordinateSystem: 'BD-09' }]) {
    const rejected = await upload(project.id, 'preview', file, { ...mapping, ...override });
    assert.equal(rejected.status, 400, JSON.stringify(override));
  }
  assert.equal((await upload('missing-project', 'inspect', file)).status, 404);
  assert.equal((await upload('missing-project', 'preview', file, mapping)).status, 404);
  assert.equal((await upload('missing-project', 'confirm', file, { ...mapping, selectedRows: '[2]' })).status, 404);
  assert.deepEqual((await request(`/api/projects/${project.id}/points`)).body, []);
});
