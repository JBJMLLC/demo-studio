import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareNarration, reconcileNarrationPending } from '../src/narration.js';
import { computeWordingApprovalHash, planSchema, type DemoPlan } from '../src/schemas.js';
import { sha256Of, writeJsonAtomic } from '../src/store.js';

const scratchDirectories: string[] = [];
afterEach(() => { for (const directory of scratchDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'demo-studio-narration-'));
  scratchDirectories.push(directory);
  return directory;
}

function ffmpeg(args: string[]): void {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', timeout: 20_000 });
  if (result.error || result.status !== 0) throw new Error(`ffmpeg fixture generation failed: ${result.stderr}`);
}

function narratedPlan(provider: 'supplied' | 'voicebox', audioFiles?: Record<string, string>): DemoPlan {
  const value = {
    schemaVersion: 1 as const, id: 'narration-plan', title: 'A narrated example', product: 'Example', audience: 'People', outcome: 'Learn a flow',
    mode: 'narrated' as const, targetUrl: 'http://127.0.0.1:4300/', viewport: { width: 640, height: 360 },
    presentation: { cursor: 'pointer' as const, captions: true }, duration: { hardLimit: false },
    narrator: provider === 'supplied' ? { provider, audioFiles: audioFiles ?? {} } : { provider, profileId: 'local-profile', baseUrl: 'http://127.0.0.1:17493' },
    scenes: [{ id: 'intro', before: '', during: '', after: '', say: 'A measured sentence.', learn: '', next: '', holdMs: 0, actions: [], assertions: [] }],
    wordingApproval: { sha256: '' },
  };
  value.wordingApproval = { sha256: computeWordingApprovalHash(value as DemoPlan) };
  return planSchema.parse(value);
}

function withVoiceboxEnvironment<T>(callback: () => Promise<T>): Promise<T> {
  const previousUrl = process.env.DEMO_STUDIO_VOICEBOX_URL;
  const previousProfile = process.env.DEMO_STUDIO_VOICEBOX_PROFILE_ID;
  process.env.DEMO_STUDIO_VOICEBOX_URL = 'http://127.0.0.1:17493';
  process.env.DEMO_STUDIO_VOICEBOX_PROFILE_ID = 'local-profile';
  return callback().finally(() => {
    if (previousUrl === undefined) delete process.env.DEMO_STUDIO_VOICEBOX_URL;
    else process.env.DEMO_STUDIO_VOICEBOX_URL = previousUrl;
    if (previousProfile === undefined) delete process.env.DEMO_STUDIO_VOICEBOX_PROFILE_ID;
    else process.env.DEMO_STUDIO_VOICEBOX_PROFILE_ID = previousProfile;
  });
}

async function serve(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not listen');
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
}

