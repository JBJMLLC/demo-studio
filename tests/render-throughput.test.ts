import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { bundleCacheKey, cachedBundle, mapLimited, renderConcurrency } from '../src/render.js';

const scratch: string[] = [];
afterEach(async () => { for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'render-throughput-'));
  scratch.push(dir);
  return dir;
}
async function runtime() {
  const dir = await tempDir();
  await writeFile(join(dir, 'composition.js'), 'export const a = 1;');
  await writeFile(join(dir, 'zoom.js'), 'export const z = 1;');
  return { dir, entry: join(dir, 'composition.js') };
}
const fakeBuild = (calls: string[]) => async (outDir: string) => {
  calls.push(outDir);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'index.html'), '<html></html>');
};

it('renders with half the cores by default, within 2-8, and honours a configured count up to the cores', () => {
  expect(renderConcurrency({}, 16)).toBe(8);
  expect(renderConcurrency({}, 32)).toBe(8);
  expect(renderConcurrency({}, 6)).toBe(3);
  expect(renderConcurrency({}, 2)).toBe(2);
  expect(renderConcurrency({ DEMO_STUDIO_RENDER_CONCURRENCY: '4' }, 16)).toBe(4);
  expect(renderConcurrency({ DEMO_STUDIO_RENDER_CONCURRENCY: '64' }, 16)).toBe(16);
  expect(renderConcurrency({ DEMO_STUDIO_RENDER_CONCURRENCY: 'lots' }, 16)).toBe(8);
});

it('builds a composition bundle once and reuses it until a runtime module or the bundler changes', async () => {
  const { dir, entry } = await runtime();
  const cacheDirectory = await tempDir();
  const calls: string[] = [];
  const first = await cachedBundle(entry, { cacheDirectory, build: fakeBuild(calls), version: '1' });
  expect(await cachedBundle(entry, { cacheDirectory, build: fakeBuild(calls), version: '1' })).toBe(first);
  expect(calls).toHaveLength(1);
  expect((await readdir(cacheDirectory)).filter((name) => name.includes('.tmp-'))).toEqual([]);

  const key = await bundleCacheKey(entry, '1');
  await writeFile(join(dir, 'zoom.js'), 'export const z = 2;');
  expect(await bundleCacheKey(entry, '1')).not.toBe(key);
  expect(await bundleCacheKey(entry, '2')).not.toBe(await bundleCacheKey(entry, '1'));
  expect(await cachedBundle(entry, { cacheDirectory, build: fakeBuild(calls), version: '1' })).not.toBe(first);
  expect(calls).toHaveLength(2);
});

it('a failed bundle build leaves nothing in the cache', async () => {
  const { entry } = await runtime();
  const cacheDirectory = await tempDir();
  await expect(cachedBundle(entry, { cacheDirectory, version: '1', build: async (outDir) => { await mkdir(outDir); throw new Error('webpack failed'); } })).rejects.toThrow('webpack failed');
  expect(await readdir(cacheDirectory)).toEqual([]);
});

it('runs frame grabs with bounded concurrency and keeps their order', async () => {
  let active = 0;
  let peak = 0;
  const results = await mapLimited([30, 10, 20, 5, 15], 2, async (ms, index) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((done) => setTimeout(done, ms));
    active -= 1;
    return index;
  });
  expect(results).toEqual([0, 1, 2, 3, 4]);
  expect(peak).toBe(2);
});
