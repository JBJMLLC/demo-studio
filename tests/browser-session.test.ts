import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as mediaClock from '../src/media-clock.js';
import { capture, checkTargetReady, isolatedContext, type CreateBrowserSession } from '../src/browser.js';
import { computeWordingApprovalHash, planSchema, type DemoPlan } from '../src/schemas.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const done of cleanups.splice(0)) await done(); });

async function serve(handler: Parameters<typeof createServer>[1]) {
  const server: Server = createServer(handler);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanups.push(() => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture failed');
  return `http://127.0.0.1:${address.port}`;
}

function workDir() {
  const directory = mkdtempSync(join(tmpdir(), 'demo-studio-session-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function makePlan(targetUrl: string, assertionSelector: string): DemoPlan {
  const value = {
    schemaVersion: 1 as const, id: 'session', title: 'Session', product: 'Fixture', audience: 'Tests', outcome: 'Capture one scene',
    mode: 'captioned' as const, targetUrl, viewport: { width: 640, height: 360 }, fps: 30,
    presentation: { cursor: 'hidden' as const, captions: false }, duration: { targetSeconds: 3, hardLimit: false },
    scenes: [{ id: 'only', before: 'Start', during: 'Nothing changes', after: 'Finish', say: '', learn: 'Fixture', next: '', holdMs: 0, actions: [], assertions: [{ selector: assertionSelector, kind: 'visible' as const }] }],
    wordingApproval: { sha256: '' },
  };
  value.wordingApproval = { sha256: computeWordingApprovalHash(value as DemoPlan) };
  return planSchema.parse(value);
}

const noNarration = { tracks: [] } as never;

describe('injectable browser session', () => {
  it('keeps the strict origin boundary when no session factory is supplied', async () => {
    const outside = await serve((_request, response) => response.end('outside'));
    const inside = await serve((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(`<main id="app">App</main><img src="${outside}/pixel">`); });
    await expect(capture(makePlan(inside, '#app'), workDir(), noNarration)).rejects.toThrow(/off-origin/);
  }, 60_000);

  it('passes mediaClock limits through to calibration', async () => {
    const inside = await serve((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<main id="app">App</main>'); });
    const plan = makePlan(inside, '#app');
    const calibration = vi.spyOn(mediaClock, 'calibrateVideo');
    cleanups.push(() => calibration.mockRestore());
    // Keep the real decoder and all limits intact. Host scheduling may reject
    // drift before uncertainty; forwarding must not depend on that ordering.
    await expect(capture(plan, workDir(), noNarration, { mediaClock: { maxUncertaintyMs: 0 } })).rejects.toThrow(/Measured browser clock failed/);
    expect(calibration).toHaveBeenCalledWith(expect.any(String), expect.any(Array), { maxUncertaintyMs: 0 });
    calibration.mockClear();
    await expect(capture(plan, workDir(), noNarration, { mediaClock: { maxOffsetDriftMs: -1 } })).rejects.toThrow(/Invalid media clock limit/);
    expect(calibration).not.toHaveBeenCalled();
  }, 60_000);

  it('records through a caller-supplied session factory', async () => {
    let outsideRequests = 0;
    const outside = await serve((_request, response) => { outsideRequests++; response.end('outside'); });
    const inside = await serve((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(`<main id="app">App</main><img src="${outside}/pixel">`); });
    const factoryOrigins: string[] = [];
    const createSession: CreateBrowserSession = async (browser, origin, options) => {
      factoryOrigins.push(origin);
      const context = await browser.newContext(options);
      return { context, assertBoundary: () => undefined };
    };
    const plan = makePlan(inside, '#app');
    const ready = await checkTargetReady(plan, { createSession });
    expect(ready.ready).toBe(true);
    const result = await capture(plan, workDir(), noNarration, { createSession });
    expect(result.assertions?.every((assertion) => assertion.passed)).toBe(true);
    expect(factoryOrigins).toEqual([new URL(inside).origin, new URL(inside).origin]);
    expect(outsideRequests).toBeGreaterThan(0);
  }, 60_000);

  it('clicks a target inside a same-page iframe that is offset from the page origin', async () => {
    const inside = await serve((request, response) => {
      response.setHeader('Content-Type', 'text/html');
      if (request.url === '/screen') response.end('<button id="go" style="margin:40px" onclick="this.textContent=\'Clicked\'">Go</button>');
      else response.end('<body style="margin:0"><iframe id="phone" src="/screen" style="position:absolute;left:300px;top:90px;width:240px;height:200px;border:6px solid #222"></iframe></body>');
    });
    const plan = makePlan(inside, '#phone >> internal:control=enter-frame >> #go');
    plan.presentation.cursor = 'pointer';
    plan.scenes[0]!.actions = [{ id: 'press-go', type: 'click', selector: '#phone >> internal:control=enter-frame >> #go' }];
    plan.scenes[0]!.assertions = [{ selector: '#phone >> internal:control=enter-frame >> text=Clicked', kind: 'visible' }];
    plan.wordingApproval = { sha256: computeWordingApprovalHash(plan) };
    const result = await capture(planSchema.parse(plan), workDir(), noNarration);
    expect(result.assertions).toEqual([expect.objectContaining({ passed: true })]);
  }, 60_000);

  it('waits for the ready hook on the recorded page before the first scene', async () => {
    const inside = await serve((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<main id="app">Loading</main>'); });
    const plan = makePlan(inside, 'main[data-ready="yes"]');
    const result = await capture(plan, workDir(), noNarration, {
      createSession: isolatedContext,
      ready: async (page) => { await page.evaluate(() => { document.querySelector('main')!.setAttribute('data-ready', 'yes'); }); },
    });
    expect(result.assertions).toEqual([expect.objectContaining({ passed: true })]);
  }, 60_000);
});
