export type LinuxLibcFamily = 'glibc' | 'musl' | 'unknown';

export interface LinuxLibcIdentity {
  family: LinuxLibcFamily;
  version?: string;
}

export interface RuntimeCompatibilityIdentity {
  nodeMajor: string;
  abi: string;
  platform: string;
  arch: string;
  linuxLibc?: LinuxLibcIdentity;
}

const glibcVersionPattern = /^\d+(?:\.\d+)+$/;

/** Reduce only the two process-report signals npm uses for GNU/musl selection. */
export function detectLinuxLibcIdentity(glibcVersionRuntime: unknown, sharedObjects: unknown): LinuxLibcIdentity {
  if (typeof glibcVersionRuntime === 'string' && glibcVersionPattern.test(glibcVersionRuntime)) {
    return { family: 'glibc', version: glibcVersionRuntime };
  }

  if (Array.isArray(sharedObjects) && sharedObjects.some((objectPath) => typeof objectPath === 'string'
    && (objectPath.includes('libc.musl-') || objectPath.includes('ld-musl-')))) {
    return { family: 'musl' };
  }

  return { family: 'unknown' };
}

/**
 * Format a cache compatibility identity. Linux without a proven libc family
 * deliberately has no reusable identity; it must not collide with GNU or musl.
 */
export function runtimeCompatibilityKeyFor(identity: RuntimeCompatibilityIdentity): string {
  const base = `node${identity.nodeMajor}-abi${identity.abi}-${identity.platform}-${identity.arch}`;
  if (identity.platform !== 'linux') return base;

  const libc = identity.linuxLibc;
  if (libc?.family === 'glibc' && libc.version && glibcVersionPattern.test(libc.version)) {
    return `${base}-libc-glibc-${libc.version}`;
  }
  if (libc?.family === 'musl' && libc.version === undefined) return `${base}-libc-musl`;
  throw new Error('Linux libc identity is unknown; refusing to reuse a runtime capsule cache.');
}

export function runtimeCapsuleCacheName(version: string, digest: string, compatibilityKey: string): string {
  return `${version}-${digest}-${compatibilityKey}`;
}

export function runtimeCompatibilityMatches(receiptKey: unknown, currentKey: string): boolean {
  return typeof receiptKey === 'string' && receiptKey === currentKey;
}
