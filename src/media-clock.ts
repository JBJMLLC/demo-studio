import { spawnSync } from 'node:child_process';

/**
 * The marker is deliberately outside the useful capture area.  Keep these
 * values in one place: the browser source uses them for CSS and the decoder
 * uses them for its crop/pattern check.
 */
export const MEDIA_CLOCK_MARKER = {
  id: '__demo_studio_media_clock_marker',
  x: 8,
  y: 8,
  width: 64,
  height: 64,
  borderPx: 8,
  /** Excluded solid-black frames before every pulse keep a fresh-context pulse off frame 0. */
  defaultPreRollMs: 120,
  defaultHoldMs: 180,
} as const;

export type MediaClockPhase = 'start' | 'end' | 'preroll' | 'postroll' | (string & {});

/**
 * Event written by the generated Playwright worker.  `workerBeforeMs` and
 * `workerAfterMs` are timestamps from the worker's monotonic clock; the
 * browser fields are from the page's independent monotonic clock.
 */
export interface MarkerBracketEvent {
  type?: 'marker_brackets' | string;
  recordingId: string;
  phase: MediaClockPhase;
  markerId?: string;
  markerState?: 0 | 1;
  workerBeforeMs: number;
  workerAfterMs: number;
  browserBeforeMs?: number;
  browserAppliedMs?: number;
  browserAfterMs?: number;
  /** Optional event ordering supplied by a caller that has multiple workers. */
  sequence?: number;
}

export interface MarkerRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MediaClockDecodeOptions {
  /** Absolute executable path or a name resolvable by PATH. */
  ffmpegPath?: string;
  ffprobePath?: string;
  markerRect?: MarkerRect;
  markerBorderPx?: number;
  /** Number of consecutive marker frames required to accept a pulse. */
  minStableFrames?: number;
  /** Center/border luminance separation required for the marker fingerprint. */
  minPatternContrast?: number;
  /**
   * Maximum accepted difference between per-pulse offset estimates. The legacy
   * default remains 50ms; decoded frame spacing is diagnostic, not extra slack.
   */
  maxOffsetDriftMs?: number;
  /** Maximum uncertainty accepted for a usable worker-to-video mapping. */
  maxUncertaintyMs?: number;
}

export interface DecodedMarkerFrame {
  frameIndex: number;
  timestampMs: number;
  /** A score useful for diagnostics; values >= 1 are accepted as visible. */
  patternScore: number;
  visible: boolean;
}

export interface VideoMarkerTransition {
  frameIndex: number;
  /** Timestamp of the first accepted frame containing the marker. */
  videoTimeMs: number;
  /** Conservative presentation-time bracket for the style transition. */
  bracketStartMs: number;
  bracketEndMs: number;
  markerState: 1;
  confidence: number;
  stableFrames: number;
}

export interface MediaClockSample {
  recordingId: string;
  phase: MediaClockPhase;
  workerBeforeMs: number;
  workerAfterMs: number;
  videoTimeMs: number;
  videoBracketStartMs: number;
  videoBracketEndMs: number;
  offsetLowerMs: number;
  offsetUpperMs: number;
  offsetMs: number;
  uncertaintyMs: number;
  transition: VideoMarkerTransition;
}

export interface MediaClockCalibration {
  ok: boolean;
  recordingId: string;
  /** Video time minus worker monotonic time. Null when calibration failed. */
  offsetMs: number | null;
  /** Conservative one-sided uncertainty around offsetMs. */
  uncertaintyMs: number | null;
  /** Max difference between accepted per-pulse offset estimates. */
  driftMs: number | null;
  maxOffsetDriftMs: number;
  samples: MediaClockSample[];
  transitions: VideoMarkerTransition[];
  decodedFrames: number;
  error?: string;
  /**
   * Map a worker-clock timestamp into raw-video milliseconds.  A failed
   * calibration throws instead of silently returning a guessed timestamp.
   */
  workerToVideoMs(workerMs: number): number;
}

