import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cleanup, generate, getStatus, prepare, reconcile, submitReview } from '../src/mission.js';
import { computeWordingApprovalHash, planSchema, type DemoPlan, type CaptureResult, type NarrationResult, type RenderResult } from '../src/schemas.js';
import { ExternalOutcomeUnknownError, sha256Of, sha256OfFile, writeJsonAtomic } from '../src/store.js';

const scratchDirectories: string[] = [];
afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'demo-studio-core-'));
  scratchDirectories.push(directory);
  return directory;
}

function makePlan(overrides: Partial<DemoPlan> = {}): DemoPlan {
  const value = {
    schemaVersion: 1 as const,
    id: 'example',
    title: 'A compact product story',
    product: 'Example product',
    audience: 'New users',
    outcome: 'Understand one workflow',
    mode: 'captioned' as const,
    targetUrl: 'http://127.0.0.1:4300/',
    viewport: { width: 640, height: 360 },
    presentation: { cursor: 'pointer' as const, captions: true },
    duration: { targetSeconds: 1, hardLimit: false },
    scenes: [{ id: 'intro', before: 'Start', during: 'Show the workflow', after: 'Finish', say: '', learn: 'One outcome', next: '', holdMs: 0, actions: [], assertions: [] }],
    wordingApproval: { sha256: '' },
    ...overrides,
  };
  value.wordingApproval = { sha256: computeWordingApprovalHash(value as DemoPlan) };
  return planSchema.parse(value);
}

function ffmpeg(args: string[]): void {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', timeout: 20_000 });
  if (result.error || result.status !== 0) throw new Error(`ffmpeg fixture generation failed: ${result.stderr}`);
}

function writePlan(directory: string, plan: DemoPlan, fileName = 'plan.json'): string {
  const path = join(directory, fileName);
  writeJsonAtomic(path, plan);
  return path;
}

function makeAdapters(plan: DemoPlan, missionDirectory: string) {
  let captures = 0;
  let renders = 0;
  const capture = async (): Promise<CaptureResult> => {
    captures += 1;
    const captureDirectory = join(missionDirectory, 'capture');
    mkdirSync(captureDirectory, { recursive: true });
    const recording = join(captureDirectory, 'recording.mp4');
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=navy:s=640x360:r=30:d=1', '-an', '-c:v', 'mpeg4', '-q:v', '3', recording]);
    const before = join(captureDirectory, 'intro-before.png');
    const after = join(captureDirectory, 'intro-after.png');
    ffmpeg(['-i', recording, '-frames:v', '1', before]);
    copyFileSync(before, after);
    return {
      recordings: ['capture/recording.mp4'], width: plan.viewport.width, height: plan.viewport.height, fps: 30, durationMs: 1_000,
      clock: { originMs: 12.5, verified: true, uncertaintyMs: 2, recordingSha256: sha256OfFile(recording) },
      scenes: [{ id: 'intro', startMs: 0, endMs: 1_000, beforeFrame: 'capture/intro-before.png', afterFrame: 'capture/intro-after.png', cursorStart: { x: 320, y: 180 }, cursorEnd: { x: 320, y: 180 } }],
      events: [], assertions: [],
    };
  };
  const render = async (_plan: DemoPlan, captureResult: CaptureResult): Promise<RenderResult> => {
    renders += 1;
    const renderDirectory = join(missionDirectory, 'render');
    mkdirSync(renderDirectory, { recursive: true });
    const videoPath = join(renderDirectory, 'demo.mp4');
    copyFileSync(join(missionDirectory, captureResult.recordings[0]!), videoPath);
    const posterPath = join(renderDirectory, 'poster.png');
    ffmpeg(['-i', videoPath, '-frames:v', '1', posterPath]);
    const timelinePath = join(renderDirectory, 'timeline.json');
    writeFileSync(timelinePath, '{"schemaVersion":1}\n');
    return {
      videoPath: 'render/demo.mp4', posterPath: 'render/poster.png', timelinePath: 'render/timeline.json',
      sampledFrames: ['render/poster.png'], durationMs: 1_000, sha256: sha256OfFile(videoPath), playbackRate: 1, hasAudio: false,
    };
  };
  return { capture, render, counts: () => ({ captures, renders }) };
}

