import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { CaptureResult, DemoAction, DemoPlan, NarrationResult, RenderResult } from './schemas.js';
import { captureResultSchema, computeWordingApprovalHash, renderResultSchema } from './schemas.js';
import type { MediaAuditFinding, MediaAuditResult } from './contracts.js';
import { missionPath, sha256Of, sha256OfFile, sha256OfJson } from './store.js';

export interface AuditOptions {
  planHash?: string;
  now?: () => Date;
  eventTimingToleranceMs?: number;
  cursorSeamTolerancePx?: number;
  durationToleranceMs?: number;
}

/** Deterministic coverage/media checks only; human semantic truth is always a separate review gate. */
export function auditMedia(
  plan: DemoPlan,
  captureInput: CaptureResult,
  renderInput: RenderResult,
  missionDirectory: string,
  narrationInput?: NarrationResult,
  options: AuditOptions = {},
): MediaAuditResult {
  const capture = captureResultSchema.parse(captureInput);
  const render = renderResultSchema.parse(renderInput);
  const findings: MediaAuditFinding[] = [];
  const add = (code: MediaAuditFinding['code'], severity: MediaAuditFinding['severity'], sceneId?: string) => {
    findings.push({ code, severity, ...(sceneId ? { sceneId } : {}) });
  };
  const planHash = options.planHash ?? sha256OfJson(plan);
  const wordingHash = computeWordingApprovalHash(plan);
  const captureHash = sha256OfJson(capture);
  const renderHash = sha256OfJson(render);
  const toleranceMs = options.eventTimingToleranceMs ?? Math.max(100, capture.clock.uncertaintyMs ?? 0);
  const durationToleranceMs = options.durationToleranceMs ?? 150;

  if (capture.recordings.length !== 1) add('RECORDING_COUNT', 'error');
  if (!capture.clock.verified || capture.clock.uncertaintyMs === undefined || capture.clock.uncertaintyMs > 100) add('CLOCK_UNVERIFIED', 'error');
  if (capture.fps !== 30) add('CLOCK_UNVERIFIED', 'error');
  const recordingPath = capture.recordings.length === 1 ? resolveAndCheck(missionDirectory, capture.recordings[0]!) : null;
  if (recordingPath && existsSync(recordingPath)) {
    if (sha256OfFile(recordingPath) !== capture.clock.recordingSha256) add('CLOCK_HASH_MISMATCH', 'error');
  } else {
    add('CLOCK_HASH_MISMATCH', 'error');
  }
  if (capture.width !== plan.viewport.width || capture.height !== plan.viewport.height) add('VIEWPORT_MISMATCH', 'error');

  if (capture.scenes.length !== plan.scenes.length
    || capture.scenes.some((scene, index) => scene.id !== plan.scenes[index]?.id)) {
    add('SCENE_COVERAGE', 'error');
  }
  let priorSceneEnd = 0;
  let priorCursorEnd: { x: number; y: number } | null = null;
  const cursorTolerance = options.cursorSeamTolerancePx ?? 64;
  for (let index = 0; index < plan.scenes.length; index += 1) {
    const planned = plan.scenes[index]!;
    const captured = capture.scenes[index];
    if (!captured || captured.id !== planned.id) continue;
    if (captured.startMs < priorSceneEnd || captured.endMs <= captured.startMs || captured.endMs > capture.durationMs + durationToleranceMs) {
      add('SCENE_TIMING', 'error', planned.id);
    }
    priorSceneEnd = captured.endMs;
    const before = resolveAndCheck(missionDirectory, captured.beforeFrame);
    const after = resolveAndCheck(missionDirectory, captured.afterFrame);
    if (!before || !after) add('SCENE_COVERAGE', 'error', planned.id);
    if (plan.presentation.cursor !== 'hidden') {
      if (!pointInViewport(captured.cursorStart, plan.viewport.width, plan.viewport.height)
        || !pointInViewport(captured.cursorEnd, plan.viewport.width, plan.viewport.height)) {
        add('CURSOR_EVIDENCE', 'error', planned.id);
      }
      if (priorCursorEnd && captured.cursorStart && distance(priorCursorEnd, captured.cursorStart) > cursorTolerance) {
        add('CURSOR_SEAM', 'error', planned.id);
      }
      priorCursorEnd = captured.cursorEnd;
    } else {
      if (captured.cursorStart || captured.cursorEnd) add('CURSOR_EVIDENCE', 'error', planned.id);
      priorCursorEnd = null;
    }
    if (plan.mode === 'narrated') {
      if (!captured.audio) {
        add('AUDIO_COVERAGE', 'error', planned.id);
      } else {
        if (captured.audio.sha256 === '' || captured.audio.playbackRate !== 1) add('AUDIO_SPEED_SCALED', 'error', planned.id);
        const sourceVsMeasured = Math.abs((captured.audio.endMs - captured.audio.startMs) - captured.audio.sourceDurationMs);
        if (captured.audio.startMs < captured.startMs - durationToleranceMs
          || captured.audio.endMs > captured.endMs + durationToleranceMs
          || sourceVsMeasured > durationToleranceMs) add('AUDIO_TIMING', 'error', planned.id);
        if (captured.endMs - captured.audio.endMs < planned.holdMs - durationToleranceMs) add('AUDIO_TAIL', 'error', planned.id);
        for (const action of planned.actions) {
          if (isActiveNarratedAction(action) && action.atMs !== undefined) {
            const relativeToScene = action.atMs;
            if (relativeToScene > captured.audio.sourceDurationMs + durationToleranceMs) add('AUDIO_TIMING', 'error', planned.id);
          }
        }
      }
    }
  }

  const expectedActions = plan.scenes.flatMap((scene) => scene.actions.map((action) => ({ sceneId: scene.id, action })));
  const eventsById = new Map(capture.events.map((event) => [event.id, event]));
  if (eventsById.size !== capture.events.length || eventsById.size !== expectedActions.length) add('EVENT_COVERAGE', 'error');
  for (const { sceneId, action } of expectedActions) {
    const event = eventsById.get(action.id);
    const scene = capture.scenes.find((candidate) => candidate.id === sceneId);
    if (!event || event.sceneId !== sceneId || event.type !== action.type) {
      add('EVENT_COVERAGE', 'error', sceneId);
      continue;
    }
    if (!scene || event.atMs < scene.startMs || event.atMs > scene.endMs
      || (event.endMs !== undefined && event.endMs < event.atMs)) {
      add('EVENT_TIMING', 'error', sceneId);
    }
    if (action.atMs !== undefined && scene
      && Math.abs((event.atMs - scene.startMs) - action.atMs) > toleranceMs) {
      add('EVENT_TIMING', 'error', sceneId);
    }
    if (plan.presentation.cursor !== 'hidden' && !pointInViewport(event.cursor, plan.viewport.width, plan.viewport.height)) {
      add('CURSOR_EVIDENCE', 'error', sceneId);
    }
    if (plan.mode === 'narrated' && isActiveNarratedAction(action)) {
      if (!action.spokenAnchor || event.spokenAnchor !== action.spokenAnchor) add('SPOKEN_ANCHOR', 'error', sceneId);
      else if (!containsAnchor(plan.scenes.find((candidate) => candidate.id === sceneId)?.say ?? '', action.spokenAnchor)) {
        add('SPOKEN_ANCHOR', 'error', sceneId);
      }
    }
  }

  const expectedAssertions = plan.scenes.flatMap((scene) => scene.assertions.map((assertion) => ({ sceneId: scene.id, ...assertion })));
  const assertionKey = (assertion: { sceneId: string; selector: string; kind: string }) => `${assertion.sceneId}\0${assertion.selector}\0${assertion.kind}`;
  const assertionKeys = new Set(capture.assertions.map(assertionKey));
  if (capture.assertions.length !== expectedAssertions.length || assertionKeys.size !== capture.assertions.length) add('ASSERTION_COVERAGE', 'error');
  for (const assertion of expectedAssertions) {
    const outcome = capture.assertions.find((candidate) => candidate.sceneId === assertion.sceneId
      && candidate.selector === assertion.selector && candidate.kind === assertion.kind);
    if (!outcome) add('ASSERTION_COVERAGE', 'error', assertion.sceneId);
    else if (!outcome.passed || (assertion.kind === 'text' && !outcome.observedValueSha256)) {
      add('ASSERTION_FAILED', 'error', assertion.sceneId);
    }
  }

  if (plan.mode === 'narrated') {
    const narration = narrationInput;
    const expectedSceneIds = plan.scenes.filter((scene) => scene.say.trim()).map((scene) => scene.id);
    if (!narration || narration.tracks.length !== expectedSceneIds.length
      || expectedSceneIds.some((sceneId, index) => narration.tracks[index]?.sceneId !== sceneId)) {
      add('AUDIO_COVERAGE', 'error');
    } else {
      for (const track of narration.tracks) {
        const scene = plan.scenes.find((candidate) => candidate.id === track.sceneId);
        const captured = capture.scenes.find((candidate) => candidate.id === track.sceneId);
        const path = resolveAndCheck(missionDirectory, track.path);
        if (!scene || !captured?.audio || !path || sha256OfFile(path) !== track.sha256
          || track.textSha256 !== sha256Of(scene.say)) {
          add('AUDIO_COVERAGE', 'error', track.sceneId);
          continue;
        }
        if (Math.abs(captured.audio.sourceDurationMs - track.durationMs) > durationToleranceMs
          || captured.audio.sha256 !== track.sha256 || captured.audio.playbackRate !== 1) {
          add('AUDIO_TIMING', 'error', track.sceneId);
        }
      }
    }
  }

  const videoPath = resolveAndCheck(missionDirectory, render.videoPath);
  const posterPath = resolveAndCheck(missionDirectory, render.posterPath);
  const timelinePath = resolveAndCheck(missionDirectory, render.timelinePath);
  const framePaths = render.sampledFrames.map((path) => resolveAndCheck(missionDirectory, path));
  if (!videoPath || !posterPath || !timelinePath || framePaths.some((path) => !path)) add('RENDER_HASH_MISMATCH', 'error');
  if (videoPath && existsSync(videoPath) && sha256OfFile(videoPath) !== render.sha256) add('RENDER_HASH_MISMATCH', 'error');
  const measuredVideoMs = videoPath ? probeVideoDurationMs(videoPath) : null;
  if (measuredVideoMs === null || Math.abs(measuredVideoMs - render.durationMs) > durationToleranceMs) add('RENDER_TIMING', 'error');
  if (Math.abs(render.durationMs - capture.durationMs) > durationToleranceMs) add('RENDER_TIMING', 'error');
  if (render.playbackRate !== 1) add('RENDER_SPEED_SCALED', 'error');
  const hasAudio = videoPath ? probeHasAudio(videoPath) : null;
  if (plan.mode === 'narrated' && (render.hasAudio !== true || hasAudio !== true)) add('AUDIO_COVERAGE', 'error');
  if (plan.mode === 'captioned' && (render.hasAudio !== false || hasAudio !== false)) add('AUDIO_COVERAGE', 'error');
  const measuredAudioMs = videoPath ? probeAudioDurationMs(videoPath) : null;
  if (measuredAudioMs !== null && measuredAudioMs > (measuredVideoMs ?? 0) + durationToleranceMs) add('AUDIO_TAIL', 'error');
  if (plan.duration.targetSeconds !== undefined && measuredVideoMs !== null) {
    const targetMs = plan.duration.targetSeconds * 1_000;
    const miss = Math.abs(measuredVideoMs - targetMs) > Math.max(1_000, targetMs * 0.1);
    if (miss && plan.duration.hardLimit && measuredVideoMs > targetMs) add('TARGET_DURATION_MISS', 'error');
    else if (miss) add('TARGET_DURATION_MISS', 'warning');
  }

  // Hash validation is not proof that the product claim or narration is true.
  add('SEMANTIC_REVIEW_REQUIRED', 'review');
  const status: MediaAuditResult['status'] = findings.some((finding) => finding.severity === 'error')
    ? 'fail'
    : 'needs-review';
  const now = options.now ?? (() => new Date());
  const auditWithoutHash = {
    schemaVersion: 1 as const,
    status,
    createdAt: now().toISOString(),
    planHash,
    wordingApprovalHash: wordingHash,
    captureHash,
    renderHash,
    measuredDurationMs: measuredVideoMs ?? render.durationMs,
    findings,
    semanticTruth: 'not-evaluated' as const,
  };
  return { ...auditWithoutHash, auditHash: sha256OfJson(auditWithoutHash) };
}

