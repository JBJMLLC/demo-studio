import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { constants, fsync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { access, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { detectLinuxLibcIdentity, runtimeCapsuleCacheName, runtimeCompatibilityKeyFor, runtimeCompatibilityMatches, type LinuxLibcIdentity } from './runtime-compatibility.js';

export const RUNTIME_CAPSULE_PACKAGE = '@jbjmllc/demo-studio-runtime';

export interface RuntimeCapsuleFileDigest {
  path: string;
  sha256: `sha256:${string}`;
}

export interface RuntimeCapsuleDescriptor {
  schemaVersion: 1;
  packageName: typeof RUNTIME_CAPSULE_PACKAGE;
  version: string;
  sha256: `sha256:${string}`;
  url: string;
  files: RuntimeCapsuleFileDigest[];
}

export type RuntimeCapsuleState = 'ready' | 'missing' | 'installing' | 'unknown-after-timeout' | 'failed' | 'invalid';
export type RuntimeCapsuleFailureStage = 'lock-persistence' | 'attempt-journal' | 'archive-acquisition' | 'npm-install' | 'post-install-validation' | 'completion-journal';

export interface RuntimeCapsuleStatus {
  schemaVersion: 1;
  status: RuntimeCapsuleState;
  descriptor: RuntimeCapsuleDescriptor;
  compatibilityKey: string;
  cachePath: string;
  runtimeEntry?: string;
  attemptId?: string;
  failureStage?: RuntimeCapsuleFailureStage;
  errorCode?: 'install-failed' | 'integrity-mismatch' | 'invalid-receipt' | 'package-identity-mismatch' | 'unsafe-cache-path' | 'unsupported-libc';
}

export interface RuntimeCapsuleOptions {
  /** Parent cache directory. The capsule is isolated below a version + digest key. */
  cacheDirectory?: string;
  /** Omit to use the exact descriptor embedded in the toolkit archive. */
  descriptor?: RuntimeCapsuleDescriptor;
  /** Bounded package acquisition/install time; defaults to 10 minutes. */
  timeoutMs?: number;
}

export interface RuntimeCapsuleReconcileOptions extends RuntimeCapsuleOptions {
  action: 'retry-failed-stage' | 'retry-uncertain-stage';
}

interface AttemptReceipt {
  schemaVersion: 1;
  descriptor: RuntimeCapsuleDescriptor;
  compatibilityKey: string;
  status: Exclude<RuntimeCapsuleState, 'missing' | 'invalid'>;
  attemptId: string;
  startedAt: string;
  updatedAt: string;
  failureStage?: RuntimeCapsuleFailureStage;
  errorCode?: RuntimeCapsuleStatus['errorCode'];
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const packagePattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const shaPattern = /^sha256:[a-f0-9]{64}$/;
const syncFileDescriptor = promisify(fsync);
const failureStages: RuntimeCapsuleFailureStage[] = ['lock-persistence', 'attempt-journal', 'archive-acquisition', 'npm-install', 'post-install-validation', 'completion-journal'];
let cachedRuntimeCompatibilityKey: string | undefined;

function isFailureStage(value: unknown): value is RuntimeCapsuleFailureStage {
  return typeof value === 'string' && failureStages.includes(value as RuntimeCapsuleFailureStage);
}

/** Native optional dependencies are installed per Node ABI, host platform, and Linux libc family. */
export function runtimeCompatibilityKey(): string {
  if (cachedRuntimeCompatibilityKey) return cachedRuntimeCompatibilityKey;
  const nodeMajor = process.versions.node.split('.')[0];
  const abi = process.versions.modules || 'none';
  let linuxLibc: LinuxLibcIdentity | undefined;
  if (process.platform === 'linux') {
    let glibcVersionRuntime: unknown;
    let sharedObjects: unknown;
    try {
      // Keep the report in memory and immediately reduce it to the two values
      // used for libc selection. No report paths or other fields are retained.
      const report = process.report.getReport() as { header?: { glibcVersionRuntime?: unknown }; sharedObjects?: unknown };
      glibcVersionRuntime = report.header?.glibcVersionRuntime;
      sharedObjects = report.sharedObjects;
    } catch {
      // An unavailable diagnostic signal is not proof of either libc family.
    }
    linuxLibc = detectLinuxLibcIdentity(glibcVersionRuntime, sharedObjects);
    if (linuxLibc.family === 'unknown') {
      fail('unsupported-libc', 'Linux libc could not be identified from Node runtime diagnostics; capsule installation and cache reuse are disabled on this host.');
    }
  }
  try {
    cachedRuntimeCompatibilityKey = runtimeCompatibilityKeyFor({ nodeMajor, abi, platform: process.platform, arch: process.arch, linuxLibc });
    return cachedRuntimeCompatibilityKey;
  } catch {
    fail('unsupported-libc', 'Linux libc could not be identified from Node runtime diagnostics; capsule installation and cache reuse are disabled on this host.');
  }
}

function fail(code: NonNullable<RuntimeCapsuleStatus['errorCode']>, message: string): never {
  const error = new Error(message);
  error.name = 'RuntimeCapsuleError';
  Object.assign(error, { code });
  throw error;
}

function validateDescriptor(input: RuntimeCapsuleDescriptor): RuntimeCapsuleDescriptor {
  if (!input || input.schemaVersion !== 1 || input.packageName !== RUNTIME_CAPSULE_PACKAGE
    || typeof input.version !== 'string' || !packagePattern.test(input.version)
    || typeof input.sha256 !== 'string' || !shaPattern.test(input.sha256)
    || !Array.isArray(input.files) || input.files.length === 0
    || input.files.some((file) => !file || typeof file.path !== 'string' || !/^(?:package\.json|npm-shrinkwrap\.json|LICENSE|THIRD_PARTY_NOTICES\.md|dist\/[A-Za-z0-9._/-]+)$/.test(file.path) || file.path.split('/').includes('..') || file.path.includes('\\') || typeof file.sha256 !== 'string' || !shaPattern.test(file.sha256))
    || new Set(input.files.map((file) => file.path)).size !== input.files.length
    || input.files.map((file) => file.path).join('\n') !== [...input.files].map((file) => file.path).sort().join('\n')
    || typeof input.url !== 'string') {
    fail('invalid-receipt', 'The pinned runtime capsule descriptor is malformed.');
  }
  let parsed: URL;
  try { parsed = new URL(input.url); } catch { return fail('invalid-receipt', 'The pinned runtime capsule location is malformed.'); }
  let localPath = '';
  if (parsed.protocol === 'file:') {
    try { localPath = fileURLToPath(parsed); } catch { return fail('invalid-receipt', 'The pinned runtime archive path is malformed.'); }
  }
  if (!['https:', 'file:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash
    || (parsed.protocol === 'file:' && !isAbsolute(localPath))) {
    fail('invalid-receipt', 'The pinned runtime capsule location uses an unsupported scheme.');
  }
  return input;
}

/** Read the descriptor generated from the release package manifest and verified runtime archive. */
export function getRuntimeCapsuleDescriptor(): RuntimeCapsuleDescriptor {
  try {
    const descriptorPath = fileURLToPath(new URL('./runtime-capsule.json', import.meta.url));
    const value = JSON.parse(readFileSync(descriptorPath, 'utf8')) as RuntimeCapsuleDescriptor;
    return validateDescriptor(value);
  } catch {
    fail('invalid-receipt', 'The release does not contain a generated runtime capsule descriptor. Rebuild the release artifacts.');
  }
}

function digestFrom(descriptor: RuntimeCapsuleDescriptor): string { return descriptor.sha256.slice('sha256:'.length); }
function defaultCacheDirectory(): string {
  const configured = process.env.DEMO_STUDIO_RUNTIME_CACHE_DIR;
  return resolve(configured || join(homedir(), '.cache', 'demo-studio', 'runtime-capsules'));
}
function capsuleName(descriptor: RuntimeCapsuleDescriptor): string { return runtimeCapsuleCacheName(descriptor.version, digestFrom(descriptor), runtimeCompatibilityKey()); }
function paths(options: RuntimeCapsuleOptions) {
  const descriptor = validateDescriptor(options.descriptor ?? getRuntimeCapsuleDescriptor());
  const cacheDirectory = resolve(options.cacheDirectory ?? defaultCacheDirectory());
  return { descriptor, cacheDirectory };
}

async function ensureOwnedDirectory(path: string): Promise<string> {
  try { await mkdir(path, { recursive: true, mode: 0o700 }); }
  catch { fail('unsafe-cache-path', 'The runtime cache directory could not be created.'); }
  const info = await lstat(path).catch(() => undefined);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) fail('unsafe-cache-path', 'The runtime cache path must be an owned directory, not a symlink.');
  try { await access(path, constants.R_OK | constants.W_OK | constants.X_OK); }
  catch { fail('unsafe-cache-path', 'The runtime cache directory is not accessible.'); }
  return realpath(path);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(tempPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await syncFileDescriptor(handle.fd);
    } finally { await handle.close(); }
    await rename(tempPath, path);
    if (process.platform !== 'win32') {
      const parent = await open(dirname(path), constants.O_RDONLY);
      try { await syncFileDescriptor(parent.fd); } finally { await parent.close(); }
    }
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function receiptIsValid(value: unknown, descriptor: RuntimeCapsuleDescriptor): value is AttemptReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Partial<AttemptReceipt>;
  const validTime = (value: unknown) => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
  try { validateDescriptor(receipt.descriptor as RuntimeCapsuleDescriptor); } catch { return false; }
  return Object.keys(receipt).every((key) => ['schemaVersion', 'descriptor', 'compatibilityKey', 'status', 'attemptId', 'startedAt', 'updatedAt', 'failureStage', 'errorCode'].includes(key))
    && receipt.schemaVersion === 1
    && receipt.descriptor?.packageName === descriptor.packageName
    && receipt.descriptor?.version === descriptor.version
    && receipt.descriptor?.sha256 === descriptor.sha256
    && JSON.stringify(receipt.descriptor?.files) === JSON.stringify(descriptor.files)
    && runtimeCompatibilityMatches(receipt.compatibilityKey, runtimeCompatibilityKey())
    && ['ready', 'installing', 'unknown-after-timeout', 'failed'].includes(receipt.status || '')
    && typeof receipt.attemptId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(receipt.attemptId)
    && validTime(receipt.startedAt) && validTime(receipt.updatedAt)
    && (receipt.failureStage === undefined || isFailureStage(receipt.failureStage))
    && ((receipt.status === 'ready' || receipt.status === 'installing') ? receipt.errorCode === undefined : receipt.errorCode !== undefined)
    && (receipt.errorCode === undefined || ['install-failed', 'integrity-mismatch', 'invalid-receipt', 'package-identity-mismatch', 'unsafe-cache-path'].includes(receipt.errorCode));
}

async function readReceipt(path: string, descriptor: RuntimeCapsuleDescriptor): Promise<AttemptReceipt | undefined> {
  const info = await lstat(path).catch((error) => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; fail('invalid-receipt', 'The runtime capsule receipt cannot be inspected.'); });
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink()) fail('invalid-receipt', 'The runtime capsule receipt must be a regular file.');
  let raw: string;
  try { raw = await readFile(path, 'utf8'); } catch { fail('invalid-receipt', 'The runtime capsule receipt cannot be read.'); }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { fail('invalid-receipt', 'The runtime capsule receipt is malformed.'); }
  if (!receiptIsValid(parsed, descriptor)) fail('invalid-receipt', 'The runtime capsule receipt does not match the pinned runtime identity.');
  return parsed;
}

async function verifyInstalled(cachePath: string, descriptor: RuntimeCapsuleDescriptor, attemptId: string): Promise<string | undefined> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attemptId)) return undefined;
  const attemptRoot = join(cachePath, 'attempts', attemptId);
  const archivePath = join(attemptRoot, 'runtime.tgz');
  const installRoot = join(attemptRoot, 'install');
  const runtimeRoot = join(installRoot, 'node_modules', ...descriptor.packageName.split('/'));
  const runtimeEntry = join(runtimeRoot, 'dist', 'runtime-cli.js');
  try {
    if (await realpath(cachePath) !== cachePath) return undefined;
    const attemptsPath = join(cachePath, 'attempts');
    const attemptsInfo = await lstat(attemptsPath);
    if (!attemptsInfo.isDirectory() || attemptsInfo.isSymbolicLink() || await realpath(attemptsPath) !== attemptsPath) return undefined;
    const attemptInfo = await lstat(attemptRoot);
    if (!attemptInfo.isDirectory() || attemptInfo.isSymbolicLink() || await realpath(attemptRoot) !== attemptRoot) return undefined;
    const archiveInfo = await lstat(archivePath);
    if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink()) return undefined;
    const archive = await readFile(archivePath);
    if (`sha256:${createHash('sha256').update(archive).digest('hex')}` !== descriptor.sha256) return undefined;
    const installComponents = [installRoot, join(installRoot, 'node_modules'), join(installRoot, 'node_modules', '@jbjmllc'), runtimeRoot];
    for (const component of installComponents) {
      const info = await lstat(component);
      if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
    }
    if (await realpath(runtimeRoot) !== runtimeRoot) return undefined;
    const manifest = JSON.parse(await readFile(join(runtimeRoot, 'package.json'), 'utf8')) as { name?: string; version?: string };
    if (manifest.name !== descriptor.packageName || manifest.version !== descriptor.version) return undefined;
    const expected = new Map(descriptor.files.map((file) => [file.path, file.sha256]));
    const actual = new Set<string>();
    const visit = async (directory: string, prefix: string): Promise<boolean> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const absolutePath = join(directory, entry.name);
        const info = await lstat(absolutePath);
        if (info.isSymbolicLink()) return false;
        if (info.isDirectory()) {
          if (!(await visit(absolutePath, relativePath))) return false;
          continue;
        }
        if (!info.isFile()) return false;
        actual.add(relativePath);
        const expectedHash = expected.get(relativePath);
        if (!expectedHash || `sha256:${createHash('sha256').update(await readFile(absolutePath)).digest('hex')}` !== expectedHash) return false;
      }
      return true;
    };
    if (!(await visit(runtimeRoot, '')) || actual.size !== expected.size || [...expected.keys()].some((path) => !actual.has(path))) return undefined;
    return runtimeEntry;
  } catch { return undefined; }
}