describe('public plan and durable mission core', () => {
  it('requires strict authored wording, matching approval hashes, and spoken anchors for active narrated actions', () => {
    const plan = makePlan();
    expect(plan.presentation).toEqual({ cursor: 'pointer', captions: true });
    expect(plan.fps).toBe(30);
    expect(() => planSchema.parse({ ...plan, privateBrand: 'not allowed' })).toThrow();

    const narrated = makePlan({
      mode: 'narrated',
      narrator: { provider: 'voicebox', profileId: 'local-profile' },
      scenes: [{ id: 'intro', say: 'Click the overview panel.', actions: [{ id: 'open-overview', type: 'click', selector: '#overview', atMs: 400, spokenAnchor: 'overview panel' }] }],
    });
    expect(narrated.scenes[0]?.actions[0]?.atMs).toBe(400);
    const missingAnchor = { ...narrated, scenes: [{ ...narrated.scenes[0]!, actions: [{ ...narrated.scenes[0]!.actions[0]!, spokenAnchor: 'pricing' }] }] };
    missingAnchor.wordingApproval = { sha256: computeWordingApprovalHash(missingAnchor) };
    expect(() => planSchema.parse(missingAnchor)).toThrow(/spokenAnchor/);
    const staleWords = { ...plan, scenes: [{ ...plan.scenes[0]!, say: 'Changed after approval.' }] };
    expect(() => planSchema.parse(staleWords)).toThrow(/wordingApproval/);
  });

  it('rechecks target evidence, caches complete generation across restart, and binds independent approval to exact artifacts', async () => {
    const work = scratch();
    const planPath = writePlan(work, makePlan());
    let readinessChecks = 0;
    const readinessHash = sha256Of('same bounded target evidence');
    const prepared = await prepare(planPath, work, {
      actorId: 'demo-studio-producer',
      runtimeProfile: 'test-runtime-v1',
      checkTargetReady: () => { readinessChecks += 1; return { ready: true, evidenceHash: readinessHash }; },
    });
    expect(prepared.status).toBe('prepared');
    const directory = resolve(work, 'missions', prepared.missionId);
    const adapters = makeAdapters(makePlan(), directory);
    const first = await generate(prepared.missionId, work, { actorId: 'demo-studio-producer', ...adapters });
    expect(first.mission.status).toBe('awaiting-review');
    expect(first.audit.status).toBe('needs-review');
    expect(first.audit.semanticTruth).toBe('not-evaluated');

    const restarted = await prepare(planPath, work, {
      actorId: 'demo-studio-producer',
      runtimeProfile: 'test-runtime-v1',
      checkTargetReady: () => { readinessChecks += 1; return { ready: true, evidenceHash: readinessHash }; },
    });
    expect(restarted.missionId).toBe(prepared.missionId);
    const cached = await generate(prepared.missionId, work, { actorId: 'demo-studio-producer', ...adapters });
    expect(adapters.counts()).toEqual({ captures: 1, renders: 1 });
    expect(cached.reviewPacket.packetHash).toBe(first.reviewPacket.packetHash);
    expect(readinessChecks).toBe(2);

    const stale = {
      missionId: prepared.missionId, packetHash: sha256Of('stale packet'), planHash: prepared.planHash, videoHash: first.render.sha256,
      reviewerId: 'independent-reviewer', reviewerType: 'independent' as const, verdict: 'approved' as const,
      checks: { contentTruth: 'pass' as const, uxQuality: 'pass' as const }, findings: [],
    };
    await expect(submitReview(stale, work)).rejects.toThrow(/stale/);
    await expect(submitReview({ ...stale, packetHash: first.reviewPacket.packetHash, reviewerId: 'demo-studio-producer' }, work)).rejects.toThrow(/caller-supplied reviewer ID/);
    await expect(submitReview({ ...stale, packetHash: first.reviewPacket.packetHash, checks: { contentTruth: 'fail', uxQuality: 'pass' } }, work)).rejects.toThrow(/passing/);
    const contradiction = await submitReview({
      ...stale, packetHash: first.reviewPacket.packetHash, verdict: 'revise', checks: { contentTruth: 'fail', uxQuality: 'pass' },
      findings: [{ id: 'contradictory-claim', severity: 'P2', sceneId: 'intro', summary: 'Narration contradicts the visible product result.' }],
    }, work);
    expect(contradiction.status).toBe('revise');
    const highFinding = { id: 'claim-needs-proof', severity: 'P1' as const, sceneId: 'intro', summary: 'The screen claim needs an evidence check.' };
    const independentReview = await submitReview({ ...stale, packetHash: first.reviewPacket.packetHash, findings: [highFinding] }, work);
    expect(independentReview.status).toBe('awaiting-operator-review');
    expect(independentReview.identityAssurance).toBe('caller-attested');
    const reviewCache = await generate(prepared.missionId, work, { actorId: 'demo-studio-producer', ...adapters });
    expect(reviewCache.mission.status).toBe('awaiting-operator-review');
    await expect(submitReview({ ...stale, packetHash: first.reviewPacket.packetHash, reviewerType: 'operator', findings: [{ ...highFinding, disposition: 'accepted' }] }, work)).rejects.toThrow(/independent/);
    await expect(submitReview({ ...stale, packetHash: first.reviewPacket.packetHash, reviewerId: 'second-reviewer', reviewerType: 'operator', findings: [highFinding] }, work)).rejects.toThrow(/disposition/);
    const approval = await submitReview({ ...stale, packetHash: first.reviewPacket.packetHash, reviewerId: 'operator-reviewer', reviewerType: 'operator', findings: [{ ...highFinding, disposition: 'accepted' }] }, work);
    expect(approval.status).toBe('approved');
    const approvedCache = await generate(prepared.missionId, work, { actorId: 'demo-studio-producer', ...adapters });
    expect(approvedCache.mission.status).toBe('approved');
    expect(approvedCache.mission.reviewRound).toBe(3);
    expect(JSON.parse(readFileSync(join(directory, 'review-history.json'), 'utf8')).rounds).toHaveLength(3);

    const changedTarget = await prepare(planPath, work, {
      actorId: 'demo-studio-producer', runtimeProfile: 'test-runtime-v1',
      checkTargetReady: () => ({ ready: true, evidenceHash: sha256Of('changed target body') }),
    });
    expect(changedTarget.missionId).not.toBe(prepared.missionId);

    const changedPresentation = makePlan({ presentation: { cursor: 'circle', captions: true } });
    const secondPlanPath = writePlan(work, changedPresentation, 'circle-plan.json');
    const newPresentationMission = await prepare(secondPlanPath, work, {
      actorId: 'demo-studio-producer', runtimeProfile: 'test-runtime-v1',
      checkTargetReady: () => ({ ready: true, evidenceHash: readinessHash }),
    });
    expect(newPresentationMission.missionId).not.toBe(prepared.missionId);
    const notReady = await prepare(planPath, work, {
      actorId: 'demo-studio-producer', runtimeProfile: 'not-ready-runtime',
      checkTargetReady: () => ({ ready: false, evidenceHash: readinessHash }),
    });
    expect(notReady.status).toBe('failed');
    const readyAgain = await prepare(planPath, work, {
      actorId: 'demo-studio-producer', runtimeProfile: 'not-ready-runtime',
      checkTargetReady: () => ({ ready: true, evidenceHash: readinessHash }),
    });
    expect(readyAgain.status).toBe('prepared');
    expect(readyAgain.missionId).not.toBe(notReady.missionId);

    const roundLimitMission = await prepare(planPath, work, {
      actorId: 'demo-studio-producer', runtimeProfile: 'review-round-limit',
      checkTargetReady: () => ({ ready: true, evidenceHash: readinessHash }),
    });
    const roundDirectory = resolve(work, 'missions', roundLimitMission.missionId);
    const roundAdapters = makeAdapters(makePlan(), roundDirectory);
    const roundCandidate = await generate(roundLimitMission.missionId, work, { actorId: 'demo-studio-producer', ...roundAdapters });
    for (let round = 1; round <= 6; round += 1) {
      const receipt = await submitReview({
        missionId: roundLimitMission.missionId, packetHash: roundCandidate.reviewPacket.packetHash,
        planHash: roundLimitMission.planHash, videoHash: roundCandidate.render.sha256, reviewerId: `reviewer-round-${round}`,
        reviewerType: 'independent', verdict: 'revise', checks: { contentTruth: 'inconclusive', uxQuality: 'inconclusive' }, findings: [],
      }, work);
      expect(receipt.round).toBe(round);
    }
    await expect(submitReview({
      missionId: roundLimitMission.missionId, packetHash: roundCandidate.reviewPacket.packetHash,
      planHash: roundLimitMission.planHash, videoHash: roundCandidate.render.sha256, reviewerId: 'reviewer-round-seven',
      reviewerType: 'independent', verdict: 'revise', checks: { contentTruth: 'inconclusive', uxQuality: 'inconclusive' }, findings: [],
    }, work)).rejects.toThrow(/Maximum review rounds/);

    const malformedReceipt = JSON.parse(readFileSync(join(directory, 'mission.json'), 'utf8')) as Record<string, unknown>;
    malformedReceipt.schemaVersion = 2;
    writeJsonAtomic(join(directory, 'mission.json'), malformedReceipt);
    await expect(getStatus(prepared.missionId, work)).rejects.toThrow(/malformed/);
  }, 30_000);

  it('only closes its owned session and retains generated media on cleanup', async () => {
    const work = scratch();
    const planPath = writePlan(work, makePlan());
    const prepared = await prepare(planPath, work, { actorId: 'producer', checkTargetReady: () => ({ ready: true, evidenceHash: sha256Of('target') }) });
    const directory = resolve(work, 'missions', prepared.missionId);
    const adapters = makeAdapters(makePlan(), directory);
    const result = await generate(prepared.missionId, work, { actorId: 'producer', ...adapters });
    const video = join(directory, result.render.videoPath);
    let closed = 0;
    const cleaned = await cleanup(prepared.missionId, work, { actorId: 'producer', closeOwnedSession: () => { closed += 1; } });
    expect(cleaned.status).toBe('cleaned');
    expect(closed).toBe(1);
    expect(existsSync(video)).toBe(true);

    const notReady = await prepare(writePlan(work, makePlan(), 'not-ready.json'), work, {
      actorId: 'producer', checkTargetReady: () => ({ ready: false, evidenceHash: sha256Of('target not ready') }),
    });
    expect(notReady.status).toBe('failed');
    const preservedFailure = await cleanup(notReady.missionId, work, { actorId: 'producer' });
    expect(preservedFailure.status).toBe('failed');
    expect(preservedFailure.currentStage).toBe('target-check');
    expect(preservedFailure.failureCode).toBe('target-check-failed');
  }, 30_000);

  it('keeps the capture and render errors as in-memory causes without persisting them', async () => {
    const work = scratch();
    const plan = makePlan();
    const planPath = writePlan(work, plan);
    const prepared = await prepare(planPath, work, { actorId: 'producer', checkTargetReady: () => ({ ready: true, evidenceHash: sha256Of('target') }) });
    const directory = resolve(work, 'missions', prepared.missionId);
    const adapters = makeAdapters(plan, directory);
    const captureError = await generate(prepared.missionId, work, { actorId: 'producer', capture: async () => { throw new Error('selector #private-detail timed out'); }, render: adapters.render }).catch((error: unknown) => error as Error);
    expect(captureError.message).toMatch(/verified receipt/);
    expect((captureError.cause as Error).message).toBe('selector #private-detail timed out');
    expect(readFileSync(join(directory, 'mission.json'), 'utf8')).not.toContain('private-detail');

    const renderWork = scratch();
    const renderPlanPath = writePlan(renderWork, plan);
    const renderMission = await prepare(renderPlanPath, renderWork, { actorId: 'producer', checkTargetReady: () => ({ ready: true, evidenceHash: sha256Of('target') }) });
    const renderDirectory = resolve(renderWork, 'missions', renderMission.missionId);
    const renderAdapters = makeAdapters(plan, renderDirectory);
    const renderError = await generate(renderMission.missionId, renderWork, { actorId: 'producer', capture: renderAdapters.capture, render: async () => { throw new Error('composition #private-detail failed'); } }).catch((error: unknown) => error as Error);
    expect(renderError.message).toMatch(/Render did not reach a verified receipt/);
    expect((renderError.cause as Error).message).toBe('composition #private-detail failed');
    expect(readFileSync(join(renderDirectory, 'mission.json'), 'utf8')).not.toContain('private-detail');
  }, 30_000);

  it('does not repeat an uncertain capture until an explicit reconciliation decision', async () => {
    const work = scratch();
    const plan = makePlan();
    const planPath = writePlan(work, plan);
    const prepared = await prepare(planPath, work, { actorId: 'producer', checkTargetReady: () => ({ ready: true, evidenceHash: sha256Of('target') }) });
    const directory = resolve(work, 'missions', prepared.missionId);
    const adapters = makeAdapters(plan, directory);
    let captureAttempts = 0;
    const capture = async (capturedPlan: DemoPlan, missionDirectory: string, narration: NarrationResult) => {
      captureAttempts += 1;
      if (captureAttempts === 1) throw new ExternalOutcomeUnknownError('capture');
      return adapters.capture(capturedPlan, missionDirectory, narration);
    };
    await expect(generate(prepared.missionId, work, { actorId: 'producer', capture, render: adapters.render })).rejects.toThrow(/verified receipt/);
    let releaseClose!: () => void;
    let reportCloseStarted!: () => void;
    const closeStarted = new Promise<void>((resolve) => { reportCloseStarted = resolve; });
    const closing = cleanup(prepared.missionId, work, {
      actorId: 'operator',
      closeOwnedSession: () => {
        reportCloseStarted();
        return new Promise<void>((resolve) => { releaseClose = resolve; });
      },
    });
    await closeStarted;
    const duringCleanup = await getStatus(prepared.missionId, work);
    expect(duringCleanup.status).toBe('unknown-after-timeout');
    expect(duringCleanup.currentStage).toBe('capture');
    expect(duringCleanup.stages.cleanup.status).toBe('running');
    releaseClose();
    const afterSuccessfulCleanup = await closing;
    expect(afterSuccessfulCleanup.status).toBe('unknown-after-timeout');
    expect(afterSuccessfulCleanup.currentStage).toBe('capture');
    await expect(cleanup(prepared.missionId, work, {
      actorId: 'operator', closeOwnedSession: () => { throw new Error('temporary close failure'); },
    })).rejects.toThrow(/retained all mission artifacts/);
    const afterFailedCleanup = await getStatus(prepared.missionId, work);
    expect(afterFailedCleanup.status).toBe('unknown-after-timeout');
    expect(afterFailedCleanup.currentStage).toBe('capture');
    expect(afterFailedCleanup.failureCode).toBe('external-outcome-unknown');
    expect(afterFailedCleanup.stages.cleanup.status).toBe('failed');
    const afterCleanup = await cleanup(prepared.missionId, work, { actorId: 'operator' });
    expect(afterCleanup.status).toBe('unknown-after-timeout');
    expect(afterCleanup.currentStage).toBe('capture');
    expect(afterCleanup.failureCode).toBe('external-outcome-unknown');
    await expect(generate(prepared.missionId, work, { actorId: 'producer', capture, render: adapters.render })).rejects.toThrow(/explicit reconciliation/);
    expect(captureAttempts).toBe(1);
    const reconciled = await reconcile(prepared.missionId, work, { actorId: 'operator', action: 'retry-uncertain-stage' });
    expect(reconciled.status).toBe('prepared');
    const result = await generate(prepared.missionId, work, { actorId: 'producer', capture, render: adapters.render });
    expect(result.mission.status).toBe('awaiting-review');
    expect(captureAttempts).toBe(2);
  }, 30_000);
});
