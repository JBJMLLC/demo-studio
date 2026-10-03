/**
 * Offset-only mapping from an explicitly stamped browser clock to finalized
 * video presentation timestamps. This module validates caller-supplied
 * evidence bindings; it does not authenticate their semantic origin.
 */

import type { PresentationEdgeBracket } from './marker-decoder.js';
export type { PresentationEdgeBracket } from './marker-decoder.js';

export type BrowserClockBasis = 'performance-relative' | 'performance-origin';

export interface BrowserClockIdentity {
  recordingId: string;
  contextId: string;
  documentId: string;
  documentOriginId: string;
  browserClock: {
    source: 'window.performance.now' | 'window.performance.timeOrigin+window.performance.now';
    basis: BrowserClockBasis;
    unit: 'ms';
    domainId: string;
    resetId: string;
    /** The declared performance timeOrigin, retained even for relative samples. */
    timeOriginMs: number;
  };
  nodeClock: {
    source: 'node:perf_hooks.performance.now';
    unit: 'ms';
    domainId: string;
    resetId: string;
  };
}

export interface BrowserEvidenceReference {
  id: string;
  /** SHA-256 of the exact referenced evidence bytes, supplied by the caller. */
  sha256: string;
}

/** Exact event, context, event-file, and finalized-video evidence identities. */
export interface BrowserClockEvidenceBinding {
  event: BrowserEvidenceReference;
  context: BrowserEvidenceReference;
  file: BrowserEvidenceReference;
  video: BrowserEvidenceReference;
}

export interface SameEvaluationClockSample {
  /** The same non-empty ID must appear on both clock observations. */
  id: string;
  node: {
    evaluationId: string;
    beforeMs: number;
    afterMs: number;
  };
  browser: {
    evaluationId: string;
    /** Same-evaluation browser samples bracketing the applied action. */
    beforeMs: number;
    appliedMs: number;
    afterMs: number;
    /** Optional raw observations; existing RAF samples may both follow the mutation. */
    rafSamplesMs?: [number, number];
  };
}

/** A browser action stamp is never just a number: its clocks and evidence travel with it. */
export interface BrowserActionClockStamp {
  identity: BrowserClockIdentity;
  evaluation: SameEvaluationClockSample;
  evidenceBinding: BrowserClockEvidenceBinding;
}

export interface BrowserClockAnchor extends BrowserActionClockStamp {
  presentationEdge: PresentationEdgeBracket;
}

export interface BrowserClockCalibrationInput {
  fps: number;
  /** Caller-declared measurement/quantization error bounds; no defaults exist. */
  precision: BrowserClockPrecisionBounds;
  /** Expected identity for this one recording/context/document/origin/reset pair. */
  identity: BrowserClockIdentity;
  /** Current caller-observed identities; each edge must match these exact refs. */
  expectedBinding: BrowserClockEvidenceBinding;
  /** States expected from the two explicitly selected marker transitions. */
  expectedStates: { leading: 0 | 1; trailing: 0 | 1 };
  leading?: BrowserClockAnchor;
  trailing?: BrowserClockAnchor;
}

export interface BrowserClockPrecisionBounds {
  browserTimestampErrorMs: number;
  nodeTimestampErrorMs: number;
  videoPtsErrorMs: number;
}

export interface BrowserClockPrecisionReport {
  browserTimestampErrorMs: number | null;
  nodeTimestampErrorMs: number | null;
  videoPtsErrorMs: number | null;
  valid: boolean;
}

export interface BrowserClockRawEdgeSnapshot {
  nodeBeforeMs: number | null;
  nodeAfterMs: number | null;
  browserBeforeMs: number | null;
  browserAppliedMs: number | null;
  browserAfterMs: number | null;
  rafSamplesMs: readonly [number | null, number | null] | null;
  state: number | null;
  precedingFrameIndex: number | null;
  firstChangedFrameIndex: number | null;
  precedingTimeMs: number | null;
  firstChangedTimeMs: number | null;
  stableFrames: number | null;
  confidence: number | null;
}

