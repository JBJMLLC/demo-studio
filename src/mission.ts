import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { auditMedia } from './audit.js';
import type {
  GenerateResult,
  MissionCleanupDependencies,
  MissionGenerateDependencies,
  MissionPrepareDependencies,
  MissionReceipt,
  MissionStage,
  MediaAuditResult,
  ReviewFinding,
  ReviewPacket,
  ReviewReceipt,
  ReviewSubmission,
  StageReceipt,
} from './contracts.js';
import { captureResultSchema, missionReceiptSchema, narrationResultSchema, planSchema, renderResultSchema, reviewHistorySchema, reviewSubmissionSchema } from './schemas.js';
import type { CaptureResult, DemoPlan, NarrationResult, RenderResult } from './schemas.js';
import {
  ExternalOutcomeUnknownError,
  MalformedReceiptError,
  ensurePrivateDirectory,
  missionDirectory,
  missionLockState,
  missionPath,
  missionReceiptPath,
  readJson,
  sha256Of,
  sha256OfFile,
  sha256OfJson,
  withMissionLock,
  writeJsonAtomic,
} from './store.js';
import {
  authorizeNarrationRetry,
  prepareNarration as defaultPrepareNarration,
  reconcileNarrationPending,
} from './narration.js';

interface NarrationReceiptOnDisk {
  schemaVersion: 1;
  inputHash: string;
  result: NarrationResult;
}

interface ReviewHistory {
  schemaVersion: 1;
  missionId: string;
  packetHash: string;
  rounds: ReviewReceipt[];
}

export type MissionStatusResult = { status: 'missing' } | MissionReceipt;
export type ReconciliationAction = 'retry-uncertain-stage' | 'accept-captured-artifacts';

export function parsePlanFile(planPath: string): DemoPlan {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(resolve(planPath), 'utf8')); }
  catch { throw new Error('Plan file is missing or is not valid JSON'); }
  const result = planSchema.safeParse(raw);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')).filter(Boolean))];
    throw new Error(`Plan validation failed${fields.length ? ` for ${fields.join(', ')}` : ''}`);
  }
  return result.data;
}

export async function prepare(planPath: string, workDirectory: string, dependencies: MissionPrepareDependencies): Promise<MissionReceipt> {
  const plan = parsePlanFile(planPath);
  const actorId = requireActor(dependencies.actorId);
  const now = dependencies.now ?? (() => new Date());
  const runtimeProfileHash = sha256Of(dependencies.runtimeProfile ?? 'browser-v1');
  const planHash = sha256OfJson(plan);
  // Readiness is rechecked on every prepare. Its bounded evidence hash is part
  // of mission identity so a changed target document cannot reuse old media.
  const targetEvidence = await dependencies.checkTargetReady(plan);
  if (!targetEvidence || typeof targetEvidence.ready !== 'boolean'
    || !/^sha256:[a-f0-9]{64}$/.test(targetEvidence.evidenceHash)) {
    throw new Error('Target readiness did not return a valid evidence hash');
  }
  const missionId = `demo-${sha256OfJson({
    planHash, runtimeProfileHash, targetEvidenceHash: targetEvidence.evidenceHash, targetReady: targetEvidence.ready,
  }).slice(7, 31)}`;
  const directory = missionDirectory(workDirectory, missionId);
  ensurePrivateDirectory(directory);
  return withMissionLock(directory, async () => {
    const receiptPath = missionReceiptPath(workDirectory, missionId);
    if (existsSync(receiptPath)) {
      let existing = readMissionReceipt(receiptPath);
      if (existing.planHash !== planHash || existing.runtimeProfileHash !== runtimeProfileHash) {
        throw new Error('Mission ID collision with a different plan or runtime profile');
      }
      if (['preparing', 'running'].includes(existing.status)) {
        existing = markInterruptedIfOwnerGone(existing, now);
        writeMission(directory, existing, now);
      }
      return existing;
    }

    const timestamp = now().toISOString();
    writeJsonAtomic(missionPath(directory, 'plan.json'), plan);
    let receipt: MissionReceipt = {
      schemaVersion: 1,
      missionId,
      status: 'preparing',
      currentStage: 'target-check',
      createdAt: timestamp,
      updatedAt: timestamp,
      artifactRetentionUntil: new Date(now().getTime() + 24 * 60 * 60 * 1000).toISOString(),
      planHash,
      wordingApprovalHash: plan.wordingApproval.sha256,
      runtimeProfileHash,
      producerFingerprint: sha256Of(actorId),
      heartbeatAt: timestamp,
      stages: emptyStages(),
      artifacts: { planFile: 'plan.json' },
      reviewRound: 0,
      maxReviewRounds: 6,
      failureCode: null,
    };
    beginStage(receipt, 'target-check', timestamp);
    writeMission(directory, receipt, now);
    try {
      if (!targetEvidence.ready) throw new Error('target-not-ready');
      completeStage(receipt, 'target-check', targetEvidence.evidenceHash, now().toISOString());
      if (plan.mode === 'narrated') {
        beginStage(receipt, 'narration', now().toISOString());
        receipt.currentStage = 'narration';
        writeMission(directory, receipt, now);
        const narration = dependencies.prepareNarration
          ? await dependencies.prepareNarration(plan, directory)
          : await defaultPrepareNarration(plan, directory, { sourceDirectory: dirname(resolve(planPath)) });
        validateNarrationArtifacts(narration, directory, plan);
        const narrationHash = sha256OfJson(narration);
        writeJsonAtomic(missionPath(directory, 'narration.json'), { schemaVersion: 1, inputHash: narrationHash, result: narration } satisfies NarrationReceiptOnDisk);
        completeStage(receipt, 'narration', narrationHash, now().toISOString());
        receipt.artifacts.narrationFile = 'narration.json';
      } else {
        const narration = narrationResultSchema.parse({ provider: 'supplied', tracks: [] });
        const narrationHash = sha256OfJson(narration);
        writeJsonAtomic(missionPath(directory, 'narration.json'), { schemaVersion: 1, inputHash: narrationHash, result: narration } satisfies NarrationReceiptOnDisk);
        skipStage(receipt, 'narration', narrationHash, now().toISOString());
        receipt.artifacts.narrationFile = 'narration.json';
      }
      receipt.status = 'prepared';
      receipt.currentStage = null;
      receipt.failureCode = null;
      writeMission(directory, receipt, now);
      return receipt;
    } catch (error) {
      const unknown = error instanceof ExternalOutcomeUnknownError;
      const stage: MissionStage = receipt.currentStage ?? 'target-check';
      failStage(receipt, stage, unknown ? 'external-outcome-unknown' : `${stage}-failed`, unknown, now().toISOString());
      receipt.status = unknown ? 'unknown-after-timeout' : 'failed';
      receipt.failureCode = unknown ? 'external-outcome-unknown' : `${stage}-failed`;
      writeMission(directory, receipt, now);
      return receipt;
    }
  });
}

