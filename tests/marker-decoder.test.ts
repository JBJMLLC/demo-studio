import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bracketMarkerEdges, decodeMarkerEdges,
  type MarkerPresentationFrame, type UniformMarkerDescriptor,
} from '../src/marker-decoder.js';

const descriptor: UniformMarkerDescriptor = {
  kind: 'uniform-rgb', rect: { x: 12, y: 12, width: 32, height: 32 },
  offRgb: [0, 0, 0], onRgb: [255, 255, 255],
};
const frames = (states: Array<0 | 1 | null>): MarkerPresentationFrame[] => states.map((state, frameIndex) => ({
  state, frameIndex, timestampMs: frameIndex * 1000 / 30, confidence: state === null ? 0 : 1,
}));

describe('closed marker presentation brackets', () => {
  it('retains both adjacent PTS bounds for leading and trailing changes', () => {
    const result = bracketMarkerEdges(frames([0, 0, 1, 1, 1, 0, 0]));
    expect(result.ok).toBe(true);
    expect(result.edges.map(edge => [edge.state, edge.precedingFrameIndex, edge.firstChangedFrameIndex]))
      .toEqual([[1, 1, 2], [0, 4, 5]]);
    expect(result.edges[0].precedingTimeMs).toBeCloseTo(1000 / 30);
    expect(result.edges[0].firstChangedTimeMs).toBeCloseTo(2000 / 30);
    expect(result.edges[1].stableFrames).toBe(2);
  });

  it('never invents a predecessor when the video starts with the marker on', () => {
    const result = bracketMarkerEdges(frames([1, 1, 0, 0]));
    expect(result.ok).toBe(false);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].state).toBe(0);
  });

  it('retains an observed leading edge when the trailing edge is missing', () => {
    const input = frames([0, 0, 1, 1]);
    const result = bracketMarkerEdges(input);
    expect(result.ok).toBe(false);
    expect(result.frames).toEqual(input);
    expect(result.edges.map(edge => edge.state)).toEqual([1]);
  });

  it('rejects a flash without silently choosing the later convenient pulse', () => {
    const result = bracketMarkerEdges(frames([0, 0, 1, 0, 0, 1, 1, 0, 0]));
    expect(result.ok).toBe(false);
    expect(result.edges.some(edge => edge.firstChangedFrameIndex === 5)).toBe(true);
  });

  it('does not bridge an unknown predecessor into an invented closed interval', () => {
    const result = bracketMarkerEdges(frames([0, 0, null, 1, 1, 0, 0]));
    expect(result.ok).toBe(false);
    expect(result.edges.some(edge => edge.state === 1)).toBe(false);
  });

  it('rejects an unclassified tail while preserving both measured edges', () => {
    const result = bracketMarkerEdges(frames([0, 0, 1, 1, 0, 0, null]));
    expect(result.ok).toBe(false);
    expect(result.edges.map(edge => edge.state)).toEqual([1, 0]);
  });

  it.each([0, 1, 1.5, 121, NaN])('rejects invalid stable-frame count %s', count => {
    expect(bracketMarkerEdges(frames([0, 0, 1, 1, 0, 0]), count).ok).toBe(false);
  });

  it.each(['index', 'duplicate-pts', 'nan-pts', 'negative-pts', 'confidence'] as const)
  ('rejects malformed presentation inventory: %s', failure => {
    const input = frames([0, 0, 1, 1, 0, 0]);
    if (failure === 'index') input[2].frameIndex = 9;
    if (failure === 'duplicate-pts') input[2].timestampMs = input[1].timestampMs;
    if (failure === 'nan-pts') input[2].timestampMs = NaN;
    if (failure === 'negative-pts') input[0].timestampMs = -1;
    if (failure === 'confidence') input[2].confidence = 1.1;
    expect(bracketMarkerEdges(input).ok).toBe(false);
  });

  it('requires a real transition rather than an all-off inventory', () => {
    expect(bracketMarkerEdges(frames([0, 0, 0, 0])).ok).toBe(false);
  });
});