/** Numeric-only copy of declared measurements; caller strings and extras never enter this snapshot. */
export interface BrowserClockRawSnapshot {
  fps: number | null;
  precision: Omit<BrowserClockPrecisionReport, 'valid'>;
  expectedStates: { leading: number | null; trailing: number | null };
  leading: BrowserClockRawEdgeSnapshot | null;
  trailing: BrowserClockRawEdgeSnapshot | null;
}

export type BrowserClockFailureCode =
  | 'invalid-input'
  | 'invalid-frame-rate'
  | 'invalid-identity'
  | 'identity-mismatch'
  | 'missing-leading-edge'
  | 'missing-trailing-edge'
  | 'invalid-evaluation-bracket'
  | 'invalid-presentation-edge'
  | 'invalid-evidence-binding'
  | 'evidence-binding-mismatch'
  | 'invalid-precision'
  | 'drift-exceeded'
  | 'uncertainty-exceeded'
  | 'invalid-action-stamp'
  | 'calibration-unusable';

export interface BrowserClockFailure {
  code: BrowserClockFailureCode;
  message: string;
  edge?: 'leading' | 'trailing';
}

export interface BrowserClockEdgeMeasurements {
  state: 0 | 1;
  videoBracketMs: { lower: number; upper: number };
  videoCenterMs: number;
  browserAppliedMs: number;
  centerOffsetMs: number;
  edgeHalfWidthMs: number;
  rawBrowserToNodeBridgeMs: { lower: number; upper: number };
  browserToNodeBridgeMs: { lower: number; upper: number } | null;
  rawBridgeHalfWidthMs: number;
  bridgeHalfWidthMs: number | null;
  browserAppliedErrorMs: number | null;
  videoPtsErrorMs: number | null;
  fixedOffsetContributionMs: number | null;
}

export interface BrowserClockCalibration {
  ok: boolean;
  raw: BrowserClockRawSnapshot;
  identity: BrowserClockIdentity | null;
  evidenceBinding: BrowserClockEvidenceBinding | null;
  expectedStates: { leading: 0 | 1; trailing: 0 | 1 } | null;
  precision: BrowserClockPrecisionReport;
  frameGateMs: number | null;
  /** The fixed model never estimates or applies a speed factor. */
  mapping: {
    model: 'offset-only';
    unit: 'ms';
    slope: 1;
    offsetMs: number | null;
    usable: boolean;
  };
  drift: {
    signedMs: number | null;
    absoluteMs: number | null;
  };
  uncertainty: {
    radiusMs: number | null;
    maxAllowedMs: number | null;
    perEdgeMs: { leading: number | null; trailing: number | null };
  };
  edges: { leading: BrowserClockEdgeMeasurements | null; trailing: BrowserClockEdgeMeasurements | null };
  failures: BrowserClockFailure[];
}

const SHA256 = /^[a-f\d]{64}$/i;
const NODE_CLOCK_SOURCE = 'node:perf_hooks.performance.now';
const BROWSER_RELATIVE_SOURCE = 'window.performance.now';
const BROWSER_ORIGIN_SOURCE = 'window.performance.timeOrigin+window.performance.now';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function numericSnapshot(value: unknown): number | null {
  return finite(value) ? value : null;
}