export async function generate(missionId: string, workDirectory: string, dependencies: MissionGenerateDependencies): Promise<GenerateResult> {
  requireActor(dependencies.actorId);
  const now = dependencies.now ?? (() => new Date());
  const directory = missionDirectory(workDirectory, missionId);
  return withMissionLock(directory, async () => {
    let mission = readMissionReceipt(missionReceiptPath(workDirectory, missionId));
    if (['awaiting-review', 'awaiting-operator-review', 'approved', 'revise', 'cleaned'].includes(mission.status)) {
      return loadCompletedGenerate(mission, directory);
    }
    if (mission.status === 'running' || mission.status === 'preparing') {
      mission = markInterruptedIfOwnerGone(mission, now);
      writeMission(directory, mission, now);
    }
    if (mission.status !== 'prepared') {
      throw new Error(`Mission is ${mission.status}; explicit reconciliation is required before generation`);
    }
    const plan = loadStoredPlan(directory, mission.planHash);
    const narration = loadNarration(directory, mission.artifacts.narrationFile);
    mission.status = 'running';
    mission.failureCode = null;

    let capture: CaptureResult;
    const existingCapture = tryLoadCapture(directory, mission.artifacts.captureFile);
    if (existingCapture) {
      capture = existingCapture;
      const captureHash = sha256OfJson(capture);
      mission.artifacts.captureFile = 'capture.json';
      if (mission.stages.capture.evidenceHash !== captureHash) {
        mission.stages.capture = completeStageValue(mission.stages.capture, captureHash, now().toISOString());
      }
    } else {
      const captureStarted = now().toISOString();
      mission.currentStage = 'capture';
      beginStage(mission, 'capture', captureStarted);
      writeMission(directory, mission, now);
      try {
        capture = captureResultSchema.parse(await dependencies.capture(plan, directory, narration));
        validateCaptureArtifacts(capture, directory);
        const captureHash = sha256OfJson(capture);
        writeJsonAtomic(missionPath(directory, 'capture.json'), capture);
        completeStage(mission, 'capture', captureHash, now().toISOString());
        mission.artifacts.captureFile = 'capture.json';
      } catch (error) {
        const unknown = error instanceof ExternalOutcomeUnknownError;
        failStage(mission, 'capture', unknown ? 'external-outcome-unknown' : 'capture-failed', unknown, now().toISOString());
        mission.status = unknown ? 'unknown-after-timeout' : 'failed';
        mission.failureCode = unknown ? 'external-outcome-unknown' : 'capture-failed';
        mission.currentStage = 'capture';
        writeMission(directory, mission, now);
        // The cause stays in memory for the caller; receipts never serialize it.
        throw new Error(`Capture did not reach a verified receipt (${mission.failureCode})`, { cause: error });
      }
    }

    let render: RenderResult;
    const existingRender = tryLoadRender(directory, mission.artifacts.renderFile);
    if (existingRender) {
      render = existingRender;
      const renderHash = sha256OfJson(render);
      mission.artifacts.renderFile = 'render.json';
      mission.artifacts.videoPath = render.videoPath;
      mission.artifacts.posterPath = render.posterPath;
      mission.artifacts.timelinePath = render.timelinePath;
      mission.artifacts.sampledFrames = render.sampledFrames;
      if (mission.stages.render.evidenceHash !== renderHash) {
        mission.stages.render = completeStageValue(mission.stages.render, renderHash, now().toISOString());
      }
    } else {
      const renderStarted = now().toISOString();
      mission.currentStage = 'render';
      beginStage(mission, 'render', renderStarted);
      writeMission(directory, mission, now);
      try {
        render = renderResultSchema.parse(await dependencies.render(plan, capture, narration, directory));
        validateRenderArtifacts(render, directory);
        const renderHash = sha256OfJson(render);
        writeJsonAtomic(missionPath(directory, 'render.json'), render);
        completeStage(mission, 'render', renderHash, now().toISOString());
        mission.artifacts.renderFile = 'render.json';
        mission.artifacts.videoPath = render.videoPath;
        mission.artifacts.posterPath = render.posterPath;
        mission.artifacts.timelinePath = render.timelinePath;
        mission.artifacts.sampledFrames = render.sampledFrames;
      } catch (error) {
        failStage(mission, 'render', 'render-failed', false, now().toISOString());
        mission.status = 'failed';
        mission.failureCode = 'render-failed';
        mission.currentStage = 'render';
        writeMission(directory, mission, now);
        throw new Error('Render did not reach a verified receipt (render-failed)', { cause: error });
      }
    }

    const auditStarted = now().toISOString();
    mission.currentStage = 'audit';
    beginStage(mission, 'audit', auditStarted);
    writeMission(directory, mission, now);
    let audit;
    try {
      audit = auditMedia(plan, capture, render, directory, narration, { planHash: mission.planHash, now });
      writeJsonAtomic(missionPath(directory, 'audit.json'), audit);
      completeStage(mission, 'audit', audit.auditHash, now().toISOString());
      mission.artifacts.auditFile = 'audit.json';
    } catch {
      failStage(mission, 'audit', 'audit-failed', false, now().toISOString());
      mission.status = 'failed';
      mission.failureCode = 'audit-failed';
      mission.currentStage = 'audit';
      writeMission(directory, mission, now);
      throw new Error('Media audit could not be verified (audit-failed)');
    }
    if (audit.status === 'fail') {
      mission.status = 'failed';
      mission.failureCode = 'media-audit-failed';
      mission.currentStage = 'audit';
      writeMission(directory, mission, now);
      return { mission, capture, render, audit, reviewPacket: createReviewPacket(mission, capture, render, audit, now) };
    }

    const packet = createReviewPacket(mission, capture, render, audit, now);
    writeJsonAtomic(missionPath(directory, 'review-packet.json'), packet);
    writeJsonAtomic(missionPath(directory, 'review-history.json'), { schemaVersion: 1, missionId, packetHash: packet.packetHash, rounds: [] } satisfies ReviewHistory);
    mission.artifacts.reviewPacketFile = 'review-packet.json';
    mission.artifacts.reviewHistoryFile = 'review-history.json';
    mission.status = 'awaiting-review';
    mission.currentStage = null;
    mission.failureCode = null;
    writeMission(directory, mission, now);
    return { mission, capture, render, audit, reviewPacket: packet };
  });
}

