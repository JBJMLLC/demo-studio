import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getRuntimeCapsuleDescriptor,
  getRuntimeCapsuleStatus,
  isolatedRuntimeEnvironment,
  launchRuntimeMcp,
} from '@jbjmllc/demo-studio/capsule';
import { connectRuntimeMcp } from './yarn-pnp-stdio.mjs';

const packageName = '@jbjmllc/demo-studio';
const requiredTools = [
  'demo_cleanup',
  'demo_doctor',
  'demo_generate',
  'demo_prepare',
  'demo_preview',
  'demo_reconcile',
  'demo_review',
  'demo_status',
].sort();
const phase = process.argv[2];
const expectedDescriptor = JSON.parse(await readFile(process.env.DEMO_STUDIO_EXPECTED_DESCRIPTOR_PATH, 'utf8'));
const descriptor = getRuntimeCapsuleDescriptor();
assert.deepEqual(descriptor, expectedDescriptor, 'The PnP-safe public API must read the descriptor from the actual installed archive.');
assert.equal(descriptor.version, expectedDescriptor.version);
const entryUrl = import.meta.resolve(packageName);
const packageEntry = fileURLToPath(entryUrl);
const pnp = createRequire(import.meta.url)('pnpapi');
assert.equal(typeof process.versions.pnp, 'string', 'The consumer must actually run under Yarn Plug\'n\'Play.');
const projectManifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'));
assert.deepEqual(Object.keys(projectManifest.dependencies).sort(), [packageName], 'The consumer manifest must declare only the installed toolkit.');
const topLevel = pnp.getPackageInformation(pnp.topLevel);
assert(topLevel, 'Yarn PnP must expose the consumer locator.');
const topLevelDependencies = [...topLevel.packageDependencies.keys()].filter((name) => name !== projectManifest.name).sort();
assert.deepEqual(topLevelDependencies, [packageName], 'The PnP project locator must expose exactly one non-self dependency.');
const locator = pnp.findPackageLocator(packageEntry);
assert(locator, 'Yarn PnP must resolve the package entry to an installed package locator.');
assert.equal(locator.name, packageName);
assert.equal(locator.reference, topLevel.packageDependencies.get(packageName), 'The imported package locator must be the consumer\'s exact declared dependency.');
const packageInfo = pnp.getPackageInformation(locator);
assert(packageInfo?.packageLocation && packageEntry.startsWith(packageInfo.packageLocation), 'The imported entry must belong to the exact resolved package locator.');

let undeclaredSdkError;
try { await import('@modelcontextprotocol/sdk/client/index.js'); }
catch (error) { undeclaredSdkError = error; }
assert(undeclaredSdkError, 'The consumer must not gain direct SDK access through toolkit transitive dependencies.');
assert.match(String(undeclaredSdkError.message), /@modelcontextprotocol\/sdk/i);

const originalNodeOptions = process.env.NODE_OPTIONS;
const isolatedEnvironment = isolatedRuntimeEnvironment(process.env);
assert.notEqual(isolatedEnvironment, process.env);
for (const key of Object.keys(process.env)) {
  if (key !== 'NODE_OPTIONS') assert.equal(isolatedEnvironment[key], process.env[key], `Runtime isolation must preserve ${key}.`);
}
assert.match(isolatedEnvironment.NODE_OPTIONS ?? '', /--trace-warnings/, 'Runtime isolation must retain unrelated Node options.');
assert.doesNotMatch(isolatedEnvironment.NODE_OPTIONS ?? '', /\.pnp\.(?:cjs|loader\.mjs)/i, 'Runtime isolation must remove Yarn PnP preload hooks from the owned child.');
assert.equal(process.env.NODE_OPTIONS, originalNodeOptions, 'Runtime isolation must not mutate the PnP parent environment.');

const invalidVersion = { ...descriptor, version: 'not-a-version' };
await assert.rejects(
  getRuntimeCapsuleStatus({ descriptor: invalidVersion }),
  (error) => error?.name === 'RuntimeCapsuleError',
  'The public capsule API must reject a malformed artifact version.',
);

const status = await getRuntimeCapsuleStatus();
if (phase === '--preflight') {
  assert.equal(status.status, 'missing', 'Public API status before explicit install must remain missing.');
  process.stdout.write('PnP package graph, locator, descriptor, version rejection, and pre-install status passed.\n');
  process.exit(0);
}
assert.equal(phase, '--workflow', 'Choose the preflight or installed workflow phase.');
assert.equal(status.status, 'ready', 'Only the explicit CLI install may make the runtime ready.');
assert.equal(status.descriptor.sha256, descriptor.sha256);
assert.deepEqual(status.descriptor.files, descriptor.files);
assert(status.runtimeEntry, 'Ready capsule status must expose the installed runtime entry.');
assert.equal(await realpath(status.runtimeEntry), status.runtimeEntry, 'The runtime entry must be canonical.');
assert.equal(pnp.findPackageLocator(status.runtimeEntry), null, 'The separate runtime install must stay outside the Yarn dependency graph.');

