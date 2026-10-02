import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, open as openFile, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  getRuntimeCapsuleStatus,
  installRuntimeCapsule,
  isolatedRuntimeEnvironment,
  reconcileRuntimeCapsule,
  runtimeCapsuleKey,
  runtimeCompatibilityKey,
  runtimeInstallerEnvironment,
  type RuntimeCapsuleDescriptor,
} from '../src/capsule.js';
import {
  detectLinuxLibcIdentity,
  runtimeCapsuleCacheName,
  runtimeCompatibilityKeyFor,
  runtimeCompatibilityMatches,
} from '../src/runtime-compatibility.js';

const runtimeName = '@jbjmllc/demo-studio-runtime';
const hash = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}` as `sha256:${string}`;

async function createRuntimeArchive(
  parent: string,
  identity: { manifestName?: string; manifestVersion?: string; descriptorVersion?: string } = {},
): Promise<{ archivePath: string; descriptor: RuntimeCapsuleDescriptor }> {
  const root = join(parent, `fixture-${randomUUID()}`);
  const packageRoot = join(root, 'package');
  const packedDirectory = join(root, 'packed');
  const manifestName = identity.manifestName ?? runtimeName;
  const manifestVersion = identity.manifestVersion ?? '0.1.2';
  const descriptorVersion = identity.descriptorVersion ?? '0.1.2';
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await mkdir(packedDirectory, { recursive: true });
  const manifest = {
    name: manifestName,
    version: manifestVersion,
    type: 'module',
    files: ['dist', 'npm-shrinkwrap.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md'],
    dependencies: {},
  };
  const lock = {
    name: manifestName,
    version: manifestVersion,
    lockfileVersion: 3,
    packages: { '': { name: manifestName, version: manifestVersion, dependencies: {} } },
  };
  await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(packageRoot, 'npm-shrinkwrap.json'), `${JSON.stringify(lock, null, 2)}\n`);
  await writeFile(join(packageRoot, 'LICENSE'), 'MIT License\n\nTest fixture only.\n');
  await writeFile(join(packageRoot, 'THIRD_PARTY_NOTICES.md'), 'Test fixture runtime package.\n');
  await writeFile(join(packageRoot, 'dist', 'runtime-cli.js'), 'if (process.argv[2] === "fixture") process.stdout.write("runtime-ok\\n");\n');

  const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packedDirectory], {
    cwd: packageRoot,
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (packed.status !== 0 || !packed.stdout) throw new Error('Failed to create the local runtime fixture archive.');
  const filename = (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0]?.filename;
  if (!filename) throw new Error('The local runtime fixture pack did not return an archive.');
  const archivePath = join(packedDirectory, filename);
  const archiveBytes = await readFile(archivePath);
  const files: RuntimeCapsuleDescriptor['files'] = [];
  for (const path of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'dist/runtime-cli.js', 'npm-shrinkwrap.json', 'package.json']) {
    files.push({ path, sha256: hash(await readFile(join(packageRoot, path))) });
  }
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return {
    archivePath,
    descriptor: {
      schemaVersion: 1,
      packageName: runtimeName,
      version: descriptorVersion,
      sha256: hash(archiveBytes),
      url: pathToFileURL(archivePath).href,
      files,
    },
  };
}

describe('integrity-pinned runtime capsule', () => {
  let root = '';
  let cacheDirectory = '';
  let archivePath = '';
  let descriptor: RuntimeCapsuleDescriptor;
  let ready: Awaited<ReturnType<typeof installRuntimeCapsule>>;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'demo-studio-capsule-test-'));
    cacheDirectory = join(root, 'cache');
    const archive = await createRuntimeArchive(root);
    archivePath = archive.archivePath;
    descriptor = archive.descriptor;
    ready = await installRuntimeCapsule({ descriptor, cacheDirectory, timeoutMs: 30_000 });
    if (ready.status !== 'ready') throw new Error(`Fixture capsule install did not reach ready: ${JSON.stringify({ status: ready.status, errorCode: ready.errorCode })}`);
  }, 60_000);

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('keys cache identity to package bytes and native runtime compatibility', () => {
    expect(runtimeCapsuleKey(descriptor)).toContain(descriptor.sha256.slice('sha256:'.length));
    expect(runtimeCompatibilityKey()).toContain(`node${process.versions.node.split('.')[0]}`);
    expect(runtimeCompatibilityKey()).toContain(`abi${process.versions.modules || 'none'}`);
    expect(runtimeCompatibilityKey()).toContain(process.platform);
    expect(runtimeCompatibilityKey()).toContain(process.arch);
  });

  it('separates GNU and musl cache identities and prevents receipt reuse across libc families', () => {
    const sameLinuxRuntime = { nodeMajor: '22', abi: '127', platform: 'linux', arch: 'x64' };
    const glibc = detectLinuxLibcIdentity('2.37', ['/lib64/libc.so.6']);
    const musl = detectLinuxLibcIdentity(undefined, ['/lib/ld-musl-x86_64.so.1']);
    const unknown = detectLinuxLibcIdentity(undefined, ['/lib64/ld-linux-x86-64.so.2']);
    const glibcKey = runtimeCompatibilityKeyFor({ ...sameLinuxRuntime, linuxLibc: glibc });
    const muslKey = runtimeCompatibilityKeyFor({ ...sameLinuxRuntime, linuxLibc: musl });

    expect(glibc.family).toBe('glibc');
    expect(musl.family).toBe('musl');
    expect(unknown.family).toBe('unknown');
    expect(glibcKey).not.toBe(muslKey);
    expect(glibcKey).toContain('glibc-2.37');
    expect(muslKey).toContain('libc-musl');
    expect(() => runtimeCompatibilityKeyFor({ ...sameLinuxRuntime, linuxLibc: unknown })).toThrow(/unknown/i);

    const glibcCache = runtimeCapsuleCacheName('0.1.2', 'abc123', glibcKey);
    const muslCache = runtimeCapsuleCacheName('0.1.2', 'abc123', muslKey);
    expect(glibcCache).not.toBe(muslCache);
    expect(runtimeCompatibilityMatches(glibcKey, glibcKey)).toBe(true);
    expect(runtimeCompatibilityMatches(glibcKey, muslKey)).toBe(false);
    expect(muslKey).not.toContain('/lib/ld-musl');

    expect(runtimeCompatibilityKeyFor({ ...sameLinuxRuntime, platform: 'darwin', arch: 'arm64', linuxLibc: unknown }))
      .toBe('node22-abi127-darwin-arm64');
  });

  it('returns a separate missing status instead of reading a failed receipt from another Linux libc cache', async () => {
    const simulatedCache = join(root, 'linux-libc-cache-isolation');
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    const archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch');
    const reportSpy = vi.spyOn(process.report, 'getReport');

    try {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
      Object.defineProperty(process, 'arch', { configurable: true, value: 'x64' });
      reportSpy.mockReturnValue({ header: { glibcVersionRuntime: '2.37' }, sharedObjects: ['/lib64/libc.so.6'] });
      vi.resetModules();
      const glibcCapsule = await import('../src/capsule.js');
      const glibcStatus = await glibcCapsule.getRuntimeCapsuleStatus({ descriptor, cacheDirectory: simulatedCache });
      expect(glibcStatus.status).toBe('missing');
      expect(glibcStatus.compatibilityKey).toContain('glibc-2.37');

      await mkdir(glibcStatus.cachePath, { recursive: true });
      const timestamp = new Date().toISOString();
      await writeFile(join(glibcStatus.cachePath, 'status.json'), JSON.stringify({
        schemaVersion: 1,
        descriptor,
        compatibilityKey: glibcStatus.compatibilityKey,
        status: 'failed',
        attemptId: randomUUID(),
        startedAt: timestamp,
        updatedAt: timestamp,
        failureStage: 'npm-install',
        errorCode: 'install-failed',
      }));
      expect((await glibcCapsule.getRuntimeCapsuleStatus({ descriptor, cacheDirectory: simulatedCache })).status).toBe('failed');

      reportSpy.mockReturnValue({ header: {}, sharedObjects: ['/lib/ld-musl-x86_64.so.1'] });
      vi.resetModules();
      const muslCapsule = await import('../src/capsule.js');
      const muslStatus = await muslCapsule.getRuntimeCapsuleStatus({ descriptor, cacheDirectory: simulatedCache });
      expect(muslStatus.status).toBe('missing');
      expect(muslStatus.compatibilityKey).toContain('libc-musl');
      expect(muslStatus.cachePath).not.toBe(glibcStatus.cachePath);

      reportSpy.mockReturnValue({ header: {}, sharedObjects: ['/lib64/ld-linux-x86-64.so.2'] });
      vi.resetModules();
      const unknownCapsule = await import('../src/capsule.js');
      await expect(unknownCapsule.getRuntimeCapsuleStatus({ descriptor, cacheDirectory: simulatedCache }))
        .rejects.toMatchObject({ name: 'RuntimeCapsuleError', code: 'unsupported-libc' });
      const storedGlibcReceipt = await readFile(join(glibcStatus.cachePath, 'status.json'), 'utf8');
      expect(storedGlibcReceipt).not.toContain('/lib');
      expect(storedGlibcReceipt).not.toContain('ld-musl');
    } finally {
      reportSpy.mockRestore();
      vi.resetModules();
      if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
      if (archDescriptor) Object.defineProperty(process, 'arch', archDescriptor);
    }
  });

  it('keeps acquisition location separate from the pinned runtime identity', async () => {
    const releaseLocation = { ...descriptor, url: 'https://github.com/JBJMLLC/demo-studio/releases/download/v0.1.2/jbjmllc-demo-studio-runtime-0.1.2.tgz' };
    const current = await getRuntimeCapsuleStatus({ descriptor: releaseLocation, cacheDirectory });
    expect(current.status).toBe('ready');
    expect(current.attemptId).toBe(ready.attemptId);
    expect(current.descriptor.url).toBe(releaseLocation.url);
  });

  it('persists capsule receipts when FileHandle.sync is absent or unsupported', async () => {
    const probe = await openFile(archivePath, 'r');
    let syncOwner: object | null = Object.getPrototypeOf(probe) as object | null;
    while (syncOwner && !Object.hasOwn(syncOwner, 'sync')) syncOwner = Object.getPrototypeOf(syncOwner) as object | null;
    const originalSync = syncOwner ? Object.getOwnPropertyDescriptor(syncOwner, 'sync') : undefined;
    await probe.close();
    expect(syncOwner).toBeTruthy();
    expect(originalSync).toBeTruthy();

    const replacements: Array<{ label: string; value: unknown }> = [
      { label: 'absent', value: undefined },
      { label: 'unsupported', value: async () => { throw new Error('Method not implemented.'); } },
    ];
    for (const replacement of replacements) {
      Object.defineProperty(syncOwner!, 'sync', { configurable: true, writable: true, value: replacement.value });
      try {
        const result = await installRuntimeCapsule({ descriptor, cacheDirectory: join(root, `sync-${replacement.label}-cache`), timeoutMs: 30_000 });
        expect(result.status).toBe('ready');
        expect((await getRuntimeCapsuleStatus({ descriptor, cacheDirectory: join(root, `sync-${replacement.label}-cache`) })).status).toBe('ready');
      } finally {
        Object.defineProperty(syncOwner!, 'sync', originalSync!);
      }
    }
  }, 90_000);

  it('installs only the exact archive inventory and detects changed installed bytes', async () => {
    expect(ready.status).toBe('ready');
    const current = await getRuntimeCapsuleStatus({ descriptor, cacheDirectory });
    expect(current.status).toBe('ready');
    const entry = current.runtimeEntry;
    expect(entry).toBeTruthy();
    const original = await readFile(entry!);
    await writeFile(entry!, Buffer.concat([original, Buffer.from('// changed after install\n')]));
    const changed = await getRuntimeCapsuleStatus({ descriptor, cacheDirectory });
    expect(changed.status).toBe('invalid');
    expect(changed.errorCode).toBe('integrity-mismatch');
    await writeFile(entry!, original);
    expect((await getRuntimeCapsuleStatus({ descriptor, cacheDirectory })).status).toBe('ready');
  });

  it('rejects archive digest, package-role, version, and file-inventory mismatches before installation', async () => {
    const checksumCache = join(root, 'checksum-negative-cache');
    const badChecksum = { ...descriptor, sha256: hash('not the runtime archive') };
    const checksumFailure = await installRuntimeCapsule({ descriptor: badChecksum, cacheDirectory: checksumCache, timeoutMs: 30_000 });
    expect(checksumFailure.status).toBe('failed');
    expect(checksumFailure.errorCode).toBe('integrity-mismatch');
    await expect(lstat(join(checksumFailure.cachePath, 'attempts', checksumFailure.attemptId!, 'install'))).rejects.toMatchObject({ code: 'ENOENT' });

    const wrongRoleArchive = await createRuntimeArchive(root, { manifestName: '@example/not-the-runtime' });
    const roleFailure = await installRuntimeCapsule({ descriptor: wrongRoleArchive.descriptor, cacheDirectory: join(root, 'role-negative-cache'), timeoutMs: 30_000 });
    expect(roleFailure.status).toBe('failed');
    expect(roleFailure.errorCode).toBe('package-identity-mismatch');
    await expect(lstat(join(roleFailure.cachePath, 'attempts', roleFailure.attemptId!, 'install'))).rejects.toMatchObject({ code: 'ENOENT' });

    const wrongVersionArchive = await createRuntimeArchive(root, { manifestVersion: '0.1.3', descriptorVersion: '0.1.2' });
    const versionFailure = await installRuntimeCapsule({ descriptor: wrongVersionArchive.descriptor, cacheDirectory: join(root, 'version-negative-cache'), timeoutMs: 30_000 });
    expect(versionFailure.status).toBe('failed');
    expect(versionFailure.errorCode).toBe('package-identity-mismatch');
    await expect(lstat(join(versionFailure.cachePath, 'attempts', versionFailure.attemptId!, 'install'))).rejects.toMatchObject({ code: 'ENOENT' });

    const corruptedFiles = descriptor.files.map((file) => file.path === 'dist/runtime-cli.js' ? { ...file, sha256: hash('different runtime bytes') } : file);
    const wrongInventory = { ...descriptor, files: corruptedFiles };
    const inventoryFailure = await installRuntimeCapsule({ descriptor: wrongInventory, cacheDirectory: join(root, 'inventory-negative-cache'), timeoutMs: 30_000 });
    expect(inventoryFailure.status).toBe('failed');
    expect(inventoryFailure.errorCode).toBe('integrity-mismatch');
    await expect(lstat(join(inventoryFailure.cachePath, 'attempts', inventoryFailure.attemptId!, 'install'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60_000);

  it('bounds HTTPS archive reads as bytes arrive without buffering an oversized response', async () => {
    const boundedCache = join(root, 'bounded-download-cache');
    let chunksRead = 0;
    const chunk = new Uint8Array(1024 * 1024);
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksRead += 1;
        controller.enqueue(chunk);
      },
    }), { status: 200 }));
    try {
      const status = await installRuntimeCapsule({
        descriptor: { ...descriptor, url: 'https://example.test/oversized-runtime.tgz' },
        cacheDirectory: boundedCache,
        timeoutMs: 30_000,
      });
      expect(status.status).toBe('failed');
      expect(status.errorCode).toBe('integrity-mismatch');
      expect(chunksRead).toBeGreaterThan(512);
      await expect(lstat(join(status.cachePath, 'attempts', status.attemptId!, 'runtime.tgz'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(join(status.cachePath, 'attempts', status.attemptId!, 'install'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      vi.unstubAllGlobals();
    }
  }, 60_000);

  it('rejects malformed receipt IDs and timestamps without silently repairing them', async () => {
    const receiptPath = join(ready.cachePath, 'status.json');
    const original = await readFile(receiptPath, 'utf8');
    const receipt = JSON.parse(original) as { attemptId: string; startedAt: string };
    try {
      await writeFile(receiptPath, JSON.stringify({ ...receipt, attemptId: '' }));
      expect((await getRuntimeCapsuleStatus({ descriptor, cacheDirectory })).status).toBe('invalid');
      await writeFile(receiptPath, JSON.stringify({ ...receipt, startedAt: 'yesterday' }));
      expect((await getRuntimeCapsuleStatus({ descriptor, cacheDirectory })).status).toBe('invalid');
    } finally { await writeFile(receiptPath, original); }
    expect((await getRuntimeCapsuleStatus({ descriptor, cacheDirectory })).status).toBe('ready');
  });

  it('rejects a symlinked install ancestor even when it points to the expected bytes', async () => {
    const attemptId = ready.attemptId!;
    const installRoot = join(ready.cachePath, 'attempts', attemptId, 'install');
    const runtimeRoot = join(installRoot, 'node_modules', '@jbjmllc', 'demo-studio-runtime');
    for (const component of [installRoot, join(installRoot, 'node_modules'), join(installRoot, 'node_modules', '@jbjmllc'), runtimeRoot, join(runtimeRoot, 'dist')]) {
      const moved = join(root, `moved-component-${randomUUID()}`);
      await rename(component, moved);
      try {
        await symlink(moved, component, 'dir');
        const result = await getRuntimeCapsuleStatus({ descriptor, cacheDirectory });
        expect(result.status).toBe('invalid');
        expect(result.errorCode).toBe('integrity-mismatch');
      } finally {
        await unlink(component).catch(() => undefined);
        await rename(moved, component);
      }
      expect((await getRuntimeCapsuleStatus({ descriptor, cacheDirectory })).status).toBe('ready');
    }
  });

  it('preserves unknown installer evidence and retries only after explicit reconciliation', async () => {
    const recoveryCache = join(root, 'recovery-cache');
    const capsulePath = join(recoveryCache, runtimeCapsuleKey(descriptor));
    await mkdir(capsulePath, { recursive: true });
    const previousAttemptId = randomUUID();
    const startedAt = new Date().toISOString();
    const lockPath = join(capsulePath, 'install.lock');
    await writeFile(lockPath, JSON.stringify({ schemaVersion: 1, descriptor, compatibilityKey: runtimeCompatibilityKey(), attemptId: previousAttemptId, pid: 2_147_483_647, startedAt }));
    const unknown = await getRuntimeCapsuleStatus({ descriptor, cacheDirectory: recoveryCache });
    expect(unknown.status).toBe('unknown-after-timeout');
    await expect(installRuntimeCapsule({ descriptor, cacheDirectory: recoveryCache, timeoutMs: 30_000 })).rejects.toThrow('use explicit reconciliation');
    expect(await readFile(lockPath, 'utf8')).toContain(previousAttemptId);

    const recovered = await reconcileRuntimeCapsule({ action: 'retry-uncertain-stage', descriptor, cacheDirectory: recoveryCache, timeoutMs: 30_000 });
    expect(recovered.status).toBe('ready');
    expect(recovered.attemptId).not.toBe(previousAttemptId);
    const archivedLocks = await readdir(join(capsulePath, 'attempts'));
    expect(archivedLocks.some((name) => name.startsWith('stale-lock-'))).toBe(true);
  }, 60_000);

  it('records an actual installer timeout, refuses automatic duplication, and preserves the partial attempt on explicit retry', async () => {
    const timeoutCache = join(root, 'timeout-cache');
    const timedOut = await installRuntimeCapsule({ descriptor, cacheDirectory: timeoutCache, timeoutMs: 1 });
    expect(timedOut.status).toBe('unknown-after-timeout');
    expect(timedOut.attemptId).toBeTruthy();
    expect(timedOut.failureStage).toBe('npm-install');
    const oldAttemptPath = join(timedOut.cachePath, 'attempts', timedOut.attemptId!);
    const oldArchive = await readFile(join(oldAttemptPath, 'runtime.tgz'));
    expect(hash(oldArchive)).toBe(descriptor.sha256);
    expect((JSON.parse(await readFile(join(timedOut.cachePath, 'attempts', `${timedOut.attemptId}.json`), 'utf8')) as { status: string }).status).toBe('unknown-after-timeout');

    const observed = await getRuntimeCapsuleStatus({ descriptor, cacheDirectory: timeoutCache });
    expect(observed.status).toBe('unknown-after-timeout');
    expect(observed.attemptId).toBe(timedOut.attemptId);
    expect(observed.failureStage).toBe('npm-install');
    await expect(installRuntimeCapsule({ descriptor, cacheDirectory: timeoutCache, timeoutMs: 30_000 })).rejects.toThrow('use explicit reconciliation');
    expect((await getRuntimeCapsuleStatus({ descriptor, cacheDirectory: timeoutCache })).attemptId).toBe(timedOut.attemptId);

    const retried = await reconcileRuntimeCapsule({ action: 'retry-uncertain-stage', descriptor, cacheDirectory: timeoutCache, timeoutMs: 30_000 });
    expect(retried.status).toBe('ready');
    expect(retried.attemptId).not.toBe(timedOut.attemptId);
    expect(hash(await readFile(join(oldAttemptPath, 'runtime.tgz')))).toBe(descriptor.sha256);
    expect((await getRuntimeCapsuleStatus({ descriptor, cacheDirectory: timeoutCache })).attemptId).toBe(retried.attemptId);
  }, 90_000);

  it('retains a failed partial attempt and writes a fresh attempt after an explicit failed-stage retry', async () => {
    const failedCache = join(root, 'failed-cache');
    const recoverySource = join(root, 'recovery-source.tgz');
    const retryDescriptor = { ...descriptor, url: pathToFileURL(recoverySource).href };
    const failed = await installRuntimeCapsule({ descriptor: retryDescriptor, cacheDirectory: failedCache, timeoutMs: 30_000 });
    expect(failed.status).toBe('failed');
    expect(failed.errorCode).toBe('integrity-mismatch');
    expect(failed.failureStage).toBe('archive-acquisition');
    expect((await getRuntimeCapsuleStatus({ descriptor: retryDescriptor, cacheDirectory: failedCache })).failureStage).toBe('archive-acquisition');
    const oldAttemptPath = join(failed.cachePath, 'attempts', failed.attemptId!);
    expect((JSON.parse(await readFile(join(failed.cachePath, 'attempts', `${failed.attemptId}.json`), 'utf8')) as { status: string }).status).toBe('failed');

    await writeFile(recoverySource, await readFile(archivePath));
    const retried = await reconcileRuntimeCapsule({ action: 'retry-failed-stage', descriptor: retryDescriptor, cacheDirectory: failedCache, timeoutMs: 30_000 });
    expect(retried.status).toBe('ready');
    expect(retried.attemptId).not.toBe(failed.attemptId);
    expect(await lstat(oldAttemptPath).then((info) => info.isDirectory())).toBe(true);
    expect((JSON.parse(await readFile(join(failed.cachePath, 'attempts', `${failed.attemptId}.json`), 'utf8')) as { status: string }).status).toBe('failed');
    const history = JSON.parse(await readFile(join(failed.cachePath, 'attempts', 'index.json'), 'utf8')) as Array<{ attemptId: string; status: string }>;
    expect(history.map((entry) => entry.attemptId)).toEqual([failed.attemptId, retried.attemptId]);
    expect(history.map((entry) => entry.status)).toEqual(['failed', 'ready']);
  }, 60_000);

  it('serializes concurrent installers into one durable attempt', async () => {
    const concurrentCache = join(root, 'concurrent-cache');
    const attempts = await Promise.allSettled([
      installRuntimeCapsule({ descriptor, cacheDirectory: concurrentCache, timeoutMs: 30_000 }),
      installRuntimeCapsule({ descriptor, cacheDirectory: concurrentCache, timeoutMs: 30_000 }),
    ]);
    const status = await getRuntimeCapsuleStatus({ descriptor, cacheDirectory: concurrentCache });
    expect(status.status).toBe('ready');
    const history = JSON.parse(await readFile(join(status.cachePath, 'attempts', 'index.json'), 'utf8')) as Array<{ attemptId: string }>;
    expect(history).toHaveLength(1);
    expect(history[0].attemptId).toBe(status.attemptId);
    const readyResults = attempts.flatMap((result) => result.status === 'fulfilled' && result.value.status === 'ready' ? [result.value] : []);
    expect(readyResults.length).toBeGreaterThan(0);
    expect(readyResults.every((result) => result.attemptId === status.attemptId)).toBe(true);
  }, 60_000);

  it('removes only PnP preload hooks from a child environment', () => {
    const input = { NODE_OPTIONS: '--require /tmp/.pnp.cjs --import=/tmp/.pnp.loader.mjs --require "/tmp/custom loader.cjs" --trace-warnings', KEEP_ME: 'yes', npm_config_allow_scripts: 'fixture-script-policy' };
    const output = isolatedRuntimeEnvironment(input);
    expect(output.NODE_OPTIONS).not.toContain('.pnp');
    expect(output.NODE_OPTIONS).toContain('/tmp/custom loader.cjs');
    expect(output.NODE_OPTIONS).toContain('--trace-warnings');
    expect(output.KEEP_ME).toBe('yes');
    expect(output.npm_config_allow_scripts).toBe('fixture-script-policy');
    expect(input.NODE_OPTIONS).toContain('.pnp.cjs');
  });

  it('normalizes only the owned npm installer child while retaining explicit script denial', () => {
    const input = { NODE_OPTIONS: '--trace-warnings', npm_config_allow_scripts: 'fixture-script-policy', NPM_CONFIG_ALLOW_SCRIPTS: 'another-fixture-policy', npm_config_strict_allow_scripts: 'true', KEEP_ME: 'yes' };
    const output = runtimeInstallerEnvironment(input);
    expect(Object.keys(output).some((key) => key.toLowerCase() === 'npm_config_allow_scripts')).toBe(false);
    expect(output.npm_config_strict_allow_scripts).toBe('true');
    expect(output.KEEP_ME).toBe('yes');
    expect(Object.keys(input).some((key) => key.toLowerCase() === 'npm_config_allow_scripts')).toBe(true);
  });

  it('rejects descriptor URLs carrying credentials or query data', async () => {
    const invalid = { ...descriptor, url: 'https://example.test/archive.tgz?credential=value' };
    await expect(getRuntimeCapsuleStatus({ descriptor: invalid, cacheDirectory: join(root, 'invalid-cache') })).rejects.toThrow('unsupported scheme');
  });
});
