import { mkdir, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { chromium, type Page, type Locator, type Browser, type BrowserContextOptions } from 'playwright';
import type { DemoPlan, CaptureResult, NarrationResult } from './schemas.js';
import { buildMediaClockRuntimeSource, calibrateVideo, type MarkerBracketEvent } from './media-clock.js';
import { fileHash, jsonHash, mediaInfo, runBinary } from './media.js';

type Point = { x: number; y: number };
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Network isolation applies before redirects, popups, fetches, or subresources leave the context. */
export async function isolatedContext(browser: Browser, origin: string, options: BrowserContextOptions = {}) {
  const context = await browser.newContext({ ...options, serviceWorkers: 'block' });
  let denied = false;
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin === origin) {
      // continue() can follow redirects without invoking another route handler.
      // Fetch one hop at a time, validating every destination before sending it.
      const response = await route.fetch({ maxRedirects: 0, maxRetries: 0 });
      const location = response.headers()['location'];
      if (![301, 302, 303, 307, 308].includes(response.status()) || !location) {
        try { await route.fulfill({ response }); } finally { await response.dispose(); }
        return;
      }
      // Refuse redirects rather than silently serving a different document at
      // the original URL. Configure the canonical target URL for this adapter.
      await response.dispose();
    }
    denied = true;
    await route.abort('blockedbyclient');
  });
  await context.routeWebSocket('**/*', (socket) => {
    const url = new URL(socket.url());
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    if (url.origin === origin) socket.connectToServer();
    else { denied = true; socket.close({ code: 1008, reason: 'Configured origin only' }); }
  });
  return { context, assertBoundary: () => { if (denied) throw new Error('Browser refused an off-origin request or HTTP redirect'); } };
}