describe('narration preparation and reconciliation', () => {
  it.each(['/generate', '/history/generation-123', '/audio/generation-123'])('never follows Voicebox redirects from %s or silently repeats submitted speech', async (redirectPath) => {
    const root = scratch();
    const missionDirectory = join(root, 'mission');
    mkdirSync(missionDirectory, { recursive: true });
    let outsideRequests = 0, generations = 0;
    const outside = createServer((_request, response) => { outsideRequests++; response.end('not permitted'); });
    const outsideUrl = await serve(outside);
    const local = createServer((request, response) => {
      if (request.url === '/generate') generations++;
      if (request.url === redirectPath) { response.writeHead(307, { location: `${outsideUrl}/destination` }); response.end(); return; }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ id: 'generation-123', profile_id: 'local-profile', text: 'A measured sentence.', status: request.url === '/generate' && redirectPath.includes('/history/') ? 'pending' : 'completed' }));
    });
    const localUrl = await serve(local);
    try {
      await withVoiceboxEnvironment(async () => {
        process.env.DEMO_STUDIO_VOICEBOX_URL = localUrl;
        const plan = narratedPlan('voicebox');
        await expect(prepareNarration(plan, missionDirectory, { wait: async () => undefined })).rejects.toMatchObject({ name: 'ExternalOutcomeUnknownError' });
        await expect(prepareNarration(plan, missionDirectory)).rejects.toMatchObject({ name: 'ExternalOutcomeUnknownError' });
      });
      expect(generations).toBe(1);
      expect(outsideRequests).toBe(0);
    } finally { await closeServer(local); await closeServer(outside); }
  });

  it.each(['/history/generation-123', '/audio/generation-123'])('keeps reconciliation unknown without following redirects from %s', async (redirectPath) => {
    const missionDirectory = scratch();
    writeJsonAtomic(join(missionDirectory, 'narration-pending/intro.json'), {
      schemaVersion: 1, provider: 'voicebox', inputHash: sha256Of('input'), generationId: 'generation-123', profileId: 'local-profile',
      sceneId: 'intro', textSha256: sha256Of('A measured sentence.'), outputPath: 'narration/intro.wav',
    });
    let outsideRequests = 0;
    const outside = createServer((_request, response) => { outsideRequests++; response.end(); });
    const outsideUrl = await serve(outside);
    const local = createServer((request, response) => {
      if (request.url === redirectPath) { response.writeHead(308, { location: `${outsideUrl}/destination` }); response.end(); return; }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ id: 'generation-123', profile_id: 'local-profile', text: 'A measured sentence.', status: 'completed' }));
    });
    const baseUrl = await serve(local);
    try {
      expect((await reconcileNarrationPending(missionDirectory, 'intro', { baseUrl })).status).toBe('unknown');
      expect(outsideRequests).toBe(0);
      expect(readFileSync(join(missionDirectory, 'narration-pending/intro.json'), 'utf8')).toContain('generation-123');
    } finally { await closeServer(local); await closeServer(outside); }
  });

  it('hashes supplied source bytes before cache reuse and rejects paths outside the plan directory', async () => {
    const root = scratch();
    const planDirectory = join(root, 'plans');
    const missionDirectory = join(root, 'mission');
    mkdirSync(planDirectory, { recursive: true });
    mkdirSync(missionDirectory, { recursive: true });
    const audioPath = join(planDirectory, 'speech.wav');
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=660:duration=0.7', '-c:a', 'pcm_s16le', audioPath]);
    const plan = narratedPlan('supplied', { intro: 'speech.wav' });
    const first = await prepareNarration(plan, missionDirectory, { sourceDirectory: planDirectory });
    const same = await prepareNarration(plan, missionDirectory, { sourceDirectory: planDirectory });
    expect(same.tracks[0]?.sha256).toBe(first.tracks[0]?.sha256);
    expect(same.tracks[0]?.path).toBe(first.tracks[0]?.path);

    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=910:duration=0.7', '-c:a', 'pcm_s16le', audioPath]);
    const changed = await prepareNarration(plan, missionDirectory, { sourceDirectory: planDirectory });
    expect(changed.tracks[0]?.sha256).not.toBe(first.tracks[0]?.sha256);
    expect(changed.tracks[0]?.path).not.toBe(first.tracks[0]?.path);

    const escapingPlan = narratedPlan('supplied', { intro: '../outside.wav' });
    await expect(prepareNarration(escapingPlan, missionDirectory, { sourceDirectory: planDirectory })).rejects.toThrow(/stay within the plan directory/);
  }, 30_000);

  it('uses documented Voicebox request fields without overriding profile engine or changing approved text', async () => {
    const root = scratch();
    const missionDirectory = join(root, 'mission');
    mkdirSync(missionDirectory, { recursive: true });
    const sourceAudio = join(root, 'fixture.wav');
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.6', '-c:a', 'pcm_s16le', sourceAudio]);
    const originalFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> | undefined;
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/generate')) {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ id: 'generation-123', profile_id: 'local-profile', text: 'A measured sentence.', status: 'completed' });
      }
      if (url.endsWith('/audio/generation-123')) return new Response(readFileSync(sourceAudio), { status: 200, headers: { 'content-type': 'audio/wav' } });
      throw new Error('Unexpected mocked Voicebox URL');
    };
    globalThis.fetch = fetchMock;
    try {
      const result = await withVoiceboxEnvironment(() => prepareNarration(narratedPlan('voicebox'), missionDirectory));
      expect(result.tracks).toHaveLength(1);
      expect(requestBody).toMatchObject({ profile_id: 'local-profile', text: 'A measured sentence.', language: 'en', personality: false, effects_chain: [], normalize: true });
      expect(requestBody).not.toHaveProperty('engine');
      expect(requestBody).not.toHaveProperty('model_size');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 30_000);

  it('refuses uncertain Voicebox reconciliation unless response ID, profile, and exact text hash match', async () => {
    const root = scratch();
    const missionDirectory = join(root, 'mission');
    mkdirSync(join(missionDirectory, 'narration'), { recursive: true });
    const sourceAudio = join(root, 'fixture.wav');
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', '-c:a', 'pcm_s16le', sourceAudio]);
    const text = 'A measured sentence.';
    const pending = {
      schemaVersion: 1, provider: 'voicebox', inputHash: sha256Of('input'), generationId: 'generation-123', profileId: 'local-profile',
      sceneId: 'intro', textSha256: sha256Of(text), outputPath: 'narration/intro.wav',
    };
    writeJsonAtomic(join(missionDirectory, 'narration-pending/intro.json'), pending);
    const mismatch = await reconcileNarrationPending(missionDirectory, 'intro', {
      baseUrl: 'http://127.0.0.1:17493',
      fetchImpl: async () => Response.json({ id: 'different-id', profile_id: 'local-profile', text, status: 'completed' }),
    });
    expect(mismatch.status).toBe('unknown');
    expect(readFileSync(join(missionDirectory, 'narration-pending/intro.json'), 'utf8')).toContain('generation-123');

    const matched = await reconcileNarrationPending(missionDirectory, 'intro', {
      baseUrl: 'http://127.0.0.1:17493',
      fetchImpl: async (input) => String(input).endsWith('/history/generation-123')
        ? Response.json({ id: 'generation-123', profile_id: 'local-profile', text, status: 'completed' })
        : new Response(readFileSync(sourceAudio), { status: 200, headers: { 'content-type': 'audio/wav' } }),
    });
    expect(matched.status).toBe('complete');
  }, 30_000);
});
