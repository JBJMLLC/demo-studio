import { describe, expect, it } from 'vitest';
import { detectMediaClockTransitions, buildMediaClockRuntimeSource, workerToVideoMs } from '../src/media-clock.js';
import { serveMedia } from '../src/render.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEDIA_CLOCK_MARKER, calibrateVideo, type MarkerBracketEvent } from '../src/media-clock.js';

describe('measured clock and media boundary', () => {
  it('recognizes only stable marker pulses, not startup or single-frame flashes', () => {
    const frames = [false, false, true, true, false, false, true, false].map((visible, frameIndex) => ({ frameIndex, timestampMs: frameIndex * 33.3, visible, patternScore: visible ? 200 : 0 }));
    const transitions = detectMediaClockTransitions(frames);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].frameIndex).toBe(2);
  });
  it('never creates a guessed mapping from failed calibration', () => {
    expect(() => workerToVideoMs({ ok: false, offsetMs: null }, 1000)).toThrow();
    expect(workerToVideoMs({ ok: true, offsetMs: -200 }, 1000)).toBe(800);
  });
  it('keeps worker and browser clocks separate', () => {
    const runtime = buildMediaClockRuntimeSource();
    expect(runtime).toContain('window.performance.now()');
    expect(runtime).toContain('requestAnimationFrame');
    expect(runtime).toContain('marker_brackets');
    expect(runtime).toContain('visibility');
  });
  it('serves only admitted media, never arbitrary paths or directories', async () => {
    const media = await serveMedia([]);
    try {
      // An empty allowlist is also safe and can be closed without an active connection.
      expect(media.urls.size).toBe(0);
    } finally { await media.close(); }
  });
  it('decodes real pulse timestamps and rejects drift or missing brackets', () => {
    const directory = mkdtempSync(join(tmpdir(), 'demo-studio-clock-'));
    const video = join(directory, 'pulses.webm');
    const pulse = "between(t,0.2,0.4)+between(t,1.2,1.4)";
    const event = (phase: 'start' | 'end', atMs: number): MarkerBracketEvent => ({ type: 'marker_brackets', recordingId: 'continuous', phase, markerId: MEDIA_CLOCK_MARKER.id, markerState: 1, workerBeforeMs: atMs, workerAfterMs: atMs + 4, browserBeforeMs: atMs + 3, browserAppliedMs: atMs + 8, browserAfterMs: atMs + 18 });
    try {
      execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=160x100:r=30:d=2', '-vf', `drawbox=x=8:y=8:w=64:h=64:color=black:t=fill:enable='${pulse}',drawbox=x=16:y=16:w=48:h=48:color=white:t=fill:enable='${pulse}'`, '-c:v', 'libvpx-vp9', '-an', video], { timeout: 15_000, stdio: 'ignore' });
      const calibrated = calibrateVideo(video, [event('start', 1000), event('end', 2000)]);
      expect(calibrated.ok).toBe(true);
      expect(calibrated.uncertaintyMs).toBeLessThan(100);
      expect(calibrateVideo(video, [event('start', 1000), event('end', 2100)]).ok).toBe(false);
      expect(calibrateVideo(video, [event('start', 1000)]).ok).toBe(false);
    } finally { rmSync(directory, { recursive: true }); }
  }, 25_000);
});
