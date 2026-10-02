import type { DemoPlan, CaptureResult, NarrationResult, RenderResult } from './schemas.js';
import type { MissionPrepareDependencies, MissionGenerateDependencies, TargetReadyEvidence, MissionReceipt } from './contracts.js';

/** Integrations are explicit consumers of these boundaries, not built-in infrastructure. */
export interface EnvironmentAdapter {
  checkTargetReady(plan: DemoPlan): Promise<TargetReadyEvidence>;
  closeOwnedSession?(missionId: string): Promise<void>;
}
export interface BrowserAdapter {
  capture(plan: DemoPlan, missionDirectory: string, narration: NarrationResult): Promise<CaptureResult>;
}
export interface NarrationAdapter {
  prepare(plan: DemoPlan, missionDirectory: string): Promise<NarrationResult>;
}
export interface RendererAdapter {
  render(plan: DemoPlan, capture: CaptureResult, narration: NarrationResult, missionDirectory: string): Promise<RenderResult>;
}
/** Publisher credentials and routing remain in the caller, never in the demo plan. */
export interface PublisherAdapter {
  publish(input: { mission: MissionReceipt; render: RenderResult; idempotencyKey: string }): Promise<{ receiptHash: string; artifactUrl: string }>;
}

export function adapterDependencies(actorId: string, adapters: { environment: EnvironmentAdapter; browser: BrowserAdapter; narration: NarrationAdapter; renderer: RendererAdapter }): { prepare: MissionPrepareDependencies; generate: MissionGenerateDependencies } {
  return {
    prepare: { actorId, checkTargetReady: (plan) => adapters.environment.checkTargetReady(plan), prepareNarration: (plan, directory) => adapters.narration.prepare(plan, directory) },
    generate: { actorId, capture: (plan, directory, narration) => adapters.browser.capture(plan, directory, narration), render: (plan, capture, narration, directory) => adapters.renderer.render(plan, capture, narration, directory) },
  };
}
