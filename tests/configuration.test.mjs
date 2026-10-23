import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApplication, jsonRequest } from './helpers/application.mjs';

test('missing credentials allow local drafts and GCJ-02 entry but explain unavailable map, planning and WGS84 conversion', async () => {
  const application = await startApplication({ AMAP_WEB_SERVICE_KEY: '', AMAP_JS_KEY: '', AMAP_JS_SECURITY_CODE: '' });
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    assert.deepEqual((await request('/api/config')).body, { mapKey: '', securityProxyPath: '/_AMapService', webServiceConfigured: false });
    const points = await request('/api/coordinates', 'POST', { points: [
      { name: '上海仓', longitude: 121.47, latitude: 31.23, source: 'manual' },
      { name: '南京客户', longitude: 118.79, latitude: 32.06, source: 'manual' },
    ] });
    assert.equal(points.status, 200);
    const project = (await request('/api/projects', 'POST', { name: '无凭证项目' })).body;
    const route = (await request(`/api/projects/${project.id}/routes`, 'POST', { name: '线路草稿', points: points.body })).body;
    const failed = await request(`/api/routes/${route.id}/plan?projectId=${project.id}`, 'POST');
    assert.equal(failed.status, 503);
    assert.match(failed.body.error, /AMAP_WEB_SERVICE_KEY/);
    const current = (await request(`/api/routes/${route.id}?projectId=${project.id}`)).body;
    assert.equal(current.snapshot, null);
    assert.equal(current.planning.status, 'failed');
    const gps = await request('/api/coordinates', 'POST', { points: [{ name: 'GPS', longitude: 121.47, latitude: 31.23, coordinateSystem: 'WGS84', source: 'manual' }] });
    assert.equal(gps.status, 503);
    assert.match(gps.body.error, /AMAP_WEB_SERVICE_KEY/);
    const proxy = await request('/_AMapService/v3/place/text');
    assert.equal(proxy.status, 503);
    assert.match(proxy.body.error, /JS Key.*安全密钥/);
  } finally { await application.stop(); await application.cleanup(); }
});

test('test upstream overrides reject non-loopback destinations before sending credentials', async () => {
  const application = await startApplication({ HAULPATH_TEST_MODE: '1', AMAP_API_BASE_URL: 'http://example.invalid', AMAP_WEB_SERVICE_KEY: 'private-web-key' });
  try {
    const result = await jsonRequest(application.baseUrl, '/api/coordinates', 'POST', { points: [
      { name: 'GPS', longitude: 121.47, latitude: 31.23, coordinateSystem: 'WGS84', source: 'manual' },
    ] });
    assert.equal(result.status, 500);
    assert.match(result.body.error, /本机 HTTP/);
    assert.doesNotMatch(JSON.stringify(result.body), /private-web-key/);
  } finally { await application.stop(); await application.cleanup(); }
});