function rawEdgeSnapshot(value: unknown): BrowserClockRawEdgeSnapshot | null {
  if (!isRecord(value)) return null;
  const evaluation = isRecord(value.evaluation) ? value.evaluation : {};
  const node = isRecord(evaluation.node) ? evaluation.node : {};
  const browser = isRecord(evaluation.browser) ? evaluation.browser : {};
  const edge = isRecord(value.presentationEdge) ? value.presentationEdge : {};
  const rafSamples = Array.isArray(browser.rafSamplesMs)
    ? Object.freeze([
      numericSnapshot(browser.rafSamplesMs[0]),
      numericSnapshot(browser.rafSamplesMs[1]),
    ]) as readonly [number | null, number | null]
    : null;
  return Object.freeze({
    nodeBeforeMs: numericSnapshot(node.beforeMs),
    nodeAfterMs: numericSnapshot(node.afterMs),
    browserBeforeMs: numericSnapshot(browser.beforeMs),
    browserAppliedMs: numericSnapshot(browser.appliedMs),
    browserAfterMs: numericSnapshot(browser.afterMs),
    rafSamplesMs: rafSamples,
    state: numericSnapshot(edge.state),
    precedingFrameIndex: numericSnapshot(edge.precedingFrameIndex),
    firstChangedFrameIndex: numericSnapshot(edge.firstChangedFrameIndex),
    precedingTimeMs: numericSnapshot(edge.precedingTimeMs),
    firstChangedTimeMs: numericSnapshot(edge.firstChangedTimeMs),
    stableFrames: numericSnapshot(edge.stableFrames),
    confidence: numericSnapshot(edge.confidence),
  });
}

function rawSnapshot(value: unknown): BrowserClockRawSnapshot {
  const input = isRecord(value) ? value : {};
  const precision = isRecord(input.precision) ? input.precision : {};
  const states = isRecord(input.expectedStates) ? input.expectedStates : {};
  return Object.freeze({
    fps: numericSnapshot(input.fps),
    precision: Object.freeze({
      browserTimestampErrorMs: numericSnapshot(precision.browserTimestampErrorMs),
      nodeTimestampErrorMs: numericSnapshot(precision.nodeTimestampErrorMs),
      videoPtsErrorMs: numericSnapshot(precision.videoPtsErrorMs),
    }),
    expectedStates: Object.freeze({
      leading: numericSnapshot(states.leading),
      trailing: numericSnapshot(states.trailing),
    }),
    leading: rawEdgeSnapshot(input.leading),
    trailing: rawEdgeSnapshot(input.trailing),
  });
}

function precisionReport(value: unknown): BrowserClockPrecisionReport {
  const precision = isRecord(value) ? value : {};
  const browserTimestampErrorMs = numericSnapshot(precision.browserTimestampErrorMs);
  const nodeTimestampErrorMs = numericSnapshot(precision.nodeTimestampErrorMs);
  const videoPtsErrorMs = numericSnapshot(precision.videoPtsErrorMs);
  const valid = browserTimestampErrorMs !== null
    && nodeTimestampErrorMs !== null
    && videoPtsErrorMs !== null
    && browserTimestampErrorMs >= 0
    && nodeTimestampErrorMs >= 0
    && videoPtsErrorMs >= 0;
  return Object.freeze({ browserTimestampErrorMs, nodeTimestampErrorMs, videoPtsErrorMs, valid });
}

function isIdentity(value: unknown): value is BrowserClockIdentity {
  if (!isRecord(value)) return false;
  const browser = value.browserClock;
  const node = value.nodeClock;
  if (!isRecord(browser) || !isRecord(node)) return false;
  const browserBasis = browser.basis;
  const sourceMatchesBasis = (browserBasis === 'performance-relative' && browser.source === BROWSER_RELATIVE_SOURCE)
    || (browserBasis === 'performance-origin' && browser.source === BROWSER_ORIGIN_SOURCE);
  return nonEmptyString(value.recordingId)
    && nonEmptyString(value.contextId)
    && nonEmptyString(value.documentId)
    && nonEmptyString(value.documentOriginId)
    && sourceMatchesBasis
    && browser.unit === 'ms'
    && nonEmptyString(browser.domainId)
    && nonEmptyString(browser.resetId)
    && finite(browser.timeOriginMs)
    && node.source === NODE_CLOCK_SOURCE
    && node.unit === 'ms'
    && nonEmptyString(node.domainId)
    && nonEmptyString(node.resetId);
}

