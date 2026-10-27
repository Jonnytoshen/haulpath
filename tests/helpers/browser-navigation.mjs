import assert from 'node:assert/strict';

export async function assertOverview(page) {
  const overview = page.getByRole('region', { name: '线路总览', exact: true });
  await overview.waitFor({ state: 'visible' });
  await overview.getByRole('heading', { name: '线路总览', exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: '线路编辑', exact: true, includeHidden: true }).count(), 0, 'the default overview does not retain a hidden route editor');
  return overview;
}

export async function openRouteFromSidebar(page, name) {
  const expand = page.getByRole('button', { name: '展开项目与线路', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.getByRole('region', { name: '项目线路', exact: true }).locator('.route-item').filter({ has: page.getByText(name, { exact: true }) }).click();
  await page.getByRole('heading', { name, exact: true }).waitFor();
  await page.getByRole('region', { name: '线路编辑', exact: true }).waitFor();
}

export async function goTask(page, task) {
  const control = page.getByRole('button', { name: task, exact: true });
  await control.click();
  assert.equal(await control.getAttribute('aria-pressed'), 'true', `${task} is the active route task`);
}
