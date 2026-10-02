import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { DemoPlan, NarratorConfig, NarrationResult, NarrationTrack } from './schemas.js';
import { narrationResultSchema, narrationTrackSchema } from './schemas.js';
import { ExternalOutcomeUnknownError, missionPath, readJson, sha256Of, writeJsonAtomic } from './store.js';

const maxProviderRequestMs = 120_000;
const maxProviderWaitMs = 120_000;
const maxProviderResponseBytes = 32 * 1024 * 1024;

interface NarrationReceipt {
  schemaVersion: 1;
  inputHash: string;
  result: NarrationResult;
}

interface PendingNarrationReceipt {
  schemaVersion: 1;
  provider: 'voicebox' | 'elevenlabs';
  inputHash: string;
  generationId?: string;
  profileId?: string;
  sceneId: string;
  textSha256: string;
  outputPath: string;
}

export interface NarrationReconciliationResult {
  status: 'complete' | 'pending' | 'unknown' | 'failed';
  sceneId: string;
}

interface NarrationTrackReceipt {
  schemaVersion: 1;
  inputHash: string;
  track: NarrationTrack;
}

export interface NarrationOptions {
  sourceDirectory?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  wait?: (milliseconds: number) => Promise<void>;
}

export function prepareNarration(plan: DemoPlan, missionDirectory: string, options: NarrationOptions = {}): Promise<NarrationResult> {
  return prepareNarrationInner(plan, missionDirectory, options);
}