describe('finalized video decoding with original configurable geometry', () => {
  it.each(['mp4', 'webm'])('reads both edges from an actual encoded %s without altering the file', extension => {
    const directory = mkdtempSync(join(tmpdir(), 'demo-studio-neutral-marker-'));
    const video = join(directory, `uniform.${extension}`);
    try {
      execFileSync('ffmpeg', [
        '-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=128x96:r=30:d=1',
        '-vf', "drawbox=x=12:y=12:w=32:h=32:color=black:t=fill,drawbox=x=12:y=12:w=32:h=32:color=white:t=fill:enable='gte(t,0.2)*lt(t,0.6)'",
        '-c:v', extension === 'mp4' ? 'libx264' : 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-an', video,
      ], { timeout: 15_000, stdio: 'ignore' });
      const original = readFileSync(video);
      const result = decodeMarkerEdges(video, descriptor);
      expect(result.error).toBeUndefined();
      expect(result.ok).toBe(true);
      expect(result.frames).toHaveLength(30);
      expect(result.edges).toHaveLength(2);
      for (const [index, observedMs] of [200, 600].entries()) {
        const edge = result.edges[index];
        expect(edge.precedingTimeMs).toBeLessThan(observedMs);
        expect(edge.firstChangedTimeMs).toBeCloseTo(observedMs, 1);
        expect(edge.firstChangedTimeMs - edge.precedingTimeMs).toBeLessThanOrEqual(34);
      }
      expect(readFileSync(video)).toEqual(original);
      const ranged = decodeMarkerEdges(video, {
        kind: 'rgb-range', rect: descriptor.rect,
        on: { minRgb: [240, 240, 240], maxRgb: [255, 255, 255], minMatchedFraction: 0.9 },
        off: { kind: 'not-on', maxMatchedFraction: 0.1 },
      });
      expect(ranged.ok).toBe(true);
      expect(ranged.edges).toEqual(result.edges);
      const oddGeometry = decodeMarkerEdges(video, {
        ...descriptor, rect: { x: 13, y: 13, width: 31, height: 31 },
      });
      expect(oddGeometry.ok).toBe(true);
      expect(oddGeometry.frames).toHaveLength(30);
      const outside = decodeMarkerEdges(video, { ...descriptor, rect: { ...descriptor.rect, x: 120 } });
      expect(outside.ok).toBe(false);
      expect(outside.error).toContain('outside');
      const linkedVideo = join(directory, `alias.${extension}`);
      symlinkSync(video, linkedVideo);
      expect(decodeMarkerEdges(linkedVideo, descriptor).ok).toBe(false);
    } finally { rmSync(directory, { recursive: true }); }
  }, 25_000);

  it('rejects ambiguous colors before launching a subprocess', () => {
    const result = decodeMarkerEdges('not-a-recording', { ...descriptor, onRgb: [10, 10, 10] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('overlapping');
  });

  it('rejects inverted color ranges instead of broadening a matching policy', () => {
    const result = decodeMarkerEdges('not-a-recording', {
      kind: 'rgb-range', rect: descriptor.rect,
      on: { minRgb: [255, 255, 255], maxRgb: [240, 240, 240], minMatchedFraction: 0.9 },
      off: { kind: 'not-on', maxMatchedFraction: 0.1 },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('thresholds');
  });

  it.each([
    { rect: { x: -1, y: 0, width: 32, height: 32 } },
    { rect: { x: 0, y: 0, width: 3, height: 32 } },
    { maxChannelError: 65 },
    { minMatchedFraction: 0.5 },
  ])('rejects malformed marker descriptors', patch => {
    expect(decodeMarkerEdges('not-a-recording', { ...descriptor, ...patch }).ok).toBe(false);
  });

  it('rejects a missing file and never manufactures raw frames or edges', () => {
    const result = decodeMarkerEdges('not-a-recording', descriptor);
    expect(result.ok).toBe(false);
    expect(result.frames).toEqual([]);
    expect(result.edges).toEqual([]);
  });
});