function identityMatches(a: BrowserClockIdentity, b: BrowserClockIdentity): boolean {
  return a.recordingId === b.recordingId
    && a.contextId === b.contextId
    && a.documentId === b.documentId
    && a.documentOriginId === b.documentOriginId
    && a.browserClock.source === b.browserClock.source
    && a.browserClock.basis === b.browserClock.basis
    && a.browserClock.unit === b.browserClock.unit
    && a.browserClock.domainId === b.browserClock.domainId
    && a.browserClock.resetId === b.browserClock.resetId
    && a.browserClock.timeOriginMs === b.browserClock.timeOriginMs
    && a.nodeClock.source === b.nodeClock.source
    && a.nodeClock.unit === b.nodeClock.unit
    && a.nodeClock.domainId === b.nodeClock.domainId
    && a.nodeClock.resetId === b.nodeClock.resetId;
}

function snapshotIdentity(value: BrowserClockIdentity): BrowserClockIdentity {
  return {
    recordingId: value.recordingId, contextId: value.contextId,
    documentId: value.documentId, documentOriginId: value.documentOriginId,
    browserClock: {
      source: value.browserClock.source, basis: value.browserClock.basis, unit: value.browserClock.unit,
      domainId: value.browserClock.domainId, resetId: value.browserClock.resetId, timeOriginMs: value.browserClock.timeOriginMs,
    },
    nodeClock: {
      source: value.nodeClock.source, unit: value.nodeClock.unit,
      domainId: value.nodeClock.domainId, resetId: value.nodeClock.resetId,
    },
  };
}

function snapshotBinding(value: BrowserClockEvidenceBinding): BrowserClockEvidenceBinding {
  const copy = (ref: BrowserEvidenceReference) => ({ id: ref.id, sha256: ref.sha256 });
  return { event: copy(value.event), context: copy(value.context), file: copy(value.file), video: copy(value.video) };
}

function isEvidenceBinding(value: unknown): value is BrowserClockEvidenceBinding {
  if (!isRecord(value)) return false;
  for (const key of ['event', 'context', 'file', 'video'] as const) {
    const reference = value[key];
    if (!isRecord(reference) || !nonEmptyString(reference.id) || typeof reference.sha256 !== 'string' || !SHA256.test(reference.sha256)) {
      return false;
    }
  }
  return true;
}

function evidenceMatches(a: BrowserClockEvidenceBinding, b: BrowserClockEvidenceBinding): boolean {
  return (['event', 'context', 'file', 'video'] as const).every((key) =>
    a[key].id === b[key].id && a[key].sha256.toLowerCase() === b[key].sha256.toLowerCase());
}

function readEdge(value: unknown): PresentationEdgeBracket | null {
  if (!isRecord(value)) return null;
  const { state, precedingFrameIndex, firstChangedFrameIndex, precedingTimeMs, firstChangedTimeMs, stableFrames, confidence } = value;
  if ((state !== 0 && state !== 1)
    || !Number.isInteger(precedingFrameIndex)
    || !Number.isInteger(firstChangedFrameIndex)
    || (precedingFrameIndex as number) < 0
    || firstChangedFrameIndex !== (precedingFrameIndex as number) + 1
    || !finite(precedingTimeMs)
    || !finite(firstChangedTimeMs)
    || (precedingTimeMs as number) < 0
    || (firstChangedTimeMs as number) <= (precedingTimeMs as number)
    || !Number.isInteger(stableFrames)
    || (stableFrames as number) < 2
    || !finite(confidence)
    || (confidence as number) < 0
    || (confidence as number) > 1) {
    return null;
  }
  return value as unknown as PresentationEdgeBracket;
}

