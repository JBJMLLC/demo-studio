import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const packageName = '@jbjmllc/demo-studio';
const yarnVersion = '4.12.0';
const archiveArgument = process.argv[2];
const runtimeArchiveArgument = process.argv[3];
if (!archiveArgument || !runtimeArchiveArgument) throw new Error('Pass the production toolkit archive and its packed runtime archive paths.');

const runRaw = (command, args, cwd, env) => {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
};
const run = (command, args, cwd, env) => {
  const result = runRaw(command, args, cwd, env);
  if (result.status !== 0) {
    const diagnostic = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(-8_000);
    throw new Error(`${command} ${args[0]} failed with exit ${result.status}:\n${diagnostic}`);
  }
  return result.stdout ?? '';
};

const readTarMember = (compressed, requestedName) => {
  const tar = gunzipSync(compressed);
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/s, '');
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/s, '');
    const memberName = prefix ? `${prefix}/${name}` : name;
    const sizeText = header.toString('ascii', 124, 136).replace(/\0.*$/s, '').trim();
    const size = Number.parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('The production archive contains an invalid tar member size.');
    const start = offset + 512;
    const end = start + size;
    if (end > tar.length) throw new Error('The production archive contains a truncated tar member.');
    if (memberName === requestedName) return Buffer.from(tar.subarray(start, end));
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new Error(`The production archive is missing ${requestedName}.`);
};

const readJsonMember = (compressed, path) => JSON.parse(readTarMember(compressed, path).toString('utf8'));
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const parseJsonOutput = (output, label) => {
  try { return JSON.parse(output); }
  catch { throw new Error(`${label} did not return one JSON value.`); }
};
const runLauncher = (...args) => run('corepack', [`yarn@${yarnVersion}`, 'exec', 'demo-studio', ...args], directory, environment);

const archive = await realpath(resolve(archiveArgument));
const archiveBytes = await readFile(archive);
const toolkitManifest = readJsonMember(archiveBytes, 'package/package.json');
const descriptor = readJsonMember(archiveBytes, 'package/dist/runtime-capsule.json');
if (toolkitManifest.name !== packageName || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(toolkitManifest.version)) {
  throw new Error('The production archive has an unexpected toolkit identity or version.');
}
assert.equal(descriptor.schemaVersion, 1);
assert.equal(descriptor.packageName, '@jbjmllc/demo-studio-runtime');
assert.equal(descriptor.version, toolkitManifest.version, 'The public descriptor version must match the packaged toolkit.');
assert.match(descriptor.sha256, /^sha256:[a-f0-9]{64}$/);
assert(Array.isArray(descriptor.files) && descriptor.files.length > 0, 'The packed descriptor must contain a runtime file inventory.');
assert.deepEqual(descriptor.files.map((file) => file.path), descriptor.files.map((file) => file.path).sort(), 'The actual packed file inventory must be canonical and sorted.');

const runtimeArchive = await realpath(resolve(runtimeArchiveArgument));
const runtimeArchiveBytes = await readFile(runtimeArchive);
assert.notEqual(runtimeArchive, archive, 'The runtime capsule must be a separate production archive.');
assert.equal(sha256(runtimeArchiveBytes), descriptor.sha256, 'The runtime archive bytes must match the descriptor embedded in the production package.');
const runtimeManifest = readJsonMember(runtimeArchiveBytes, 'package/package.json');
assert.equal(runtimeManifest.name, descriptor.packageName);
assert.equal(runtimeManifest.version, descriptor.version);

const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'demo-studio-yarn-pnp-')));
const directory = join(temporaryRoot, 'consumer');
await mkdir(directory, { mode: 0o700 });
assert.equal(await realpath(directory), directory, 'The generated PnP project path must be canonical.');
const cache = join(directory, '.yarn', 'cache');
const runtimeCache = join(temporaryRoot, 'runtime-cache');
const nodeOptions = [process.env.NODE_OPTIONS, '--trace-warnings'].filter(Boolean).join(' ');
const environment = {
  ...process.env,
  NODE_OPTIONS: nodeOptions,
  YARN_ENABLE_GLOBAL_CACHE: 'false',
  YARN_CACHE_FOLDER: cache,
  YARN_ENABLE_IMMUTABLE_INSTALLS: 'false',
  DEMO_STUDIO_RUNTIME_CACHE_DIR: runtimeCache,
};
const sourceFiles = [new URL('../npm-shrinkwrap.json', import.meta.url), new URL('../src/index.ts', import.meta.url)];
const sourceSnapshots = await Promise.all(sourceFiles.map(async (path) => [path, await readFile(path)]));
const manifest = {
  name: 'demo-studio-yarn-pnp-smoke',
  private: true,
  type: 'module',
  packageManager: `yarn@${yarnVersion}`,
  dependencies: { [packageName]: pathToFileURL(archive).href },
};
const expectedDescriptorPath = join(directory, 'expected-runtime-descriptor.json');
let fixture;
let fixtureReady = false;