export async function getStatus(missionId: string, workDirectory: string): Promise<MissionStatusResult> {
  const directory = missionDirectory(workDirectory, missionId);
  const receiptPath = missionReceiptPath(workDirectory, missionId);
  if (!existsSync(receiptPath)) return { status: 'missing' };
  const lockState = missionLockState(directory);
  if (lockState === 'live' || lockState === 'unknown') return readMissionReceipt(receiptPath);
  return withMissionLock(directory, async () => {
    let receipt = readMissionReceipt(receiptPath);
    if (receipt.status === 'running' || receipt.status === 'preparing') {
      receipt = markInterruptedIfOwnerGone(receipt, () => new Date());
      writeMission(directory, receipt, () => new Date());
    }
    return receipt;
  });
}

export async function reconcile(
  missionId: string,
  workDirectory: string,
  input: { actorId: string; action: ReconciliationAction },
): Promise<MissionReceipt> {
  const actorId = requireActor(input.actorId);
  const now = () => new Date();
  const directory = missionDirectory(workDirectory, missionId);
  return withMissionLock(directory, async () => {
    const mission = readMissionReceipt(missionReceiptPath(workDirectory, missionId));
    if (!['unknown-after-timeout', 'failed'].includes(mission.status)) throw new Error('Reconciliation is only valid for an interrupted or failed mission stage');
    if (input.action === 'accept-captured-artifacts') {
      if (mission.currentStage !== 'capture') throw new Error('Only an uncertain capture may be accepted as captured artifacts');
      const capture = tryLoadCapture(directory, mission.artifacts.captureFile ?? 'capture.json');
      if (!capture) throw new Error('No complete captured artifact receipt exists to accept');
      validateCaptureArtifacts(capture, directory);
      mission.artifacts.captureFile = 'capture.json';
      completeStage(mission, 'capture', sha256OfJson(capture), now().toISOString());
      mission.status = 'prepared';
      mission.currentStage = null;
      mission.failureCode = null;
      writeMission(directory, mission, now);
      recordReconciliation(directory, missionId, actorId, 'accept-captured-artifacts', now().toISOString());
      return mission;
    }
    // This records an explicit operator decision. It does not itself rerun capture or paid narration.
    const stage = mission.currentStage;
    if (!stage) throw new Error('Mission has no uncertain stage to reconcile');
    if (stage === 'narration') {
      const plan = loadStoredPlan(directory, mission.planHash);
      const provider = plan.narrator?.provider;
      if (!provider || provider === 'supplied') throw new Error('Supplied narration cannot have an uncertain provider outcome');
      const pendingSceneIds = plan.scenes.map((scene) => scene.id)
        .filter((sceneId) => existsSync(missionPath(directory, `narration-pending/${sceneId}.json`)));
      if (pendingSceneIds.length !== 1) throw new Error('Pending narration request could not be uniquely identified; preserve it for manual inspection');
      const sceneId = pendingSceneIds[0]!;
      if (provider === 'voicebox') {
        const outcome = await reconcileNarrationPending(directory, sceneId, { baseUrl: process.env.DEMO_STUDIO_VOICEBOX_URL ?? plan.narrator?.baseUrl });
        if (outcome.status === 'pending' || outcome.status === 'unknown') return mission;
        if (outcome.status === 'failed') authorizeNarrationRetry(directory, sceneId, now());
      } else {
        authorizeNarrationRetry(directory, sceneId, now());
      }
      try {
        const narration = await defaultPrepareNarration(plan, directory);
        validateNarrationArtifacts(narration, directory, plan);
        const narrationHash = sha256OfJson(narration);
        writeJsonAtomic(missionPath(directory, 'narration.json'), { schemaVersion: 1, inputHash: narrationHash, result: narration } satisfies NarrationReceiptOnDisk);
        mission.artifacts.narrationFile = 'narration.json';
        mission.stages.narration = completeStageValue(mission.stages.narration, narrationHash, now().toISOString());
        mission.status = 'prepared';
        mission.currentStage = null;
        mission.failureCode = null;
        recordReconciliation(directory, missionId, actorId, input.action, now().toISOString());
        writeMission(directory, mission, now);
        return mission;
      } catch (error) {
        const unknown = error instanceof ExternalOutcomeUnknownError;
        failStage(mission, 'narration', unknown ? 'external-outcome-unknown' : 'narration-failed', unknown, now().toISOString());
        mission.status = unknown ? 'unknown-after-timeout' : 'failed';
        mission.failureCode = unknown ? 'external-outcome-unknown' : 'narration-failed';
        writeMission(directory, mission, now);
        return mission;
      }
    }
    if (stage === 'capture') {
      mission.stages.capture = pendingStage();
      mission.artifacts.captureFile = undefined;
    } else if (stage === 'render') {
      mission.stages.render = pendingStage();
      mission.artifacts.renderFile = undefined;
    } else {
      throw new Error('This uncertain stage cannot be retried automatically');
    }
    mission.status = 'prepared';
    mission.currentStage = null;
    mission.failureCode = null;
    writeMission(directory, mission, now);
    recordReconciliation(directory, missionId, actorId, input.action, now().toISOString());
    return mission;
  });
}

