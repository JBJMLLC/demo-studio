import { dirname } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { prepare, generate, getStatus, cleanup, submitReview, reconcile } from './mission.js';
import { prepareNarration } from './narration.js';
import { checkTargetReady, capture } from './browser.js';
import { render } from './render.js';

export { getStatus, cleanup, submitReview, reconcile };
export function prepareDemo(planPath: string, workDir: string, actorId: string) {
  const hash = createHash('sha256');
  for (const name of ['browser', 'render', 'media-clock', 'narration', 'schemas']) {
    const compiled = new URL(`./${name}.js`, import.meta.url);
    hash.update(readFileSync(existsSync(compiled) ? compiled : new URL(`./${name}.ts`, import.meta.url)));
  }
  return prepare(planPath, workDir, { actorId, runtimeProfile: `playwright-remotion-native-v1:${hash.digest('hex')}`, checkTargetReady, prepareNarration: (plan, directory) => prepareNarration(plan, directory, { sourceDirectory: dirname(planPath) }) });
}
export function generateDemo(missionId: string, workDir: string, actorId: string) {
  return generate(missionId, workDir, { actorId, capture, render });
}