async function activePid(pid: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function readOwnerPid(path: string): Promise<number | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return undefined;
    const value = JSON.parse(await readFile(path, 'utf8')) as { schemaVersion?: unknown; pid?: unknown };
    return value.schemaVersion === 1 && Number.isSafeInteger(value.pid) ? value.pid as number : undefined;
  } catch { return undefined; }
}

async function readInstallLock(path: string, descriptor: RuntimeCapsuleDescriptor): Promise<{ attemptId: string; pid: number; startedAt: string } | undefined> {
  const info = await lstat(path).catch((error) => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; fail('invalid-receipt', 'The runtime installer lock cannot be inspected.'); });
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink()) fail('invalid-receipt', 'The runtime installer lock must be a regular file.');
  let value: unknown;
  try { value = JSON.parse(await readFile(path, 'utf8')); } catch { fail('invalid-receipt', 'The runtime installer lock is malformed.'); }
  if (!value || typeof value !== 'object') fail('invalid-receipt', 'The runtime installer lock is malformed.');
  const lock = value as { schemaVersion?: unknown; descriptor?: RuntimeCapsuleDescriptor; compatibilityKey?: unknown; attemptId?: unknown; pid?: unknown; startedAt?: unknown };
  const validTime = (time: unknown) => typeof time === 'string' && !Number.isNaN(Date.parse(time)) && new Date(time).toISOString() === time;
  try { validateDescriptor(lock.descriptor as RuntimeCapsuleDescriptor); } catch { fail('invalid-receipt', 'The runtime installer lock descriptor is malformed.'); }
  if (Object.keys(lock).some((key) => !['schemaVersion', 'descriptor', 'compatibilityKey', 'attemptId', 'pid', 'startedAt'].includes(key))
    || lock.schemaVersion !== 1 || lock.descriptor?.packageName !== descriptor.packageName || lock.descriptor.version !== descriptor.version
    || lock.descriptor.sha256 !== descriptor.sha256 || JSON.stringify(lock.descriptor.files) !== JSON.stringify(descriptor.files)
    || !runtimeCompatibilityMatches(lock.compatibilityKey, runtimeCompatibilityKey())
    || typeof lock.attemptId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(lock.attemptId)
    || !Number.isSafeInteger(lock.pid) || !validTime(lock.startedAt)) fail('invalid-receipt', 'The runtime installer lock does not match the pinned identity.');
  return { attemptId: lock.attemptId as string, pid: lock.pid as number, startedAt: lock.startedAt as string };
}