function loadCompletedGenerate(mission: MissionReceipt, directory: string): GenerateResult {
  const plan = loadStoredPlan(directory, mission.planHash);
  const narration = loadNarration(directory, mission.artifacts.narrationFile);
  const capture = tryLoadCapture(directory, mission.artifacts.captureFile);
  const render = tryLoadRender(directory, mission.artifacts.renderFile);
  if (!capture || !render || !mission.artifacts.auditFile || !mission.artifacts.reviewPacketFile || !mission.artifacts.reviewHistoryFile) {
    throw new MalformedReceiptError();
  }
  const audit = readJson<MediaAuditResult>(missionPath(directory, mission.artifacts.auditFile, true));
  const { auditHash, ...auditBody } = audit;
  if (auditHash !== sha256OfJson(auditBody)
    || audit.planHash !== mission.planHash
    || audit.captureHash !== sha256OfJson(capture)
    || audit.renderHash !== sha256OfJson(render)
    || mission.stages.capture.evidenceHash !== sha256OfJson(capture)
    || mission.stages.render.evidenceHash !== sha256OfJson(render)
    || mission.stages.audit.evidenceHash !== audit.auditHash) {
    throw new MalformedReceiptError();
  }
  const packet = readJson<ReviewPacket>(missionPath(directory, mission.artifacts.reviewPacketFile, true));
  const { packetHash, ...packetBody } = packet;
  if (packetHash !== sha256OfJson(packetBody)
    || packet.planHash !== mission.planHash
    || packet.wordingApprovalHash !== plan.wordingApproval.sha256
    || packet.captureHash !== sha256OfJson(capture)
    || packet.renderHash !== sha256OfJson(render)
    || packet.videoHash !== render.sha256
    || packet.auditHash !== audit.auditHash) {
    throw new MalformedReceiptError();
  }
  const history = readReviewHistory(directory, mission);
  if (history.packetHash !== packet.packetHash || history.rounds.length !== mission.reviewRound) throw new MalformedReceiptError();
  return { mission, capture, render, audit, reviewPacket: packet };
}