function readEvaluation(value: unknown): SameEvaluationClockSample | null {
  if (!isRecord(value) || !nonEmptyString(value.id) || !isRecord(value.node) || !isRecord(value.browser)) return null;
  const node = value.node;
  const browser = value.browser;
  if (node.evaluationId !== value.id
    || browser.evaluationId !== value.id
    || !finite(node.beforeMs)
    || !finite(node.afterMs)
    || (node.beforeMs as number) > (node.afterMs as number)
    || !finite(browser.beforeMs)
    || !finite(browser.appliedMs)
    || !finite(browser.afterMs)
    || (browser.beforeMs as number) > (browser.appliedMs as number)
    || (browser.appliedMs as number) > (browser.afterMs as number)) {
    return null;
  }
  if (browser.rafSamplesMs !== undefined) {
    if (!Array.isArray(browser.rafSamplesMs)
      || browser.rafSamplesMs.length !== 2
      || !finite(browser.rafSamplesMs[0])
      || !finite(browser.rafSamplesMs[1])
      || (browser.rafSamplesMs[0] as number) < (browser.appliedMs as number)
      || (browser.rafSamplesMs[0] as number) > (browser.rafSamplesMs[1] as number)
      || (browser.rafSamplesMs[1] as number) > (browser.afterMs as number)) {
      return null;
    }
  }
  const nodeDuration = (node.afterMs as number) - (node.beforeMs as number);
  const browserDuration = (browser.afterMs as number) - (browser.beforeMs as number);
  if (!finite(nodeDuration) || !finite(browserDuration) || nodeDuration < browserDuration) return null;
  return value as unknown as SameEvaluationClockSample;
}

function failure(code: BrowserClockFailureCode, message: string, edge?: 'leading' | 'trailing'): BrowserClockFailure {
  return edge === undefined ? { code, message } : { code, message, edge };
}