export async function getRuntimeCapsuleStatus(options: RuntimeCapsuleOptions = {}): Promise<RuntimeCapsuleStatus> {
  const { descriptor, cacheDirectory } = paths(options);
  const compatibilityKey = runtimeCompatibilityKey();
  let baseInfo;
  try { baseInfo = await lstat(cacheDirectory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, status: 'missing', descriptor, compatibilityKey, cachePath: join(cacheDirectory, capsuleName(descriptor)) };
    return { schemaVersion: 1, status: 'invalid', descriptor, compatibilityKey, cachePath: join(cacheDirectory, capsuleName(descriptor)), errorCode: 'unsafe-cache-path' };
  }
  const lexicalPath = join(cacheDirectory, capsuleName(descriptor));
  if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink()) return { schemaVersion: 1, status: 'invalid', descriptor, compatibilityKey, cachePath: lexicalPath, errorCode: 'unsafe-cache-path' };
  const canonicalCache = await realpath(cacheDirectory);
  const cachePath = join(canonicalCache, capsuleName(descriptor));
  const receiptPath = join(cachePath, 'status.json');
  let leaf;
  try { leaf = await lstat(cachePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, status: 'missing', descriptor, compatibilityKey, cachePath };
    return { schemaVersion: 1, status: 'invalid', descriptor, compatibilityKey, cachePath, errorCode: 'unsafe-cache-path' };
  }
  if (!leaf.isDirectory() || leaf.isSymbolicLink()) return { schemaVersion: 1, status: 'invalid', descriptor, compatibilityKey, cachePath, errorCode: 'unsafe-cache-path' };
  let receipt: AttemptReceipt | undefined;
  try { receipt = await readReceipt(receiptPath, descriptor); }
  catch { return { schemaVersion: 1, status: 'invalid', descriptor, compatibilityKey, cachePath, errorCode: 'invalid-receipt' }; }
  if (!receipt) {
    try {
      const lock = await readInstallLock(join(cachePath, 'install.lock'), descriptor);
      if (!lock) return { schemaVersion: 1, status: 'invalid', descriptor, compatibilityKey, cachePath, errorCode: 'invalid-receipt' };
      return { schemaVersion: 1, status: await activePid(lock.pid) ? 'installing' : 'unknown-after-timeout', descriptor, compatibilityKey, cachePath, attemptId: lock.attemptId };
    } catch { return { schemaVersion: 1, status: 'invalid', descriptor, compatibilityKey, cachePath, errorCode: 'invalid-receipt' }; }
  }
  if (receipt.status === 'installing') {
    const ownerPid = await readOwnerPid(join(cachePath, 'owner.json'));
    const lock = await readInstallLock(join(cachePath, 'install.lock'), descriptor).catch(() => undefined);
    if ((ownerPid !== undefined && await activePid(ownerPid)) || (lock !== undefined && await activePid(lock.pid))) {
      return { schemaVersion: 1, status: 'installing', descriptor, compatibilityKey, cachePath, attemptId: receipt.attemptId };
    }
    return { schemaVersion: 1, status: 'unknown-after-timeout', descriptor, compatibilityKey, cachePath, attemptId: receipt.attemptId };
  }
  if (receipt.status === 'ready') {
    const runtimeEntry = await verifyInstalled(cachePath, descriptor, receipt.attemptId);
    return runtimeEntry
      ? { schemaVersion: 1, status: 'ready', descriptor, compatibilityKey, cachePath, runtimeEntry, attemptId: receipt.attemptId }
      : { schemaVersion: 1, status: 'invalid', descriptor, compatibilityKey, cachePath, attemptId: receipt.attemptId, errorCode: 'integrity-mismatch' };
  }
  return { schemaVersion: 1, status: receipt.status, descriptor, compatibilityKey, cachePath, attemptId: receipt.attemptId, failureStage: receipt.failureStage, errorCode: receipt.errorCode };
}