export async function submitReview(input: ReviewSubmission, workDirectory: string): Promise<ReviewReceipt> {
  const submission = reviewSubmissionSchema.parse(input);
  const directory = missionDirectory(workDirectory, submission.missionId);
  const now = () => new Date();
  return withMissionLock(directory, async () => {
    const mission = readMissionReceipt(missionReceiptPath(workDirectory, submission.missionId));
    if (!['awaiting-review', 'awaiting-operator-review', 'revise'].includes(mission.status)) {
      throw new Error('Mission is not accepting a review');
    }
    const packet = readJson<ReviewPacket>(missionPath(directory, mission.artifacts.reviewPacketFile ?? 'review-packet.json', true));
    if (submission.packetHash !== packet.packetHash || submission.planHash !== mission.planHash || submission.videoHash !== packet.videoHash) {
      throw new Error('Review hashes are stale or do not match this exact candidate');
    }
    const reviewerFingerprint = sha256Of(submission.reviewerId);
    if (reviewerFingerprint === mission.producerFingerprint) {
      throw new Error('Review is rejected because its caller-supplied reviewer ID matches the producer ID');
    }
    if (submission.findings.some((finding) => finding.sceneId && !planContainsScene(directory, finding.sceneId))) {
      throw new Error('Review finding references an unknown scene');
    }
    if (new Set(submission.findings.map((finding) => finding.id)).size !== submission.findings.length) {
      throw new Error('Review finding IDs must be unique');
    }
    const history = readReviewHistory(directory, mission);
    if (history.rounds.length >= mission.maxReviewRounds) throw new Error('Maximum review rounds reached');
    const priorHighFindings = history.rounds.flatMap((round) => round.findings)
      .filter((finding) => ['P0', 'P1'].includes(finding.severity) && !['fixed', 'accepted'].includes(finding.disposition ?? ''));
    if (submission.reviewerType === 'operator' && priorHighFindings.length > 0) {
      if (history.rounds.at(-1)?.reviewerFingerprint === reviewerFingerprint) {
        throw new Error('P0/P1 operator disposition must come from a reviewer independent of the prior review');
      }
      const operatorFindings = new Map(submission.findings.map((finding) => [finding.id, finding]));
      if (priorHighFindings.some((finding) => {
        const disposition = operatorFindings.get(finding.id)?.disposition;
        return !['fixed', 'accepted'].includes(disposition ?? '');
      })) {
        throw new Error('Operator review must disposition every unresolved prior P0/P1 finding');
      }
    }
    const hasUnresolvedHighFinding = submission.findings.some((finding) => ['P0', 'P1'].includes(finding.severity)
      && (!finding.disposition || finding.disposition === 'rejected'));
    if (submission.reviewerType === 'independent' && submission.findings.some((finding) => finding.disposition)) {
      throw new Error('Only an operator review may disposition P0/P1 findings');
    }
    const allChecksPassed = submission.checks.contentTruth === 'pass' && submission.checks.uxQuality === 'pass';
    if (submission.verdict === 'approved' && !allChecksPassed) throw new Error('Approval requires passing contentTruth and uxQuality checks');
    if (submission.reviewerType === 'operator' && submission.verdict === 'approved'
      && submission.findings.some((finding) => ['P0', 'P1'].includes(finding.severity) && !['fixed', 'accepted'].includes(finding.disposition ?? ''))) {
      throw new Error('Operator approval requires an explicit disposition for every P0/P1 finding');
    }
    const status: ReviewReceipt['status'] = submission.verdict === 'revise' || !allChecksPassed
      ? 'revise'
      : submission.reviewerType === 'independent' && hasUnresolvedHighFinding
        ? 'awaiting-operator-review'
        : submission.reviewerType === 'operator' && hasUnresolvedHighFinding
          ? 'revise'
          : 'approved';
    const receipt: ReviewReceipt = {
      schemaVersion: 1,
      missionId: submission.missionId,
      packetHash: submission.packetHash,
      planHash: submission.planHash,
      videoHash: submission.videoHash,
      reviewerFingerprint,
      identityAssurance: 'caller-attested',
      reviewerType: submission.reviewerType,
      verdict: submission.verdict,
      checks: submission.checks,
      findings: submission.findings as ReviewFinding[],
      round: history.rounds.length + 1,
      createdAt: now().toISOString(),
      status,
    };
    history.rounds.push(receipt);
    writeJsonAtomic(missionPath(directory, 'review-history.json'), history);
    mission.reviewRound = receipt.round;
    mission.status = status;
    mission.currentStage = status === 'approved' || status === 'revise' ? null : 'review';
    mission.stages.review = completeStageValue(mission.stages.review, sha256OfJson(receipt), now().toISOString());
    mission.failureCode = null;
    writeMission(directory, mission, now);
    return receipt;
  });
}

