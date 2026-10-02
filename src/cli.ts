#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  descriptorForLocalArchive,
  getRuntimeCapsuleDescriptor,
  getRuntimeCapsuleStatus,
  installRuntimeCapsule,
  launchRuntimeCli,
  launchRuntimeMcp,
  reconcileRuntimeCapsule,
} from './capsule.js';
import { planSchema } from './schemas.js';
import { readFile } from 'node:fs/promises';
import { packageVersion } from './version.js';

const help = `demo-studio v${packageVersion}
  doctor [--narration supplied|voicebox|elevenlabs] [--skills-only]
  validate --plan examples/quickstart/plan.json
  prepare --plan PLAN [--work-dir .demo-studio] [--actor PRODUCER]
  generate --mission ID [--work-dir .demo-studio] [--actor PRODUCER]
  status --mission ID [--work-dir .demo-studio]
  preview --mission ID [--work-dir .demo-studio]
  review --file REVIEW_JSON [--work-dir .demo-studio]
  cleanup --mission ID [--work-dir .demo-studio] [--actor PRODUCER]
  reconcile --mission ID --action retry-uncertain-stage|accept-captured-artifacts [--work-dir .demo-studio]
  capsule status
  capsule install [--archive ABSOLUTE_PATH --version VERSION --sha256 sha256:HEX]
  capsule reconcile --action retry-failed-stage|retry-uncertain-stage
  mcp

The toolkit's schemas and media-clock helpers are PnP-safe. Browser capture,
Remotion rendering and MCP operations run in the checksum-pinned runtime capsule.
Source clones and ordinary npm installs may use the bundled local runtime directly.
Preparation never provisions infrastructure; generation is a review candidate,
not publication. Cleanup preserves media and receipts.
`;

function isPnP(): boolean { return typeof Reflect.get(process.versions, 'pnp') === 'string'; }
function options(args: string[]) {
  return parseArgs({
    args,
    options: {
      plan: { type: 'string' }, mission: { type: 'string' }, 'work-dir': { type: 'string' }, actor: { type: 'string' },
      action: { type: 'string' }, file: { type: 'string' }, narration: { type: 'string' }, 'skills-only': { type: 'boolean' },
      archive: { type: 'string' }, version: { type: 'string' }, sha256: { type: 'string' },
    },
  }).values;
}
function required(values: Record<string, string | boolean | undefined>, key: string): string {
  const value = values[key];
  if (typeof value !== 'string' || !value) throw new Error(`Missing --${key}`);
  return value;
}
function print(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
async function childExit(args: string[]): Promise<void> {
  const child = args[0] === 'mcp' ? await launchRuntimeMcp() : await launchRuntimeCli(args);
  await new Promise<void>((resolveExit, reject) => {
    child.once('error', () => reject(new Error('Pinned runtime child could not start.')));
    child.once('exit', (code, signal) => {
      if (signal) process.exitCode = 1;
      else process.exitCode = code ?? 1;
      resolveExit();
    });
  });
}

async function pnpDoctor(args: string[]): Promise<void> {
  const values = options(args.slice(1));
  const provider = values.narration;
  if (provider && !['supplied', 'voicebox', 'elevenlabs'].includes(String(provider))) throw new Error('Unsupported narration provider.');
  if (values['skills-only']) {
    const { doctor } = await import('./doctor.js');
    const result = await doctor({ browser: false, renderer: false, narration: provider as 'supplied' | 'voicebox' | 'elevenlabs' | undefined });
    print(result);
    if (!result.ready) process.exitCode = 1;
    return;
  }
  const capsule = await getRuntimeCapsuleStatus();
  if (capsule.status !== 'ready') {
    print({ schemaVersion: 1, ready: false, checks: [{ requirement: 'runtime-capsule', status: 'fail' }], runtimeCapsule: capsule });
    process.exitCode = 1;
    return;
  }
  const child = await launchRuntimeCli(args, { stdio: ['ignore', 'pipe', 'ignore'] });
  const chunks: Buffer[] = [];
  let length = 0;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 120_000);
  child.stdout?.on('data', (chunk: Buffer) => {
    length += chunk.length;
    if (length > 64 * 1024) { child.kill('SIGTERM'); return; }
    chunks.push(Buffer.from(chunk));
  });
  const code = await new Promise<number>((done, reject) => {
    child.once('error', () => reject(new Error('The pinned runtime doctor could not start.')));
    child.once('exit', (exitCode) => done(exitCode ?? 1));
  }).finally(() => clearTimeout(timer));
  if (timedOut || length > 64 * 1024) throw new Error('The pinned runtime doctor did not complete within its output/time bound.');
  let result: { schemaVersion?: number; ready?: boolean; checks?: unknown[] };
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof result; }
  catch { throw new Error('The pinned runtime doctor returned an invalid report.'); }
  const checks = [...(result.checks ?? []), { requirement: 'runtime-capsule', status: 'pass' }];
  print({ ...result, checks, ready: result.ready === true && code === 0, runtimeCapsule: capsule });
  if (result.ready !== true || code !== 0) process.exitCode = 1;
}