function measureAnchor(
  value: unknown,
  edgeName: 'leading' | 'trailing',
  expectedIdentity: BrowserClockIdentity,
  expectedBinding: BrowserClockEvidenceBinding,
  expectedState: 0 | 1 | null,
  precision: BrowserClockPrecisionReport,
  failures: BrowserClockFailure[],
): BrowserClockEdgeMeasurements | null {
  if (!isRecord(value)) {
    failures.push(failure(edgeName === 'leading' ? 'missing-leading-edge' : 'missing-trailing-edge', `Missing ${edgeName} browser/video edge bracket`, edgeName));
    return null;
  }

  if (!isIdentity(value.identity)) {
    failures.push(failure('invalid-identity', `${edgeName} edge has a malformed clock or recording identity`, edgeName));
    return null;
  }
  if (!identityMatches(value.identity, expectedIdentity)) {
    failures.push(failure('identity-mismatch', `${edgeName} edge belongs to a different clock domain, reset, recording, context, document, or origin`, edgeName));
  }

  const evaluation = readEvaluation(value.evaluation);
  if (!evaluation) {
    failures.push(failure('invalid-evaluation-bracket', `${edgeName} edge must carry one same-evaluation Node bracket and ordered browser before/applied/after samples`, edgeName));
    return null;
  }

  if (!isEvidenceBinding(value.evidenceBinding)) {
    failures.push(failure('invalid-evidence-binding', `${edgeName} edge has malformed event/context/file/video evidence references`, edgeName));
  } else if (!evidenceMatches(value.evidenceBinding, expectedBinding)) {
    failures.push(failure('evidence-binding-mismatch', `${edgeName} edge evidence is stale or does not match the expected event/context/file/video binding`, edgeName));
  }

  const edge = readEdge(value.presentationEdge);
  if (!edge) {
    failures.push(failure('invalid-presentation-edge', `${edgeName} edge must contain adjacent preceding and first-changed frames with an increasing closed PTS bracket`, edgeName));
    return null;
  }
  if (expectedState !== null && edge.state !== expectedState) {
    failures.push(failure('invalid-presentation-edge', `${edgeName} transition state does not match expectedStates`, edgeName));
  }

  const { node, browser } = evaluation;
  // These are intervals on an offset between clocks, not a comparison of their raw origins.
  const bridgeLower = node.beforeMs - browser.beforeMs;
  const bridgeUpper = node.afterMs - browser.afterMs;
  if (!finite(bridgeLower) || !finite(bridgeUpper) || bridgeLower > bridgeUpper) {
    failures.push(failure('invalid-evaluation-bracket', `${edgeName} Node/browser same-evaluation bridge interval is unordered`, edgeName));
    return null;
  }

  const videoCenterMs = edge.precedingTimeMs + ((edge.firstChangedTimeMs - edge.precedingTimeMs) / 2);
  const centerOffsetMs = videoCenterMs - browser.appliedMs;
  const edgeHalfWidthMs = (edge.firstChangedTimeMs - edge.precedingTimeMs) / 2;
  const rawBridgeHalfWidthMs = (bridgeUpper - bridgeLower) / 2;
  const bridgeExpansionMs = precision.valid
    ? (precision.browserTimestampErrorMs as number) + (precision.nodeTimestampErrorMs as number)
    : null;
  const bridgeHalfWidthMs = bridgeExpansionMs === null ? null : rawBridgeHalfWidthMs + bridgeExpansionMs;
  const expandedBridgeLower = bridgeExpansionMs === null ? null : bridgeLower - bridgeExpansionMs;
  const expandedBridgeUpper = bridgeExpansionMs === null ? null : bridgeUpper + bridgeExpansionMs;
  if (![videoCenterMs, centerOffsetMs, edgeHalfWidthMs, rawBridgeHalfWidthMs].every(Number.isFinite)
    || (bridgeExpansionMs !== null && (![bridgeExpansionMs, bridgeHalfWidthMs, expandedBridgeLower, expandedBridgeUpper].every(Number.isFinite)))) {
    failures.push(failure('invalid-evaluation-bracket', `${edgeName} edge measurements exceed finite millisecond range`, edgeName));
    return null;
  }

  return {
    state: edge.state,
    videoBracketMs: { lower: edge.precedingTimeMs, upper: edge.firstChangedTimeMs },
    videoCenterMs,
    browserAppliedMs: browser.appliedMs,
    centerOffsetMs,
    edgeHalfWidthMs,
    rawBrowserToNodeBridgeMs: { lower: bridgeLower, upper: bridgeUpper },
    browserToNodeBridgeMs: expandedBridgeLower === null || expandedBridgeUpper === null
      ? null
      : { lower: expandedBridgeLower, upper: expandedBridgeUpper },
    rawBridgeHalfWidthMs,
    bridgeHalfWidthMs,
    browserAppliedErrorMs: precision.valid ? precision.browserTimestampErrorMs : null,
    videoPtsErrorMs: precision.valid ? precision.videoPtsErrorMs : null,
    fixedOffsetContributionMs: null,
  };
}

/**
 * Calibrate two caller-selected marker transitions in one browser document.
 * No scale correction, favored edge, or tolerance padding is applied. Frame
 * gate is exactly ceil(1000 / fps).
 */