export async function cleanup(missionId: string, workDirectory: string, dependencies: MissionCleanupDependencies): Promise<MissionReceipt> {
  requireActor(dependencies.actorId);
  const now = dependencies.now ?? (() => new Date());
  const directory = missionDirectory(workDirectory, missionId);
  return withMissionLock(directory, async () => {
    let mission = readMissionReceipt(missionReceiptPath(workDirectory, missionId));
    if (mission.status === 'running' || mission.status === 'preparing') {
      // With the exclusive lock held, the prior owner is gone. Record uncertainty before cleanup runs.
      mission = markInterruptedIfOwnerGone(mission, now);
      writeMission(directory, mission, now);
    }
    if (mission.status === 'cleaned') return mission;

    const priorStatus = mission.status;
    const priorStage = mission.currentStage;
    const priorFailureCode = mission.failureCode;
    const preserveFailure = priorStatus === 'failed' || priorStatus === 'unknown-after-timeout';
    const started = now().toISOString();
    beginStage(mission, 'cleanup', started);
    // Keep the failed/uncertain stage addressable in a durable receipt even while
    // the secondary cleanup callback is in flight.
    if (preserveFailure) mission.currentStage = priorStage;
    writeMission(directory, mission, now);
    try {
      await dependencies.closeOwnedSession?.(missionId);
      completeStage(mission, 'cleanup', sha256OfJson({ missionId, closed: true }), now().toISOString());
      mission.status = preserveFailure ? priorStatus : 'cleaned';
      mission.currentStage = preserveFailure ? priorStage : null;
      mission.failureCode = preserveFailure ? priorFailureCode : null;
      // Media, screenshots, plan, narration, and review receipts are retained; cleanup owns no external VM.
      writeMission(directory, mission, now);
      return mission;
    } catch {
      failStage(mission, 'cleanup', 'cleanup-failed', false, now().toISOString());
      // Cleanup is secondary bookkeeping. It must not replace the stage and recovery path
      // that originally failed or whose external outcome is still uncertain.
      mission.status = priorStatus;
      mission.currentStage = priorStage;
      mission.failureCode = priorFailureCode;
      writeMission(directory, mission, now);
      throw new Error('Owned session cleanup failed; retained all mission artifacts');
    }
  });
}

