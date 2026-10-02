import { createHash } from 'node:crypto';
import { z } from 'zod';

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const nonEmpty = z.string().trim().min(1).max(20_000);

export const pointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
}).strict();

export const presentationSchema = z.object({
  cursor: z.enum(['pointer', 'circle', 'hidden']).default('pointer'),
  captions: z.boolean().default(true),
}).strict().default({});

export const actionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  type: z.enum(['navigate', 'click', 'type', 'drag', 'wait', 'press']),
  selector: z.string().trim().min(1).max(2_000).optional(),
  value: z.string().max(20_000).optional(),
  url: z.string().trim().min(1).max(4_096).optional(),
  toSelector: z.string().trim().min(1).max(2_000).optional(),
  durationMs: z.number().int().min(0).max(60_000).optional(),
  atMs: z.number().int().nonnegative().max(3_600_000).optional(),
  spokenAnchor: z.string().trim().min(1).max(300).optional(),
}).strict().superRefine((action, ctx) => {
  const requireField = (field: 'selector' | 'value' | 'url' | 'toSelector' | 'durationMs') => {
    if (action[field] === undefined || action[field] === '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${action.type} action requires ${field}` });
    }
  };
  if (action.type === 'navigate') requireField('url');
  if (action.type === 'click') requireField('selector');
  if (action.type === 'type') {
    requireField('selector');
    if (action.value === undefined) requireField('value');
  }
  if (action.type === 'drag') {
    requireField('selector');
    requireField('toSelector');
  }
  if (action.type === 'press') {
    requireField('selector');
    if (action.value === undefined) requireField('value');
  }
  if (action.type === 'wait') requireField('durationMs');
  if (action.type !== 'navigate' && action.url !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: 'url is only supported for navigate actions' });
  }
  if (action.type !== 'drag' && action.toSelector !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['toSelector'], message: 'toSelector is only supported for drag actions' });
  }
  if (action.type !== 'wait' && action.durationMs !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['durationMs'], message: 'durationMs is only supported for wait actions' });
  }
});

export const assertionSchema = z.object({
  selector: z.string().trim().min(1).max(2_000),
  kind: z.enum(['visible', 'text']),
  value: z.string().max(2_000).optional(),
}).strict().superRefine((assertion, ctx) => {
  if (assertion.kind === 'text' && assertion.value === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'text assertions require value' });
  }
  if (assertion.kind === 'visible' && assertion.value !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'visible assertions do not accept value' });
  }
});

export const sceneSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  before: z.string().max(20_000).default(''),
  during: z.string().max(20_000).default(''),
  after: z.string().max(20_000).default(''),
  say: z.string().max(20_000).default(''),
  learn: z.string().max(20_000).default(''),
  next: z.string().max(20_000).default(''),
  holdMs: z.number().int().min(0).max(60_000).default(1_000),
  actions: z.array(actionSchema).default([]),
  assertions: z.array(assertionSchema).default([]),
}).strict();

export const narratorSchema = z.object({
  provider: z.enum(['supplied', 'voicebox', 'elevenlabs']),
  /** Provider selection only. Credentials and service routing come from env vars. */
  voiceId: z.string().trim().min(1).max(256).optional(),
  profileId: z.string().trim().min(1).max(256).optional(),
  baseUrl: z.string().trim().url().max(2_048).optional(),
  /** Local paths keyed by scene ID; only the supplied provider may set these. */
  audioFiles: z.record(z.string().min(1), z.string().trim().min(1).max(4_096)).optional(),
}).strict().superRefine((narrator, ctx) => {
  if (narrator.provider !== 'supplied' && narrator.audioFiles !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['audioFiles'], message: 'audioFiles are only supported by supplied narration' });
  }
  if (narrator.provider === 'supplied' && (narrator.voiceId || narrator.profileId || narrator.baseUrl)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'supplied narration does not use provider or voice configuration' });
  }
  if (narrator.provider === 'elevenlabs' && narrator.baseUrl !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['baseUrl'], message: 'ElevenLabs service routing is configured through environment variables' });
  }
});

