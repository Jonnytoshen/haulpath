import { setTimeout } from 'node:timers/promises';

const port = 47653;
export const amapEnvironment = {
  HAULPATH_TEST_MODE: '1', AMAP_API_BASE_URL: `http://127.0.0.1:${port}`,
  AMAP_WEB_SERVICE_KEY: 'docker-test-web-key', AMAP_JS_KEY: 'docker-test-js-key',
  AMAP_JS_SECURITY_CODE: 'docker-test-security-code',
};

// This process is injected only into the test container. No fixture enters the image.
const source = `
import { createServer } from 'node:http';
const state = { driving: [], proxies: [], holdAt: null, held: 0 };
createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  response.setHeader('Content-Type', 'application/json');
  if (url.pathname === '/__fixture') {
    if (request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      state.holdAt = input.holdAfter === null ? null : state.driving.length + input.holdAfter;
    }
    response.end(JSON.stringify(state)); return;
  }
  if (url.pathname === '/v5/direction/driving') {
    state.driving.push(Object.fromEntries(url.searchParams));
    if (state.driving.length === state.holdAt) { state.held++; return; }
    const distance = url.searchParams.get('strategy') === '43' ? '2345' : '1234';
    const polyline = url.searchParams.get('origin') + ';' + url.searchParams.get('destination');
    response.end(JSON.stringify({ status: '1', route: { paths: [
      { distance, steps: [{ polyline }] }, { distance: '999999', steps: [{ polyline }] },
    ] } })); return;
  }
  if (url.pathname === '/v3/assistant/coordinate/convert') {
    const locations = url.searchParams.get('locations').split('|').map((point) => {
      const [longitude, latitude] = point.split(',').map(Number);
      return (longitude + 0.001).toFixed(6) + ',' + (latitude + 0.001).toFixed(6);
    }).join(';');
    response.end(JSON.stringify({ status: '1', locations })); return;
  }
  if (['/v3/assistant/inputtips', '/v3/place/text', '/v3/place/detail'].includes(url.pathname)) {
    state.proxies.push(Object.fromEntries(url.searchParams));
    response.end(JSON.stringify({ status: '1', tips: [{ name: '容器同源代理地点' }] })); return;
  }
  response.writeHead(404).end(JSON.stringify({ error: 'unknown fixture endpoint' }));
}).listen(${port}, '127.0.0.1');
`;

export async function injectAmap(app) {
  await app.compose(['exec', '--detach', '--no-TTY', 'app', 'node', '--input-type=module', '--eval', source]);
  const control = async (body) => {
    const options = body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) };
    const script = `const response = await fetch('http://127.0.0.1:${port}/__fixture', ${JSON.stringify(options)}); if (!response.ok) throw new Error('fixture control failed'); process.stdout.write(await response.text());`;
    return JSON.parse((await app.exec(['node', '--input-type=module', '--eval', script])).stdout);
  };
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await control(); return { state: () => control(), holdAfter: (count) => control({ holdAfter: count }) }; }
    catch (error) {
      if (attempt === 29) throw error;
      await setTimeout(100);
    }
  }
}