function createReviewPacket(
  mission: MissionReceipt,
  capture: CaptureResult,
  render: RenderResult,
  audit: ReturnType<typeof auditMedia>,
  now: () => Date,
): ReviewPacket {
  const body = {
    schemaVersion: 1 as const,
    missionId: mission.missionId,
    createdAt: now().toISOString(),
    planHash: mission.planHash,
    videoHash: render.sha256,
    wordingApprovalHash: mission.wordingApprovalHash,
    captureHash: sha256OfJson(capture),
    renderHash: sha256OfJson(render),
    auditHash: audit.auditHash,
    videoPath: render.videoPath,
    posterPath: render.posterPath,
    timelinePath: render.timelinePath,
    sampledFrames: render.sampledFrames,
    deterministicAudit: { status: audit.status, findingCodes: audit.findings.map((finding) => finding.code) },
    requiredChecks: ['contentTruth', 'uxQuality'] as ['contentTruth', 'uxQuality'],
  };
  return { ...body, packetHash: sha256OfJson(body) };
}

function readMissionReceipt(path: string): MissionReceipt {
  const raw = readJson<unknown>(path);
  const parsed = missionReceiptSchema.safeParse(raw);
  if (!parsed.success) throw new MalformedReceiptError();
  return parsed.data;
}

function writeMission(directory: string, receipt: MissionReceipt, now: () => Date): void {
  receipt.updatedAt = now().toISOString();
  receipt.heartbeatAt = receipt.updatedAt;
  writeJsonAtomic(missionPath(directory, 'mission.json'), missionReceiptSchema.parse(receipt));
}

function loadStoredPlan(directory: string, expectedHash: string): DemoPlan {
  const plan = planSchema.safeParse(readJson<unknown>(missionPath(directory, 'plan.json', true)));
  if (!plan.success || sha256OfJson(plan.data) !== expectedHash) throw new MalformedReceiptError();
  return plan.data;
}

function loadNarration(directory: string, file?: string): NarrationResult {
  if (!file) return narrationResultSchema.parse({ provider: 'supplied', tracks: [] });
  const receipt = readJson<NarrationReceiptOnDisk>(missionPath(directory, file, true));
  const result = narrationResultSchema.parse(receipt.result);
  if (receipt.schemaVersion !== 1 || receipt.inputHash !== sha256OfJson(result)) throw new MalformedReceiptError();
  validateNarrationArtifacts(result, directory);
  return result;
}

function tryLoadCapture(directory: string, file?: string): CaptureResult | null {
  const path = file ? missionPath(directory, file) : missionPath(directory, 'capture.json');
  if (!existsSync(path)) return null;
  const capture = captureResultSchema.parse(readJson<unknown>(path));
  validateCaptureArtifacts(capture, directory);
  return capture;
}

function tryLoadRender(directory: string, file?: string): RenderResult | null {
  const path = file ? missionPath(directory, file) : missionPath(directory, 'render.json');
  if (!existsSync(path)) return null;
  const render = renderResultSchema.parse(readJson<unknown>(path));
  validateRenderArtifacts(render, directory);
  return render;
}

function validateNarrationArtifacts(narration: NarrationResult, directory: string, plan?: DemoPlan): void {
  const ids = new Set<string>();
  for (const track of narration.tracks) {
    if (ids.has(track.sceneId)) throw new Error('Narration contains duplicate scene tracks');
    ids.add(track.sceneId);
    const path = missionPath(directory, track.path, true);
    if (sha256OfFile(path) !== track.sha256) throw new Error('Narration checksum does not match its audio file');
    if (plan) {
      const scene = plan.scenes.find((candidate) => candidate.id === track.sceneId);
      if (!scene || sha256Of(scene.say) !== track.textSha256) throw new Error('Narration wording does not match the approved scene');
    }
  }
  if (plan?.mode === 'narrated') {
    const expected = plan.scenes.filter((scene) => scene.say.trim()).map((scene) => scene.id);
    if (expected.length !== ids.size || expected.some((id) => !ids.has(id))) throw new Error('Narration does not cover every spoken scene');
  }
}

function validateCaptureArtifacts(capture: CaptureResult, directory: string): void {
  for (const recording of capture.recordings) missionPath(directory, recording, true);
  for (const scene of capture.scenes) {
    missionPath(directory, scene.beforeFrame, true);
    missionPath(directory, scene.afterFrame, true);
  }
}

