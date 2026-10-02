import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mediaInfo } from '../src/media.js';

const directory = await mkdtemp(resolve(tmpdir(), 'demo-studio-smoke-'));
const probe = createServer();
await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
const address = probe.address();
if (!address || typeof address === 'string') throw new Error('No fixture port is available');
const port = address.port;
await new Promise<void>((done) => probe.close(() => done()));
const plan = JSON.parse(await readFile('examples/quickstart/plan.json', 'utf8'));
plan.targetUrl = `http://127.0.0.1:${port}`;
const planPath = resolve(directory, 'fixture-plan.json');
await writeFile(planPath, JSON.stringify(plan, null, 2), { mode: 0o600 });
const fixture = spawn(process.execPath, ['examples/quickstart/server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
process.stdout.write(`Artifact directory: ${directory}\n`);
let fixtureReady = false;
fixture.stdout.on('data', () => { fixtureReady = true; });
fixture.stderr.on('data', () => undefined);
const connect = async () => {
  const client = new Client({ name: 'standalone-smoke', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('dist/mcp.js')], stderr: 'pipe' }));
  return client;
};
const readResult = (value: unknown) => {
  const result = value as { isError?: boolean; content: Array<{ type: string; text?: string }> };
  if (result.isError) throw new Error('MCP tool failed; inspect its durable receipt.');
  return JSON.parse(result.content.find((entry) => entry.type === 'text')!.text!);
};
let client: Client | undefined;
try {
  for (let attempt = 0; attempt < 100 && !fixtureReady; attempt++) await new Promise((done) => setTimeout(done, 100));
  assert(fixtureReady, 'Bundled fixture did not start');
  client = await connect();
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  for (const name of ['demo_doctor', 'demo_prepare', 'demo_generate', 'demo_status', 'demo_cleanup', 'demo_preview', 'demo_review', 'demo_reconcile']) assert(names.includes(name), `Missing discovered tool: ${name}`);
  const call = (name: string, args: Record<string, unknown>) => client!.callTool({ name, arguments: args }, undefined, { timeout: 600_000 }).then(readResult);
  const ready = await call('demo_doctor', {});
  assert(ready.ready, 'Doctor failed');
  process.stdout.write('Doctor and dynamic discovery passed.\n');
  const prepared = await call('demo_prepare', { planPath, workDir: directory });
  assert.equal(prepared.status, 'prepared');
  const result = await call('demo_generate', { missionId: prepared.missionId, workDir: directory, wait: true });
  if (result.mission.status !== 'awaiting-review') process.stdout.write(`${JSON.stringify({ status: result.mission.status, failureStage: result.mission.currentStage, failureCode: result.mission.failureCode, findings: result.audit?.findings, timing: result.capture?.events.map((event: { id: string; sceneId: string; atMs: number }) => { const scene = result.capture.scenes.find((entry: { id: string }) => entry.id === event.sceneId); const action = plan.scenes.find((entry: { id: string }) => entry.id === event.sceneId).actions.find((entry: { id: string }) => entry.id === event.id); return { id: event.id, plannedMs: action.atMs, observedMs: event.atMs - scene.startMs }; }) })}\n`);
  assert.equal(result.mission.status, 'awaiting-review');
  assert.notEqual(result.audit.status, 'fail');
  const missionDir = resolve(directory, 'missions', prepared.missionId);
  const video = resolve(missionDir, result.render.videoPath);
  const info = await mediaInfo(video);
  assert.equal(info.width, 1440); assert.equal(info.height, 900);
  assert.equal(info.hasAudio, false, 'Captioned fixture should not fabricate narration');
  assert(result.render.sampledFrames.length > 10, 'Final-video samples are missing');
  const originalMtime = (await stat(video)).mtimeMs;
  const preview = await call('demo_preview', { missionId: prepared.missionId, workDir: directory });
  assert.equal(preview.reviewPacket.packetHash, result.reviewPacket.packetHash);
  await client.close();
  client = await connect();
  const resumed = await call('demo_prepare', { planPath, workDir: directory });
  assert.equal(resumed.missionId, prepared.missionId);
  await call('demo_generate', { missionId: prepared.missionId, workDir: directory, wait: true });
  assert.equal((await stat(video)).mtimeMs, originalMtime, 'Restart duplicated generation');
  const stale = await client.callTool({ name: 'demo_review', arguments: { workDir: directory, submission: { missionId: prepared.missionId, packetHash: `sha256:${'0'.repeat(64)}`, planHash: result.mission.planHash, videoHash: result.render.sha256, reviewerId: 'smoke-independent', reviewerType: 'independent', verdict: 'approved', checks: { contentTruth: 'pass', uxQuality: 'pass' }, findings: [] } } });
  assert(stale.isError, 'Stale review was accepted');
  if (process.env.DEMO_STUDIO_SMOKE_KEEP_REVIEW !== '1') {
    const cleaned = await call('demo_cleanup', { missionId: prepared.missionId, workDir: directory });
    assert.equal(cleaned.status, 'cleaned');
    assert.equal((await stat(video)).mtimeMs, originalMtime, 'Cleanup deleted or changed retained media');
  }
  JSON.parse(await readFile(resolve(missionDir, 'render/timeline.json'), 'utf8'));
  process.stdout.write(`Capture, render, sampled review and restart reuse passed. ${process.env.DEMO_STUDIO_SMOKE_KEEP_REVIEW === '1' ? 'Mission retained for independent review.' : 'Non-destructive cleanup passed.'}\nArtifact directory: ${directory}\n`);
} finally { if (client) await client.close(); fixture.kill('SIGTERM'); }