async function resolveArchive(descriptor: RuntimeCapsuleDescriptor, archivePath: string, timeoutMs: number): Promise<void> {
  const expected = descriptor.sha256;
  const parsed = new URL(descriptor.url);
  if (parsed.protocol === 'file:') {
    const source = fileURLToPath(parsed);
    const info = await lstat(source).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_ARCHIVE_BYTES) fail('integrity-mismatch', 'The runtime archive path is not a regular bounded file.');
    await writeFile(archivePath, await readFile(source), { flag: 'wx', mode: 0o600 });
  } else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(descriptor.url, { redirect: 'follow', signal: controller.signal, headers: { accept: 'application/octet-stream' } });
      if (!response.ok || !response.body) fail('install-failed', 'The pinned runtime archive could not be downloaded.');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let byteLength = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        byteLength += value.byteLength;
        if (byteLength > MAX_ARCHIVE_BYTES) {
          await reader.cancel().catch(() => undefined);
          fail('integrity-mismatch', 'The runtime archive exceeds the configured size bound.');
        }
        chunks.push(value);
      }
      const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), byteLength);
      await writeFile(archivePath, bytes, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as Error).name === 'AbortError') fail('install-failed', 'Runtime archive download timed out.');
      if ((error as { code?: string }).code) throw error;
      fail('install-failed', 'The pinned runtime archive could not be downloaded.');
    } finally { clearTimeout(timer); }
  }
  const bytes = await readFile(archivePath);
  if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== expected) fail('integrity-mismatch', 'The runtime archive digest does not match its pinned descriptor.');
  verifyArchiveRole(bytes, descriptor);
}