export function calibrateBrowserClockToVideo(input: BrowserClockCalibrationInput): BrowserClockCalibration {
  const failures: BrowserClockFailure[] = [];
  const raw = rawSnapshot(input);
  const record: Record<string, unknown> = isRecord(input) ? input : {};
  const identityValue: unknown = record.identity;
  const identity = isIdentity(identityValue) ? snapshotIdentity(identityValue) : null;
  if (!identity) failures.push(failure('invalid-identity', 'Calibration requires explicit recording, context, document, origin, source, unit, domain, reset, and timeOrigin identity'));

  const bindingValue: unknown = record.expectedBinding;
  const binding = isEvidenceBinding(bindingValue) ? snapshotBinding(bindingValue) : null;
  if (!binding) failures.push(failure('invalid-evidence-binding', 'Calibration requires exact hashed event, context, file, and video evidence references'));
  else if (identity && binding.context.id !== identity.contextId) {
    failures.push(failure('evidence-binding-mismatch', 'Expected context evidence ID must match the stamped context ID'));
  }

  const precision = precisionReport(record.precision);
  if (!precision.valid) {
    failures.push(failure('invalid-precision', 'Browser timestamp, Node timestamp, and video PTS error bounds must be explicitly declared as finite non-negative milliseconds'));
  }

  const stateValue = record.expectedStates;
  const expectedStates = isRecord(stateValue)
    && (stateValue.leading === 0 || stateValue.leading === 1)
    && (stateValue.trailing === 0 || stateValue.trailing === 1)
    ? { leading: stateValue.leading, trailing: stateValue.trailing } as { leading: 0 | 1; trailing: 0 | 1 }
    : null;
  if (!expectedStates) failures.push(failure('invalid-input', 'Calibration requires explicit leading and trailing expected marker states'));

  const fps = record.fps;
  let frameGateMs: number | null = null;
  if (!finite(fps) || fps <= 0 || !Number.isFinite(Math.ceil(1000 / fps))) {
    failures.push(failure('invalid-frame-rate', 'fps must be finite, positive, and produce a finite frame gate'));
  } else {
    frameGateMs = Math.ceil(1000 / fps);
  }

  const leading = identity && binding
    ? measureAnchor(record.leading, 'leading', identity, binding, expectedStates?.leading ?? null, precision, failures)
    : null;
  const trailing = identity && binding
    ? measureAnchor(record.trailing, 'trailing', identity, binding, expectedStates?.trailing ?? null, precision, failures)
    : null;

  if (leading && trailing) {
    const leadAnchor = record.leading as BrowserClockAnchor;
    const trailAnchor = record.trailing as BrowserClockAnchor;
    const leadEvaluation = readEvaluation(leadAnchor.evaluation);
    const trailEvaluation = readEvaluation(trailAnchor.evaluation);
    if (leadAnchor.evaluation.id === trailAnchor.evaluation.id) {
      failures.push(failure('invalid-evaluation-bracket', 'Leading and trailing marker edges require distinct bracket-backed evaluations'));
    }
    if (leadEvaluation && trailEvaluation
      && (leadEvaluation.browser.appliedMs >= trailEvaluation.browser.appliedMs
        || leadEvaluation.browser.afterMs >= trailEvaluation.browser.beforeMs
        || leadEvaluation.node.afterMs >= trailEvaluation.node.beforeMs)) {
      failures.push(failure('invalid-evaluation-bracket', 'Leading and trailing browser and Node evaluation brackets must be disjoint and temporally ordered'));
    }
    if (leading.videoBracketMs.upper >= trailing.videoBracketMs.lower
      || leadAnchor.presentationEdge.firstChangedFrameIndex >= trailAnchor.presentationEdge.firstChangedFrameIndex) {
      failures.push(failure('invalid-presentation-edge', 'The trailing declared edge must follow the leading declared edge in finalized video PTS and frame order'));
    }
  }

  const offsetMs = leading && trailing ? (leading.centerOffsetMs / 2) + (trailing.centerOffsetMs / 2) : null;
  let signedDriftMs: number | null = null;
  let absoluteDriftMs: number | null = null;
  let uncertaintyRadiusMs: number | null = null;
  let leadingContributionMs: number | null = null;
  let trailingContributionMs: number | null = null;

  if (leading && trailing && offsetMs !== null) {
    signedDriftMs = trailing.centerOffsetMs - leading.centerOffsetMs;
    absoluteDriftMs = Math.abs(signedDriftMs);
    if (precision.valid
      && leading.bridgeHalfWidthMs !== null
      && trailing.bridgeHalfWidthMs !== null
      && leading.browserAppliedErrorMs !== null
      && trailing.browserAppliedErrorMs !== null
      && leading.videoPtsErrorMs !== null
      && trailing.videoPtsErrorMs !== null) {
      leadingContributionMs = Math.abs(leading.centerOffsetMs - offsetMs)
        + leading.edgeHalfWidthMs + leading.bridgeHalfWidthMs
        + leading.browserAppliedErrorMs + leading.videoPtsErrorMs;
      trailingContributionMs = Math.abs(trailing.centerOffsetMs - offsetMs)
        + trailing.edgeHalfWidthMs + trailing.bridgeHalfWidthMs
        + trailing.browserAppliedErrorMs + trailing.videoPtsErrorMs;
      uncertaintyRadiusMs = Math.max(leadingContributionMs, trailingContributionMs);
      leading.fixedOffsetContributionMs = leadingContributionMs;
      trailing.fixedOffsetContributionMs = trailingContributionMs;
    }
    if (![offsetMs, signedDriftMs, absoluteDriftMs].every(Number.isFinite)
      || (uncertaintyRadiusMs !== null && !Number.isFinite(uncertaintyRadiusMs))) {
      failures.push(failure('invalid-evaluation-bracket', 'Combined browser/video calibration exceeds finite millisecond range'));
      uncertaintyRadiusMs = null;
    } else if (frameGateMs !== null) {
      if (absoluteDriftMs > frameGateMs) failures.push(failure('drift-exceeded', `Observed edge-center drift exceeds the ${frameGateMs} ms frame gate`));
      if (uncertaintyRadiusMs !== null && uncertaintyRadiusMs > frameGateMs) {
        failures.push(failure('uncertainty-exceeded', `Composed uncertainty exceeds the ${frameGateMs} ms frame gate`));
      }
    }
  }

  const ok = failures.length === 0 && offsetMs !== null && uncertaintyRadiusMs !== null;
  return {
    ok,
    raw,
    identity,
    evidenceBinding: binding,
    expectedStates,
    precision,
    frameGateMs,
    mapping: { model: 'offset-only', unit: 'ms', slope: 1, offsetMs, usable: ok },
    drift: { signedMs: signedDriftMs, absoluteMs: absoluteDriftMs },
    uncertainty: {
      radiusMs: uncertaintyRadiusMs,
      maxAllowedMs: frameGateMs,
      perEdgeMs: { leading: leadingContributionMs, trailing: trailingContributionMs },
    },
    edges: { leading, trailing },
    failures,
  };
}

