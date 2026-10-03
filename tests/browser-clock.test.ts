import { describe, expect, it } from 'vitest';
import {
  calibrateBrowserClockToVideo,
  mapBrowserActionToVideoPtsMs,
  type BrowserClockAnchor,
  type BrowserClockCalibrationInput,
  type BrowserClockEvidenceBinding,
  type BrowserClockIdentity,
} from '../src/browser-clock.js';

const identity: BrowserClockIdentity = {
  recordingId: 'synthetic-recording-a',
  contextId: 'synthetic-context-a',
  documentId: 'synthetic-document-a',
  documentOriginId: 'synthetic-origin-a',
  browserClock: {
    source: 'window.performance.now',
    basis: 'performance-relative',
    unit: 'ms',
    domainId: 'browser-domain-a',
    resetId: 'browser-reset-a',
    timeOriginMs: 1_700_000_000_000,
  },
  nodeClock: {
    source: 'node:perf_hooks.performance.now',
    unit: 'ms',
    domainId: 'node-domain-a',
    resetId: 'node-reset-a',
  },
};

const evidenceBinding: BrowserClockEvidenceBinding = {
  event: { id: 'synthetic-event-a', sha256: 'a'.repeat(64) },
  context: { id: 'synthetic-context-a', sha256: 'b'.repeat(64) },
  file: { id: 'synthetic-events-file-a', sha256: 'c'.repeat(64) },
  video: { id: 'synthetic-video-a', sha256: 'd'.repeat(64) },
};

function anchor(
  edgeName: 'leading' | 'trailing',
  browserBaseMs: number,
  nodeBaseMs: number,
  videoBaseMs: number,
  overrides: Partial<BrowserClockAnchor> = {},
): BrowserClockAnchor {
  const leading = edgeName === 'leading';
  const edge: BrowserClockAnchor = {
    identity: structuredClone(identity),
    evaluation: {
      id: `synthetic-evaluation-${edgeName}`,
      node: { evaluationId: `synthetic-evaluation-${edgeName}`, beforeMs: nodeBaseMs, afterMs: nodeBaseMs + 10 },
      browser: { evaluationId: `synthetic-evaluation-${edgeName}`, beforeMs: browserBaseMs, appliedMs: browserBaseMs + 2, afterMs: browserBaseMs + 4 },
    },
    evidenceBinding: structuredClone(evidenceBinding),
    presentationEdge: {
      state: leading ? 1 : 0,
      precedingFrameIndex: leading ? 5 : 35,
      firstChangedFrameIndex: leading ? 6 : 36,
      precedingTimeMs: videoBaseMs - 1,
      firstChangedTimeMs: videoBaseMs + 1,
      stableFrames: 3,
      confidence: 0.98,
    },
  };
  return {
    ...edge,
    ...overrides,
    identity: overrides.identity ?? edge.identity,
    evaluation: overrides.evaluation ?? edge.evaluation,
    evidenceBinding: overrides.evidenceBinding ?? edge.evidenceBinding,
    presentationEdge: overrides.presentationEdge ?? edge.presentationEdge,
  };
}

function validInput(overrides: Partial<BrowserClockCalibrationInput> = {}): BrowserClockCalibrationInput {
  return {
    fps: 30,
    precision: { browserTimestampErrorMs: 0, nodeTimestampErrorMs: 0, videoPtsErrorMs: 0 },
    identity: structuredClone(identity),
    expectedBinding: structuredClone(evidenceBinding),
    expectedStates: { leading: 1, trailing: 0 },
    leading: anchor('leading', 100, 1_000, 200),
    trailing: anchor('trailing', 1_100, 2_000, 1_200),
    ...overrides,
  };
}

