import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';

const pageHtml = await readFile(new URL('../examples/quickstart/index.html', import.meta.url), 'utf8');
const allowedPaths = new Set(['/', '/shared/weekly-growth-demo']);
let server: Server | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let origin = '';

beforeAll(async () => {
  server = createServer((request, response) => {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    if (request.method !== 'GET' || !allowedPaths.has(pathname)) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(pageHtml);
  });
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Quickstart fixture did not bind to a local port.');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  if (server) await new Promise<void>((resolve) => { server!.close(() => resolve()); server!.closeAllConnections(); });
});

it('derives the signup change from its values and removes editing controls from the shared view', async () => {
  if (!browser) throw new Error('Quickstart browser did not start.');
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${origin}/`, { waitUntil: 'load' });
    expect(await page.locator('.chart-menu').count()).toBe(2);

    await page.locator('[data-testid="add-chart"]').click();
    await page.locator('[data-testid="chart-title"]').fill('Weekly sign-ups');
    await page.locator('[data-testid="confirm-add-chart"]').click();

    const chart = page.locator('#chart-card-weekly-sign-ups');
    await chart.waitFor({ state: 'visible' });
    const summary = (await chart.locator('.chart-summary').innerText()).trim();
    const values = /^([0-9]+)\s*→\s*([0-9]+)\s+sign-ups$/.exec(summary);
    expect(values).not.toBeNull();
    const previous = Number(values![1]);
    const current = Number(values![2]);
    expect(Number(await chart.locator('.chart-value').innerText())).toBe(current);
    const expectedChange = `${current >= previous ? '+' : ''}${(((current - previous) / previous) * 100).toFixed(1)}%`;
    expect((await chart.locator('.chart-delta').innerText()).trim()).toBe(expectedChange);
    expect(expectedChange).toBe('+72.2%');
    expect((await chart.locator('svg[role="img"]').getAttribute('aria-label'))).toContain(`from ${previous} to ${current}`);
    expect(await page.locator('.chart-menu').count()).toBe(3);

    await page.evaluate(() => localStorage.setItem('fieldnote-demo-weekly-sign-ups', JSON.stringify({ title: 'Weekly sign-ups', wide: true })));
    await page.goto(`${origin}/shared/weekly-growth-demo`, { waitUntil: 'load' });

    expect(await page.locator('main[data-testid="shared-view"]').isVisible()).toBe(true);
    expect(await page.locator('[data-testid="read-only-banner"]').isVisible()).toBe(true);
    expect(await page.locator('#chart-card-weekly-sign-ups[data-size="wide"]').isVisible()).toBe(true);
    expect(await page.locator('.chart-menu').count()).toBe(0);
    expect(await page.locator('.resize-controls, .resize-handle, .wide-dropzone').count()).toBe(0);
    expect(await page.locator('main[data-testid="shared-view"] button:visible').count()).toBe(0);
    expect(await page.locator('#edit-toolbar').isVisible()).toBe(false);
  } finally {
    await page.close();
  }
}, 30_000);