function resolveAndCheck(directory: string, path: string): string | null {
  try {
    const resolved = missionPath(directory, path, true);
    return existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

function pointInViewport(point: { x: number; y: number } | null, width: number, height: number): boolean {
  return point !== null && point.x >= 0 && point.y >= 0 && point.x <= width && point.y <= height;
}

function distance(left: { x: number; y: number }, right: { x: number; y: number }): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function isActiveNarratedAction(action: DemoAction): boolean {
  return action.type === 'click' || action.type === 'type' || action.type === 'drag';
}

function containsAnchor(speech: string, anchor: string): boolean {
  const tokens = (value: string) => value.toLocaleLowerCase('en-US').match(/[a-z0-9]+/g) ?? [];
  const sentence = tokens(speech);
  const phrase = tokens(anchor);
  return phrase.length > 0 && sentence.some((_, index) => phrase.every((token, offset) => sentence[index + offset] === token));
}

function probeVideoDurationMs(path: string): number | null {
  // Compare the video stream itself with the audio stream. Format duration is
  // the maximum of both and would hide a narration tail extending past video.
  const result = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'default=nw=1:nk=1', path], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  const value = Number(result.stdout.trim());
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1_000) : null;
}

function probeHasAudio(path: string): boolean | null {
  const result = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', path], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim().length > 0;
}

function probeAudioDurationMs(path: string): number | null {
  const result = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=duration', '-of', 'default=nw=1:nk=1', path], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  const value = Number(result.stdout.trim());
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1_000) : null;
}
