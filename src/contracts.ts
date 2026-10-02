import type { DemoPlan, CaptureResult, NarrationResult, RenderResult } from './schemas.js';

export type MissionStatus =
  | 'preparing'
  | 'prepared'
  | 'running'
  | 'awaiting-review'
  | 'awaiting-operator-review'
  | 'approved'
  | 'revise'
  | 'failed'
  | 'unknown-after-timeout'
  | 'cleaned';

export type MissionStage = 'target-check' | 'narration' | 'capture' | 'render' | 'audit' | 'review' | 'cleanup';
export type StageStatus = 'pending' | 'running' | 'complete' | 'failed' | 'unknown-after-timeout' | 'skipped';

export interface StageReceipt {
  status: StageStatus;
  startedAt: string | null;
  completedAt: string | null;
  evidenceHash: string | null;
  errorCode: string | null;
}

export interface MissionStages {
  'target-check': StageReceipt;
  narration: StageReceipt;
  capture: StageReceipt;
  render: StageReceipt;
  audit: StageReceipt;
  review: StageReceipt;
  cleanup: StageReceipt;
}

/** Local-only receipt. It deliberately stores hashes and relative artifact names, not target URLs or credentials. */
export interface MissionReceipt {
  schemaVersion: 1;
  missionId: string;
  status: MissionStatus;
  currentStage: MissionStage | null;
  createdAt: string;
  updatedAt: string;
  artifactRetentionUntil: string;
  planHash: string;
  wordingApprovalHash: string;
  runtimeProfileHash: string;
  producerFingerprint: string;
  heartbeatAt: string;
  stages: MissionStages;
  artifacts: {
    planFile: 'plan.json';
    narrationFile?: 'narration.json';
    captureFile?: 'capture.json';
    renderFile?: 'render.json';
    auditFile?: 'audit.json';
    reviewPacketFile?: 'review-packet.json';
    reviewHistoryFile?: 'review-history.json';
    videoPath?: string;
    posterPath?: string;
    timelinePath?: string;
    sampledFrames?: string[];
  };
  reviewRound: number;
  maxReviewRounds: 6;
  failureCode: string | null;
}

export interface TargetReadyEvidence {
  ready: boolean;
  /** Hash of bounded health/readiness evidence. Do not include page content or URL. */
  evidenceHash: string;
}

export interface MissionPrepareDependencies {
  actorId: string;
  runtimeProfile?: string;
  checkTargetReady: (plan: DemoPlan) => Promise<TargetReadyEvidence> | TargetReadyEvidence;
  prepareNarration?: (plan: DemoPlan, missionDirectory: string) => Promise<NarrationResult>;
  now?: () => Date;
}

export interface MissionGenerateDependencies {
  actorId: string;
  capture: (plan: DemoPlan, missionDirectory: string, narration: NarrationResult) => Promise<CaptureResult>;
  render: (plan: DemoPlan, capture: CaptureResult, narration: NarrationResult, missionDirectory: string) => Promise<RenderResult>;
  now?: () => Date;
}

export interface MissionCleanupDependencies {
  actorId: string;
  closeOwnedSession?: (missionId: string) => Promise<void> | void;
  now?: () => Date;
}

export type FindingSeverity = 'P0' | 'P1' | 'P2' | 'P3';
export type ReviewDisposition = 'fixed' | 'accepted' | 'rejected';

export interface ReviewFinding {
  id: string;
  severity: FindingSeverity;
  sceneId?: string;
  summary: string;
  disposition?: ReviewDisposition;
}

export interface ReviewPacket {
  schemaVersion: 1;
  packetHash: string;
  missionId: string;
  createdAt: string;
  planHash: string;
  videoHash: string;
  wordingApprovalHash: string;
  captureHash: string;
  renderHash: string;
  auditHash: string;
  videoPath: string;
  posterPath: string;
  timelinePath: string;
  sampledFrames: string[];
  deterministicAudit: {
    status: 'pass' | 'needs-review' | 'fail';
    findingCodes: string[];
  };
  requiredChecks: ['contentTruth', 'uxQuality'];
}

export interface ReviewSubmission {
  missionId: string;
  packetHash: string;
  planHash: string;
  videoHash: string;
  /** Caller-supplied identifier; the local workflow does not authenticate the person behind it. */
  reviewerId: string;
  /** Caller-supplied role claim; the local workflow does not verify organizational independence. */
  reviewerType: 'independent' | 'operator';
  verdict: 'approved' | 'revise';
  checks: {
    contentTruth: 'pass' | 'fail' | 'inconclusive';
    uxQuality: 'pass' | 'fail' | 'inconclusive';
  };
  findings: ReviewFinding[];
}

export interface ReviewReceipt {
  schemaVersion: 1;
  missionId: string;
  packetHash: string;
  planHash: string;
  videoHash: string;
  reviewerFingerprint: string;
  /** Reviewer ID and role are caller-attested claims, not authenticated identities. */
  identityAssurance: 'caller-attested';
  reviewerType: 'independent' | 'operator';
  verdict: 'approved' | 'revise';
  checks: ReviewSubmission['checks'];
  findings: ReviewFinding[];
  round: number;
  createdAt: string;
  status: 'awaiting-operator-review' | 'approved' | 'revise';
}

export type MediaAuditFinding = {
  code:
    | 'RECORDING_COUNT'
    | 'CLOCK_UNVERIFIED'
    | 'CLOCK_HASH_MISMATCH'
    | 'VIEWPORT_MISMATCH'
    | 'SCENE_COVERAGE'
    | 'SCENE_TIMING'
    | 'CURSOR_EVIDENCE'
    | 'CURSOR_SEAM'
    | 'EVENT_COVERAGE'
    | 'EVENT_TIMING'
    | 'SPOKEN_ANCHOR'
    | 'ASSERTION_COVERAGE'
    | 'ASSERTION_FAILED'
    | 'AUDIO_COVERAGE'
    | 'AUDIO_TIMING'
    | 'AUDIO_SPEED_SCALED'
    | 'AUDIO_TAIL'
    | 'RENDER_HASH_MISMATCH'
    | 'RENDER_TIMING'
    | 'RENDER_SPEED_SCALED'
    | 'TARGET_DURATION_MISS'
    | 'SEMANTIC_REVIEW_REQUIRED';
  severity: 'error' | 'warning' | 'review';
  sceneId?: string;
};

export interface MediaAuditResult {
  schemaVersion: 1;
  status: 'pass' | 'needs-review' | 'fail';
  createdAt: string;
  planHash: string;
  wordingApprovalHash: string;
  captureHash: string;
  renderHash: string;
  auditHash: string;
  measuredDurationMs: number;
  findings: MediaAuditFinding[];
  semanticTruth: 'not-evaluated';
}

export interface GenerateResult {
  mission: MissionReceipt;
  capture: CaptureResult;
  render: RenderResult;
  audit: MediaAuditResult;
  reviewPacket: ReviewPacket;
}
