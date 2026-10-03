import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';

export interface PresentationEdgeBracket {
  state: 0 | 1;
  precedingFrameIndex: number;
  firstChangedFrameIndex: number;
  precedingTimeMs: number;
  firstChangedTimeMs: number;
  stableFrames: number;
  confidence: number;
}

export interface UniformMarkerDescriptor {
  kind: 'uniform-rgb';
  rect: { x: number; y: number; width: number; height: number };
  offRgb: readonly [number, number, number];
  onRgb: readonly [number, number, number];
  /** Per-channel compression allowance, not a timing tolerance. */
  maxChannelError?: number;
  minMatchedFraction?: number;
}

/** Explicit color bounds with a declared off-state, not inferred background RGB. */
export interface ColorRangeMarkerDescriptor {
  kind: 'rgb-range';
  rect: { x: number; y: number; width: number; height: number };
  on: {
    minRgb: readonly [number, number, number];
    maxRgb: readonly [number, number, number];
    minMatchedFraction: number;
  };
  off: { kind: 'not-on'; maxMatchedFraction: number };
}

export type MarkerDescriptor = UniformMarkerDescriptor | ColorRangeMarkerDescriptor;

export interface MarkerPresentationFrame {
  frameIndex: number;
  timestampMs: number;
  state: 0 | 1 | null;
  confidence: number;
}

export interface MarkerDecodeResult {
  ok: boolean;
  frames: MarkerPresentationFrame[];
  edges: PresentationEdgeBracket[];
  error?: string;
}

export interface MarkerDecodeOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  minStableFrames?: number;
  /** Each owned subprocess is bounded; no recording is modified. */
  timeoutMs?: number;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function stableCount(value: number): void {
  if (!Number.isInteger(value) || value < 2 || value > 120) throw new Error('Invalid stable frame count');
}

function validateDescriptor(value: MarkerDescriptor): void {
  if (value?.kind !== 'uniform-rgb' && value?.kind !== 'rgb-range') throw new Error('Unsupported marker descriptor');
  const r = value.rect;
  if (!r || ![r.x, r.y, r.width, r.height].every(Number.isInteger)
    || r.x < 0 || r.y < 0 || r.x > 8192 || r.y > 8192
    || r.width < 4 || r.height < 4 || r.width > 512 || r.height > 512) {
    throw new Error('Invalid marker rectangle');
  }
  const colors = value.kind === 'uniform-rgb' ? [value.offRgb, value.onRgb] : [value.on?.minRgb, value.on?.maxRgb];
  for (const color of colors) {
    if (!Array.isArray(color) || color.length !== 3
      || color.some(channel => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
      throw new Error('Invalid marker color');
    }
  }
  if (value.kind === 'rgb-range') {
    if (value.on.minRgb.some((channel, index) => channel > value.on.maxRgb[index])
      || !finite(value.on.minMatchedFraction) || value.on.minMatchedFraction <= 0.5 || value.on.minMatchedFraction > 1
      || value.off?.kind !== 'not-on' || !finite(value.off.maxMatchedFraction)
      || value.off.maxMatchedFraction < 0 || value.off.maxMatchedFraction >= 0.5) {
      throw new Error('Invalid color-range marker thresholds');
    }
    return;
  }
  const error = value.maxChannelError ?? 16;
  const fraction = value.minMatchedFraction ?? 0.9;
  if (!finite(error) || error < 0 || error > 64 || !finite(fraction) || fraction <= 0.5 || fraction > 1) {
    throw new Error('Invalid marker matching thresholds');
  }
  const separation = Math.max(...value.offRgb.map((channel, index) => Math.abs(channel - value.onRgb[index])));
  if (separation <= 2 * error) throw new Error('Marker colors have overlapping acceptance regions');
}

/** Preserve both sides of every transition; frame zero is never a predecessor. */
export function bracketMarkerEdges(frames: readonly MarkerPresentationFrame[], minStableFrames = 2): MarkerDecodeResult {
  const result: MarkerDecodeResult = { ok: false, frames: [...frames], edges: [] };
  const reject = (error: string) => ({ ...result, error });
  try { stableCount(minStableFrames); } catch { return reject('Invalid stable frame count'); }
  if (!frames.length) return reject('No decoded presentation frames');
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (!frame || frame.frameIndex !== i || !finite(frame.timestampMs) || frame.timestampMs < 0
      || ![0, 1, null].includes(frame.state) || !finite(frame.confidence) || frame.confidence < 0 || frame.confidence > 1
      || (i > 0 && frame.timestampMs <= frames[i - 1].timestampMs)) return reject('Malformed or discontinuous presentation frames');
  }
  // Unclassified frames are uncertainty, not permission to skip to a convenient edge.
  let incomplete = frames[0].state !== 0 || frames.some(frame => frame.state === null);
  for (let i = 1; i < frames.length;) {
    const frame = frames[i];
    const prior = frames[i - 1];
    if (frame.state === null || frame.state === prior.state) { i++; continue; }
    const state = frame.state;
    let end = i + 1;
    while (end < frames.length && frames[end].state === state) end++;
    if (prior.state === null || end - i < minStableFrames) {
      incomplete = true;
    } else {
      result.edges.push({
        state,
        precedingFrameIndex: prior.frameIndex,
        firstChangedFrameIndex: frame.frameIndex,
        precedingTimeMs: prior.timestampMs,
        firstChangedTimeMs: frame.timestampMs,
        stableFrames: end - i,
        confidence: Math.min(...frames.slice(i, end).map(value => value.confidence)),
      });
    }
    i = end;
  }
  if (incomplete || result.edges.length === 0 || result.edges.length % 2 !== 0
    || result.edges.some((edge, index) => edge.state !== (index % 2 === 0 ? 1 : 0))) {
    return reject('Missing or ambiguous leading/trailing marker edge');
  }
  return { ...result, ok: true };
}