function tarString(block: Buffer, start: number, end: number): string {
  const field = block.subarray(start, end);
  const terminator = field.indexOf(0);
  return field.subarray(0, terminator < 0 ? field.length : terminator).toString('utf8');
}

function tarOctal(block: Buffer, start: number, end: number): number {
  const value = block.subarray(start, end).toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]+$/.test(value)) throw new Error('invalid-tar-size');
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('invalid-tar-size');
  return parsed;
}

function verifyArchiveRole(bytes: Buffer, descriptor: RuntimeCapsuleDescriptor): void {
  let tar: Buffer;
  try { tar = gunzipSync(bytes, { maxOutputLength: MAX_ARCHIVE_BYTES }); }
  catch { fail('integrity-mismatch', 'The runtime archive is not a bounded valid gzip tarball.'); }
  const expected = new Map(descriptor.files.map((file) => [`package/${file.path}`, file.sha256]));
  const found = new Set<string>();
  let packageManifest: { name?: unknown; version?: unknown; dependencies?: unknown } | undefined;
  let offset = 0;
  try {
    while (offset + 512 <= tar.length) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) break;
      const name = tarString(header, 0, 100);
      const prefix = tarString(header, 345, 500);
      const archivePath = prefix ? `${prefix}/${name}` : name;
      const type = header[156];
      if (type !== 0 && type !== 48) fail('integrity-mismatch', 'The runtime archive contains unsupported filesystem entries.');
      if (!archivePath || archivePath.startsWith('/') || archivePath.includes('\\') || archivePath.split('/').includes('..') || found.has(archivePath)) fail('integrity-mismatch', 'The runtime archive contains an unsafe or duplicate path.');
      const length = tarOctal(header, 124, 136);
      if (length > MAX_ARCHIVE_BYTES || offset + 512 + Math.ceil(length / 512) * 512 > tar.length) fail('integrity-mismatch', 'The runtime archive has an invalid bounded entry size.');
      const content = tar.subarray(offset + 512, offset + 512 + length);
      const expectedHash = expected.get(archivePath);
      if (!expectedHash || `sha256:${createHash('sha256').update(content).digest('hex')}` !== expectedHash) fail('integrity-mismatch', 'The runtime archive contents do not match the pinned file inventory.');
      found.add(archivePath);
      if (archivePath === 'package/package.json') packageManifest = JSON.parse(content.toString('utf8')) as typeof packageManifest;
      offset += 512 + Math.ceil(length / 512) * 512;
    }
  } catch (error) {
    if ((error as { code?: string }).code) throw error;
    fail('integrity-mismatch', 'The runtime archive tar index is malformed.');
  }
  if (found.size !== expected.size || [...expected.keys()].some((path) => !found.has(path))) fail('integrity-mismatch', 'The runtime archive does not contain the exact pinned file inventory.');
  if (!packageManifest || packageManifest.name !== descriptor.packageName || packageManifest.version !== descriptor.version || !packageManifest.dependencies || typeof packageManifest.dependencies !== 'object') {
    fail('package-identity-mismatch', 'The runtime archive package identity or dependency manifest is not valid.');
  }
  const lockHash = expected.get('package/npm-shrinkwrap.json');
  if (!lockHash) fail('integrity-mismatch', 'The runtime archive does not include its locked dependency graph.');
  const lockEntry = [...expected.keys()].find((path) => path === 'package/npm-shrinkwrap.json');
  if (!lockEntry) fail('integrity-mismatch', 'The runtime archive does not include its locked dependency graph.');
  const lockFile = tarFileContent(tar, lockEntry);
  let shrinkwrap: { name?: unknown; version?: unknown; packages?: Record<string, { name?: unknown; version?: unknown; dependencies?: unknown }> };
  try { shrinkwrap = JSON.parse(lockFile.toString('utf8')) as typeof shrinkwrap; }
  catch { fail('integrity-mismatch', 'The runtime archive dependency lock is malformed.'); }
  const rootLock = shrinkwrap.packages?.[''];
  if (shrinkwrap.name !== descriptor.packageName || shrinkwrap.version !== descriptor.version || rootLock?.name !== descriptor.packageName || rootLock.version !== descriptor.version || JSON.stringify(rootLock.dependencies) !== JSON.stringify(packageManifest.dependencies)) {
    fail('package-identity-mismatch', 'The runtime archive dependency lock does not match its package role and version.');
  }
}