const planPath = resolve(process.env.DEMO_STUDIO_PLAN_PATH);
const workDirectory = resolve(process.env.DEMO_STUDIO_WORK_DIRECTORY);
const targetUrl = process.env.DEMO_STUDIO_QUICKSTART_URL;
assert(targetUrl?.startsWith('http://127.0.0.1:'), 'The browser smoke must target only its local synthetic fixture.');
const plan = JSON.parse(await readFile(planPath, 'utf8'));
assert.equal(plan.targetUrl, targetUrl);
const expectedActionCount = plan.scenes.reduce((sum, scene) => sum + scene.actions.length, 0);

const startServer = async () => {
  const child = await launchRuntimeMcp({ cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
  const connected = await connectRuntimeMcp(child);
  assert.deepEqual(connected.tools.map((tool) => tool.name).sort(), requiredTools, 'The installed runtime must dynamically advertise all eight tools over raw stdio JSON-RPC.');
  return connected;
};
const callTool = async (client, name, args, timeoutMs = 30_000) => {
  const response = await client.request('tools/call', { name, arguments: args }, timeoutMs);
  assert(response?.isError === undefined || response.isError === false, `Installed MCP tool ${name} must succeed.`);
  const text = response?.content?.find((item) => item.type === 'text')?.text;
  assert.equal(typeof text, 'string', `Installed MCP tool ${name} must return JSON text.`);
  try { return JSON.parse(text); }
  catch { throw new Error(`Installed MCP tool ${name} did not return one JSON value.`); }
};
const hashFile = async (path) => `sha256:${createHash('sha256').update(await readFile(path)).digest('hex')}`;
const artifactSnapshot = async (missionDirectory, relativePaths) => Promise.all(relativePaths.map(async (relativePath) => {
  const path = resolve(missionDirectory, relativePath);
  const info = await stat(path, { bigint: true });
  assert(info.isFile());
  return { relativePath, size: info.size.toString(), modified: info.mtimeNs.toString(), digest: await hashFile(path) };
}));
const probeVideo = (videoPath) => {
  const result = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'json', videoPath], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1_000_000,
  });
  if (result.error || result.status !== 0) throw new Error('The rendered candidate could not be inspected with ffprobe.');
  try { return JSON.parse(result.stdout); }
  catch { throw new Error('ffprobe did not return valid video metadata.'); }
};

