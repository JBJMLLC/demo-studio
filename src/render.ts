import { bundle } from '@remotion/bundler';
import { ensureBrowser, renderMedia, selectComposition } from '@remotion/renderer';
import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { availableParallelism, homedir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import type { CaptureResult, DemoPlan, NarrationResult, RenderResult } from './schemas.js';
import type { VideoProps } from './composition.js';
import { missionPath } from './store.js';
import { planZoom } from './zoom.js';
import { writeJsonAtomic } from './store.js';
import { fileHash, mediaInfo, runBinary, MediaIntegrityError, verifyFirstFrameIntegrity } from './media.js';

type RemotionRenderApi = Pick<typeof import('@remotion/renderer'), 'ensureBrowser' | 'selectComposition' | 'renderMedia'>;
type RemotionRenderRequest = Omit<Parameters<typeof renderMedia>[0], 'composition' | 'logLevel'> & { id: string };

/**
 * Remotion's default `info` logger writes to stdout, which is the MCP stdio
 * JSON-RPC transport. Keep routine browser-download and render progress off
 * that protocol channel; errors remain available on stderr.
 */
export async function renderWithProtocolSafeLogs(api: RemotionRenderApi, request: RemotionRenderRequest): Promise<void> {
  await api.ensureBrowser({ logLevel: 'error' });
  const composition = await api.selectComposition({
    serveUrl: request.serveUrl,
    id: request.id,
    inputProps: request.inputProps,
    logLevel: 'error',
  });
  const { id: _id, ...renderOptions } = request;
  await api.renderMedia({ ...renderOptions, composition, logLevel: 'error' });
}

/** Only explicitly admitted media files are served. No directory browsing or path translation. */
export async function serveMedia(files: string[]) {
  const allowed = new Map(files.map((path) => [`/${randomUUID()}${extname(path)}`, path]));
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    const path = allowed.get(pathname);
    if (!path || !['GET', 'HEAD'].includes(request.method || '')) { response.writeHead(404).end(); return; }
    try {
      const size = (await stat(path)).size;
      const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) { response.writeHead(416).end(); return; }
      response.writeHead(range ? 206 : 200, { 'Content-Type': ({ '.mp4': 'video/mp4', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.webm': 'video/webm' } as Record<string, string>)[extname(path)] || 'application/octet-stream', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
      if (request.method === 'HEAD') response.end(); else createReadStream(path, { start, end }).pipe(response);
    } catch { response.writeHead(500).end(); }
  });
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Media server did not bind');
  const urls = new Map([...allowed.entries()].map(([key, path]) => [path, `http://127.0.0.1:${address.port}${key}`]));
  return { urls, close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }) };
}

function captionChunks(text: string, startFrame: number, endFrame: number) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const count = Math.max(1, Math.ceil(words.length / 14));
  return Array.from({ length: count }, (_, index) => ({ text: words.slice(index * 14, (index + 1) * 14).join(' '), startFrame: Math.round(startFrame + (endFrame - startFrame) * index / count), endFrame: Math.round(startFrame + (endFrame - startFrame) * (index + 1) / count) })).filter((entry) => entry.text);
}

/**
 * Times (ms) at which to sample review frames from the final video. Every time is at least 100 ms
 * before the end: the container duration can run past the last video frame (the audio track may be a
 * few ms longer), and ffmpeg writes no file for a seek at or past the last frame, which then fails
 * the render's artifact check.
 */
export function sampleTimes(durationMs: number, capture: Pick<CaptureResult, 'events' | 'scenes'>): number[] {
  const last = Math.max(0, durationMs - 100);
  const clamp = (ms: number) => Math.min(Math.max(0, ms), last);
  const points = new Set<number>([0, last]);
  for (let ms = 0; ms < durationMs; ms += 2000) points.add(clamp(ms));
  for (const event of capture.events) for (const delta of [-250, 0, 500]) points.add(clamp(event.atMs + delta));
  for (const scene of capture.scenes) points.add(clamp(scene.endMs));
  return [...points].sort((a, b) => a - b);
}

/**
 * Remotion's frame concurrency: DEMO_STUDIO_RENDER_CONCURRENCY when it is a positive integer
 * (capped at the core count), else half the cores, between 2 and 8. Each unit is one headless
 * browser tab, so a machine running several renders at once should set it lower.
 */