/** Read-only provider reconciliation; Voicebox generation IDs can be inspected without resubmitting speech. */
export async function reconcileNarrationPending(
  missionDirectory: string,
  sceneId: string,
  options: Pick<NarrationOptions, 'fetchImpl' | 'now'> & { baseUrl?: string } = {},
): Promise<NarrationReconciliationResult> {
  const pendingPath = join(missionDirectory, 'narration-pending', `${sceneId}.json`);
  if (!existsSync(pendingPath)) return { status: 'unknown', sceneId };
  let pending: PendingNarrationReceipt;
  try { pending = readJson<PendingNarrationReceipt>(pendingPath); } catch { return { status: 'unknown', sceneId }; }
  if (pending.schemaVersion !== 1 || pending.sceneId !== sceneId || !pending.inputHash || !pending.textSha256 || !pending.outputPath) {
    return { status: 'unknown', sceneId };
  }
  if (pending.provider !== 'voicebox' || !pending.generationId || !pending.profileId) return { status: 'unknown', sceneId };
  const configuredBaseUrl = options.baseUrl ?? process.env.DEMO_STUDIO_VOICEBOX_URL;
  if (!configuredBaseUrl) return { status: 'unknown', sceneId };
  let base: URL;
  try { base = new URL(configuredBaseUrl); } catch { return { status: 'unknown', sceneId }; }
  if (base.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
    || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    return { status: 'unknown', sceneId };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${base.origin}/history/${encodeURIComponent(pending.generationId)}`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  } catch {
    return { status: 'unknown', sceneId };
  }
  if (!response.ok) return { status: response.status >= 500 ? 'pending' : 'unknown', sceneId };
  let state: unknown;
  try { state = await response.json(); } catch { return { status: 'unknown', sceneId }; }
  if (!isObject(state) || typeof state.status !== 'string'
    || state.id !== pending.generationId || typeof state.text !== 'string'
    || sha256Of(state.text) !== pending.textSha256 || state.profile_id !== pending.profileId) {
    return { status: 'unknown', sceneId };
  }
  if (['loading_model', 'pending', 'queued', 'generating'].includes(state.status)) return { status: 'pending', sceneId };
  if (state.status !== 'completed') return { status: 'failed', sceneId };
  try { response = await fetchImpl(`${base.origin}/audio/${encodeURIComponent(pending.generationId)}`, { redirect: 'error', signal: AbortSignal.timeout(10_000) }); }
  catch { return { status: 'unknown', sceneId }; }
  if (!response.ok) return { status: response.status >= 500 ? 'pending' : 'unknown', sceneId };
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.byteLength < 12 || audio.byteLength > maxProviderResponseBytes
    || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') return { status: 'unknown', sceneId };
  let outputPath: string;
  try { outputPath = missionPath(missionDirectory, pending.outputPath); }
  catch { return { status: 'unknown', sceneId }; }
  writePrivateFile(outputPath, audio);
  const durationMs = probeDurationMs(outputPath);
  if (durationMs === null) return { status: 'unknown', sceneId };
  const track: NarrationTrack = {
    sceneId,
    path: pending.outputPath,
    durationMs,
    sha256: sha256Of(audio),
    textSha256: pending.textSha256,
  };
  writeJsonAtomic(join(missionDirectory, 'narration-cache', `${sceneId}.json`), {
    schemaVersion: 1,
    inputHash: pending.inputHash,
    track,
  } satisfies NarrationTrackReceipt);
  unlinkSync(pendingPath);
  return { status: 'complete', sceneId };
}

/** Quarantine only the exact unreceipted mission output, then permit an explicitly requested retry. */
export function authorizeNarrationRetry(missionDirectory: string, sceneId: string, at = new Date()): void {
  const pendingPath = join(missionDirectory, 'narration-pending', `${sceneId}.json`);
  const pending = readJson<PendingNarrationReceipt>(pendingPath);
  if (pending.schemaVersion !== 1 || pending.sceneId !== sceneId || !pending.outputPath) throw new Error('Unknown narration receipt cannot be reconciled');
  const outputPath = missionPath(missionDirectory, pending.outputPath);
  if (existsSync(outputPath)) {
    const quarantineDirectory = join(missionDirectory, 'narration-quarantine');
    mkdirSync(quarantineDirectory, { recursive: true, mode: 0o700 });
    const extension = extname(outputPath) || '.audio';
    renameSync(outputPath, join(quarantineDirectory, `${sceneId}-${at.getTime()}${extension}`));
  }
  unlinkSync(pendingPath);
}

async function prepareNarrationInner(plan: DemoPlan, missionDirectory: string, options: NarrationOptions): Promise<NarrationResult> {
  if (plan.mode !== 'narrated' || !plan.narrator) return narrationResultSchema.parse({ provider: 'supplied', tracks: [] });
  const provider = plan.narrator.provider;
  const sourceDirectory = resolve(options.sourceDirectory ?? missionDirectory);
  const tracksDirectory = join(missionDirectory, 'narration');
  mkdirSync(tracksDirectory, { recursive: true, mode: 0o700 });
  const suppliedSourceHashes: Record<string, string> = {};
  const suppliedSourcePaths: Record<string, string> = {};
  if (provider === 'supplied') {
    const sourceRoot = realpathSync(sourceDirectory);
    for (const scene of plan.scenes.filter((candidate) => candidate.say.trim())) {
      const inputPath = plan.narrator.audioFiles?.[scene.id];
      if (!inputPath) throw new Error('A narrated scene is missing its supplied audio file');
      const absoluteSource = resolve(sourceDirectory, inputPath);
      if (!isContained(sourceDirectory, absoluteSource)) throw new Error('Supplied audio file must stay within the plan directory');
      let sourceStat;
      try { sourceStat = statSync(absoluteSource); } catch { throw new Error('Supplied audio file is missing or inaccessible'); }
      if (!sourceStat.isFile() || sourceStat.size <= 0 || sourceStat.size > maxProviderResponseBytes) {
        throw new Error('Supplied audio file is not a supported regular file');
      }
      const actualPath = realpathSync(absoluteSource);
      if (!isContained(sourceRoot, actualPath)) throw new Error('Supplied audio symlink must stay within the plan directory');
      suppliedSourcePaths[scene.id] = actualPath;
      suppliedSourceHashes[scene.id] = sha256Of(readFileSync(actualPath));
    }
  }
  const inputHash = sha256Of(JSON.stringify({
    wording: plan.scenes.map(({ id, say }) => ({ id, say })),
    provider,
    voiceId: process.env.DEMO_STUDIO_ELEVENLABS_VOICE_ID ?? plan.narrator.voiceId ?? null,
    profileId: process.env.DEMO_STUDIO_VOICEBOX_PROFILE_ID ?? plan.narrator.profileId ?? null,
    baseUrl: process.env.DEMO_STUDIO_VOICEBOX_URL ?? plan.narrator.baseUrl ?? process.env.DEMO_STUDIO_ELEVENLABS_BASE_URL ?? null,
    suppliedSourceHashes: provider === 'supplied' ? suppliedSourceHashes : undefined,
  }));
  const receiptPath = join(missionDirectory, 'narration-cache.json');
  const cached = readValidNarrationCache(receiptPath, inputHash, missionDirectory);
  if (cached) return cached;

  const fetchImpl = options.fetchImpl ?? fetch;
  const tracks: NarrationTrack[] = [];
  for (const scene of plan.scenes) {
    if (!scene.say.trim()) continue;
    const textSha256 = sha256Of(scene.say);
    const extension = provider === 'supplied'
      ? safeAudioExtension(plan.narrator.audioFiles?.[scene.id])
      : provider === 'voicebox' ? '.wav' : '.mp3';
    const sourcePath = provider === 'supplied' && plan.narrator.audioFiles?.[scene.id]
      ? suppliedSourcePaths[scene.id]
      : undefined;
    const sourceHash = sourcePath ? suppliedSourceHashes[scene.id] ?? null : null;
    const trackInputHash = sha256Of(JSON.stringify({ inputHash, sceneId: scene.id, textSha256, sourceHash }));
    const outputName = `${scene.id}-${trackInputHash.slice(7, 19)}${extension}`;
    const outputRelative = `narration/${outputName}`;
    const outputPath = resolve(missionDirectory, outputRelative);
    const trackReceiptPath = join(missionDirectory, 'narration-cache', `${scene.id}.json`);
    const cachedTrack = readValidTrackCache(trackReceiptPath, trackInputHash, missionDirectory);
    if (cachedTrack) {
      tracks.push(cachedTrack);
      continue;
    }
    const pendingDirectory = join(missionDirectory, 'narration-pending');
    const pendingPath = join(pendingDirectory, `${scene.id}.json`);
    if (existsSync(pendingPath)) throw new ExternalOutcomeUnknownError('narration');
    if (provider !== 'supplied' && existsSync(outputPath)) throw new ExternalOutcomeUnknownError('narration');
    let bytes: Buffer;
    if (provider === 'supplied') {
      const suppliedPath = plan.narrator.audioFiles?.[scene.id];
      if (!suppliedPath) throw new Error('A narrated scene is missing its supplied audio file');
      const absoluteSource = sourcePath!;
      let sourceStat;
      try { sourceStat = statSync(absoluteSource); } catch { throw new Error('Supplied audio file is missing or inaccessible'); }
      if (!sourceStat.isFile() || sourceStat.size <= 0 || sourceStat.size > maxProviderResponseBytes) {
        throw new Error('Supplied audio file is not a supported regular file');
      }
      const temporary = `${outputPath}.tmp-${process.pid}`;
      copyFileSync(absoluteSource, temporary);
      renameSync(temporary, outputPath);
      bytes = readFileSync(outputPath);
    } else if (provider === 'elevenlabs') {
      mkdirSync(pendingDirectory, { recursive: true, mode: 0o700 });
      writeJsonAtomic(pendingPath, { schemaVersion: 1, provider, sceneId: scene.id, textSha256, outputPath: outputRelative, inputHash: trackInputHash } satisfies PendingNarrationReceipt);
      try {
        bytes = await synthesizeElevenLabs(scene.say, plan.narrator, fetchImpl);
        writePrivateFile(outputPath, bytes);
      } catch (error) {
        if (!(error instanceof ExternalOutcomeUnknownError)) unlinkSync(pendingPath);
        throw error;
      }
    } else {
      mkdirSync(pendingDirectory, { recursive: true, mode: 0o700 });
      writeJsonAtomic(pendingPath, { schemaVersion: 1, provider, sceneId: scene.id, textSha256, outputPath: outputRelative, inputHash: trackInputHash } satisfies PendingNarrationReceipt);
      try {
        bytes = await synthesizeVoicebox(scene.id, scene.say, textSha256, trackInputHash, outputPath, missionDirectory, plan.narrator, fetchImpl, options.wait);
      } catch (error) {
        if (!(error instanceof ExternalOutcomeUnknownError)) unlinkSync(pendingPath);
        throw error;
      }
    }
    const durationMs = probeDurationMs(outputPath);
    if (durationMs === null) throw new Error('Narration audio duration could not be verified');
    const track = { sceneId: scene.id, path: outputRelative, durationMs, sha256: sha256Of(bytes), textSha256 };
    writeJsonAtomic(trackReceiptPath, { schemaVersion: 1, inputHash: trackInputHash, track } satisfies NarrationTrackReceipt);
    if (existsSync(pendingPath)) unlinkSync(pendingPath);
    tracks.push(track);
  }
  const result = narrationResultSchema.parse({ provider, tracks });
  writeJsonAtomic(receiptPath, { schemaVersion: 1, inputHash, result } satisfies NarrationReceipt);
  return result;
}

function readValidNarrationCache(path: string, inputHash: string, missionDirectory: string): NarrationResult | null {
  if (!existsSync(path)) return null;
  let receipt: NarrationReceipt;
  try { receipt = readJson<NarrationReceipt>(path); } catch { throw new Error('Narration cache receipt is malformed; explicit recovery is required'); }
  if (receipt.schemaVersion !== 1 || receipt.inputHash !== inputHash) return null;
  let result: NarrationResult;
  try { result = narrationResultSchema.parse(receipt.result); } catch { throw new Error('Narration cache receipt is malformed; explicit recovery is required'); }
  for (const track of result.tracks) {
    let path: string;
    try { path = missionPath(missionDirectory, track.path, true); } catch { return null; }
    if (!existsSync(path)) return null;
    if (sha256Of(readFileSync(path)) !== track.sha256 || probeDurationMs(path) !== track.durationMs) return null;
  }
  return result;
}

function readValidTrackCache(path: string, inputHash: string, missionDirectory: string): NarrationTrack | null {
  if (!existsSync(path)) return null;
  let receipt: NarrationTrackReceipt;
  try { receipt = readJson<NarrationTrackReceipt>(path); } catch { throw new Error('Narration track receipt is malformed; explicit recovery is required'); }
  if (receipt.schemaVersion !== 1 || receipt.inputHash !== inputHash) return null;
  let track: NarrationTrack;
  try { track = narrationTrackSchema.parse(receipt.track); } catch { throw new Error('Narration track receipt is malformed; explicit recovery is required'); }
  let audioPath: string;
  try { audioPath = missionPath(missionDirectory, track.path, true); } catch { return null; }
  if (!existsSync(audioPath)) return null;
  if (sha256Of(readFileSync(audioPath)) !== track.sha256 || probeDurationMs(audioPath) !== track.durationMs) {
    throw new Error('Narration cache audio does not match its receipt; explicit recovery is required');
  }
  return track;
}

async function synthesizeElevenLabs(text: string, config: NarratorConfig, fetchImpl: typeof fetch): Promise<Buffer> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.DEMO_STUDIO_ELEVENLABS_VOICE_ID ?? config.voiceId;
  const base = process.env.DEMO_STUDIO_ELEVENLABS_BASE_URL ?? 'https://api.elevenlabs.io';
  if (!apiKey || !voiceId) throw new Error('ElevenLabs narration requires ELEVENLABS_API_KEY and DEMO_STUDIO_ELEVENLABS_VOICE_ID');
  let endpoint: URL;
  try {
    const origin = new URL(base);
    if (origin.pathname !== '/' || origin.search || origin.hash) throw new Error();
    endpoint = new URL(`/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps`, origin);
  }
  catch { throw new Error('ElevenLabs base URL configuration is invalid'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
    throw new Error('ElevenLabs base URL must be HTTPS and must not contain credentials');
  }
  endpoint.searchParams.set('output_format', 'mp3_44100_128');
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', 'xi-api-key': apiKey },
      body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { speed: 1 } }),
      signal: AbortSignal.timeout(maxProviderRequestMs),
    });
  } catch {
    throw new ExternalOutcomeUnknownError('narration');
  }
  if (!response.ok) {
    if (response.status === 408 || response.status >= 500) throw new ExternalOutcomeUnknownError('narration');
    throw new Error(`ElevenLabs narration request was rejected (HTTP ${response.status})`);
  }
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new ExternalOutcomeUnknownError('narration'); }
  if (typeof payload !== 'object' || payload === null || !('audio_base64' in payload) || typeof payload.audio_base64 !== 'string') {
    throw new ExternalOutcomeUnknownError('narration');
  }
  const audio = Buffer.from(payload.audio_base64, 'base64');
  if (audio.byteLength === 0 || audio.byteLength > maxProviderResponseBytes) throw new ExternalOutcomeUnknownError('narration');
  return audio;
}

async function synthesizeVoicebox(
  sceneId: string,
  text: string,
  textSha256: string,
  inputHash: string,
  outputPath: string,
  missionDirectory: string,
  config: NarratorConfig,
  fetchImpl: typeof fetch,
  waitImpl?: (milliseconds: number) => Promise<void>,
): Promise<Buffer> {
  const baseUrl = process.env.DEMO_STUDIO_VOICEBOX_URL ?? config.baseUrl;
  const profileId = process.env.DEMO_STUDIO_VOICEBOX_PROFILE_ID ?? config.profileId;
  if (!baseUrl || !profileId) throw new Error('Voicebox narration requires DEMO_STUDIO_VOICEBOX_URL and DEMO_STUDIO_VOICEBOX_PROFILE_ID');
  let endpoint: URL;
  try { endpoint = new URL(baseUrl); } catch { throw new Error('Voicebox URL configuration is invalid'); }
  if (endpoint.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error('Voicebox must be configured as a plain loopback HTTP origin');
  }
  const origin = endpoint.origin;
  const safeFetch = (url: string | URL, init?: RequestInit) => fetchImpl(url, {
    ...init,
    redirect: 'error',
    signal: init?.signal ?? AbortSignal.timeout(maxProviderRequestMs),
  });

  let response: Response;
  try {
    response = await safeFetch(`${origin}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    // Leave engine/model_size unset so Voicebox applies the selected profile's
    // supported defaults. Never allow profile personality rewrites or effects
    // to alter approved wording or change its timing.
    body: JSON.stringify({ profile_id: profileId, text, language: 'en', personality: false, effects_chain: [], normalize: true }),
    });
  } catch {
    throw new ExternalOutcomeUnknownError('narration');
  }
  if (!response.ok) {
    if (response.status === 408 || response.status >= 500) throw new ExternalOutcomeUnknownError('narration');
    throw new Error(`Voicebox narration request was rejected (HTTP ${response.status})`);
  }
  let generation: unknown;
  try { generation = await response.json(); } catch { throw new ExternalOutcomeUnknownError('narration'); }
  if (!isObject(generation) || typeof generation.id !== 'string' || typeof generation.status !== 'string'
    || generation.text !== text || generation.profile_id !== profileId) {
    throw new ExternalOutcomeUnknownError('narration');
  }
  const generationId = generation.id;
  const pendingDirectory = join(missionDirectory, 'narration-pending');
  mkdirSync(pendingDirectory, { recursive: true, mode: 0o700 });
  const pendingPath = join(pendingDirectory, `${sceneId}.json`);
  writeJsonAtomic(pendingPath, {
    schemaVersion: 1,
    provider: 'voicebox',
    inputHash,
    generationId,
    profileId,
    sceneId,
    textSha256,
    outputPath: relativeFromMission(missionDirectory, outputPath),
  } satisfies PendingNarrationReceipt);

  const wait = waitImpl ?? ((duration: number) => new Promise<void>((resolveWait) => setTimeout(resolveWait, duration)));
  const endAt = Date.now() + maxProviderWaitMs;
  let state = generation;
  const active = new Set(['loading_model', 'pending', 'queued', 'generating']);
  while (active.has(String((state as Record<string, unknown>).status))) {
    if (Date.now() >= endAt) throw new ExternalOutcomeUnknownError('narration');
    await wait(500);
    try { response = await safeFetch(`${origin}/history/${encodeURIComponent(generationId)}`); }
    catch { throw new ExternalOutcomeUnknownError('narration'); }
    if (!response.ok) {
      if (response.status === 408 || response.status >= 500) throw new ExternalOutcomeUnknownError('narration');
      throw new Error(`Voicebox status request failed (HTTP ${response.status})`);
    }
    try { state = await response.json(); } catch { throw new ExternalOutcomeUnknownError('narration'); }
    if (!isObject(state) || typeof state.status !== 'string') throw new ExternalOutcomeUnknownError('narration');
  }
  if (state.status !== 'completed') throw new Error('Voicebox narration generation failed');
  try { response = await safeFetch(`${origin}/audio/${encodeURIComponent(generationId)}`); }
  catch { throw new ExternalOutcomeUnknownError('narration'); }
  if (!response.ok) {
    if (response.status === 408 || response.status >= 500) throw new ExternalOutcomeUnknownError('narration');
    throw new Error(`Voicebox audio export failed (HTTP ${response.status})`);
  }
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.byteLength < 12 || audio.byteLength > maxProviderResponseBytes
    || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
    throw new ExternalOutcomeUnknownError('narration');
  }
  writePrivateFile(outputPath, audio);
  return audio;
}

function writePrivateFile(path: string, bytes: Buffer): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, bytes, { mode: 0o600, flag: 'wx' });
  renameSync(temporaryPath, path);
}

function probeDurationMs(path: string): number | null {
  const result = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path], {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  const seconds = Number(result.stdout.trim());
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1_000) : null;
}

function safeAudioExtension(sourcePath: string | undefined): string {
  const extension = sourcePath ? extname(sourcePath).toLowerCase() : '';
  return ['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.flac'].includes(extension) ? extension : '.audio';
}

function isContained(root: string, child: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function relativeFromMission(root: string, child: string): string {
  const rel = relative(resolve(root), resolve(child));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Audio path escapes its mission directory');
  return rel.replaceAll('\\', '/');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
