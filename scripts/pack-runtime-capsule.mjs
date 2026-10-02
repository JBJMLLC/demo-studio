import { createHash } from 'node:crypto';
import { cp, copyFile, lstat, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const toolkit = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(root, 'npm-shrinkwrap.json'), 'utf8'));
const runtimeName = '@jbjmllc/demo-studio-runtime';
const args = process.argv.slice(2);
const arg = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const artifactDirectory = resolve(arg('--artifact-dir') || join(root, 'release-artifacts'));
const runtimeUrlOverride = arg('--runtime-url');
if (!isAbsolute(artifactDirectory)) throw new Error('--artifact-dir must resolve to an absolute path.');
if (toolkit.name !== '@jbjmllc/demo-studio' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(toolkit.version)) throw new Error('Toolkit package identity or version is invalid.');
if (lock.name !== toolkit.name || lock.version !== toolkit.version || lock.packages?.['']?.version !== toolkit.version) throw new Error('npm shrinkwrap and package manifest versions differ.');
if (JSON.stringify(lock.packages?.['']?.dependencies) !== JSON.stringify(toolkit.dependencies)) throw new Error('npm shrinkwrap runtime dependencies differ from the toolkit manifest.');
if (runtimeUrlOverride && !runtimeUrlOverride.startsWith('file://')) throw new Error('Only an explicit local file URL is accepted for a test capsule descriptor override.');

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const listDigests = async (directory, prefix = '') => {
  const result = [];
  for (const entry of (await (await import('node:fs/promises')).readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = join(directory, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error('Runtime artifact staging must not contain symlinks.');
    if (info.isDirectory()) result.push(...await listDigests(absolute, path));
    else if (info.isFile()) result.push({ path, sha256: sha256(await readFile(absolute)) });
    else throw new Error('Runtime artifact staging contains an unsupported file type.');
  }
  return result;
};

const stage = await mkdtemp(join(tmpdir(), 'demo-studio-runtime-capsule-'));
try {
  const packageRoot = join(stage, 'package');
  const packDirectory = join(stage, 'packed');
  await mkdir(packageRoot, { recursive: true, mode: 0o700 });
  await mkdir(packDirectory, { recursive: true, mode: 0o700 });
  await cp(join(root, 'dist'), join(packageRoot, 'dist'), { recursive: true });
  // The runtime archive does not need the toolkit's capsule pointer. This avoids a self-hash cycle.
  await unlink(join(packageRoot, 'dist', 'runtime-capsule.json')).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
  await copyFile(join(root, 'LICENSE'), join(packageRoot, 'LICENSE'));
  await copyFile(join(root, 'THIRD_PARTY_NOTICES.md'), join(packageRoot, 'THIRD_PARTY_NOTICES.md'));

  const manifest = {
    name: runtimeName,
    version: toolkit.version,
    description: 'Checksum-pinned runtime capsule for the public Demo Studio toolkit.',
    type: 'module',
    license: toolkit.license,
    engines: toolkit.engines,
    files: ['dist', 'npm-shrinkwrap.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md'],
    dependencies: toolkit.dependencies,
  };
  const runtimeLock = structuredClone(lock);
  runtimeLock.name = runtimeName;
  runtimeLock.version = toolkit.version;
  const rootPackage = runtimeLock.packages[''];
  rootPackage.name = runtimeName;
  rootPackage.version = toolkit.version;
  rootPackage.license = toolkit.license;
  rootPackage.dependencies = toolkit.dependencies;
  delete rootPackage.devDependencies;
  delete rootPackage.bin;
  await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(packageRoot, 'npm-shrinkwrap.json'), `${JSON.stringify(runtimeLock, null, 2)}\n`, { mode: 0o600 });

  const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packDirectory], { cwd: packageRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (packed.status !== 0 || !packed.stdout) throw new Error('Runtime archive packing failed.');
  const packInfo = JSON.parse(packed.stdout);
  if (!Array.isArray(packInfo) || packInfo.length !== 1 || !packInfo[0].filename) throw new Error('Runtime archive packing did not return one artifact.');
  const packedPath = join(packDirectory, packInfo[0].filename);
  const expectedFilename = 'jbjmllc-demo-studio-runtime-' + toolkit.version + '.tgz';
  if (basename(packedPath) !== expectedFilename) throw new Error('Runtime archive filename does not match its generated package version.');
  const archiveBytes = await readFile(packedPath);
  const digest = sha256(archiveBytes);
  const files = await listDigests(packageRoot);
  const targetPath = join(artifactDirectory, expectedFilename);
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  const existing = await lstat(targetPath).catch(() => undefined);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('Runtime artifact destination is not a regular file.');
  if (existing) {
    if (!(await readFile(targetPath)).equals(archiveBytes)) throw new Error(`Refusing to overwrite an existing different runtime artifact: ${expectedFilename}`);
  } else {
    await copyFile(packedPath, targetPath, 1);
  }

  const descriptor = {
    schemaVersion: 1,
    packageName: runtimeName,
    version: toolkit.version,
    sha256: digest,
    url: runtimeUrlOverride || `https://github.com/JBJMLLC/demo-studio/releases/download/v${toolkit.version}/${expectedFilename}`,
    files: files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  };
  const descriptorJson = `${JSON.stringify(descriptor, null, 2)}\n`;
  await writeFile(join(root, 'dist', 'runtime-capsule.json'), descriptorJson, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ runtimeArchive: targetPath, sha256: digest, descriptor }, null, 2)}\n`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