function validateRenderArtifacts(render: RenderResult, directory: string): void {
  missionPath(directory, render.videoPath, true);
  missionPath(directory, render.posterPath, true);
  missionPath(directory, render.timelinePath, true);
  for (const frame of render.sampledFrames) missionPath(directory, frame, true);
  if (sha256OfFile(missionPath(directory, render.videoPath, true)) !== render.sha256) throw new Error('Rendered video checksum does not match its receipt');
}

function readReviewHistory(directory: string, mission: MissionReceipt): ReviewHistory {
  const path = missionPath(directory, mission.artifacts.reviewHistoryFile ?? 'review-history.json');
  if (!existsSync(path)) throw new MalformedReceiptError();
  const parsed = reviewHistorySchema.safeParse(readJson<unknown>(path));
  if (!parsed.success || parsed.data.missionId !== mission.missionId) throw new MalformedReceiptError();
  const history = parsed.data;
  const packet = readJson<ReviewPacket>(missionPath(directory, mission.artifacts.reviewPacketFile ?? 'review-packet.json', true));
  if (history.packetHash !== packet.packetHash || history.rounds.some((round, index) =>
    round.missionId !== mission.missionId || round.packetHash !== packet.packetHash || round.round !== index + 1)) {
    throw new MalformedReceiptError();
  }
  return history;
}

function planContainsScene(directory: string, sceneId: string): boolean {
  return loadStoredPlan(directory, readMissionReceipt(missionPath(directory, 'mission.json', true)).planHash).scenes.some((scene) => scene.id === sceneId);
}

function emptyStages(): MissionReceipt['stages'] {
  const pending = (): StageReceipt => ({ status: 'pending', startedAt: null, completedAt: null, evidenceHash: null, errorCode: null });
  return { 'target-check': pending(), narration: pending(), capture: pending(), render: pending(), audit: pending(), review: pending(), cleanup: pending() };
}

function pendingStage(): StageReceipt {
  return { status: 'pending', startedAt: null, completedAt: null, evidenceHash: null, errorCode: null };
}

function beginStage(receipt: MissionReceipt, stage: MissionStage, startedAt: string): void {
  receipt.stages[stage] = { status: 'running', startedAt, completedAt: null, evidenceHash: null, errorCode: null };
  receipt.currentStage = stage;
}

function completeStage(receipt: MissionReceipt, stage: MissionStage, evidenceHash: string, completedAt: string): void {
  receipt.stages[stage] = { status: 'complete', startedAt: receipt.stages[stage].startedAt ?? completedAt, completedAt, evidenceHash, errorCode: null };
}

function completeStageValue(previous: StageReceipt, evidenceHash: string, completedAt: string): StageReceipt {
  return { status: 'complete', startedAt: previous.startedAt ?? completedAt, completedAt, evidenceHash, errorCode: null };
}

function skipStage(receipt: MissionReceipt, stage: MissionStage, evidenceHash: string, completedAt: string): void {
  receipt.stages[stage] = { status: 'skipped', startedAt: null, completedAt, evidenceHash, errorCode: null };
}

function failStage(receipt: MissionReceipt, stage: MissionStage, code: string, unknown: boolean, completedAt: string): void {
  receipt.stages[stage] = { status: unknown ? 'unknown-after-timeout' : 'failed', startedAt: receipt.stages[stage].startedAt ?? completedAt, completedAt, evidenceHash: null, errorCode: code };
}

function markInterruptedIfOwnerGone(receipt: MissionReceipt, now: () => Date): MissionReceipt {
  // Called only after this process acquired the exclusive mission lock; the prior runner no longer owns it.
  if (receipt.currentStage) failStage(receipt, receipt.currentStage, 'external-outcome-unknown', true, now().toISOString());
  receipt.status = 'unknown-after-timeout';
  receipt.failureCode = 'external-outcome-unknown';
  return receipt;
}

function recordReconciliation(directory: string, missionId: string, actorId: string, action: string, at: string): void {
  const path = missionPath(directory, 'reconciliations.json');
  const entries = existsSync(path) ? readJson<Array<{ at: string; action: string; actorFingerprint: string }>>(path) : [];
  entries.push({ at, action, actorFingerprint: sha256Of(actorId) });
  writeJsonAtomic(path, entries);
}

function requireActor(actorId: string): string {
  if (typeof actorId !== 'string' || actorId.trim().length === 0 || actorId.length > 256) throw new Error('A configured actor ID is required');
  return actorId.trim();
}
