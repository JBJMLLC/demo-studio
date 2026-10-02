#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { doctor } from './doctor.js';
import { prepareDemo, generateDemo, getStatus, cleanup, submitReview, reconcile } from './runtime.js';
import { missionDirectory, missionPath, readJson } from './store.js';
import { planSchema } from './schemas.js';
import type { ReviewSubmission } from './contracts.js';

const help = `demo-studio v0.1.0
  doctor [--narration supplied|voicebox|elevenlabs] [--skills-only]
  validate --plan examples/quickstart/plan.json
  prepare --plan PLAN [--work-dir .demo-studio] [--actor PRODUCER]
  generate --mission ID [--work-dir .demo-studio] [--actor PRODUCER]
  status --mission ID [--work-dir .demo-studio]
  preview --mission ID [--work-dir .demo-studio]
  review --file REVIEW_JSON [--work-dir .demo-studio]
  cleanup --mission ID [--work-dir .demo-studio] [--actor PRODUCER]
  reconcile --mission ID --action retry-uncertain-stage|accept-captured-artifacts [--work-dir .demo-studio]
  mcp

Preparation never provisions infrastructure. Generation produces a review candidate,
not automatic publication. Cleanup preserves all media and receipts.
`;

export async function main(args = process.argv.slice(2)) {
  const command = args[0];
  if (!command || ['help', '--help', '-h'].includes(command)) { process.stdout.write(help); return; }
  if (command === 'mcp') { const { startMcp } = await import('./mcp.js'); await startMcp(); return; }
  const parsed = parseArgs({ args: args.slice(1), options: { plan: { type: 'string' }, mission: { type: 'string' }, 'work-dir': { type: 'string' }, actor: { type: 'string' }, action: { type: 'string' }, file: { type: 'string' }, narration: { type: 'string' }, 'skills-only': { type: 'boolean' } } });
  const values = parsed.values;
  const workDir = resolve(values['work-dir'] || '.demo-studio');
  const actorId = values.actor || 'demo-studio-producer';
  const required = (name: 'mission' | 'plan' | 'file') => { const value = values[name]; if (!value) throw new Error(`Missing --${name}`); return value; };
  let result: unknown;
  switch (command) {
    case 'doctor': {
      const provider = values.narration;
      if (provider && !['supplied', 'voicebox', 'elevenlabs'].includes(provider)) throw new Error('Unsupported narration provider');
      result = await doctor({ browser: !values['skills-only'], renderer: !values['skills-only'], narration: provider as 'supplied' | 'voicebox' | 'elevenlabs' | undefined });
      if (!(result as { ready: boolean }).ready) process.exitCode = 1;
      break;
    }
    case 'validate': result = { valid: true, scenes: planSchema.parse(JSON.parse(await readFile(resolve(required('plan')), 'utf8'))).scenes.length }; break;
    case 'prepare': result = await prepareDemo(resolve(required('plan')), workDir, actorId); break;
    case 'generate': result = await generateDemo(required('mission'), workDir, actorId); break;
    case 'status': result = await getStatus(required('mission'), workDir); break;
    case 'preview': {
      const id = required('mission'); const directory = missionDirectory(workDir, id);
      result = { mission: await getStatus(id, workDir), plan: readJson(missionPath(directory, 'plan.json', true)), reviewPacket: readJson(missionPath(directory, 'review-packet.json', true)) };
      break;
    }
    case 'review': result = await submitReview(JSON.parse(await readFile(resolve(required('file')), 'utf8')) as ReviewSubmission, workDir); break;
    case 'cleanup': result = await cleanup(required('mission'), workDir, { actorId }); break;
    case 'reconcile': {
      if (!['retry-uncertain-stage', 'accept-captured-artifacts'].includes(values.action || '')) throw new Error('Choose an explicit reconciliation action');
      result = await reconcile(required('mission'), workDir, { actorId, action: values.action as 'retry-uncertain-stage' | 'accept-captured-artifacts' }); break;
    }
    default: throw new Error('Unknown command. Run demo-studio help.');
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result && typeof result === 'object' && 'status' in result && ['failed', 'unknown-after-timeout'].includes(String(result.status))) process.exitCode = 1;
}

if (process.argv[1] && /(?:^|[/\\])cli\.(?:ts|js)$/.test(process.argv[1])) main().catch((error: unknown) => {
  // Detailed provider output, URLs, and local file paths are deliberately not echoed.
  process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.name : 'Error', message: 'Operation failed. Inspect the durable status receipt and troubleshooting guide.' })}\n`);
  process.exitCode = 1;
});