export const planSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  title: nonEmpty,
  product: nonEmpty,
  audience: nonEmpty,
  outcome: nonEmpty,
  mode: z.enum(['captioned', 'narrated']),
  targetUrl: z.string().url().max(4_096),
  viewport: z.object({
    width: z.number().int().positive().max(10_000),
    height: z.number().int().positive().max(10_000),
  }).strict(),
  fps: z.literal(30).default(30),
  duration: z.object({
    targetSeconds: z.number().finite().positive().max(3_600).optional(),
    hardLimit: z.boolean().default(false),
  }).strict().default({}),
  presentation: presentationSchema,
  narrator: narratorSchema.optional(),
  wordingApproval: z.object({ sha256: sha256Schema }).strict(),
  scenes: z.array(sceneSchema).min(1).max(200),
}).strict().superRefine((plan, ctx) => {
  let target: URL;
  try {
    target = new URL(plan.targetUrl);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targetUrl'], message: 'targetUrl must be an absolute HTTP or HTTPS URL' });
    return;
  }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targetUrl'], message: 'targetUrl must be an HTTP or HTTPS URL without credentials' });
  }

  const sceneIds = new Set<string>();
  const actionIds = new Set<string>();
  plan.scenes.forEach((scene, sceneIndex) => {
    if (sceneIds.has(scene.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scenes', sceneIndex, 'id'], message: 'scene IDs must be unique' });
    }
    sceneIds.add(scene.id);
    scene.actions.forEach((action, actionIndex) => {
      if (actionIds.has(action.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scenes', sceneIndex, 'actions', actionIndex, 'id'], message: 'action IDs must be unique across the plan' });
      }
      actionIds.add(action.id);
      if (action.type === 'navigate' && action.url) {
        try {
          if (new URL(action.url, plan.targetUrl).origin !== target.origin) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scenes', sceneIndex, 'actions', actionIndex, 'url'], message: 'navigate actions must stay on the configured origin' });
          }
        } catch {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scenes', sceneIndex, 'actions', actionIndex, 'url'], message: 'navigate action URL is invalid' });
        }
      }
      const active = ['click', 'type', 'drag'].includes(action.type);
      if (plan.mode === 'narrated' && active) {
        if (!action.spokenAnchor) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scenes', sceneIndex, 'actions', actionIndex, 'spokenAnchor'], message: 'narrated click, type, and drag actions require a spokenAnchor' });
        } else if (!containsSpokenAnchor(scene.say, action.spokenAnchor)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scenes', sceneIndex, 'actions', actionIndex, 'spokenAnchor'], message: 'spokenAnchor must occur in scene.say' });
        }
        if (action.atMs === undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scenes', sceneIndex, 'actions', actionIndex, 'atMs'], message: 'narrated click, type, and drag actions require authored atMs timing' });
        }
      }
    });
    if (plan.mode === 'narrated' && !scene.say.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scenes', sceneIndex, 'say'], message: 'narrated scenes require spoken wording' });
    }
  });

  if (plan.mode === 'narrated' && !plan.narrator) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['narrator'], message: 'narrated plans require a narrator or supplied audio configuration' });
  }
  if (plan.narrator?.provider === 'supplied') {
    const files = plan.narrator.audioFiles ?? {};
    for (const scene of plan.scenes.filter((candidate) => candidate.say.trim())) {
      if (!files[scene.id]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['narrator', 'audioFiles', scene.id], message: 'supplied narrated scenes require a local audio file' });
      }
    }
    for (const sceneId of Object.keys(files)) {
      if (!sceneIds.has(sceneId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['narrator', 'audioFiles', sceneId], message: 'audioFiles keys must reference a plan scene' });
      }
    }
  }

  const expectedWordingHash = computeWordingApprovalHash(plan);
  if (plan.wordingApproval.sha256 !== expectedWordingHash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['wordingApproval', 'sha256'], message: 'wordingApproval hash does not match the complete scene wording' });
  }
});

export type DemoPlan = z.infer<typeof planSchema>;
export type DemoScene = DemoPlan['scenes'][number];
export type DemoAction = DemoScene['actions'][number];
export type NarratorConfig = NonNullable<DemoPlan['narrator']>;

export function computeWordingApprovalHash(plan: Pick<DemoPlan, 'scenes'> | { scenes: Array<Pick<DemoScene, 'id' | 'before' | 'during' | 'after' | 'say' | 'learn' | 'next'>> }): string {
  const wording = plan.scenes.map(({ id, before, during, after, say, learn, next }) => ({
    id, before: before ?? '', during: during ?? '', after: after ?? '', say: say ?? '', learn: learn ?? '', next: next ?? '',
  }));
  return `sha256:${createHash('sha256').update(JSON.stringify(wording)).digest('hex')}`;
}