export function renderConcurrency(env: NodeJS.ProcessEnv = process.env, cores = availableParallelism()): number {
  const configured = Number(env.DEMO_STUDIO_RENDER_CONCURRENCY);
  if (Number.isInteger(configured) && configured >= 1) return Math.min(configured, cores);
  return Math.max(2, Math.min(8, Math.floor(cores / 2)));
}

/**
 * Identifies a composition bundle: every module beside the entry point (the composition and
 * what it imports) plus the bundler version. A rebuilt runtime gets a new key.
 */
export async function bundleCacheKey(entryPoint: string, bundlerVersion: string): Promise<string> {
  const directory = dirname(entryPoint);
  const hash = createHash('sha256').update(`bundler ${bundlerVersion}\nentry ${entryPoint.slice(directory.length)}\n`);
  const names = (await readdir(directory)).filter((name) => /\.(js|ts|tsx)$/.test(name) && !name.endsWith('.d.ts')).sort();
  for (const name of names) hash.update(`${name}\n`).update(await readFile(join(directory, name))).update('\n');
  return hash.digest('hex').slice(0, 32);
}

const bundlerVersion = (): string => {
  try { return (createRequire(import.meta.url)('@remotion/bundler/package.json') as { version: string }).version; }
  catch { return 'unknown'; }
};

/**
 * The Remotion bundle for `entryPoint`, built once per key into a cache shared by every render on
 * the machine (DEMO_STUDIO_RENDER_CACHE_DIR, else ~/.cache/demo-studio/remotion-bundles), instead
 * of a fresh Webpack build per render. Built into a private folder and renamed into place, so a
 * concurrent render never serves a half-written bundle. The cache stays outside the installed
 * runtime, which is checksum-verified and immutable.
 */
export async function cachedBundle(entryPoint: string, options: { cacheDirectory?: string; build?: (outDir: string) => Promise<unknown>; version?: string } = {}): Promise<string> {
  const cacheDirectory = resolve(options.cacheDirectory ?? process.env.DEMO_STUDIO_RENDER_CACHE_DIR ?? join(homedir(), '.cache', 'demo-studio', 'remotion-bundles'));
  const target = join(cacheDirectory, await bundleCacheKey(entryPoint, options.version ?? bundlerVersion()));
  if (existsSync(join(target, 'index.html'))) return target;
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const building = `${target}.tmp-${randomUUID()}`;
  const build = options.build ?? ((outDir: string) => bundle({ entryPoint, outDir, enableCaching: false }));
  try {
    await build(building);
    await rename(building, target);
  } catch (error) {
    // Another render finished the same bundle first: use theirs.
    if (!existsSync(join(target, 'index.html'))) throw error;
  } finally {
    await rm(building, { recursive: true, force: true });
  }
  return target;
}