const reservePort = async () => {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
};

const stopFixture = async () => {
  if (!fixture || fixture.exitCode !== null || fixture.signalCode !== null) return;
  fixture.kill('SIGTERM');
  await new Promise((resolveExit) => {
    const timer = setTimeout(() => { fixture.kill('SIGKILL'); resolveExit(); }, 3_000);
    fixture.once('exit', () => { clearTimeout(timer); resolveExit(); });
  });
};

try {
  assert.deepEqual(await (await import('node:fs/promises')).readdir(directory), [], 'The generated consumer must start without package-manager state.');
  assert.deepEqual(Object.keys(manifest.dependencies), [packageName], 'The consumer manifest must declare only the installed toolkit.');
  await writeFile(join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(directory, '.yarnrc.yml'), 'nodeLinker: pnp\n', { mode: 0o600 });
  await writeFile(expectedDescriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
  run('corepack', [`yarn@${yarnVersion}`, 'install'], directory, environment);

  const fs = await import('node:fs/promises');
  assert((await fs.readdir(directory)).includes('yarn.lock'), 'Yarn must create a lockfile only in the generated temporary consumer.');
  assert((await fs.readdir(directory)).includes('.pnp.cjs'), 'The consumer must use Yarn Plug\'n\'Play.');
  await writeFile(join(directory, 'smoke.mjs'), await readFile(new URL('./yarn-pnp-consumer.mjs', import.meta.url), 'utf8'), { mode: 0o600 });
  await writeFile(join(directory, 'yarn-pnp-stdio.mjs'), await readFile(new URL('./yarn-pnp-stdio.mjs', import.meta.url), 'utf8'), { mode: 0o600 });

  const initialCliStatus = parseJsonOutput(runLauncher('capsule', 'status'), 'The thin launcher capsule status command');
  assert.equal(initialCliStatus.status, 'missing', 'Read-only status must not install the runtime.');
  assert.deepEqual(initialCliStatus.descriptor, descriptor);
  const skillsOnlyDoctor = parseJsonOutput(runLauncher('doctor', '--skills-only'), 'The PnP skills-only doctor');
  assert.equal(skillsOnlyDoctor.ready, true);
  assert.deepEqual(skillsOnlyDoctor.checks.map((check) => check.requirement), ['node'], 'Skills-only doctor must check Node without probing browser or media tools.');
  assert.equal(parseJsonOutput(runLauncher('capsule', 'status'), 'Capsule status after skills-only doctor').status, 'missing');
  const missingDoctor = runRaw('corepack', [`yarn@${yarnVersion}`, 'exec', 'demo-studio', 'doctor'], directory, environment);
  assert.equal(missingDoctor.status, 1, 'Full doctor must fail closed when the runtime capsule is missing.');
  const missingDoctorReport = parseJsonOutput(missingDoctor.stdout, 'The full doctor with a missing runtime capsule');
  assert.equal(missingDoctorReport.ready, false);
  assert.equal(missingDoctorReport.runtimeCapsule?.status, 'missing');
  assert.equal(parseJsonOutput(runLauncher('capsule', 'status'), 'Capsule status after missing-runtime doctor').status, 'missing');
  await assert.rejects(fs.lstat(runtimeCache), (error) => error?.code === 'ENOENT', 'Doctor paths must leave the runtime cache absent.');
  const preflightEnvironment = { ...environment, DEMO_STUDIO_EXPECTED_DESCRIPTOR_PATH: expectedDescriptorPath };
  run('corepack', [`yarn@${yarnVersion}`, 'node', 'smoke.mjs', '--preflight'], directory, preflightEnvironment);

  const installed = parseJsonOutput(runLauncher('capsule', 'install', '--archive', runtimeArchive, '--version', descriptor.version, '--sha256', descriptor.sha256), 'The explicit runtime capsule install command');
  assert.equal(installed.status, 'ready');
  assert.equal(installed.descriptor.sha256, descriptor.sha256);
  assert.deepEqual(installed.descriptor.files, descriptor.files);
  assert.equal(typeof installed.attemptId, 'string');

  const readyCliStatus = parseJsonOutput(runLauncher('capsule', 'status'), 'The installed capsule status command');
  assert.equal(readyCliStatus.status, 'ready');
  assert.equal(readyCliStatus.attemptId, installed.attemptId);
  const doctor = parseJsonOutput(runLauncher('doctor'), 'The installed runtime read-only doctor');
  assert.equal(doctor.ready, true, 'The installed runtime doctor must pass without installing or repairing anything.');
  assert.equal(doctor.runtimeCapsule?.status, 'ready');
  const statusAfterDoctor = parseJsonOutput(runLauncher('capsule', 'status'), 'Capsule status after read-only doctor');
  assert.equal(statusAfterDoctor.attemptId, installed.attemptId, 'Doctor must not create a second runtime installation.');

  const fixtureDirectory = join(directory, 'quickstart-fixture');
  await mkdir(fixtureDirectory, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(join(fixtureDirectory, 'server.mjs'), readTarMember(archiveBytes, 'package/examples/quickstart/server.mjs'), { mode: 0o600 }),
    writeFile(join(fixtureDirectory, 'index.html'), readTarMember(archiveBytes, 'package/examples/quickstart/index.html'), { mode: 0o600 }),
  ]);
  const port = await reservePort();
  const targetUrl = `http://127.0.0.1:${port}`;
  const plan = readJsonMember(archiveBytes, 'package/examples/quickstart/plan.json');
  plan.targetUrl = targetUrl;
  const planPath = join(directory, 'quickstart-plan.json');
  const workDirectory = join(directory, 'quickstart-work');
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  const consumerEnvironment = {
    ...environment,
    DEMO_STUDIO_EXPECTED_DESCRIPTOR_PATH: expectedDescriptorPath,
    DEMO_STUDIO_PLAN_PATH: planPath,
    DEMO_STUDIO_WORK_DIRECTORY: workDirectory,
    DEMO_STUDIO_QUICKSTART_URL: targetUrl,
  };

  fixture = spawn(process.execPath, [join(fixtureDirectory, 'server.mjs')], {
    cwd: fixtureDirectory,
    env: { ...environment, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let fixtureOutput = '';
  const fixtureReadyPromise = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error('The packaged synthetic browser fixture did not start.')), 15_000);
    fixture.stdout.setEncoding('utf8');
    fixture.stdout.on('data', (chunk) => {
      fixtureOutput = `${fixtureOutput}${chunk}`.slice(-2_000);
      if (fixtureOutput.includes('Quickstart fixture ready')) { fixtureReady = true; clearTimeout(timer); resolveReady(); }
    });
    fixture.once('error', () => { clearTimeout(timer); rejectReady(new Error('The packaged synthetic browser fixture could not start.')); });
    fixture.once('exit', (code) => { if (!fixtureReady) { clearTimeout(timer); rejectReady(new Error(`The packaged synthetic browser fixture exited early (${code ?? 'unknown'}).`)); } });
    fixture.stderr.resume();
  });
  await fixtureReadyPromise;
  const fixtureResponse = await fetch(targetUrl);
  assert.equal(fixtureResponse.status, 200, 'The packaged quickstart page must be served to a real browser.');

  run('corepack', [`yarn@${yarnVersion}`, 'node', 'smoke.mjs', '--workflow'], directory, consumerEnvironment);
  await stopFixture();
  fixture = undefined;
  const finalStatus = parseJsonOutput(runLauncher('capsule', 'status'), 'Final capsule status after runtime restart');
  assert.equal(finalStatus.status, 'ready');
  assert.equal(finalStatus.attemptId, installed.attemptId, 'Runtime restart must reuse the same installed archive without another install.');

  for (const [path, contents] of sourceSnapshots) {
    assert.deepEqual(await readFile(path), contents, `The Yarn PnP smoke must not modify ${path.pathname}.`);
  }
  if (process.env.DEMO_STUDIO_KEEP_YARN_PNP === '1') process.stderr.write(`Retained temporary PnP consumer root: ${temporaryRoot}\n`);
  else await rm(temporaryRoot, { recursive: true, force: true });
  process.stdout.write(`Yarn PnP archive install, minimal dependency graph, real browser capture/render, dynamic MCP discovery, and restart reuse passed (${yarnVersion}).\n`);
} catch (error) {
  await stopFixture();
  if (process.env.DEMO_STUDIO_KEEP_YARN_PNP === '1') process.stderr.write(`Retained temporary PnP consumer root after failure: ${temporaryRoot}\n`);
  else await rm(temporaryRoot, { recursive: true, force: true });
  throw error;
}
