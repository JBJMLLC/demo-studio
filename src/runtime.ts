import { dirname } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { prepare, generate, getStatus, cleanup, submitReview, reconcile } from './mission.js';
import { prepareNarration } from './narration.js';
import { checkTargetReady, capture } from './browser.js';
import { render } from './render.js';

export { getStatus, cleanup, submitReview, reconcile };
export function runtimeFingerprint() {
  const hash = createHash('sha256');
  for (const name of ['browser', 'render', 'composition', 'media-clock', 'media', 'narration', 'schemas', 'mission', 'audit', 'store']) {
    const compiled = new URL(`./${name}.js`, import.meta.url);
    hash.update(readFileSync(existsSync(compiled) ? compiled : new URL(`./${name}.${name === 'composition' ? 'tsx' : 'ts'}`, import.meta.url)));
  }
  hash.update(readFileSync(new URL('../package.json', import.meta.url)));
  return `playwright-remotion-native-v1:${hash.digest('hex')}`;
}
export function prepareDemo(planPath: string, workDir: string, actorId: string) {
  return prepare(planPath, workDir, { actorId, runtimeProfile: runtimeFingerprint(), checkTargetReady, prepareNarration: (plan, directory) => prepareNarration(plan, directory, { sourceDirectory: dirname(planPath) }) });
}
export async function generateDemo(missionId: string, workDir: string, actorId: string) {
  const receipt = await getStatus(missionId, workDir);
  if (receipt.runtimeProfile !== runtimeFingerprint()) throw new Error('Runtime changed after preparation; prepare again before generation');
  return generate(missionId, workDir, { actorId, capture, render });
}