describe('browser-to-video clock contract', () => {
  it('snapshots accepted identities and evidence instead of trusting mutable diagnostic input', () => {
    const input = validInput();
    const calibration = calibrateBrowserClockToVideo(input);
    const action = anchor('leading', 150, 1_050, 250);
    input.identity.browserClock.resetId = 'changed-after-calibration';
    input.expectedBinding.video.sha256 = 'e'.repeat(64);
    expect(calibration.identity?.browserClock.resetId).toBe('browser-reset-a');
    expect(calibration.evidenceBinding?.video.sha256).toBe('d'.repeat(64));
    expect(calibration.raw).not.toBe(input);
    expect(calibration.raw.leading?.browserAppliedMs).toBe(102);
    expect(mapBrowserActionToVideoPtsMs(calibration, action)).toBe(250);
    action.identity.browserClock.resetId = 'changed-after-calibration';
    expect(() => mapBrowserActionToVideoPtsMs(calibration, action)).toThrow(/reset/);
  });

  it('rejects impossible cross-clock duration brackets on actions as well as anchors', () => {
    const calibration = calibrateBrowserClockToVideo(validInput());
    const action = anchor('leading', 150, 1_050, 250);
    action.evaluation.node.afterMs = action.evaluation.node.beforeMs + 1;
    expect(() => mapBrowserActionToVideoPtsMs(calibration, action)).toThrow();
    expect(calibrateBrowserClockToVideo(validInput({ leading: action })).ok).toBe(false);
  });

  it('rejects RAF observations outside the declared same-evaluation browser bracket', () => {
    const input = validInput();
    input.leading!.evaluation.browser.rafSamplesMs = [103, 105];
    expect(calibrateBrowserClockToVideo(input).ok).toBe(false);
  });

  it('requires explicit precision bounds; unknown precision fails closed', () => {
    const input = validInput() as Partial<BrowserClockCalibrationInput>;
    delete input.precision;
    const calibration = calibrateBrowserClockToVideo(input as BrowserClockCalibrationInput);
    expect(calibration.ok).toBe(false);
    expect(calibration.precision).toEqual({
      browserTimestampErrorMs: null,
      nodeTimestampErrorMs: null,
      videoPtsErrorMs: null,
      valid: false,
    });
    expect(calibration.mapping.offsetMs).toBe(98);
    expect(calibration.mapping.usable).toBe(false);
    expect(calibration.uncertainty.radiusMs).toBeNull();
    expect(calibration.failures.map(({ code }) => code)).toContain('invalid-precision');
  });

  it('adds browser, Node, and video timestamp precision bounds to the bridge and edge radius', () => {
    const calibration = calibrateBrowserClockToVideo(validInput({
      precision: { browserTimestampErrorMs: 1, nodeTimestampErrorMs: 2, videoPtsErrorMs: 3 },
    }));
    expect(calibration.ok).toBe(true);
    expect(calibration.edges.leading?.rawBridgeHalfWidthMs).toBe(3);
    expect(calibration.edges.leading?.browserToNodeBridgeMs).toEqual({ lower: 897, upper: 909 });
    expect(calibration.edges.leading?.bridgeHalfWidthMs).toBe(6);
    expect(calibration.uncertainty.radiusMs).toBe(11);
  });

  it('rejects quantization bounds that push an otherwise accepted fit past the frame gate', () => {
    const calibration = calibrateBrowserClockToVideo(validInput({
      precision: { browserTimestampErrorMs: 16, nodeTimestampErrorMs: 0, videoPtsErrorMs: 0 },
    }));
    expect(calibration.ok).toBe(false);
    expect(calibration.uncertainty.radiusMs).toBe(36);
    expect(calibration.failures.map(({ code }) => code)).toContain('uncertainty-exceeded');
  });

  it('keeps a frozen numeric-only raw snapshot and does not echo extra or malformed values', () => {
    const input = validInput();
    const sentinel = 'SECRET_SENTINEL_DO_NOT_ECHO';
    const withExtras = input as unknown as Record<string, unknown>;
    withExtras.secretSentinel = sentinel;
    const leading = input.leading as unknown as Record<string, unknown>;
    leading.secretSentinel = sentinel;
    (input.identity as unknown as Record<string, unknown>).secretSentinel = sentinel;
    (input.expectedBinding.event as unknown as Record<string, unknown>).secretSentinel = sentinel;
    input.leading!.evaluation.browser.rafSamplesMs = [103, Number.POSITIVE_INFINITY];
    const browser = input.leading!.evaluation.browser as unknown as Record<string, unknown>;
    browser.beforeMs = sentinel;

    const calibration = calibrateBrowserClockToVideo(input);
    const rawText = JSON.stringify(calibration.raw);
    expect(rawText).not.toContain(sentinel);
    expect(JSON.stringify(calibration)).not.toContain(sentinel);
    expect(Object.keys(calibration.raw)).toEqual(['fps', 'precision', 'expectedStates', 'leading', 'trailing']);
    expect(calibration.raw.leading?.browserBeforeMs).toBeNull();
    expect(calibration.raw.leading?.browserAppliedMs).toBe(102);
    expect(calibration.raw.leading?.rafSamplesMs).toEqual([103, null]);
    expect(Object.isFrozen(calibration.raw)).toBe(true);
    expect(Object.isFrozen(calibration.raw.leading?.rafSamplesMs)).toBe(true);

    input.fps = 60;
    input.leading!.evaluation.browser.rafSamplesMs![0] = 104;
    expect(calibration.raw.fps).toBe(30);
    expect(calibration.raw.leading?.rafSamplesMs).toEqual([103, null]);
  });

  it('uses both on/off presentation brackets to fit one offset and maps stamped actions without scaling', () => {
    const calibration = calibrateBrowserClockToVideo(validInput());
    expect(calibration.ok).toBe(true);
    expect(calibration.frameGateMs).toBe(34);
    expect(calibration.mapping).toMatchObject({ model: 'offset-only', slope: 1, offsetMs: 98, usable: true });
    expect(calibration.drift).toEqual({ signedMs: 0, absoluteMs: 0 });
    expect(calibration.uncertainty.radiusMs).toBe(4);
    expect(calibration.edges.leading?.videoBracketMs).toEqual({ lower: 199, upper: 201 });
    expect(calibration.edges.trailing?.videoBracketMs).toEqual({ lower: 1_199, upper: 1_201 });

    const action = anchor('leading', 150, 1_050, 250);
    expect(mapBrowserActionToVideoPtsMs(calibration, action)).toBe(250);
    const outside = anchor('leading', 2_000, 3_000, 3_100);
    expect(() => mapBrowserActionToVideoPtsMs(calibration, outside)).toThrow(/outside the bracketed/);
  });

  it('supports explicitly declared off/on content-boundary transitions and optional post-mutation RAF samples', () => {
    const leading = anchor('leading', 100, 1_000, 200);
    const trailing = anchor('trailing', 1_100, 2_000, 1_200);
    leading.presentationEdge.state = 0;
    trailing.presentationEdge.state = 1;
    leading.evaluation.browser.rafSamplesMs = [103, 104];
    trailing.evaluation.browser.rafSamplesMs = [1_103, 1_104];
    const calibration = calibrateBrowserClockToVideo(validInput({
      expectedStates: { leading: 0, trailing: 1 },
      leading,
      trailing,
    }));
    expect(calibration.ok).toBe(true);

    trailing.evaluation.browser.rafSamplesMs = [1_104, 1_103];
    expect(calibrateBrowserClockToVideo(validInput({
      expectedStates: { leading: 0, trailing: 1 },
      leading,
      trailing,
    })).ok).toBe(false);
  });

  it('rejects center drift over the exact 30 fps frame gate without choosing an edge', () => {
    const tooMuchDrift = anchor('trailing', 1_100, 2_000, 1_235);
    const calibration = calibrateBrowserClockToVideo(validInput({ trailing: tooMuchDrift }));
    expect(calibration.ok).toBe(false);
    expect(calibration.mapping.offsetMs).toBe(115.5);
    expect(calibration.mapping.usable).toBe(false);
    expect(calibration.drift.absoluteMs).toBe(35);
    expect(calibration.failures.map(({ code }) => code)).toContain('drift-exceeded');
  });

  it('rejects edge-plus-bridge uncertainty above the frame gate with no tolerance padding', () => {
    const leading = anchor('leading', 100, 1_000, 200, {
      presentationEdge: {
        state: 1,
        precedingFrameIndex: 5,
        firstChangedFrameIndex: 6,
        precedingTimeMs: 165,
        firstChangedTimeMs: 235,
        stableFrames: 3,
        confidence: 0.98,
      },
    });
    const trailing = anchor('trailing', 1_100, 2_000, 1_200, {
      presentationEdge: {
        state: 0,
        precedingFrameIndex: 35,
        firstChangedFrameIndex: 36,
        precedingTimeMs: 1_165,
        firstChangedTimeMs: 1_235,
        stableFrames: 3,
        confidence: 0.98,
      },
    });
    const calibration = calibrateBrowserClockToVideo(validInput({ leading, trailing }));
    expect(calibration.ok).toBe(false);
    expect(calibration.drift.absoluteMs).toBe(0);
    expect(calibration.uncertainty.radiusMs).toBe(38);
    expect(calibration.failures.map(({ code }) => code)).toContain('uncertainty-exceeded');
  });

  it('rejects a reset/domain mismatch between edge anchors', () => {
    const trailing = anchor('trailing', 1_100, 2_000, 1_200);
    trailing.identity.browserClock.resetId = 'browser-reset-b';
    const calibration = calibrateBrowserClockToVideo(validInput({ trailing }));
    expect(calibration.ok).toBe(false);
    expect(calibration.failures).toContainEqual(expect.objectContaining({ code: 'identity-mismatch', edge: 'trailing' }));
  });

  it('rejects reversed, overlapping, or malformed edge pairs', () => {
    const reversedLeading = anchor('leading', 1_100, 2_000, 1_200);
    const reversedTrailing = anchor('trailing', 100, 1_000, 200);
    const reversed = calibrateBrowserClockToVideo(validInput({ leading: reversedLeading, trailing: reversedTrailing }));
    expect(reversed.ok).toBe(false);
    expect(reversed.failures.map(({ code }) => code)).toContain('invalid-evaluation-bracket');
    expect(reversed.failures.map(({ code }) => code)).toContain('invalid-presentation-edge');

    const malformedEdge = anchor('leading', 100, 1_000, 200, {
      presentationEdge: {
        state: 1,
        precedingFrameIndex: 5,
        firstChangedFrameIndex: 6,
        precedingTimeMs: 199,
        firstChangedTimeMs: 201,
        stableFrames: 1,
        confidence: 1.2,
      },
    });
    const malformed = calibrateBrowserClockToVideo(validInput({ leading: malformedEdge }));
    expect(malformed.ok).toBe(false);
    expect(malformed.failures.map(({ code }) => code)).toContain('invalid-presentation-edge');
  });

  it('rejects stale artifact hashes and retains the raw edge evidence on failure', () => {
    const trailing = anchor('trailing', 1_100, 2_000, 1_200);
    trailing.evidenceBinding.video.sha256 = 'e'.repeat(64);
    const input = validInput({ trailing });
    const calibration = calibrateBrowserClockToVideo(input);
    expect(calibration.ok).toBe(false);
    expect(calibration.raw).not.toBe(input);
    expect(calibration.raw.trailing?.firstChangedTimeMs).toBe(1_201);
    expect(calibration.edges.leading?.videoBracketMs).toEqual({ lower: 199, upper: 201 });
    expect(calibration.failures.map(({ code }) => code)).toContain('evidence-binding-mismatch');
  });

  it('requires both complete edge brackets and never fabricates a frame-zero predecessor', () => {
    const missing = calibrateBrowserClockToVideo(validInput({ trailing: undefined }));
    expect(missing.ok).toBe(false);
    expect(missing.mapping.offsetMs).toBeNull();
    expect(missing.drift.absoluteMs).toBeNull();
    expect(missing.failures.map(({ code }) => code)).toContain('missing-trailing-edge');

    const frameZero = anchor('leading', 100, 1_000, 200, {
      presentationEdge: {
        state: 1,
        precedingFrameIndex: -1,
        firstChangedFrameIndex: 0,
        precedingTimeMs: 0,
        firstChangedTimeMs: 1,
        stableFrames: 3,
        confidence: 0.98,
      },
    });
    const invalid = calibrateBrowserClockToVideo(validInput({ leading: frameZero }));
    expect(invalid.ok).toBe(false);
    expect(invalid.failures.map(({ code }) => code)).toContain('invalid-presentation-edge');
  });

  it('requires explicit relative/origin basis and rejects wrong document origins in the action mapper', () => {
    const calibration = calibrateBrowserClockToVideo(validInput());
    const wrongOrigin = anchor('leading', 150, 1_050, 250);
    wrongOrigin.identity.documentOriginId = 'another-origin';
    expect(() => mapBrowserActionToVideoPtsMs(calibration, wrongOrigin)).toThrow(/basis\/origin/);

    const wrongBasis = anchor('leading', 150, 1_050, 250);
    wrongBasis.identity.browserClock.basis = 'performance-origin';
    expect(calibrateBrowserClockToVideo(validInput({ leading: wrongBasis })).ok).toBe(false);

    const wrongEvidence = anchor('leading', 150, 1_050, 250);
    wrongEvidence.evidenceBinding.event.sha256 = 'f'.repeat(64);
    expect(() => mapBrowserActionToVideoPtsMs(calibration, wrongEvidence)).toThrow(/evidence binding/);
  });

  it('preserves performance-origin milliseconds instead of inferring or normalizing them', () => {
    const originIdentity: BrowserClockIdentity = {
      ...structuredClone(identity),
      browserClock: {
        ...identity.browserClock,
        source: 'window.performance.timeOrigin+window.performance.now',
        basis: 'performance-origin',
        timeOriginMs: 5_000,
      },
    };
    const originAnchor = (
      edgeName: 'leading' | 'trailing',
      browserBaseMs: number,
      nodeBaseMs: number,
      videoBaseMs: number,
    ): BrowserClockAnchor => {
      const made = anchor(edgeName, browserBaseMs, nodeBaseMs, videoBaseMs);
      made.identity = structuredClone(originIdentity);
      return made;
    };
    const calibration = calibrateBrowserClockToVideo(validInput({
      identity: originIdentity,
      leading: originAnchor('leading', 5_100, 1_000, 200),
      trailing: originAnchor('trailing', 6_100, 2_000, 1_200),
    }));
    expect(calibration.ok).toBe(true);
    expect(calibration.mapping.offsetMs).toBe(-4_902);
    expect(mapBrowserActionToVideoPtsMs(calibration, originAnchor('leading', 5_150, 1_050, 250))).toBe(250);
  });
});