/** Runs `task` over `items` with at most `limit` in flight, keeping results in order. */
export async function mapLimited<T, R>(items: T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

export async function render(plan: DemoPlan, capture: CaptureResult, narration: NarrationResult, missionDir: string): Promise<RenderResult> {
  if (capture.recordings.length !== 1 || !capture.clock.verified) throw new Error('Render requires a single verified continuous recording');
  const directory = resolve(missionDir, 'render');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const recording = missionPath(missionDir, capture.recordings[0], true);
  const media = await serveMedia([recording, ...narration.tracks.map((track) => missionPath(missionDir, track.path, true))]);
  try {
    const audio = narration.tracks.map((track) => {
      const scene = capture.scenes.find((entry) => entry.id === track.sceneId);
      if (!scene?.audio || scene.audio.playbackRate !== 1 || scene.audio.sha256 !== track.sha256) throw new Error('Narration timeline does not match captured scene');
      return { url: media.urls.get(missionPath(missionDir, track.path, true))!, startFrame: Math.round(scene.audio.startMs * plan.fps / 1000), frames: Math.ceil(track.durationMs * plan.fps / 1000) };
    });
    const durationInFrames = Math.ceil(Math.max(capture.durationMs * plan.fps / 1000, ...audio.map((track) => track.startFrame + track.frames + plan.fps)));
    const captionBandHeight = plan.presentation.captions ? Math.min(Math.max(72, Math.round(capture.height * .08)), Math.floor(capture.height * .2)) : 0;
    const props: VideoProps = { recordingUrl: media.urls.get(recording)!, width: capture.width, height: capture.height, durationInFrames, audio, captionBandHeight, zoom: { scale: plan.presentation.zoom, windows: plan.presentation.zoom > 1 ? planZoom(capture.events, plan.fps, durationInFrames, { width: capture.width, height: capture.height }, plan.presentation.zoom) : [] }, captions: plan.presentation.captions ? capture.scenes.flatMap((scene) => captionChunks(plan.scenes.find((entry) => entry.id === scene.id)!.say, Math.round(scene.startMs * plan.fps / 1000), Math.round(scene.endMs * plan.fps / 1000))) : [] };
    const nearby = fileURLToPath(new URL('./composition.js', import.meta.url));
    const source = fileURLToPath(new URL('./composition.tsx', import.meta.url));
    // The installed runtime is checksum-verified and immutable. Remotion's
    // default Webpack cache is rooted beside its package.json, so it stays off;
    // the finished bundle is cached outside the package instead (cachedBundle).
    const serveUrl = await cachedBundle(existsSync(nearby) ? nearby : source);
    // Render with Remotion's pinned Chrome Headless Shell, not Playwright's Chromium:
    // newer full Chromium builds return tiled, mis-scaled frame screenshots.
    const videoPath = resolve(directory, 'demo.mp4');
    await renderWithProtocolSafeLogs({ ensureBrowser, selectComposition, renderMedia }, {
      serveUrl,
      id: 'Demo',
      codec: 'h264',
      outputLocation: videoPath,
      inputProps: props,
      concurrency: renderConcurrency(),
      overwrite: true,
      onProgress: ({ renderedFrames, encodedFrames }) => writeJsonAtomic(resolve(directory, 'progress.json'), { schemaVersion: 1, renderedFrames, encodedFrames, totalFrames: durationInFrames }),
    });
    const info = await mediaInfo(videoPath);
    if (Math.abs(info.durationMs - durationInFrames / plan.fps * 1000) > 100 || info.width !== capture.width || info.height !== capture.height || info.hasAudio !== (audio.length > 0)) throw new Error('Final media does not match its composition');
    try {
      const firstFrame = await verifyFirstFrameIntegrity(recording, videoPath, capture.width, capture.height, captionBandHeight);
      writeJsonAtomic(resolve(directory, 'first-frame-integrity.json'), { schemaVersion: 1, ...firstFrame });
    } catch (error) {
      if (error instanceof MediaIntegrityError) writeJsonAtomic(resolve(directory, 'first-frame-integrity.json'), { schemaVersion: 1, pass: false, code: error.code, threshold: error.threshold, ...(error.score === undefined ? {} : { score: error.score }) });
      throw error;
    }
    const samples = sampleTimes(info.durationMs, capture);
    // One short seek-and-grab per sample; they are independent, so several run at once.
    const frames = await mapLimited(samples, Math.min(8, availableParallelism()), async (atMs, index) => {
      const name = `frame-${String(index).padStart(3, '0')}.png`;
      await runBinary('ffmpeg', ['-y', '-ss', String(atMs / 1000), '-i', videoPath, '-frames:v', '1', resolve(directory, name)]);
      return `render/${name}`;
    });
    const posterPath = 'render/poster.png';
    await runBinary('ffmpeg', ['-y', '-ss', String(Math.max(0, info.durationMs / 1000 - 1.5)), '-i', videoPath, '-frames:v', '1', resolve(missionDir, posterPath)]);
    const sha256 = await fileHash(videoPath);
    await writeFile(resolve(directory, 'timeline.json'), JSON.stringify({ schemaVersion: 1, fps: plan.fps, durationMs: info.durationMs, playbackRate: 1, captionBandHeight, viewportTransform: { scale: (capture.height - captionBandHeight) / capture.height, offsetX: capture.width * captionBandHeight / capture.height / 2, offsetY: 0 }, zoom: props.zoom, videoHash: sha256, scenes: capture.scenes, events: capture.events, samples: samples.map((atMs, index) => ({ atMs, path: frames[index] })) }, null, 2), { mode: 0o600 });
    return { videoPath: 'render/demo.mp4', posterPath, durationMs: info.durationMs, sampledFrames: frames, timelinePath: 'render/timeline.json', sha256, playbackRate: 1, hasAudio: info.hasAudio };
  } finally { await media.close(); }
}