export interface CalibrateVideoOptions extends MediaClockDecodeOptions {
  /** Select one recording when events from more than one recording are given. */
  recordingId?: string;
}

const DEFAULT_DECODE_OPTIONS: Required<Pick<MediaClockDecodeOptions,
  'ffmpegPath' | 'ffprobePath' | 'markerRect' | 'markerBorderPx' | 'minStableFrames' | 'minPatternContrast' | 'maxOffsetDriftMs' | 'maxUncertaintyMs'>> = {
  ffmpegPath: 'ffmpeg',
  ffprobePath: 'ffprobe',
  markerRect: {
    x: MEDIA_CLOCK_MARKER.x,
    y: MEDIA_CLOCK_MARKER.y,
    width: MEDIA_CLOCK_MARKER.width,
    height: MEDIA_CLOCK_MARKER.height,
  },
  markerBorderPx: MEDIA_CLOCK_MARKER.borderPx,
  minStableFrames: 2,
  minPatternContrast: 58,
  maxOffsetDriftMs: 50,
  maxUncertaintyMs: 100,
};

function mergedDecodeOptions(options: MediaClockDecodeOptions = {}): typeof DEFAULT_DECODE_OPTIONS {
  const markerRect = options.markerRect ?? DEFAULT_DECODE_OPTIONS.markerRect;
  return {
    ffmpegPath: options.ffmpegPath ?? DEFAULT_DECODE_OPTIONS.ffmpegPath,
    ffprobePath: options.ffprobePath ?? DEFAULT_DECODE_OPTIONS.ffprobePath,
    markerRect: {
      x: markerRect.x,
      y: markerRect.y,
      width: markerRect.width,
      height: markerRect.height,
    },
    markerBorderPx: options.markerBorderPx ?? DEFAULT_DECODE_OPTIONS.markerBorderPx,
    minStableFrames: options.minStableFrames ?? DEFAULT_DECODE_OPTIONS.minStableFrames,
    minPatternContrast: options.minPatternContrast ?? DEFAULT_DECODE_OPTIONS.minPatternContrast,
    maxOffsetDriftMs: options.maxOffsetDriftMs ?? DEFAULT_DECODE_OPTIONS.maxOffsetDriftMs,
    maxUncertaintyMs: options.maxUncertaintyMs ?? DEFAULT_DECODE_OPTIONS.maxUncertaintyMs,
  };
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function assertMarkerRect(rect: MarkerRect): void {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isInteger)
    || rect.x < 0
    || rect.y < 0
    || rect.width < 4
    || rect.height < 4) {
    throw new Error('Media clock markerRect must contain non-negative integer x/y and dimensions >= 4');
  }
}

