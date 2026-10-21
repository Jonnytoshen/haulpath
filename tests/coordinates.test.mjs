import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startApplication, jsonRequest } from './helpers/application.mjs';

let application;
let upstream;
let handleUpstream;
const upstreamRequests = [];

before(async () => {
  upstream = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    upstreamRequests.push(url);
    await handleUpstream(url, response);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  application = await startApplication({
    ZHONGTU_TEST_MODE: '1',
    AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
    AMAP_WEB_SERVICE_KEY: 'test-web-secret',
    AMAP_JS_KEY: 'test-browser-key',
    AMAP_JS_SECURITY_CODE: 'test-js-secret',
  });
});

after(async () => {
  await application?.stop();
  await application?.cleanup();
  if (upstream) await new Promise((resolve) => upstream.close(resolve));
});

const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
const inputPoint = (name, longitude = 121.471234567, latitude = 31.231234567) => ({ name, longitude, latitude, source: 'manual' });

test('GCJ-02 point entry preserves original coordinates without requesting conversion', async () => {
  const beforeCount = upstreamRequests.length;
  const result = await request('/api/coordinates', 'POST', { points: [inputPoint('上海仓')] });
  assert.equal(result.status, 200);
  assert.equal(result.body.length, 1);
  assert.equal(typeof result.body[0].id, 'string');
  assert.equal(result.body[0].longitude, 121.471234567);
  assert.equal(result.body[0].originalLongitude, 121.471234567);
  assert.equal(result.body[0].originalLatitude, 31.231234567);
  assert.equal(result.body[0].coordinateSystem, 'GCJ-02');
  assert.equal(upstreamRequests.length, beforeCount);
});

test('WGS84 entry converts in bounded batches and preserves originals and input order', async () => {
  handleUpstream = (url, response) => {
    assert.equal(url.pathname, '/v3/assistant/coordinate/convert');
    assert.equal(url.searchParams.get('coordsys'), 'gps');
    assert.equal(url.searchParams.get('key'), 'test-web-secret');
    const positions = url.searchParams.get('locations').split('|');
    assert.ok(positions.length <= 40);
    assert.ok(positions.every((position) => /^-?\d+\.\d{6},-?\d+\.\d{6}$/.test(position)));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ status: '1', locations: positions.map(() => '121.476,31.236').join(';') }));
  };
  const beforeCount = upstreamRequests.length;
  const points = Array.from({ length: 41 }, (_, index) => ({ ...inputPoint(`GPS ${index}`), coordinateSystem: 'WGS84' }));
  points.splice(1, 0, inputPoint('已是高德坐标'));
  const result = await request('/api/coordinates', 'POST', { points });
  assert.equal(result.status, 200);
  assert.equal(result.body.length, 42);
  assert.deepEqual(result.body.map((point) => point.name), points.map((point) => point.name));
  assert.equal(result.body[0].longitude, 121.476);
  assert.equal(result.body[0].latitude, 31.236);
  assert.equal(result.body[0].originalLongitude, 121.471234567);
  assert.equal(result.body[0].coordinateSystem, 'WGS84');
  assert.equal(result.body[1].longitude, 121.471234567);
  assert.equal(upstreamRequests.length - beforeCount, 2);
});