function tarFileContent(tar: Buffer, requestedPath: string): Buffer {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 500);
    const archivePath = prefix ? `${prefix}/${name}` : name;
    const length = tarOctal(header, 124, 136);
    if (archivePath === requestedPath) return tar.subarray(offset + 512, offset + 512 + length);
    offset += 512 + Math.ceil(length / 512) * 512;
  }
  fail('integrity-mismatch', 'A pinned runtime archive entry is missing.');
}

function tokenizeNodeOptions(value: string): string[] {
  const segments: string[] = [];
  let token = '';
  let quote: '"' | "'" | '' = '';
  let escaped = false;
  for (const char of value) {
    if (escaped) { token += char; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ''; else token += char; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/\s/.test(char)) { if (token) { segments.push(token); token = ''; } continue; }
    token += char;
  }
  if (escaped || quote) fail('invalid-receipt', 'NODE_OPTIONS contains malformed quoting; runtime launch was refused.');
  if (token) segments.push(token);
  return segments;
}

function isPnpPreload(value: string): boolean {
  const normalized = value.replaceAll('\\', '/').toLowerCase();
  const base = normalized.split('/').at(-1);
  return base === '.pnp.cjs' || base === '.pnp.loader.mjs';
}

/** Remove only Yarn PnP's own preload hooks; preserve every unrelated caller option. */
export function isolatedRuntimeEnvironment(input: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...input };
  const source = input.NODE_OPTIONS;
  if (!source) return env;
  const segments = tokenizeNodeOptions(source);
  const kept: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const token = segments[index];
    if (token === '--require' || token === '-r' || token === '--import' || token === '--loader' || token === '--experimental-loader') {
      const value = segments[index + 1];
      if (value && isPnpPreload(value)) { index += 1; continue; }
    }
    const match = token.match(/^(--require|--import|--loader|--experimental-loader)=(.+)$/);
    if (match && isPnpPreload(match[2])) continue;
    kept.push(token);
  }
  env.NODE_OPTIONS = kept.map((token) => /\s/.test(token) ? JSON.stringify(token) : token).join(' ');
  return env;
}

/** Prepare only the owned npm-install child; --ignore-scripts remains explicit on its command. */
export function runtimeInstallerEnvironment(input: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = isolatedRuntimeEnvironment(input);
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key];
  }
  return env;
}

function runNpmInstall(prefix: string, archive: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('npm', ['install', '--prefix', prefix, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', archive], {
      env,
      cwd: prefix,
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch { /* preserve unknown outcome below */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* process may already be gone */ } }, 2_000).unref();
    }, timeoutMs);
    child.once('error', () => { clearTimeout(timer); rejectRun(new Error('npm-install-failed')); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) rejectRun(Object.assign(new Error('install-timeout'), { code: 'unknown-after-timeout' }));
      else if (code === 0) resolveRun();
      else rejectRun(new Error('npm-install-failed'));
    });
  });
}

