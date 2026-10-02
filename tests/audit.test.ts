import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditMedia } from '../src/audit.js';
import { computeWordingApprovalHash, planSchema, type DemoPlan } from '../src/schemas.js';
import { sha256Of, sha256OfFile } from '../src/store.js';

const scratchDirectories: string[] = [];
afterEach(() => { for (const directory of scratchDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'demo-studio-audit-'));
  scratchDirectories.push(directory);
  return directory;
}

function ffmpeg(args: string[]): void {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', timeout: 20_000 });
  if (result.error || result.status !== 0) throw new Error(`ffmpeg fixture generation failed: ${result.stderr}`);
}

function makePlan(scenes: DemoPlan['scenes'], mode: DemoPlan['mode'] = 'captioned'): DemoPlan {
  const value = {
    schemaVersion: 1 as const, id: 'audit-plan', title: 'Audit a generic flow', product: 'Example', audience: 'People', outcome: 'Understand the flow',
    mode, targetUrl: 'http://127.0.0.1:4300/', viewport: { width: 640, height: 360 }, presentation: { cursor: 'pointer' as const, captions: true },
    duration: { targetSeconds: 1, hardLimit: false },
    ...(mode === 'narrated' ? { narrator: { provider: 'voicebox' as const, profileId: 'local-profile' } } : {}),
    scenes, wordingApproval: { sha256: '' },
  };
  value.wordingApproval = { sha256: computeWordingApprovalHash(value as DemoPlan) };
  return planSchema.parse(value);
}

function makeCaptionedMedia(directory: string) {
  mkdirSync(join(directory, 'capture'), { recursive: true });
  mkdirSync(join(directory, 'render'), { recursive: true });
  const recording = join(directory, 'capture/recording.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=1', '-an', '-c:v', 'mpeg4', '-q:v', '3', recording]);
  for (const name of ['one-before.png', 'one-after.png', 'two-before.png', 'two-after.png']) {
    ffmpeg(['-i', recording, '-frames:v', '1', join(directory, `capture/${name}`)]);
  }
  const video = join(directory, 'render/demo.mp4');
  copyFileSync(recording, video);
  const poster = join(directory, 'render/poster.png');
  ffmpeg(['-i', video, '-frames:v', '1', poster]);
  writeFileSync(join(directory, 'render/timeline.json'), '{}');
  return { recording, video };
}

function ffprobeMs(path: string, stream = 'format') {
  const result = spawnSync('ffprobe', ['-v', 'error', ...(stream === 'audio' ? ['-select_streams', 'a:0', '-show_entries', 'stream=duration'] : ['-show_entries', 'format=duration']), '-of', 'default=nw=1:nk=1', path], { encoding: 'utf8', timeout: 10_000 });
  if (result.error || result.status !== 0) throw new Error('ffprobe fixture measurement failed');
  return Math.round(Number(result.stdout.trim()) * 1_000);
}