function containsSpokenAnchor(speech: string, anchor: string): boolean {
  const normalize = (value: string) => value.toLocaleLowerCase('en-US').match(/[a-z0-9]+/g) ?? [];
  const sentence = normalize(speech);
  const needle = normalize(anchor);
  if (needle.length === 0 || needle.length > sentence.length) return false;
  return sentence.some((_, index) => needle.every((token, offset) => sentence[index + offset] === token));
}

export const narrationTrackSchema = z.object({
  sceneId: z.string().min(1),
  path: z.string().min(1),
  durationMs: z.number().finite().positive(),
  sha256: sha256Schema,
  textSha256: sha256Schema,
  alignment: z.unknown().optional(),
}).strict();

export const narrationResultSchema = z.object({
  provider: z.enum(['supplied', 'voicebox', 'elevenlabs']),
  tracks: z.array(narrationTrackSchema),
}).strict();

export const captureSceneSchema = z.object({
  id: z.string().min(1),
  startMs: z.number().finite().nonnegative(),
  endMs: z.number().finite().positive(),
  beforeFrame: z.string().min(1),
  afterFrame: z.string().min(1),
  cursorStart: pointSchema.nullable(),
  cursorEnd: pointSchema.nullable(),
  audio: z.object({
    startMs: z.number().finite().nonnegative(),
    endMs: z.number().finite().positive(),
    sourceDurationMs: z.number().finite().positive(),
    sha256: sha256Schema,
    playbackRate: z.number().finite().positive(),
  }).strict().optional(),
}).strict();

export const captureEventSchema = z.object({
  id: z.string().min(1),
  sceneId: z.string().min(1),
  type: z.enum(['navigate', 'click', 'type', 'drag', 'wait', 'press']),
  atMs: z.number().finite().nonnegative(),
  endMs: z.number().finite().nonnegative().optional(),
  cursor: pointSchema.nullable(),
  spokenAnchor: z.string().trim().min(1).optional(),
}).strict();

export const captureAssertionSchema = z.object({
  sceneId: z.string().min(1),
  selector: z.string().min(1),
  kind: z.enum(['visible', 'text']),
  passed: z.boolean(),
  /** Hash only; raw observed page text is never written to receipts. */
  observedValueSha256: sha256Schema.optional(),
}).strict();

export const captureResultSchema = z.object({
  recordings: z.array(z.string().min(1)).min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.literal(30),
  durationMs: z.number().finite().positive(),
  clock: z.object({
    originMs: z.number().finite(),
    verified: z.boolean(),
    uncertaintyMs: z.number().finite().nonnegative().max(100).optional(),
    recordingSha256: sha256Schema,
  }).strict(),
  scenes: z.array(captureSceneSchema),
  events: z.array(captureEventSchema),
  assertions: z.array(captureAssertionSchema).default([]),
}).strict();

export const renderResultSchema = z.object({
  videoPath: z.string().min(1),
  posterPath: z.string().min(1),
  durationMs: z.number().finite().positive(),
  sampledFrames: z.array(z.string().min(1)).min(1),
  timelinePath: z.string().min(1),
  sha256: sha256Schema,
  playbackRate: z.number().finite().positive(),
  hasAudio: z.boolean(),
}).strict();

const stageReceiptSchema = z.object({
  status: z.enum(['pending', 'running', 'complete', 'failed', 'unknown-after-timeout', 'skipped']),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  completedAt: z.string().datetime({ offset: true }).nullable(),
  evidenceHash: sha256Schema.nullable(),
  errorCode: z.string().max(128).nullable(),
}).strict();

const relativeArtifactPathSchema = z.string().trim().min(1).max(4_096).refine((value) =>
  !value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value) && !value.includes('\0')
    && !value.split(/[\\/]/).includes('..'),
'artifact paths must stay relative to the mission directory');

