import { createServer, type Server } from 'node:http';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { isolatedContext } from '../src/browser.js';

async function listen(server: Server) {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture failed');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) { await new Promise<void>((done) => server.close(() => done())); }

describe('configured browser origin', () => {
  for (const scenario of ['redirect', 'subresource', 'popup'] as const) {
    it(`blocks ${scenario} before it reaches an external origin`, async () => {
      let externalRequests = 0;
      const outside = createServer((_request, response) => { externalRequests++; response.end('Outside'); });
      const outsideUrl = await listen(outside);
      const inside = createServer((_request, response) => {
        if (scenario === 'redirect') { response.writeHead(302, { Location: outsideUrl }); response.end(); }
        else { response.setHeader('Content-Type', 'text/html'); response.end(scenario === 'subresource' ? `<img src="${outsideUrl}/image">` : `<button onclick="window.open('${outsideUrl}/popup')">Open</button>`); }
      });
      const insideUrl = await listen(inside);
      const browser = await chromium.launch({ headless: true });
      try {
        const { context, assertBoundary } = await isolatedContext(browser, insideUrl);
        const page = await context.newPage();
        if (scenario === 'redirect') await expect(page.goto(insideUrl)).rejects.toThrow();
        else {
          await page.goto(insideUrl, { waitUntil: 'load' });
          if (scenario === 'popup') {
            const popup = page.waitForEvent('popup');
            await page.getByRole('button', { name: 'Open' }).click();
            const opened = await popup;
            await opened.waitForLoadState().catch(() => undefined);
          }
        }
        expect(externalRequests).toBe(0);
        expect(assertBoundary).toThrow('off-origin request');
      } finally { await browser.close(); await close(inside); await close(outside); }
    }, 30_000);
  }
});