export async function checkTargetReady(plan: DemoPlan) {
  const browser = await chromium.launch({ headless: true });
  try {
    const { context, assertBoundary } = await isolatedContext(browser, new URL(plan.targetUrl).origin, { viewport: plan.viewport });
    const page = await context.newPage();
    const response = await page.goto(plan.targetUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    if (!response || !response.ok()) throw new Error('Target did not return a successful document');
    if (new URL(page.url()).origin !== new URL(plan.targetUrl).origin) throw new Error('Target redirected outside the configured origin');
    assertBoundary();
    return { ready: true, evidenceHash: jsonHash({ status: response.status(), documentHash: jsonHash((await response.body()).toString('utf8')), title: await page.title(), viewport: plan.viewport }) };
  } finally { await browser.close(); }
}

async function move(page: Page, from: Point, to: Point, duration = 380) {
  const steps = 15;
  const started = performance.now();
  for (let step = 1; step <= steps; step++) {
    const t = step / steps;
    const eased = 1 - (1 - t) ** 3;
    await page.mouse.move(from.x + (to.x - from.x) * eased, from.y + (to.y - from.y) * eased);
    await sleep(Math.max(0, started + duration * step / steps - performance.now()));
  }
}

async function center(locator: Locator): Promise<Point> {
  await locator.waitFor({ state: 'visible', timeout: 10_000 });
  await locator.scrollIntoViewIfNeeded({ timeout: 10_000 });
  const box = await locator.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) throw new Error('Action target has no visible geometry');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export async function capture(plan: DemoPlan, workDir: string, narration: NarrationResult): Promise<CaptureResult> {
  const directory = resolve(workDir, 'capture');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const browser = await chromium.launch({ headless: true });
  const { context, assertBoundary } = await isolatedContext(browser, new URL(plan.targetUrl).origin, { viewport: plan.viewport, recordVideo: { dir: directory, size: plan.viewport }, reducedMotion: 'reduce' });
  let pointer: Point = { x: Math.round(plan.viewport.width * .78), y: Math.round(plan.viewport.height * .72) };
  await context.addInitScript(({ initial, cursor }) => {
    const attach = () => {
      if (cursor === 'hidden' || document.getElementById('__demo_studio_pointer')) return;
      let position = initial;
      try { position = JSON.parse(sessionStorage.getItem('__demo_studio_pointer_position') || 'null') || initial; } catch { /* use initial point */ }
      const node = document.createElement('div');
      node.id = '__demo_studio_pointer'; node.setAttribute('aria-hidden', 'true');
      node.style.cssText = `position:fixed;left:${position.x}px;top:${position.y}px;z-index:2147483646;pointer-events:none;width:24px;height:30px;filter:drop-shadow(0 1px 2px #0008)`;
      node.innerHTML = cursor === 'circle'
        ? '<svg width="24" height="24"><circle cx="12" cy="12" r="9" fill="#6c5ce750" stroke="white" stroke-width="2"/></svg>'
        : '<svg width="24" height="30" viewBox="0 0 24 30"><path d="M2 1 L2 24 L8 18 L13 28 L17 26 L12 16 L22 16 Z" fill="#20233b" stroke="white" stroke-width="2"/></svg>';
      document.documentElement.appendChild(node);
      document.addEventListener('mousemove', (event) => {
        node.style.left = `${event.clientX}px`; node.style.top = `${event.clientY}px`;
        try { sessionStorage.setItem('__demo_studio_pointer_position', JSON.stringify({ x: event.clientX, y: event.clientY })); } catch { /* storage can be disabled */ }
      });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach); else attach();
  }, { initial: pointer, cursor: plan.presentation.cursor });
  const page = await context.newPage();
  const video = page.video();
  const markers: MarkerBracketEvent[] = [];
  const marker = new Function('emit', `${buildMediaClockRuntimeSource()}; return calibrate;`)((event: MarkerBracketEvent) => markers.push(event)) as (page: Page, id: string, phase: string) => Promise<void>;
  const scenes: CaptureResult['scenes'] = [];
  const events: CaptureResult['events'] = [];
  const assertions: NonNullable<CaptureResult['assertions']> = [];
  let firstWorkerMs = 0, lastWorkerMs = 0;
  let activeSceneId: string | null = null, activeActionId: string | null = null;
  try {
    const initialResponse = await page.goto(plan.targetUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    if (!initialResponse?.ok() || new URL(page.url()).origin !== new URL(plan.targetUrl).origin) throw new Error('Capture target readiness changed');
    assertBoundary();
    await page.mouse.move(pointer.x, pointer.y);
    await marker(page, 'main', 'start');
    await sleep(180);
    for (const scene of plan.scenes) {
      activeSceneId = scene.id; activeActionId = null;
      const startMs = performance.now();
      if (!firstWorkerMs) firstWorkerMs = startMs;
      const cursorStart = plan.presentation.cursor === 'hidden' ? null : { ...pointer };
      const beforeFrame = resolve(directory, `${scene.id}-before.png`);
      await page.screenshot({ path: beforeFrame });
      for (const action of scene.actions) {
        activeActionId = action.id;
        const locator = action.selector ? page.locator(action.selector) : undefined;
        const target = locator ? await center(locator) : pointer;
        const approach = ['click', 'type', 'drag'].includes(action.type) ? 380 : 0;
        if (action.atMs !== undefined) await sleep(Math.max(0, startMs + action.atMs - approach - 140 - performance.now()));
        if (approach) { await move(page, pointer, target, approach); pointer = target; await sleep(140); }
        const atMs = performance.now();
        switch (action.type) {
          case 'navigate': {
            const url = new URL(action.url || '/', plan.targetUrl);
            if (url.origin !== new URL(plan.targetUrl).origin) throw new Error('Navigation outside configured origin refused');
            await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 20_000 });
            if (new URL(page.url()).origin !== new URL(plan.targetUrl).origin) throw new Error('Navigation redirected outside configured origin');
            await page.mouse.move(pointer.x, pointer.y); break;
          }
          case 'click': {
            if (!await locator!.isEnabled() || !await locator!.evaluate((element, point) => { const hit = document.elementFromPoint(point.x, point.y); return hit === element || (hit !== null && element.contains(hit)); }, pointer)) throw new Error('Click target is disabled or occluded');
            await page.mouse.click(pointer.x, pointer.y); break;
          }
          case 'type':
            await locator!.focus(); await locator!.fill('');
            for (const char of action.value || '') await page.keyboard.insertText(char).then(() => sleep(150 + (char.charCodeAt(0) % 55)));
            break;
          case 'drag': {
            const destination = await center(page.locator(action.toSelector!));
            await page.mouse.down(); await move(page, pointer, destination, 600); await page.mouse.up(); pointer = destination; break;
          }
          case 'press': await locator!.press(action.value!); break;
          case 'wait': await sleep(action.durationMs!); break;
        }
        if (new URL(page.url()).origin !== new URL(plan.targetUrl).origin) throw new Error('Action left the configured origin');
        assertBoundary();
        events.push({ id: action.id, sceneId: scene.id, type: action.type, atMs, endMs: performance.now(), cursor: plan.presentation.cursor === 'hidden' ? null : { ...pointer }, ...(action.spokenAnchor ? { spokenAnchor: action.spokenAnchor } : {}) });
      }
      for (const assertion of scene.assertions) {
        const locator = page.locator(assertion.selector);
        await locator.waitFor({ state: 'visible', timeout: 10_000 });
        const box = await locator.boundingBox();
        if (!box || box.x < 0 || box.y < 0 || box.x + box.width > plan.viewport.width + 1 || box.y + box.height > plan.viewport.height + 1) throw new Error('Visible proof does not fit the recording viewport');
        const text = assertion.kind === 'text' ? await locator.textContent() : null;
        const passed = assertion.kind === 'visible' || text?.includes(assertion.value || '') === true;
        assertions.push({ sceneId: scene.id, selector: assertion.selector, kind: assertion.kind, passed, ...(text !== null ? { observedValueSha256: jsonHash(text) } : {}) });
        if (!passed) throw new Error(`Scene ${scene.id} failed its visible product assertion`);
      }
      const track = narration.tracks.find((entry) => entry.sceneId === scene.id);
      const readableMs = track?.durationMs ?? Math.max(2800, scene.say.split(/\s+/).length * 290);
      await sleep(Math.max(scene.holdMs, startMs + readableMs + scene.holdMs - performance.now()));
      const afterFrame = resolve(directory, `${scene.id}-after.png`);
      await page.screenshot({ path: afterFrame });
      assertBoundary();
      lastWorkerMs = performance.now();
      scenes.push({ id: scene.id, startMs, endMs: lastWorkerMs, beforeFrame: relative(workDir, beforeFrame), afterFrame: relative(workDir, afterFrame), cursorStart, cursorEnd: plan.presentation.cursor === 'hidden' ? null : { ...pointer }, ...(track ? { audio: { startMs, endMs: startMs + track.durationMs, sourceDurationMs: track.durationMs, sha256: track.sha256, playbackRate: 1 } } : {}) });
    }
    await marker(page, 'main', 'end');
    await context.close();
    if (!video) throw new Error('Browser did not create a recording');
    const raw = await video.path();
    const calibration = calibrateVideo(raw, markers);
    if (!calibration.ok) throw new Error(`Measured browser clock failed: ${calibration.error}`);
    const origin = calibration.workerToVideoMs(firstWorkerMs);
    const end = calibration.workerToVideoMs(lastWorkerMs);
    if (origin < 0 || end <= origin) throw new Error('Invalid measured capture bounds');
    const normalized = resolve(directory, 'recording.mp4');
    await runBinary('ffmpeg', ['-y', '-i', raw, '-ss', String(origin / 1000), '-t', String((end - origin) / 1000), '-r', String(plan.fps), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', normalized]);
    const recordingSha256 = await fileHash(normalized);
    const mappedScenes = scenes.map((scene) => ({ ...scene, startMs: scene.startMs - firstWorkerMs, endMs: scene.endMs - firstWorkerMs, ...(scene.audio ? { audio: { ...scene.audio, startMs: scene.audio.startMs - firstWorkerMs, endMs: scene.audio.endMs - firstWorkerMs } } : {}) }));
    const mappedEvents = events.map((event) => ({ ...event, atMs: event.atMs - firstWorkerMs, endMs: event.endMs! - firstWorkerMs }));
    const info = await mediaInfo(normalized);
    const result: CaptureResult = { recordings: [relative(workDir, normalized)], width: plan.viewport.width, height: plan.viewport.height, fps: 30, durationMs: info.durationMs, scenes: mappedScenes, events: mappedEvents, assertions, clock: { originMs: origin, verified: true, uncertaintyMs: calibration.uncertaintyMs ?? undefined, recordingSha256 } };
    await writeFile(resolve(directory, 'clock.json'), JSON.stringify({ recordingId: 'main', offsetMs: calibration.offsetMs, uncertaintyMs: calibration.uncertaintyMs, driftMs: calibration.driftMs, originMs: origin, recordingSha256, playbackRate: 1, markers }, null, 2), { mode: 0o600 });
    await writeFile(resolve(directory, 'capture.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const code = message.startsWith('Visible proof') ? 'PROOF_OUTSIDE_VIEWPORT' : message.startsWith('Click target') ? 'TARGET_OCCLUDED' : message.startsWith('Measured browser clock') ? 'CLOCK_CALIBRATION_FAILED' : 'CAPTURE_FAILED';
    await page.screenshot({ path: resolve(directory, 'diagnostic-failure.png') }).catch(() => undefined);
    await writeFile(resolve(directory, 'failure.json'), JSON.stringify({ schemaVersion: 1, diagnosticOnly: true, sceneId: activeSceneId, actionId: activeActionId, code }, null, 2), { mode: 0o600 });
    throw error;
  } finally { await browser.close(); }
}
