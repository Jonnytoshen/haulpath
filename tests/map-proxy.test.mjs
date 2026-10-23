import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startApplication, jsonRequest } from './helpers/application.mjs';

let application;
let upstream;
let respond;
const requests = [];
before(async () => {
  upstream = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push(url);
    respond(url, response);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  application = await startApplication({
    HAULPATH_TEST_MODE: '1', AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
    AMAP_WEB_SERVICE_KEY: 'private-web-key', AMAP_JS_KEY: 'public-browser-key', AMAP_JS_SECURITY_CODE: 'private-security-code',
  });
});
after(async () => {
  await application?.stop();
  await application?.cleanup();
  if (upstream) await new Promise((resolve) => upstream.close(resolve));
});

test('public map configuration exposes the JS key and fixed proxy path without server credentials', async () => {
  const config = await jsonRequest(application.baseUrl, '/api/config');
  assert.equal(config.status, 200);
  assert.deepEqual(config.body, { mapKey: 'public-browser-key', securityProxyPath: '/_AMapService', webServiceConfigured: true });
  assert.doesNotMatch(JSON.stringify(config.body), /private-web-key|private-security-code/);
});

test('the fixed SDK proxy preserves JSONP and content type while overriding client credentials', async () => {
  respond = (url, response) => {
    assert.equal(url.pathname, '/v3/assistant/inputtips');
    assert.equal(url.searchParams.get('keywords'), '上海仓');
    assert.deepEqual(url.searchParams.getAll('jscode'), ['private-security-code']);
    assert.deepEqual(url.searchParams.getAll('key'), ['public-browser-key']);
    response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    response.end('sdkCallback({"status":"1","tips":[{"name":"上海仓"}]});');
  };
  const result = await fetch(`${application.baseUrl}/_AMapService/v3/assistant/inputtips?keywords=${encodeURIComponent('上海仓')}&callback=sdkCallback&key=attacker-key&jscode=attacker-secret&jscode=second-secret`);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('content-type'), 'application/javascript; charset=utf-8');
  assert.equal(await result.text(), 'sdkCallback({"status":"1","tips":[{"name":"上海仓"}]});');
  assert.match(result.headers.get('cache-control'), /no-store/);
});

test('the SDK proxy rejects unrelated paths and upstream redirects and does not expose echoed server credentials', async () => {
  const beforeCount = requests.length;
  for (const path of ['v5/direction/driving', 'v3/ip', 'https://example.com', 'v4/map/styles']) {
    const result = await fetch(`${application.baseUrl}/_AMapService/${path}`);
    assert.equal(result.status, 404);
  }
  assert.equal(requests.length, beforeCount);
  respond = (_url, response) => {
    response.setHeader('Content-Type', 'application/javascript');
    response.end('sdkCallback({"debug":"private-security-code","key":"private-web-key"});');
  };
  const echoed = await fetch(`${application.baseUrl}/_AMapService/v3/place/text?keywords=warehouse`);
  assert.equal(echoed.status, 200);
  assert.doesNotMatch(await echoed.text(), /private-security-code|private-web-key/);
  respond = (_url, response) => { response.writeHead(302, { Location: 'http://localhost:9/private' }); response.end(); };
  const redirected = await fetch(`${application.baseUrl}/_AMapService/v3/place/detail?id=POI`);
  assert.equal(redirected.status, 502);
  assert.doesNotMatch(await redirected.text(), /private-security-code|private-web-key/);
});