function processBytes(command: string, args: string[], timeoutMs: number): Buffer {
  const child = spawnSync(command, args, {
    encoding: undefined,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (child.error || child.status !== 0 || !child.stdout) throw new Error('Marker decoding subprocess failed or exceeded its bound');
  return Buffer.from(child.stdout);
}

/**
 * Decode a finalized local file with the configured marker's original geometry.
 * Returned closed PTS brackets enclose each change; they are not point anchors,
 * confidence intervals, recording IDs, or proof of emitter/artifact identity.
 */
export function decodeMarkerEdges(videoPath: string, descriptor: MarkerDescriptor, options: MarkerDecodeOptions = {}): MarkerDecodeResult {
  let frames: MarkerPresentationFrame[] = [];
  try {
    validateDescriptor(descriptor);
    const minStableFrames = options.minStableFrames ?? 2;
    stableCount(minStableFrames);
    const timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new Error('Invalid decoding deadline');
    let file;
    try { file = lstatSync(videoPath); } catch { throw new Error('Finalized marker video is unavailable'); }
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('Finalized marker video must be a regular local file');
    const metadata = JSON.parse(processBytes(options.ffprobePath ?? 'ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_streams',
      '-show_entries', 'stream=width,height:frame=best_effort_timestamp_time', '-of', 'json', videoPath,
    ], timeoutMs).toString('utf8')) as { streams?: Array<{ width?: number; height?: number }>; frames?: Array<{ best_effort_timestamp_time?: string }> };
    const { rect } = descriptor;
    const stream = metadata.streams?.[0];
    if (!stream || !finite(stream.width) || !finite(stream.height)
      || rect.x + rect.width > stream.width || rect.y + rect.height > stream.height) throw new Error('Marker rectangle is outside the video frame');
    if (!Array.isArray(metadata.frames) || !metadata.frames.length || metadata.frames.length > 18_000) throw new Error('Invalid or oversized finalized frame inventory');
    const timestamps = metadata.frames.map(frame => Number(frame.best_effort_timestamp_time) * 1000);
    const raw = processBytes(options.ffmpegPath ?? 'ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', videoPath, '-map', '0:v:0',
      '-vf', `crop=${rect.width}:${rect.height}:${rect.x}:${rect.y}:exact=1,format=rgb24`,
      '-an', '-sn', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ], timeoutMs);
    const pixels = rect.width * rect.height;
    const stride = pixels * 3;
    if (raw.length !== timestamps.length * stride) throw new Error('Decoded frame bytes do not match finalized PTS inventory');
    const maxError = descriptor.kind === 'uniform-rgb' ? descriptor.maxChannelError ?? 16 : 0;
    const minimum = descriptor.kind === 'uniform-rgb' ? descriptor.minMatchedFraction ?? 0.9 : descriptor.on.minMatchedFraction;
    frames = timestamps.map((timestampMs, frameIndex) => {
      let off = 0;
      let on = 0;
      for (let pixel = 0; pixel < pixels; pixel++) {
        const start = frameIndex * stride + pixel * 3;
        if (descriptor.kind === 'uniform-rgb') {
          if (descriptor.offRgb.every((channel, index) => Math.abs(channel - raw[start + index]) <= maxError)) off++;
          if (descriptor.onRgb.every((channel, index) => Math.abs(channel - raw[start + index]) <= maxError)) on++;
        } else if (descriptor.on.minRgb.every((channel, index) => raw[start + index] >= channel && raw[start + index] <= descriptor.on.maxRgb[index])) on++;
      }
      if (descriptor.kind === 'rgb-range') {
        const matched = on / pixels;
        const state = matched >= minimum ? 1 : matched <= descriptor.off.maxMatchedFraction ? 0 : null;
        return { frameIndex, timestampMs, state, confidence: state === 1 ? matched : state === 0 ? 1 - matched : 0 };
      }
      const confidence = Math.max(off, on) / pixels;
      const state = on / pixels >= minimum ? 1 : off / pixels >= minimum ? 0 : null;
      return { frameIndex, timestampMs, state, confidence };
    });
    return bracketMarkerEdges(frames, minStableFrames);
  } catch (error) {
    return { ok: false, frames, edges: [], error: error instanceof Error ? error.message : 'Marker decoding failed' };
  }
}