async function loadHistory(cachePath: string): Promise<Array<Record<string, unknown>>> {
  const historyPath = join(cachePath, 'attempts', 'index.json');
  try {
    const value = JSON.parse(await readFile(historyPath, 'utf8')) as unknown;
    const validTime = (time: unknown) => typeof time === 'string' && !Number.isNaN(Date.parse(time)) && new Date(time).toISOString() === time;
    const validAttempt = (entry: unknown) => {
      if (!entry || typeof entry !== 'object') return false;
      const record = entry as Record<string, unknown>;
      const hasCompleted = Object.hasOwn(record, 'completedAt');
      return Object.keys(record).every((key) => ['attemptId', 'status', 'startedAt', 'completedAt', 'failureStage', 'errorCode'].includes(key))
        && typeof record.attemptId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.attemptId)
        && ['installing', 'ready', 'failed', 'unknown-after-timeout'].includes(String(record.status))
        && validTime(record.startedAt)
        && (hasCompleted ? validTime(record.completedAt) : record.status === 'installing')
        && (record.failureStage === undefined || isFailureStage(record.failureStage))
        && (record.errorCode === undefined || ['install-failed', 'integrity-mismatch', 'invalid-receipt', 'package-identity-mismatch', 'unsafe-cache-path'].includes(String(record.errorCode)));
    };
    if (!Array.isArray(value) || value.some((entry) => !validAttempt(entry)) || new Set(value.map((entry) => (entry as { attemptId: string }).attemptId)).size !== value.length) fail('invalid-receipt', 'The runtime capsule attempt history is malformed.');
    return value as Array<Record<string, unknown>>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function install(options: RuntimeCapsuleOptions, retryStatus?: RuntimeCapsuleStatus['status']): Promise<RuntimeCapsuleStatus> {
  const { descriptor, cacheDirectory } = paths(options);
  const canonicalCache = await ensureOwnedDirectory(cacheDirectory);
  const canonicalPath = join(canonicalCache, capsuleName(descriptor));
  const existing = await getRuntimeCapsuleStatus({ ...options, descriptor, cacheDirectory: canonicalCache });
  if (existing.status === 'ready') return existing;
  if (existing.status === 'installing') fail('invalid-receipt', 'A runtime capsule installation is already in progress.');
  if (existing.status !== 'missing' && retryStatus !== existing.status) {
    fail(existing.status === 'invalid' ? 'invalid-receipt' : 'install-failed', `Runtime capsule status is ${existing.status}; use explicit reconciliation before retrying.`);
  }
  await mkdir(canonicalPath, { recursive: true, mode: 0o700 });
  const leafInfo = await lstat(canonicalPath);
  if (!leafInfo.isDirectory() || leafInfo.isSymbolicLink()) fail('unsafe-cache-path', 'The runtime capsule cache entry must be a real directory.');
  const lockPath = join(canonicalPath, 'install.lock');
  const attemptId = randomUUID();
  const startedAt = new Date().toISOString();
  const compatibilityKey = runtimeCompatibilityKey();
  const receipt: AttemptReceipt = { schemaVersion: 1, descriptor, compatibilityKey, status: 'installing', attemptId, startedAt, updatedAt: startedAt };
  let failureStage: RuntimeCapsuleFailureStage = 'lock-persistence';
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch {
    if (!retryStatus) fail('invalid-receipt', 'A runtime capsule installer lock already exists; inspect status before continuing.');
    const stale = await readInstallLock(lockPath, descriptor);
    if (!stale) fail('invalid-receipt', 'The previous runtime installer lock is malformed; inspect it before recovery.');
    if (await activePid(stale.pid)) fail('invalid-receipt', 'A runtime capsule installer is still active.');
    const historyDirectory = join(canonicalPath, 'attempts');
    await mkdir(historyDirectory, { recursive: true, mode: 0o700 });
    const historyDirectoryInfo = await lstat(historyDirectory);
    if (!historyDirectoryInfo.isDirectory() || historyDirectoryInfo.isSymbolicLink()) fail('unsafe-cache-path', 'The runtime attempts directory must be a real directory.');
    await rename(lockPath, join(historyDirectory, `stale-lock-${randomUUID()}.json`));
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch { fail('invalid-receipt', 'A runtime capsule installer lock was acquired concurrently.'); }
  }
  const receiptPath = join(canonicalPath, 'status.json');
  const attemptsPath = join(canonicalPath, 'attempts');
  try {
    await lock.writeFile(JSON.stringify({ schemaVersion: 1, descriptor, compatibilityKey, attemptId, pid: process.pid, startedAt }));
    await syncFileDescriptor(lock.fd);
    const afterLock = await getRuntimeCapsuleStatus({ ...options, descriptor, cacheDirectory: canonicalCache });
    if (afterLock.status === 'ready') return afterLock;
    const isOwnFreshLock = afterLock.status === 'installing' && afterLock.attemptId === attemptId;
    if (!isOwnFreshLock && afterLock.status !== 'missing' && afterLock.status !== retryStatus) {
      fail('invalid-receipt', `Runtime capsule status changed to ${afterLock.status} while acquiring the installer lock.`);
    }
    failureStage = 'attempt-journal';
    await mkdir(attemptsPath, { recursive: true, mode: 0o700 });
    const attemptDirectoryInfo = await lstat(attemptsPath);
    if (!attemptDirectoryInfo.isDirectory() || attemptDirectoryInfo.isSymbolicLink()) fail('unsafe-cache-path', 'The runtime attempts directory must be a real directory.');
    const attemptRoot = join(attemptsPath, attemptId);
    await mkdir(attemptRoot, { recursive: false, mode: 0o700 });
    const attemptRootInfo = await lstat(attemptRoot);
    if (!attemptRootInfo.isDirectory() || attemptRootInfo.isSymbolicLink()) fail('unsafe-cache-path', 'The runtime attempt directory must be a new real directory.');
    const history = await loadHistory(canonicalPath);
    history.push({ attemptId, status: 'installing', startedAt });
    await writeJsonAtomic(join(attemptsPath, `${attemptId}.json`), receipt);
    await writeJsonAtomic(join(attemptsPath, 'index.json'), history);
    await writeJsonAtomic(receiptPath, receipt);
    await writeJsonAtomic(join(canonicalPath, 'owner.json'), { schemaVersion: 1, attemptId, pid: process.pid, startedAt });
    await lock.close();

    const archivePath = join(attemptRoot, 'runtime.tgz');
    failureStage = 'archive-acquisition';
    await resolveArchive(descriptor, archivePath, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const installRoot = join(attemptRoot, 'install');
    await mkdir(installRoot, { recursive: false, mode: 0o700 });
    failureStage = 'npm-install';
    await runNpmInstall(installRoot, archivePath, runtimeInstallerEnvironment(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    failureStage = 'post-install-validation';
    const runtimeEntry = await verifyInstalled(canonicalPath, descriptor, attemptId);
    if (!runtimeEntry) fail('package-identity-mismatch', 'Installed runtime capsule identity or bytes do not match the pinned descriptor.');
    const ready: AttemptReceipt = { ...receipt, status: 'ready', updatedAt: new Date().toISOString() };
    const updatedHistory = await loadHistory(canonicalPath);
    const last = updatedHistory.at(-1);
    if (last?.attemptId === attemptId) updatedHistory[updatedHistory.length - 1] = { attemptId, status: 'ready', startedAt, completedAt: ready.updatedAt };
    failureStage = 'completion-journal';
    await writeJsonAtomic(join(attemptsPath, `${attemptId}.json`), ready);
    await writeJsonAtomic(join(attemptsPath, 'index.json'), updatedHistory);
    await writeJsonAtomic(receiptPath, ready);
    await access(runtimeEntry, constants.R_OK);
    return { schemaVersion: 1, status: 'ready', descriptor, compatibilityKey, cachePath: canonicalPath, runtimeEntry, attemptId };
  } catch (error) {
    const unknown = (error as { code?: string }).code === 'unknown-after-timeout';
    const errorCode = (error as { code?: RuntimeCapsuleStatus['errorCode'] }).code;
    const failedStatus: AttemptReceipt = { ...receipt, status: unknown ? 'unknown-after-timeout' : 'failed', updatedAt: new Date().toISOString(), failureStage, ...(errorCode && ['install-failed', 'integrity-mismatch', 'invalid-receipt', 'package-identity-mismatch', 'unsafe-cache-path'].includes(errorCode) ? { errorCode } : { errorCode: 'install-failed' }) };
    await writeJsonAtomic(join(attemptsPath, `${attemptId}.json`), failedStatus).catch(() => undefined);
    const history = await loadHistory(canonicalPath).catch(() => []);
    const last = history.at(-1);
    if (last?.attemptId === attemptId) history[history.length - 1] = { attemptId, status: failedStatus.status, startedAt, completedAt: failedStatus.updatedAt, failureStage, errorCode: failedStatus.errorCode };
    await writeJsonAtomic(join(attemptsPath, 'index.json'), history).catch(() => undefined);
    await writeJsonAtomic(receiptPath, failedStatus).catch(() => undefined);
    return { schemaVersion: 1, status: failedStatus.status, descriptor, compatibilityKey, cachePath: canonicalPath, attemptId, failureStage, errorCode: failedStatus.errorCode };
  } finally {
    await lock?.close().catch(() => undefined);
    await rename(lockPath, join(canonicalPath, `install-${attemptId}.lock.receipt`)).catch(() => undefined);
    await writeJsonAtomic(join(canonicalPath, 'owner.json'), { schemaVersion: 1, attemptId, pid: -1, completedAt: new Date().toISOString() }).catch(() => undefined);
  }
}

/** Install only from the pinned descriptor. Failed or uncertain attempts require explicit reconciliation. */
export async function installRuntimeCapsule(options: RuntimeCapsuleOptions = {}): Promise<RuntimeCapsuleStatus> {
  return install(options);
}

/** Explicitly create a new attempt after inspecting the durable prior attempt. */
export async function reconcileRuntimeCapsule(options: RuntimeCapsuleReconcileOptions): Promise<RuntimeCapsuleStatus> {
  const current = await getRuntimeCapsuleStatus(options);
  const allowed = options.action === 'retry-failed-stage' ? 'failed' : 'unknown-after-timeout';
  if (current.status !== allowed) fail('invalid-receipt', `Reconciliation does not apply to current status ${current.status}.`);
  return install(options, allowed);
}

async function readyEntry(options: RuntimeCapsuleOptions): Promise<string> {
  const status = await getRuntimeCapsuleStatus(options);
  if (status.status !== 'ready' || !status.runtimeEntry) fail('install-failed', `Runtime capsule is ${status.status}; install the pinned capsule before launching runtime commands.`);
  return status.runtimeEntry;
}

async function launchRuntimeCommand(args: string[], options: RuntimeCapsuleOptions & { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: StdioOptions } = {}): Promise<ChildProcess> {
  const entry = await readyEntry(options);
  return spawn(process.execPath, [entry, ...args], {
    cwd: options.cwd ?? process.cwd(),
    env: isolatedRuntimeEnvironment(options.env ?? process.env),
    stdio: options.stdio ?? 'inherit',
    windowsHide: true,
  });
}

/** Launch the installed MCP server with Yarn's project PnP hooks removed only from this owned child. */
export async function launchRuntimeMcp(options: RuntimeCapsuleOptions & { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: StdioOptions } = {}): Promise<ChildProcess> {
  return launchRuntimeCommand(['mcp'], options);
}

/** Used by the thin CLI for non-MCP runtime commands; the public client boundary is launchRuntimeMcp. */
export async function launchRuntimeCli(args: string[], options: RuntimeCapsuleOptions & { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: StdioOptions } = {}): Promise<ChildProcess> {
  return launchRuntimeCommand(args, options);
}

/** Construct a descriptor for an explicitly selected local artifact; callers must provide its expected digest. */
export function descriptorForLocalArchive(base: RuntimeCapsuleDescriptor, archivePath: string, sha256: string): RuntimeCapsuleDescriptor {
  if (!shaPattern.test(sha256) || !isAbsolute(archivePath)) fail('invalid-receipt', 'An explicit absolute archive path and SHA-256 are required.');
  return validateDescriptor({ ...base, sha256: sha256 as `sha256:${string}`, url: pathToFileURL(resolve(archivePath)).href });
}

export function runtimeCapsuleKey(descriptor: RuntimeCapsuleDescriptor): string {
  validateDescriptor(descriptor);
  return capsuleName(descriptor);
}