let session = await startServer();
let { client } = session;
try {
  const doctor = await callTool(client, 'demo_doctor', {});
  assert.equal(doctor.ready, true, 'The installed runtime doctor must pass its requested browser and media checks.');
  const prepared = await callTool(client, 'demo_prepare', { planPath, workDir: workDirectory });
  assert.equal(prepared.status, 'prepared');
  assert.match(prepared.missionId, /^demo-[a-f0-9]{24}$/);

  const preparedStatus = await callTool(client, 'demo_status', { missionId: prepared.missionId, workDir: workDirectory });
  assert.equal(preparedStatus.status, 'prepared');
  const generated = await callTool(client, 'demo_generate', { missionId: prepared.missionId, workDir: workDirectory, wait: true }, 600_000);
  assert.equal(generated.mission.status, 'awaiting-review', 'Real capture and render must stop at a review candidate.');
  assert.equal(generated.audit.semanticTruth, 'not-evaluated', 'Automated checks must not claim semantic approval.');
  assert.notEqual(generated.audit.status, 'fail');
  assert.equal(generated.mission.stages.capture.status, 'complete');
  assert.equal(generated.mission.stages.render.status, 'complete');
  assert.equal(generated.capture.clock.verified, true);
  assert.equal(generated.capture.scenes.length, plan.scenes.length);
  assert.equal(generated.capture.events.length, expectedActionCount);

  const missionDirectory = join(workDirectory, 'missions', prepared.missionId);
  const captureFile = JSON.parse(await readFile(join(missionDirectory, 'capture.json'), 'utf8'));
  assert.equal(captureFile.clock.recordingSha256, generated.capture.clock.recordingSha256);
  assert.equal(captureFile.events.length, expectedActionCount);
  assert(captureFile.recordings.length > 0, 'A real browser recording must be retained.');
  const recordingPath = resolve(missionDirectory, captureFile.recordings[0]);
  assert.equal(await hashFile(recordingPath), captureFile.clock.recordingSha256);

  const packet = generated.reviewPacket;
  assert.equal(packet.missionId, prepared.missionId);
  assert.equal(packet.planHash, generated.mission.planHash);
  assert.equal(packet.videoHash, generated.render.sha256);
  assert.equal(packet.requiredChecks.includes('contentTruth'), true);
  assert.equal(packet.requiredChecks.includes('uxQuality'), true);
  assert.equal(packet.deterministicAudit.status, generated.audit.status);
  assert.notEqual(packet.deterministicAudit.status, 'fail');
  assert.match(packet.packetHash, /^sha256:[a-f0-9]{64}$/);
  assert(packet.sampledFrames.length > 10, 'The review packet must refer to sampled final-video frames.');

  const videoPath = resolve(missionDirectory, generated.render.videoPath);
  const media = probeVideo(videoPath);
  const videoStream = media.streams?.find((stream) => stream.codec_type === 'video');
  assert.equal(videoStream?.width, 1440);
  assert.equal(videoStream?.height, 900);
  assert.equal(media.streams?.some((stream) => stream.codec_type === 'audio'), false, 'The captioned fixture must not fabricate narration.');
  assert.equal(await hashFile(videoPath), generated.render.sha256);
  const preview = await callTool(client, 'demo_preview', { missionId: prepared.missionId, workDir: workDirectory });
  assert.equal(preview.reviewPacket.packetHash, packet.packetHash, 'Preview must expose the exact generated review packet.');
  assert.equal(preview.mission.status, 'awaiting-review');

  const artifactsToRetain = [
    'capture.json',
    generated.render.videoPath,
    generated.render.posterPath,
    generated.render.timelinePath,
    ...generated.render.sampledFrames,
  ];
  const beforeRestartArtifacts = await artifactSnapshot(missionDirectory, artifactsToRetain);
  const beforeRestartStatus = await getRuntimeCapsuleStatus();
  assert.equal(beforeRestartStatus.status, 'ready');
  const installedAttemptId = beforeRestartStatus.attemptId;

  await client.close();
  session = await startServer();
  client = session.client;
  const resumed = await callTool(client, 'demo_prepare', { planPath, workDir: workDirectory });
  assert.equal(resumed.missionId, prepared.missionId, 'Restart must resume the exact prepared mission.');
  const repeatedGenerate = await callTool(client, 'demo_generate', { missionId: prepared.missionId, workDir: workDirectory, wait: true }, 600_000);
  assert.equal(repeatedGenerate.mission.status, 'awaiting-review');
  assert.deepEqual(repeatedGenerate.mission.stages.capture, generated.mission.stages.capture, 'Restart must not repeat browser capture.');
  assert.deepEqual(repeatedGenerate.mission.stages.render, generated.mission.stages.render, 'Restart must not repeat video rendering.');
  assert.deepEqual(await artifactSnapshot(missionDirectory, artifactsToRetain), beforeRestartArtifacts, 'Restart must leave captured and rendered artifacts byte-for-byte unchanged.');
  const afterRestartStatus = await getRuntimeCapsuleStatus();
  assert.equal(afterRestartStatus.status, 'ready');
  assert.equal(afterRestartStatus.attemptId, installedAttemptId, 'MCP restart must reuse the existing capsule installation.');

  const staleReview = await client.request('tools/call', {
    name: 'demo_review',
    arguments: {
      workDir: workDirectory,
      submission: {
        missionId: prepared.missionId,
        packetHash: `sha256:${'0'.repeat(64)}`,
        planHash: packet.planHash,
        videoHash: packet.videoHash,
        reviewerId: 'synthetic-smoke-reviewer',
        reviewerType: 'independent',
        verdict: 'revise',
        checks: { contentTruth: 'inconclusive', uxQuality: 'inconclusive' },
        findings: [],
      },
    },
  });
  assert.equal(staleReview.isError, true, 'The runtime must reject a review bound to a stale packet hash.');
  const afterRejectedReview = await callTool(client, 'demo_status', { missionId: prepared.missionId, workDir: workDirectory });
  assert.equal(afterRejectedReview.status, 'awaiting-review', 'A rejected stale review must not create an approval receipt.');
  assert.equal(afterRejectedReview.stages.review.status, 'pending');
} finally {
  await client.close();
}

process.stdout.write('Installed PnP runtime performed real capture/render, dynamic MCP discovery, review-packet inspection, and restart/cache reuse.\n');