/** Apply only a successful, identity- and evidence-matched browser action stamp. */
export function mapBrowserActionToVideoPtsMs(
  calibration: BrowserClockCalibration,
  action: BrowserActionClockStamp,
): number {
  if (!calibration.ok || !calibration.mapping.usable || calibration.mapping.offsetMs === null || !calibration.identity) {
    throw new Error('Cannot map a browser action with an unusable calibration');
  }
  if (!isRecord(action)
    || !isIdentity(action.identity)
    || !identityMatches(action.identity, calibration.identity)
    || !readEvaluation(action.evaluation)
    || !isEvidenceBinding(action.evidenceBinding)
    || !calibration.evidenceBinding
    || !evidenceMatches(action.evidenceBinding, calibration.evidenceBinding)) {
    throw new Error('Browser action stamp has a mismatched clock basis/origin, domain/reset, or event/context/file/video evidence binding');
  }
  const browserMs = action.evaluation.browser.appliedMs;
  const leadingMs = calibration.edges.leading?.browserAppliedMs;
  const trailingMs = calibration.edges.trailing?.browserAppliedMs;
  if (leadingMs === undefined || trailingMs === undefined || browserMs < leadingMs || browserMs > trailingMs) {
    throw new Error('Browser action is outside the bracketed browser-clock interval');
  }
  const videoPtsMs = browserMs + calibration.mapping.offsetMs;
  if (!finite(videoPtsMs)) throw new Error('Browser action maps outside finite video PTS milliseconds');
  return videoPtsMs;
}
