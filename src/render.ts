import { bundle } from '@remotion/bundler';
import { ensureBrowser, renderMedia, selectComposition } from '@remotion/renderer';
import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { CaptureResult, DemoPlan, NarrationResult, RenderResult } from './schemas.js';
import type { VideoProps } from './composition.js';
import { missionPath } from './store.js';
import { planZoom } from './zoom.js';
import { writeJsonAtomic } from './store.js';
import { fileHash, mediaInfo, runBinary, MediaIntegrityError, verifyFirstFrameIntegrity } from './media.js';

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
    const props: VideoProps = { recordingUrl: media.urls.get(recording)!, width: capture.width, height: capture.height, durationInFrames, audio, captionBandHeight, zoom: { scale: plan.presentation.zoom, windows: plan.presentation.zoom > 1 ? planZoom(capture.events, plan.fps, durationInFrames) : [] }, captions: plan.presentation.captions ? capture.scenes.flatMap((scene) => captionChunks(plan.scenes.find((entry) => entry.id === scene.id)!.say, Math.round(scene.startMs * plan.fps / 1000), Math.round(scene.endMs * plan.fps / 1000))) : [] };
    const nearby = fileURLToPath(new URL('./composition.js', import.meta.url));
    const source = fileURLToPath(new URL('./composition.tsx', import.meta.url));
    // The installed runtime is checksum-verified and immutable. Remotion's
    // default Webpack cache is rooted beside its package.json, so disable that
    // cache instead of allowing build output inside the verified package.
    const serveUrl = await bundle({ entryPoint: existsSync(nearby) ? nearby : source, outDir: resolve(directory, 'bundle'), enableCaching: false });
    // Render with Remotion's pinned Chrome Headless Shell, not Playwright's Chromium:
    // newer full Chromium builds return tiled, mis-scaled frame screenshots.
    await ensureBrowser();
    const composition = await selectComposition({ serveUrl, id: 'Demo', inputProps: props });
    const videoPath = resolve(directory, 'demo.mp4');
    await renderMedia({ composition, serveUrl, codec: 'h264', outputLocation: videoPath, inputProps: props, concurrency: 2, overwrite: true, onProgress: ({ renderedFrames, encodedFrames }) => writeJsonAtomic(resolve(directory, 'progress.json'), { schemaVersion: 1, renderedFrames, encodedFrames, totalFrames: durationInFrames }) });
    const info = await mediaInfo(videoPath);
    if (Math.abs(info.durationMs - durationInFrames / plan.fps * 1000) > 100 || info.width !== capture.width || info.height !== capture.height || info.hasAudio !== (audio.length > 0)) throw new Error('Final media does not match its composition');
    try {
      const firstFrame = await verifyFirstFrameIntegrity(recording, videoPath, capture.width, capture.height, captionBandHeight);
      writeJsonAtomic(resolve(directory, 'first-frame-integrity.json'), { schemaVersion: 1, ...firstFrame });
    } catch (error) {
      if (error instanceof MediaIntegrityError) writeJsonAtomic(resolve(directory, 'first-frame-integrity.json'), { schemaVersion: 1, pass: false, code: error.code, threshold: error.threshold, ...(error.score === undefined ? {} : { score: error.score }) });
      throw error;
    }
    const points = new Set<number>([0, Math.max(0, info.durationMs - 100)]);
    for (let ms = 0; ms < info.durationMs; ms += 2000) points.add(ms);
    for (const event of capture.events) for (const delta of [-250, 0, 500]) points.add(Math.min(Math.max(0, event.atMs + delta), info.durationMs - 100));
    for (const scene of capture.scenes) points.add(Math.min(scene.endMs, info.durationMs - 100));
    const frames: string[] = [];
    const samples = [...points].sort((a, b) => a - b);
    for (let index = 0; index < samples.length; index++) {
      const path = resolve(directory, `frame-${String(index).padStart(3, '0')}.png`);
      await runBinary('ffmpeg', ['-y', '-ss', String(samples[index] / 1000), '-i', videoPath, '-frames:v', '1', path]);
      frames.push(`render/frame-${String(index).padStart(3, '0')}.png`);
    }
    const posterPath = 'render/poster.png';
    await runBinary('ffmpeg', ['-y', '-ss', String(Math.max(0, info.durationMs / 1000 - 1.5)), '-i', videoPath, '-frames:v', '1', resolve(missionDir, posterPath)]);
    const sha256 = await fileHash(videoPath);
    await writeFile(resolve(directory, 'timeline.json'), JSON.stringify({ schemaVersion: 1, fps: plan.fps, durationMs: info.durationMs, playbackRate: 1, captionBandHeight, viewportTransform: { scale: (capture.height - captionBandHeight) / capture.height, offsetX: capture.width * captionBandHeight / capture.height / 2, offsetY: 0 }, zoom: props.zoom, videoHash: sha256, scenes: capture.scenes, events: capture.events, samples: samples.map((atMs, index) => ({ atMs, path: frames[index] })) }, null, 2), { mode: 0o600 });
    return { videoPath: 'render/demo.mp4', posterPath, durationMs: info.durationMs, sampledFrames: frames, timelinePath: 'render/timeline.json', sha256, playbackRate: 1, hasAudio: info.hasAudio };
  } finally { await media.close(); }
}