export const missionReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  missionId: z.string().regex(/^demo-[a-f0-9]{24}$/),
  status: z.enum(['preparing', 'prepared', 'running', 'awaiting-review', 'awaiting-operator-review', 'approved', 'revise', 'failed', 'unknown-after-timeout', 'cleaned']),
  currentStage: z.enum(['target-check', 'narration', 'capture', 'render', 'audit', 'review', 'cleanup']).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  artifactRetentionUntil: z.string().datetime({ offset: true }),
  planHash: sha256Schema,
  wordingApprovalHash: sha256Schema,
  runtimeProfileHash: sha256Schema,
  producerFingerprint: sha256Schema,
  heartbeatAt: z.string().datetime({ offset: true }),
  stages: z.object({
    'target-check': stageReceiptSchema,
    narration: stageReceiptSchema,
    capture: stageReceiptSchema,
    render: stageReceiptSchema,
    audit: stageReceiptSchema,
    review: stageReceiptSchema,
    cleanup: stageReceiptSchema,
  }).strict(),
  artifacts: z.object({
    planFile: z.literal('plan.json'),
    narrationFile: z.literal('narration.json').optional(),
    captureFile: z.literal('capture.json').optional(),
    renderFile: z.literal('render.json').optional(),
    auditFile: z.literal('audit.json').optional(),
    reviewPacketFile: z.literal('review-packet.json').optional(),
    reviewHistoryFile: z.literal('review-history.json').optional(),
    videoPath: relativeArtifactPathSchema.optional(),
    posterPath: relativeArtifactPathSchema.optional(),
    timelinePath: relativeArtifactPathSchema.optional(),
    sampledFrames: z.array(relativeArtifactPathSchema).optional(),
  }).strict(),
  reviewRound: z.number().int().min(0).max(6),
  maxReviewRounds: z.literal(6),
  failureCode: z.string().max(128).nullable(),
}).strict();

export const reviewSubmissionSchema = z.object({
  missionId: z.string().regex(/^demo-[a-f0-9]{24}$/),
  packetHash: sha256Schema,
  planHash: sha256Schema,
  videoHash: sha256Schema,
  reviewerId: z.string().trim().min(1).max(256),
  reviewerType: z.enum(['independent', 'operator']),
  verdict: z.enum(['approved', 'revise']),
  checks: z.object({
    contentTruth: z.enum(['pass', 'fail', 'inconclusive']),
    uxQuality: z.enum(['pass', 'fail', 'inconclusive']),
  }).strict(),
  findings: z.array(z.object({
    id: z.string().trim().min(1).max(128),
    severity: z.enum(['P0', 'P1', 'P2', 'P3']),
    sceneId: z.string().trim().min(1).max(64).optional(),
    summary: z.string().trim().min(1).max(1_000),
    disposition: z.enum(['fixed', 'accepted', 'rejected']).optional(),
  }).strict()).max(500),
}).strict();

export const reviewReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  missionId: z.string().regex(/^demo-[a-f0-9]{24}$/),
  packetHash: sha256Schema,
  planHash: sha256Schema,
  videoHash: sha256Schema,
  reviewerFingerprint: sha256Schema,
  identityAssurance: z.literal('caller-attested'),
  reviewerType: z.enum(['independent', 'operator']),
  verdict: z.enum(['approved', 'revise']),
  checks: z.object({
    contentTruth: z.enum(['pass', 'fail', 'inconclusive']),
    uxQuality: z.enum(['pass', 'fail', 'inconclusive']),
  }).strict(),
  findings: z.array(z.object({
    id: z.string().trim().min(1).max(128),
    severity: z.enum(['P0', 'P1', 'P2', 'P3']),
    sceneId: z.string().trim().min(1).max(64).optional(),
    summary: z.string().trim().min(1).max(1_000),
    disposition: z.enum(['fixed', 'accepted', 'rejected']).optional(),
  }).strict()).max(500),
  round: z.number().int().min(1).max(6),
  createdAt: z.string().datetime({ offset: true }),
  status: z.enum(['awaiting-operator-review', 'approved', 'revise']),
}).strict();

export const reviewHistorySchema = z.object({
  schemaVersion: z.literal(1),
  missionId: z.string().regex(/^demo-[a-f0-9]{24}$/),
  packetHash: sha256Schema,
  rounds: z.array(reviewReceiptSchema).max(6),
}).strict();

export type NarrationTrack = z.infer<typeof narrationTrackSchema>;
export type NarrationResult = z.infer<typeof narrationResultSchema>;
export type CaptureResult = z.infer<typeof captureResultSchema>;
export type RenderResult = z.infer<typeof renderResultSchema>;
export type MissionReceiptData = z.infer<typeof missionReceiptSchema>;
export type ReviewSubmissionData = z.infer<typeof reviewSubmissionSchema>;
export type ReviewReceiptData = z.infer<typeof reviewReceiptSchema>;
export type ReviewHistoryData = z.infer<typeof reviewHistorySchema>;
