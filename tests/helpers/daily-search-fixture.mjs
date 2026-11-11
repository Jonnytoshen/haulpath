import assert from 'node:assert/strict';

export async function waitSearch(request, model, taskId, predicate, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await request(`${model.path}/daily-transport/${taskId}?summary=1`);
    assert.equal(response.status, 200);
    if (predicate(response.body)) return response.body;
    assert.ok(['running', 'queued'].includes(response.body.status), JSON.stringify(response.body));
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.fail('search did not reach the public observable state');
}