describe('deterministic media audit', () => {
  it('fails missing assertion coverage and cursor discontinuities without trusting scene headings', () => {
    const directory = scratch();
    const sceneWithAssertion = { id: 'one', before: '', during: '', after: '', say: '', learn: '', next: '', holdMs: 0, actions: [{ id: 'save-filter', type: 'click' as const, selector: '#save-filter' }], assertions: [{ selector: '#metric', kind: 'text' as const, value: '82' }] };
    const plan = makePlan([sceneWithAssertion, { id: 'two', before: '', during: '', after: '', say: '', learn: '', next: '', holdMs: 0, actions: [], assertions: [] }]);
    const { recording, video } = makeCaptionedMedia(directory);
    const capture = {
      recordings: ['capture/recording.mp4'], width: 640, height: 360, fps: 30 as const, durationMs: 1_000,
      clock: { originMs: 5, verified: true, uncertaintyMs: 2, recordingSha256: sha256OfFile(recording) },
      scenes: [
        { id: 'one', startMs: 0, endMs: 500, beforeFrame: 'capture/one-before.png', afterFrame: 'capture/one-after.png', cursorStart: { x: 10, y: 10 }, cursorEnd: { x: 20, y: 20 } },
        { id: 'two', startMs: 500, endMs: 1_000, beforeFrame: 'capture/two-before.png', afterFrame: 'capture/two-after.png', cursorStart: { x: 500, y: 200 }, cursorEnd: { x: 500, y: 200 } },
      ], events: [], assertions: [],
    };
    const render = { videoPath: 'render/demo.mp4', posterPath: 'render/poster.png', timelinePath: 'render/timeline.json', sampledFrames: ['render/poster.png'], durationMs: 1_000, sha256: sha256OfFile(video), playbackRate: 1, hasAudio: false };
    const audit = auditMedia(plan, capture, render, directory);
    const codes = new Set(audit.findings.map((finding) => finding.code));
    expect(audit.status).toBe('fail');
    expect(codes.has('ASSERTION_COVERAGE')).toBe(true);
    expect(codes.has('EVENT_COVERAGE')).toBe(true);
    expect(codes.has('CURSOR_SEAM')).toBe(true);
    expect(audit.semanticTruth).toBe('not-evaluated');
  }, 30_000);

  it('keeps semantic review mandatory even when authored spoken anchors and measured media timing align', () => {
    const directory = scratch();
    mkdirSync(join(directory, 'capture'), { recursive: true });
    mkdirSync(join(directory, 'render'), { recursive: true });
    mkdirSync(join(directory, 'narration'), { recursive: true });
    const speech = 'Click the overview panel.';
    const plan = makePlan([{
      id: 'intro', before: '', during: '', after: '', say: speech, learn: '', next: '', holdMs: 0,
      actions: [{ id: 'open-overview', type: 'click', selector: '#overview', atMs: 300, spokenAnchor: 'overview panel' }], assertions: [],
    }], 'narrated');
    const recording = join(directory, 'capture/recording.mp4');
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=1', '-an', '-c:v', 'mpeg4', '-q:v', '3', recording]);
    for (const name of ['intro-before.png', 'intro-after.png']) ffmpeg(['-i', recording, '-frames:v', '1', join(directory, `capture/${name}`)]);
    const sourceAudio = join(directory, 'narration/intro.wav');
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=800:duration=1', '-c:a', 'pcm_s16le', sourceAudio]);
    const trackHash = sha256OfFile(sourceAudio);
    const audioMs = ffprobeMs(sourceAudio, 'audio');
    const video = join(directory, 'render/demo.mp4');
    ffmpeg(['-i', recording, '-i', sourceAudio, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-shortest', video]);
    const poster = join(directory, 'render/poster.png');
    ffmpeg(['-i', video, '-frames:v', '1', poster]);
    writeFileSync(join(directory, 'render/timeline.json'), '{}');
    const capture = {
      recordings: ['capture/recording.mp4'], width: 640, height: 360, fps: 30 as const, durationMs: 1_000,
      clock: { originMs: 2, verified: true, uncertaintyMs: 2, recordingSha256: sha256OfFile(recording) },
      scenes: [{ id: 'intro', startMs: 0, endMs: 1_000, beforeFrame: 'capture/intro-before.png', afterFrame: 'capture/intro-after.png', cursorStart: { x: 400, y: 200 }, cursorEnd: { x: 400, y: 200 }, audio: { startMs: 0, endMs: audioMs, sourceDurationMs: audioMs, sha256: trackHash, playbackRate: 1 } }],
      events: [{ id: 'open-overview', sceneId: 'intro', type: 'click' as const, atMs: 300, cursor: { x: 400, y: 200 }, spokenAnchor: 'overview panel' }], assertions: [],
    };
    const render = { videoPath: 'render/demo.mp4', posterPath: 'render/poster.png', timelinePath: 'render/timeline.json', sampledFrames: ['render/poster.png'], durationMs: ffprobeMs(video), sha256: sha256OfFile(video), playbackRate: 1, hasAudio: true };
    const narration = { provider: 'voicebox' as const, tracks: [{ sceneId: 'intro', path: 'narration/intro.wav', durationMs: audioMs, sha256: trackHash, textSha256: sha256Of(speech) }] };
    const audit = auditMedia(plan, capture, render, directory, narration);
    expect(audit.status).toBe('needs-review');
    expect(audit.findings.map((finding) => finding.code)).toContain('SEMANTIC_REVIEW_REQUIRED');
    expect(audit.semanticTruth).toBe('not-evaluated');
    const truncatedPath = join(directory, 'narration/truncated.wav');
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=800:duration=0.4', '-c:a', 'pcm_s16le', truncatedPath]);
    const truncatedMs = ffprobeMs(truncatedPath, 'audio');
    const truncatedHash = sha256OfFile(truncatedPath);
    const truncatedAudit = auditMedia(plan, {
      ...capture,
      scenes: [{ ...capture.scenes[0]!, audio: { ...capture.scenes[0]!.audio!, sha256: truncatedHash } }],
    }, render, directory, {
      provider: 'voicebox', tracks: [{ sceneId: 'intro', path: 'narration/truncated.wav', durationMs: truncatedMs, sha256: truncatedHash, textSha256: sha256Of(speech) }],
    });
    expect(truncatedAudit.status).toBe('fail');
    expect(truncatedAudit.findings.map((finding) => finding.code)).toContain('AUDIO_TIMING');
    const longAudio = join(directory, 'narration/too-long.wav');
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=700:duration=1.4', '-c:a', 'pcm_s16le', longAudio]);
    const tailVideo = join(directory, 'render/tail.mp4');
    ffmpeg(['-i', recording, '-i', longAudio, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', tailVideo]);
    const tailAudit = auditMedia(plan, capture, { ...render, videoPath: 'render/tail.mp4', sha256: sha256OfFile(tailVideo) }, directory, narration);
    expect(tailAudit.status).toBe('fail');
    expect(tailAudit.findings.map((finding) => finding.code)).toContain('AUDIO_TAIL');
  }, 30_000);
});
