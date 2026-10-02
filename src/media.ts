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

export function jsonHash(value: unknown) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