async function pnpMain(args: string[]): Promise<void> {
  const command = args[0];
  if (!command || ['help', '--help', '-h'].includes(command)) { process.stdout.write(help); return; }
  if (command === 'validate') {
    const values = options(args.slice(1));
    const plan = planSchema.parse(JSON.parse(await readFile(resolve(required(values, 'plan')), 'utf8')));
    print({ valid: true, scenes: plan.scenes.length });
    return;
  }
  if (command === 'capsule') {
    const subcommand = args[1];
    const values = options(args.slice(2));
    if (subcommand === 'status') {
      const status = await getRuntimeCapsuleStatus();
      print(status);
      if (['failed', 'unknown-after-timeout', 'invalid'].includes(status.status)) process.exitCode = 1;
      return;
    }
    if (subcommand === 'install') {
      let descriptor = getRuntimeCapsuleDescriptor();
      if (values.archive !== undefined || values.version !== undefined || values.sha256 !== undefined) {
        const archive = required(values, 'archive');
        const version = required(values, 'version');
        const sha256 = required(values, 'sha256');
        if (!isAbsolute(archive) || version !== descriptor.version) throw new Error('--archive must be an absolute path with the embedded runtime version.');
        descriptor = descriptorForLocalArchive(descriptor, resolve(archive), sha256);
      }
      const status = await installRuntimeCapsule({ descriptor });
      print(status);
      if (status.status !== 'ready') process.exitCode = 1;
      return;
    }
    if (subcommand === 'reconcile') {
      const action = required(values, 'action');
      if (!['retry-failed-stage', 'retry-uncertain-stage'].includes(action)) throw new Error('Choose an explicit supported capsule retry action.');
      const status = await reconcileRuntimeCapsule({ action: action as 'retry-failed-stage' | 'retry-uncertain-stage' });
      print(status);
      if (status.status !== 'ready') process.exitCode = 1;
      return;
    }
    throw new Error('Unknown capsule command. Run demo-studio help.');
  }
  if (command === 'doctor') {
    await pnpDoctor(args);
    return;
  }
  if (command === 'mcp' || ['prepare', 'generate', 'status', 'preview', 'review', 'cleanup', 'reconcile'].includes(command)) {
    await childExit(args);
    return;
  }
  throw new Error('Unknown command. Run demo-studio help.');
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args[0] === 'capsule') return pnpMain(args);
  if (isPnP()) return pnpMain(args);
  // In source clones and conventional node_modules installs, use the bundled runtime.
  const runtime = await import('./runtime-cli.js');
  await runtime.main(args);
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    const message = error instanceof Error && ['RuntimeCapsuleError', 'Error'].includes(error.name) ? error.message : 'Operation failed. Inspect the durable status receipt and troubleshooting guide.';
    process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.name : 'Error', message })}\n`);
    process.exitCode = 1;
  });
}
