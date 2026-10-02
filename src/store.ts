import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export class MissionBusyError extends Error {
  constructor() {
    super('Mission is already being modified by another process');
    this.name = 'MissionBusyError';
  }
}

export class MalformedReceiptError extends Error {
  constructor() {
    super('Mission receipt is malformed; preserve it for explicit recovery');
    this.name = 'MalformedReceiptError';
  }
}

export class ExternalOutcomeUnknownError extends Error {
  constructor(stage: string) {
    super(`The ${stage} request may have completed, but its result was not durably observed`);
    this.name = 'ExternalOutcomeUnknownError';
  }
}

export function sha256Of(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function sha256OfJson(value: unknown): string {
  return sha256Of(JSON.stringify(value));
}

export function sha256OfFile(path: string): string {
  return sha256Of(readFileSync(path));
}

export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function writeJsonAtomic(path: string, value: unknown): void {
  const parent = dirname(path);
  ensurePrivateDirectory(parent);
  const temporaryPath = join(parent, `.tmp-${randomUUID()}`);
  const fd = openSync(temporaryPath, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporaryPath, path);
    try {
      const dirFd = openSync(parent, 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch {
      // Some filesystems do not permit syncing directory handles; the file is still atomically renamed.
    }
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* Preserve the original failure. */ }
    throw error;
  }
}

export function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    throw new MalformedReceiptError();
  }
}

/** Resolve only paths owned by one mission; reject absolute paths and traversal. */
export function missionPath(missionDirectory: string, artifactPath: string, mustExist = false): string {
  if (artifactPath.length === 0 || artifactPath.includes('\0') || isAbsolute(artifactPath)) {
    throw new Error('Artifact path must be relative to its mission directory');
  }
  const root = resolve(missionDirectory);
  const candidate = resolve(root, artifactPath);
  const rel = relative(root, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Artifact path escapes its mission directory');
  }

  if (mustExist) {
    let realRoot: string;
    let realCandidate: string;
    try {
      realRoot = realpathSync(root);
      realCandidate = realpathSync(candidate);
    } catch {
      throw new Error('Artifact file is missing or inaccessible');
    }
    const realRelative = relative(realRoot, realCandidate);
    if (realRelative === '..' || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) {
      throw new Error('Artifact symlink escapes its mission directory');
    }
    if (!statSync(realCandidate).isFile()) throw new Error('Artifact path is not a regular file');
  }

  return candidate;
}

export function assertRelativeFile(path: string): string {
  if (!path || isAbsolute(path) || path.includes('\0')) throw new Error('Adapter artifact paths must be relative');
  const normalized = resolve('.', path);
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) throw new Error('Adapter artifact path escapes the working directory');
  return path.replaceAll('\\', '/');
}

export function missionDirectory(workDirectory: string, missionId: string): string {
  if (!/^demo-[a-f0-9]{24}$/.test(missionId)) throw new Error('Invalid mission ID');
  return resolve(workDirectory, 'missions', missionId);
}

export function missionReceiptPath(workDirectory: string, missionId: string): string {
  return join(missionDirectory(workDirectory, missionId), 'mission.json');
}

export async function withMissionLock<T>(directory: string, operation: () => Promise<T> | T): Promise<T> {
  ensurePrivateDirectory(directory);
  const lockPath = join(directory, '.lock');
  const token = randomUUID();
  const payload = JSON.stringify({ token, pid: process.pid, host: hostname(), startedAt: new Date().toISOString() });
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
  } catch {
    if (removeStaleLock(lockPath)) {
      try { fd = openSync(lockPath, 'wx', 0o600); }
      catch { throw new MissionBusyError(); }
    } else {
      throw new MissionBusyError();
    }
  }
  try {
    writeFileSync(fd, payload, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  try {
    return await operation();
  } finally {
    try {
      const current = readFileSync(lockPath, 'utf8');
      if (current === payload) unlinkSync(lockPath);
    } catch {
      // A missing or changed lock is not ours to remove.
    }
  }
}

export function missionLockState(directory: string): 'none' | 'live' | 'stale' | 'unknown' {
  const lockPath = join(directory, '.lock');
  if (!existsSync(lockPath)) return 'none';
  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown; host?: unknown };
    if (typeof lock.pid !== 'number' || typeof lock.host !== 'string') {
      return statSync(lockPath).mtimeMs < Date.now() - 60_000 ? 'stale' : 'unknown';
    }
    if (lock.host !== hostname()) return 'live';
    try {
      process.kill(lock.pid, 0);
      return 'live';
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM') return 'live';
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') return 'stale';
      return 'unknown';
    }
  } catch {
    try { return statSync(lockPath).mtimeMs < Date.now() - 60_000 ? 'stale' : 'unknown'; }
    catch { return 'none'; }
  }
}

function removeStaleLock(path: string): boolean {
  if (missionLockState(dirname(path)) !== 'stale') return false;
  try {
    const beforeStat = statSync(path);
    const beforeContent = readFileSync(path, 'utf8');
    if (missionLockState(dirname(path)) !== 'stale') return false;
    const afterStat = statSync(path);
    const afterContent = readFileSync(path, 'utf8');
    if (beforeStat.dev !== afterStat.dev || beforeStat.ino !== afterStat.ino || beforeContent !== afterContent) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
