import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MediaIntegrityError, verifyFirstFrameIntegrity } from '../src/media.js';

const width = 320;
const height = 200;
const captionBandHeight = 16;

describe('rendered first-frame integrity', () => {
  let directory: string;
  let reference: string;
  let clean: string;
  let blank: string;
  let tiled: string;
  let highFrequencyReference: string;
  let highFrequencyClean: string;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'demo-studio-first-frame-'));
    reference = join(directory, 'reference.mp4');
    clean = join(directory, 'clean.mp4');
    blank = join(directory, 'blank.mp4');
    tiled = join(directory, 'tiled.mp4');
    highFrequencyReference = join(directory, 'high-frequency-reference.mp4');
    highFrequencyClean = join(directory, 'high-frequency-clean.mp4');

    ffmpeg([
      '-f', 'lavfi', '-i', [
        `color=c=0xf5f7fb:s=${width}x${height}:r=30:d=1`,
        'drawbox=x=0:y=0:w=320:h=18:color=0x1f765f:t=fill',
        'drawbox=x=16:y=32:w=288:h=3:color=0x142033:t=fill',
        'drawbox=x=18:y=48:w=130:h=45:color=0xe4f4ef:t=fill',
        'drawbox=x=172:y=48:w=130:h=45:color=0xe7eff2:t=fill',
        'drawbox=x=18:y=104:w=284:h=2:color=0xc8d4dc:t=fill',
        'drawbox=x=20:y=125:w=32:h=2:color=0x1e6f59:t=fill',
        'drawbox=x=52:y=118:w=32:h=2:color=0x1e6f59:t=fill',
        'drawbox=x=84:y=120:w=32:h=2:color=0x1e6f59:t=fill',
        'drawbox=x=116:y=112:w=32:h=2:color=0x1e6f59:t=fill',
        'drawbox=x=148:y=108:w=32:h=2:color=0x1e6f59:t=fill',
        'drawbox=x=180:y=114:w=32:h=2:color=0x1e6f59:t=fill',
        'drawbox=x=212:y=100:w=32:h=2:color=0x1e6f59:t=fill',
        'drawbox=x=244:y=96:w=32:h=2:color=0x1e6f59:t=fill',
      ].join(','),
      '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', reference,
    ]);
    ffmpeg([
      '-i', reference,
      '-filter_complex', `[0:v]scale=${width}:${height - captionBandHeight}:force_original_aspect_ratio=decrease,pad=${width}:${height - captionBandHeight}:(ow-iw)/2:(oh-ih)/2:color=0xf5f7fb,format=yuv444p[screen];color=c=0x141a29:s=${width}x${captionBandHeight}:r=30:d=1,format=yuv444p[band];[screen][band]vstack=inputs=2,format=yuv420p[out]`,
      '-map', '[out]', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clean,
    ]);
    ffmpeg([
      '-f', 'lavfi', '-i', `color=c=0xf5f7fb:s=${width}x${height}:r=30:d=1`,
      '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', blank,
    ]);
    ffmpeg([
      '-i', reference,
      '-filter_complex', `[0:v]scale=${width / 2}:${height / 2}:flags=neighbor,split=4[a][b][c][d];[a][b][c][d]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0[copies];[copies]crop=${width}:${height - captionBandHeight}:0:0,format=yuv444p[screen];color=c=0x141a29:s=${width}x${captionBandHeight}:r=30:d=1,format=yuv444p[band];[screen][band]vstack=inputs=2,format=yuv420p[out]`,
      '-map', '[out]', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', tiled,
    ]);
    ffmpeg([
      '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=30:duration=1`,
      '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', highFrequencyReference,
    ]);
    ffmpeg([
      '-i', highFrequencyReference,
      '-filter_complex', `[0:v]scale=${width}:${height - captionBandHeight}:force_original_aspect_ratio=decrease,pad=${width}:${height - captionBandHeight}:(ow-iw)/2:(oh-ih)/2:color=0xf5f7fb,format=yuv444p[screen];color=c=0x141a29:s=${width}x${captionBandHeight}:r=30:d=1,format=yuv444p[band];[screen][band]vstack=inputs=2,format=yuv420p[out]`,
      '-map', '[out]', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', highFrequencyClean,
    ]);
  }, 30_000);

  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it('accepts a clean first frame and excludes only the caption band from comparison', async () => {
    const result = await verifyFirstFrameIntegrity(reference, clean, width, height, captionBandHeight);
    expect(result.pass).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(result.threshold);
    expect(result.score).toBeGreaterThan(0.99);
  }, 20_000);

  it('tolerates scaled high-frequency content after normalization', async () => {
    const result = await verifyFirstFrameIntegrity(highFrequencyReference, highFrequencyClean, width, height, captionBandHeight);
    expect(result.pass).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(result.threshold);
    expect(result.score).toBeGreaterThan(0.98);
  }, 20_000);

  it('rejects a blank first frame', async () => {
    await expectIntegrityFailure(blank);
  }, 20_000);

  it('rejects a repeated 2x2 tiled first frame', async () => {
    await expectIntegrityFailure(tiled);
  }, 20_000);

  async function expectIntegrityFailure(finalVideo: string) {
    const outcome = await verifyFirstFrameIntegrity(reference, finalVideo, width, height, captionBandHeight)
      .then((value) => ({ value }), (error: unknown) => ({ error }));
    expect('error' in outcome).toBe(true);
    if ('error' in outcome) {
      expect(outcome.error).toBeInstanceOf(MediaIntegrityError);
      expect(outcome.error).toMatchObject({ code: 'MEDIA_INTEGRITY_FIRST_FRAME' });
      if (outcome.error instanceof MediaIntegrityError) {
        expect(outcome.error.score).toBeDefined();
        expect(outcome.error.score).toBeLessThan(outcome.error.threshold);
      }
    }
  }
});

function ffmpeg(args: string[]) {
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { timeout: 15_000, stdio: 'ignore' });
}