function runProcess(command: string, args: string[], encoding: 'buffer' | 'utf8'): Buffer | string {
  const result = spawnSync(command, args, {
    encoding: encoding === 'buffer' ? undefined : 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`Unable to run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : String(result.stderr ?? '');
    throw new Error(`${command} failed (${result.status ?? 'unknown'}): ${stderr.trim() || 'no stderr'}`);
  }
  if (encoding === 'buffer') return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '');
  return String(result.stdout ?? '');
}

function readFrameTimestamps(videoPath: string, ffprobePath: string): number[] {
  const raw = runProcess(ffprobePath, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_frames',
    '-show_entries', 'frame=best_effort_timestamp_time,pkt_duration_time',
    '-of', 'json',
    videoPath,
  ], 'utf8') as string;

  let parsed: { frames?: Array<{ best_effort_timestamp_time?: string; pkt_duration_time?: string }> };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch (error) {
    throw new Error(`ffprobe returned invalid frame metadata: ${error instanceof Error ? error.message : String(error)}`);
  }

  const timestamps: number[] = [];
  for (const frame of parsed.frames ?? []) {
    const timestamp = Number(frame.best_effort_timestamp_time);
    if (!finiteNumber(timestamp)) continue;
    timestamps.push(timestamp * 1000);
  }
  if (timestamps.length === 0) {
    throw new Error('Finalized video has no usable video-frame timestamps');
  }
  return timestamps;
}

function meanAndContrast(frame: Buffer, rect: MarkerRect, borderPx: number): { centerMean: number; borderMean: number; score: number } {
  const frameWidth = rect.width;
  const frameHeight = rect.height;
  const border = Math.max(1, Math.min(borderPx, Math.floor(Math.min(frameWidth, frameHeight) / 2) - 1));
  let centerSum = 0;
  let centerCount = 0;
  let borderSum = 0;
  let borderCount = 0;
  const centerLeft = border;
  const centerTop = border;
  const centerRight = frameWidth - border;
  const centerBottom = frameHeight - border;

  for (let y = 0; y < frameHeight; y += 1) {
    for (let x = 0; x < frameWidth; x += 1) {
      const value = frame[(y * frameWidth) + x] ?? 0;
      const center = x >= centerLeft && x < centerRight && y >= centerTop && y < centerBottom;
      if (center) {
        centerSum += value;
        centerCount += 1;
      } else {
        borderSum += value;
        borderCount += 1;
      }
    }
  }

  const centerMean = centerCount > 0 ? centerSum / centerCount : 0;
  const borderMean = borderCount > 0 ? borderSum / borderCount : 0;
  // A visible marker is a white center surrounded by a dark border.  Using
  // the spatial fingerprint rejects blank/white startup frames that a single
  // average-luminance threshold would mistake for the marker.
  const score = centerMean - borderMean;
  return { centerMean, borderMean, score };
}

function markerVisible(frame: Buffer, rect: MarkerRect, borderPx: number, minPatternContrast: number): { visible: boolean; score: number } {
  const { centerMean, borderMean, score } = meanAndContrast(frame, rect, borderPx);
  const visible = score >= minPatternContrast && centerMean >= 125 && borderMean <= 105;
  return { visible, score };
}

function markerFramesFromRaw(raw: Buffer, timestamps: number[], options: typeof DEFAULT_DECODE_OPTIONS): DecodedMarkerFrame[] {
  const frameBytes = options.markerRect.width * options.markerRect.height;
  if (frameBytes <= 0 || raw.length < frameBytes) return [];
  const availableFrames = Math.floor(raw.length / frameBytes);
  const frameCount = Math.min(availableFrames, timestamps.length);
  const frames: DecodedMarkerFrame[] = [];
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const frame = raw.subarray(frameIndex * frameBytes, (frameIndex + 1) * frameBytes);
    const visibility = markerVisible(frame, options.markerRect, options.markerBorderPx, options.minPatternContrast);
    frames.push({
      frameIndex,
      timestampMs: timestamps[frameIndex],
      patternScore: visibility.score,
      visible: visibility.visible,
    });
  }
  return frames;
}

/**
 * Decode the marker ROI from the finalized video.  This intentionally uses
 * ffmpeg/ffprobe on the file after Playwright has closed the context; a live
 * recording path is not treated as evidence.
 */
export function decodeMediaClockMarker(videoPath: string, options: MediaClockDecodeOptions = {}): DecodedMarkerFrame[] {
  const merged = mergedDecodeOptions(options);
  assertMarkerRect(merged.markerRect);
  const timestamps = readFrameTimestamps(videoPath, merged.ffprobePath);
  const rect = merged.markerRect;
  const filter = `crop=${rect.width}:${rect.height}:${rect.x}:${rect.y},format=gray`;
  const raw = runProcess(merged.ffmpegPath, [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', videoPath,
    '-map', '0:v:0',
    '-vf', filter,
    '-an',
    '-sn',
    // Preserve one decoded sample per finalized presentation frame.  The
    // timestamps come from ffprobe; duplicating/dropping frames here would
    // break the frame-to-timestamp correspondence for VFR recordings.
    '-fps_mode', 'passthrough',
    '-f', 'rawvideo',
    '-pix_fmt', 'gray',
    'pipe:1',
  ], 'buffer') as Buffer;
  return markerFramesFromRaw(raw, timestamps, merged);
}

/** Detect accepted visible-marker pulses, ignoring startup/background frames. */
export function detectMediaClockTransitions(
  frames: readonly DecodedMarkerFrame[],
  options: Pick<MediaClockDecodeOptions, 'minStableFrames'> = {},
): VideoMarkerTransition[] {
  const minStableFrames = Math.max(1, Math.floor(options.minStableFrames ?? DEFAULT_DECODE_OPTIONS.minStableFrames));
  const transitions: VideoMarkerTransition[] = [];
  let index = 0;
  while (index < frames.length) {
    if (!frames[index].visible) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < frames.length && frames[index].visible) index += 1;
    const endExclusive = index;
    const stableFrames = endExclusive - start;
    if (stableFrames < minStableFrames) continue;
    const previousTimestamp = start > 0 ? frames[start - 1].timestampMs : 0;
    const firstTimestamp = frames[start].timestampMs;
    const frameDuration = start + 1 < frames.length
      ? Math.max(0, frames[start + 1].timestampMs - firstTimestamp)
      : (start > 0 ? Math.max(0, firstTimestamp - previousTimestamp) : 0);
    // With a preceding frame the transition is between two presentation
    // timestamps. If the marker is already present in frame zero there is no
    // preceding observation, so retain a full first-frame interval instead of
    // manufacturing a zero-width, overconfident bracket.
    const bracketStartMs = start > 0 ? previousTimestamp : Math.max(0, firstTimestamp - frameDuration);
    const bracketEndMs = start > 0 ? firstTimestamp : firstTimestamp + frameDuration;
    const confidence = Math.min(...frames.slice(start, endExclusive).map((frame) => frame.patternScore));
    transitions.push({
      frameIndex: frames[start].frameIndex,
      videoTimeMs: firstTimestamp,
      bracketStartMs,
      bracketEndMs: Math.max(bracketStartMs, bracketEndMs),
      markerState: 1,
      confidence,
      stableFrames,
    });
  }
  return transitions;
}

function phaseRank(phase: MediaClockPhase): number {
  if (phase === 'start' || phase === 'preroll') return 0;
  if (phase === 'end' || phase === 'postroll') return 1;
  return 2;
}

function normalizeEvents(events: readonly MarkerBracketEvent[], recordingId?: string): MarkerBracketEvent[] {
  const filtered = events.filter((event) => !recordingId || event.recordingId === recordingId);
  return filtered
    .filter((event) => event.type === undefined || event.type === 'marker_brackets')
    .filter((event) => finiteNumber(event.workerBeforeMs) && finiteNumber(event.workerAfterMs))
    .filter((event) => event.workerAfterMs >= event.workerBeforeMs)
    .sort((left, right) => {
      const sequenceDelta = (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER);
      if (sequenceDelta !== 0) return sequenceDelta;
      return left.workerBeforeMs - right.workerBeforeMs;
    });
}

/** Median spacing of decoded frame timestamps, or null when it cannot be measured. */
export function estimateFrameIntervalMs(frames: readonly Pick<DecodedMarkerFrame, 'timestampMs'>[]): number | null {
  const deltas: number[] = [];
  for (let i = 1; i < frames.length; i += 1) {
    const delta = frames[i].timestampMs - frames[i - 1].timestampMs;
    if (finiteNumber(delta) && delta > 0) deltas.push(delta);
  }
  if (deltas.length === 0) return null;
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)];
}

/** Reject invalid limits before launching a browser or decoding a recording. */
export function validateMediaClockLimits(options: Pick<MediaClockDecodeOptions, 'maxOffsetDriftMs' | 'maxUncertaintyMs'>): void {
  for (const name of ['maxOffsetDriftMs', 'maxUncertaintyMs'] as const) {
    const value = options[name];
    if (value !== undefined && (!finiteNumber(value) || value < 0)) throw new Error(`Invalid media clock limit: ${name}`);
  }
}

function failedCalibration(
  recordingId: string,
  error: string,
  transitions: VideoMarkerTransition[] = [],
  decodedFrames = 0,
  maxOffsetDriftMs = DEFAULT_DECODE_OPTIONS.maxOffsetDriftMs,
): MediaClockCalibration {
  return {
    ok: false,
    recordingId,
    offsetMs: null,
    uncertaintyMs: null,
    driftMs: null,
    maxOffsetDriftMs,
    samples: [],
    transitions,
    decodedFrames,
    error,
    workerToVideoMs: () => {
      throw new Error(`Media clock calibration failed for ${recordingId}: ${error}`);
    },
  };
}

function chooseRecordingId(events: readonly MarkerBracketEvent[], requested?: string): string {
  if (requested) return requested;
  const ids = [...new Set(events
    .filter((event) => event.type === undefined || event.type === 'marker_brackets')
    .map((event) => event.recordingId)
    .filter(Boolean))];
  if (ids.length === 1) return ids[0];
  if (ids.length === 0) return 'unknown';
  throw new Error(`Media clock events contain multiple recording IDs; specify recordingId (${ids.join(', ')})`);
}

/**
 * Calibrate one finalized raw recording.  The mapping is an offset only: a
 * start/end disagreement above maxOffsetDriftMs fails closed instead of
 * silently introducing a time scale that could move a user action into a
 * neighboring scene.
 */
export function calibrateVideo(
  videoPath: string,
  events: readonly MarkerBracketEvent[],
  options: CalibrateVideoOptions = {},
): MediaClockCalibration {
  try { validateMediaClockLimits(options); } catch (error) {
    return failedCalibration(options.recordingId ?? 'unknown', error instanceof Error ? error.message : 'Invalid media clock limit');
  }
  let recordingId: string;
  try {
    recordingId = chooseRecordingId(events, options.recordingId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failedCalibration(options.recordingId ?? 'unknown', message, [], 0, options.maxOffsetDriftMs ?? DEFAULT_DECODE_OPTIONS.maxOffsetDriftMs);
  }
  const merged = mergedDecodeOptions(options);
  let frames: DecodedMarkerFrame[];
  try {
    frames = decodeMediaClockMarker(videoPath, merged);
  } catch (error) {
    return failedCalibration(recordingId, error instanceof Error ? error.message : String(error), [], 0, merged.maxOffsetDriftMs);
  }
  const frameIntervalMs = estimateFrameIntervalMs(frames);
  const frameNote = frameIntervalMs === null ? 'unknown frame interval' : `frame interval ${frameIntervalMs.toFixed(2)}ms`;
  const transitions = detectMediaClockTransitions(frames, merged);
  const rawSelectedEvents = events.filter((event) => (
    event.recordingId === recordingId
    && (event.type === undefined || event.type === 'marker_brackets')
    && phaseRank(event.phase) < 2
  ));
  const invalidEvent = rawSelectedEvents.find((event) => (
    !finiteNumber(event.workerBeforeMs)
    || !finiteNumber(event.workerAfterMs)
    || event.workerAfterMs < event.workerBeforeMs
    || (event.markerState !== undefined && event.markerState !== 1)
    || ([event.browserBeforeMs, event.browserAppliedMs, event.browserAfterMs].some((value) => value !== undefined)
      && (!finiteNumber(event.browserBeforeMs)
        || !finiteNumber(event.browserAppliedMs)
        || !finiteNumber(event.browserAfterMs)
        || event.browserAppliedMs < event.browserBeforeMs
        || event.browserAfterMs < event.browserAppliedMs))
  ));
  if (invalidEvent) {
    return failedCalibration(
      recordingId,
      'Invalid media clock marker bracket: worker timestamps must be finite and ordered and markerState must be 1',
      transitions,
      frames.length,
      merged.maxOffsetDriftMs,
    );
  }
  const selectedEvents = normalizeEvents(events, recordingId)
    .filter((event) => phaseRank(event.phase) < 2);
  const starts = selectedEvents.filter((event) => phaseRank(event.phase) === 0);
  const ends = selectedEvents.filter((event) => phaseRank(event.phase) === 1);
  if (starts.length === 0 || ends.length === 0) {
    return failedCalibration(recordingId, 'Calibration requires both start/preroll and end/postroll marker brackets', transitions, frames.length, merged.maxOffsetDriftMs);
  }
  if (transitions.length !== selectedEvents.length) {
    return failedCalibration(
      recordingId,
      `Marker pulse count is ambiguous: finalized video contains ${transitions.length} pulse(s), but ${selectedEvents.length} bracket event(s) were recorded`,
      transitions,
      frames.length,
      merged.maxOffsetDriftMs,
    );
  }

  // The runtime emits one visible pulse per calibration call.  Events and
  // pulses are therefore paired in monotonic order.  Extra pulses are not
  // silently reused; selecting the first N makes a duplicate call observable
  // through the later offset/drift checks and event-count diagnostics.
  const orderedEvents = [...selectedEvents].sort((left, right) => {
    const sequenceDelta = (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER);
    if (sequenceDelta !== 0) return sequenceDelta;
    return left.workerBeforeMs - right.workerBeforeMs;
  });
  if (phaseRank(orderedEvents[0].phase) !== 0 || phaseRank(orderedEvents[orderedEvents.length - 1].phase) !== 1) {
    return failedCalibration(
      recordingId,
      'Media clock marker phases are out of order: start/preroll must precede end/postroll',
      transitions,
      frames.length,
      merged.maxOffsetDriftMs,
    );
  }
  const samples: MediaClockSample[] = orderedEvents.map((event, index) => {
    const transition = transitions[index];
    const videoLower = transition.bracketStartMs - event.workerAfterMs;
    const videoUpper = transition.bracketEndMs - event.workerBeforeMs;
    const offsetMs = (videoLower + videoUpper) / 2;
    return {
      recordingId,
      phase: event.phase,
      workerBeforeMs: event.workerBeforeMs,
      workerAfterMs: event.workerAfterMs,
      videoTimeMs: transition.videoTimeMs,
      videoBracketStartMs: transition.bracketStartMs,
      videoBracketEndMs: transition.bracketEndMs,
      offsetLowerMs: videoLower,
      offsetUpperMs: videoUpper,
      offsetMs,
      uncertaintyMs: Math.max(0, (videoUpper - videoLower) / 2),
      transition,
    };
  });
  const offsetValues = samples.map((sample) => sample.offsetMs);
  const minimumOffset = Math.min(...offsetValues);
  const maximumOffset = Math.max(...offsetValues);
  const driftMs = maximumOffset - minimumOffset;
  if (driftMs > merged.maxOffsetDriftMs) {
    return failedCalibration(
      recordingId,
      `Media clock drift rejected: start/end offset disagreement ${driftMs.toFixed(2)}ms exceeds ${merged.maxOffsetDriftMs.toFixed(2)}ms (${frameNote})`,
      transitions,
      frames.length,
      merged.maxOffsetDriftMs,
    );
  }

  // The midpoint of the conservative offset intervals is the least-surprising
  // estimate for a constant offset.  Keep uncertainty conservative: include
  // the widest bracket and half the observed pulse disagreement.
  const offsetMs = offsetValues.reduce((sum, value) => sum + value, 0) / offsetValues.length;
  const uncertaintyMs = Math.max(...samples.map((sample) => sample.uncertaintyMs)) + (driftMs / 2);
  if (uncertaintyMs > merged.maxUncertaintyMs) {
    return failedCalibration(
      recordingId,
      `Media clock uncertainty rejected: ${uncertaintyMs.toFixed(2)}ms exceeds ${merged.maxUncertaintyMs.toFixed(2)}ms`,
      transitions,
      frames.length,
      merged.maxOffsetDriftMs,
    );
  }
  return {
    ok: true,
    recordingId,
    offsetMs,
    uncertaintyMs,
    driftMs,
    maxOffsetDriftMs: merged.maxOffsetDriftMs,
    samples,
    transitions,
    decodedFrames: frames.length,
    workerToVideoMs(workerMs: number): number {
      if (!finiteNumber(workerMs)) throw new Error('workerToVideoMs requires a finite worker timestamp');
      return workerMs + offsetMs;
    },
  };
}

/** Standalone mapper for callers that persist only the calibration payload. */
export function workerToVideoMs(calibration: Pick<MediaClockCalibration, 'ok' | 'offsetMs'>, workerMs: number): number {
  if (!calibration.ok || !finiteNumber(calibration.offsetMs)) {
    throw new Error('Cannot map worker time without a valid media clock calibration');
  }
  if (!finiteNumber(workerMs)) throw new Error('workerToVideoMs requires a finite worker timestamp');
  return workerMs + calibration.offsetMs;
}

/**
 * Browser/Playwright runtime source.  It is intentionally a complete snippet
 * rather than an import: generated specs can splice it into their source and
 * call `await calibrate(activePage, recordingId, 'start'|'end')`.
 *
 * The visible pulse is applied in one RAF and confirmed by a second RAF.  The
 * host bracket surrounds only that evaluate call, before the hold/hide phase,
 * so marker dwell does not inflate clock uncertainty.  The marker is hidden
 * again before the helper resolves, keeping calibration out of scene footage.
 */
export const mediaClockCalibrationRuntimeSource = `
const DEMO_MEDIA_CLOCK_MARKER_ID = ${JSON.stringify(MEDIA_CLOCK_MARKER.id)};
const DEMO_MEDIA_CLOCK_MARKER_PREROLL_MS = ${MEDIA_CLOCK_MARKER.defaultPreRollMs};
const DEMO_MEDIA_CLOCK_MARKER_HOLD_MS = ${MEDIA_CLOCK_MARKER.defaultHoldMs};
const DEMO_MEDIA_CLOCK_MARKER_RECT = ${JSON.stringify({
  x: MEDIA_CLOCK_MARKER.x,
  y: MEDIA_CLOCK_MARKER.y,
  width: MEDIA_CLOCK_MARKER.width,
  height: MEDIA_CLOCK_MARKER.height,
  borderPx: MEDIA_CLOCK_MARKER.borderPx,
})};

async function calibrate(page, recordingId, phase, options = {}) {
  const markerId = DEMO_MEDIA_CLOCK_MARKER_ID;
  const holdMs = Number.isFinite(options.holdMs) && options.holdMs >= 0
    ? options.holdMs
    : DEMO_MEDIA_CLOCK_MARKER_HOLD_MS;
  const preRollMs = Number.isFinite(options.preRollMs) && options.preRollMs >= 0
    ? options.preRollMs
    : DEMO_MEDIA_CLOCK_MARKER_PREROLL_MS;
  // Show a uniform magenta (non-detectable) marker during the excluded
  // pre-roll. Identical hidden frames may be dropped by a recorder/encoder,
  // especially at a large viewport; a visible, chromatic but non-pulse state
  // forces real preceding frames without leaking into trimmed scene footage.
  await page.evaluate(async ({ markerId: evaluateMarkerId, rect }) => {
    let marker = document.getElementById(evaluateMarkerId);
    if (!marker) {
      marker = document.createElement('div');
      marker.id = evaluateMarkerId;
      marker.setAttribute('aria-hidden', 'true');
      marker.style.cssText = [
        'position:fixed!important',
        'left:' + rect.x + 'px!important',
        'top:' + rect.y + 'px!important',
        'width:' + rect.width + 'px!important',
        'height:' + rect.height + 'px!important',
        'box-sizing:border-box!important',
        'border:' + rect.borderPx + 'px solid #000!important',
        'background:#000!important',
        'display:block!important',
        'visibility:hidden!important',
        'opacity:1!important',
        'pointer-events:none!important',
        'z-index:2147483647!important',
        'contain:strict!important',
        'font-size:0!important',
        'line-height:0!important',
      ].join(';');
      (document.documentElement || document.body).appendChild(marker);
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
    marker.style.setProperty('border-color', '#ff00ff', 'important');
    marker.style.setProperty('background', '#ff00ff', 'important');
    marker.style.setProperty('visibility', 'visible', 'important');
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }, { markerId, rect: DEMO_MEDIA_CLOCK_MARKER_RECT });
  // Leave a measured blank window in a new context before the first marker
  // pulse. The solid-black state above ensures this window is actually
  // represented in the finalized video.
  if (preRollMs > 0) await page.waitForTimeout(preRollMs);
  const markerState = 1;
  const workerBeforeMs = performance.now();
  const browserBracket = await page.evaluate(async ({ markerId: evaluateMarkerId, rect }) => {
    const ensureMarker = () => {
      let marker = document.getElementById(evaluateMarkerId);
      if (marker) return marker;
      marker = document.createElement('div');
      marker.id = evaluateMarkerId;
      marker.setAttribute('aria-hidden', 'true');
      marker.style.cssText = [
        'position:fixed!important',
        'left:' + rect.x + 'px!important',
        'top:' + rect.y + 'px!important',
        'width:' + rect.width + 'px!important',
        'height:' + rect.height + 'px!important',
        'box-sizing:border-box!important',
        'border:' + rect.borderPx + 'px solid #000!important',
        'background:#000!important',
        'display:block!important',
        'visibility:hidden!important',
        'opacity:1!important',
        'pointer-events:none!important',
        'z-index:2147483647!important',
        'contain:strict!important',
        'font-size:0!important',
        'line-height:0!important',
      ].join(';');
      (document.documentElement || document.body).appendChild(marker);
      return marker;
    };
    const marker = ensureMarker();
    const waitForFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(window.performance.now())));
    const browserBeforeMs = window.performance.now();
    const browserAppliedMs = await new Promise((resolve) => requestAnimationFrame(() => {
      marker.style.setProperty('border-color', '#000', 'important');
      marker.style.setProperty('background', '#fff', 'important');
      marker.style.setProperty('visibility', 'visible', 'important');
      resolve(window.performance.now());
    }));
    // Resolve only after the browser has had a subsequent frame to apply the
    // style. The host's after timestamp then brackets the RAF application.
    const browserAfterMs = await waitForFrame();
    return { browserBeforeMs, browserAppliedMs, browserAfterMs };
  }, { markerId, rect: DEMO_MEDIA_CLOCK_MARKER_RECT });
  const workerAfterMs = performance.now();
  const event = {
    type: 'marker_brackets',
    recordingId,
    phase,
    markerId,
    markerState,
    workerBeforeMs,
    workerAfterMs,
    browserBeforeMs: browserBracket.browserBeforeMs,
    browserAppliedMs: browserBracket.browserAppliedMs,
    browserAfterMs: browserBracket.browserAfterMs,
  };
  await emit(event);
  if (holdMs > 0) await page.waitForTimeout(holdMs);
  await page.evaluate(async ({ markerId: evaluateMarkerId }) => {
    const marker = document.getElementById(evaluateMarkerId);
    if (!marker) return;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    marker.style.setProperty('visibility', 'hidden', 'important');
    marker.style.setProperty('border-color', '#000', 'important');
    marker.style.setProperty('background', '#000', 'important');
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }, { markerId });
  return event;
}
`;

/** Alias with a shorter name for generated-spec consumers. */
export const mediaClockMarkerRuntimeSource = mediaClockCalibrationRuntimeSource;

export function buildMediaClockRuntimeSource(): string {
  return mediaClockCalibrationRuntimeSource;
}

// Browser-domain mapping is separate from the legacy worker-domain mapper.
export * from './browser-clock.js';
export * from './marker-decoder.js';
