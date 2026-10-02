import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const run = promisify(execFile);

export async function runBinary(command: string, args: string[], timeout = 120_000) {
  try { return await run(command, args, { timeout, maxBuffer: 32 * 1024 * 1024 }); }
  catch { throw new Error(`${command} failed or timed out; no provider output was persisted`); }
}

export async function mediaInfo(path: string) {
  const { stdout } = await runBinary('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', path]);
  const data = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type: string; width?: number; height?: number }[] };
  const durationMs = Number(data.format?.duration) * 1000;
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('Invalid measured media duration');
  const video = data.streams?.find((stream) => stream.codec_type === 'video');
  return { durationMs, width: video?.width, height: video?.height, hasAudio: data.streams?.some((stream) => stream.codec_type === 'audio') ?? false };
}

export async function fileHash(path: string) {
  return `sha256:${createHash('sha256').update(await readFile(path)).digest('hex')}`;
}

export const FIRST_FRAME_SSIM_THRESHOLD = 0.98;

export class MediaIntegrityError extends Error {
  readonly code = 'MEDIA_INTEGRITY_FIRST_FRAME';

  constructor(message: string, readonly score?: number, readonly threshold = FIRST_FRAME_SSIM_THRESHOLD) {
    super(message);
    this.name = 'MediaIntegrityError';
  }
}

export async function verifyFirstFrameIntegrity(
  referenceCaptureMp4: string,
  finalMp4: string,
  width: number,
  height: number,
  captionBandHeight: number,
) {
  if (!Number.isInteger(width) || width < 2
    || !Number.isInteger(height) || height < 2
    || !Number.isInteger(captionBandHeight) || captionBandHeight < 0 || captionBandHeight >= height) {
    throw new MediaIntegrityError('Invalid first-frame media integrity geometry');
  }

  const finalInfo = await mediaInfo(finalMp4).catch(() => {
    throw new MediaIntegrityError('Unable to inspect rendered media dimensions');
  });
  if (finalInfo.width !== width || finalInfo.height !== height) {
    throw new MediaIntegrityError('Rendered media dimensions do not match the expected viewport');
  }

  const browserHeight = height - captionBandHeight;
  const filter = [
    `[0:v:0]trim=end_frame=1,scale=${width}:${browserHeight}:force_original_aspect_ratio=decrease,pad=${width}:${browserHeight}:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv444p,gblur=sigma=1.5,settb=AVTB,setpts=PTS-STARTPTS[reference]`,
    `[1:v:0]trim=end_frame=1,format=yuv444p,crop=${width}:${browserHeight}:0:0,gblur=sigma=1.5,settb=AVTB,setpts=PTS-STARTPTS[rendered]`,
    '[reference][rendered]ssim=shortest=1[comparison]',
  ].join(';');

  const output = await runBinary('ffmpeg', [
    '-hide_banner', '-nostats', '-loglevel', 'info',
    '-i', referenceCaptureMp4,
    '-i', finalMp4,
    '-filter_complex', filter,
    '-map', '[comparison]',
    '-frames:v', '1',
    '-an',
    '-f', 'null', '-',
  ], 30_000).catch(() => {
    throw new MediaIntegrityError('Unable to compare the rendered first frame with its recording');
  });

  const match = /\bSSIM\b[^\n]*\bAll:([01](?:\.\d+)?)/.exec(`${output.stderr}\n${output.stdout}`);
  const score = match ? Number(match[1]) : Number.NaN;
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new MediaIntegrityError('First-frame comparison produced no valid SSIM score');
  }
  if (score < FIRST_FRAME_SSIM_THRESHOLD) {
    throw new MediaIntegrityError(
      `Rendered first frame differs from its recording (SSIM ${score.toFixed(4)} below ${FIRST_FRAME_SSIM_THRESHOLD.toFixed(2)})`,
      score,
    );
  }
  return { score, pass: true as const, threshold: FIRST_FRAME_SSIM_THRESHOLD };
}

export function jsonHash(value: unknown) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
