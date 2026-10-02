import { access } from 'node:fs/promises';
import { chromium } from 'playwright';
import { runBinary } from './media.js';

export type DoctorCheck = { requirement: string; status: 'pass' | 'fail' | 'skipped'; remedy?: string };
export async function doctor(options: { browser?: boolean; renderer?: boolean; narration?: 'supplied' | 'voicebox' | 'elevenlabs' } = {}) {
  const checks: DoctorCheck[] = [{ requirement: 'node', status: Number(process.versions.node.split('.')[0]) >= 22 ? 'pass' : 'fail', remedy: 'Install Node.js 22 or newer.' }];
  for (const binary of options.renderer === false ? [] : ['ffmpeg', 'ffprobe']) {
    try { await runBinary(binary, ['-version'], 5000); checks.push({ requirement: binary, status: 'pass' }); }
    catch { checks.push({ requirement: binary, status: 'fail', remedy: 'Install FFmpeg and expose its binaries on PATH.' }); }
  }
  if (options.browser !== false) {
    try { await access(chromium.executablePath()); const browser = await chromium.launch({ headless: true }); await browser.close(); checks.push({ requirement: 'chromium', status: 'pass' }); }
    catch { checks.push({ requirement: 'chromium', status: 'fail', remedy: 'Run npx playwright install chromium (Linux may also need install-deps).' }); }
  }
  if (options.narration === 'elevenlabs') {
    let valid = false;
    try { const origin = new URL(process.env.DEMO_STUDIO_ELEVENLABS_BASE_URL ?? 'https://api.elevenlabs.io'); valid = Boolean(process.env.ELEVENLABS_API_KEY && process.env.DEMO_STUDIO_ELEVENLABS_VOICE_ID) && origin.protocol === 'https:' && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash; } catch { /* invalid configuration */ }
    checks.push({ requirement: 'elevenlabs-configuration', status: valid ? 'pass' : 'fail', remedy: 'Set your own ELEVENLABS_API_KEY and DEMO_STUDIO_ELEVENLABS_VOICE_ID. If configured, DEMO_STUDIO_ELEVENLABS_BASE_URL must be a plain HTTPS origin. Never commit credentials.' });
  }
  if (options.narration === 'voicebox') {
    const base = process.env.DEMO_STUDIO_VOICEBOX_URL;
    try { if (!base || !process.env.DEMO_STUDIO_VOICEBOX_PROFILE_ID) throw new Error(); const origin = new URL(base); if (origin.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error(); const response = await fetch(new URL('/health', origin), { signal: AbortSignal.timeout(5000), redirect: 'error' }); checks.push({ requirement: 'voicebox', status: response.ok ? 'pass' : 'fail', remedy: 'Start your locally configured Voicebox service.' }); }
    catch { checks.push({ requirement: 'voicebox', status: 'fail', remedy: 'Start your locally configured Voicebox service and configure DEMO_STUDIO_VOICEBOX_URL and DEMO_STUDIO_VOICEBOX_PROFILE_ID.' }); }
  }
  return { schemaVersion: 1, ready: checks.every((check) => check.status !== 'fail'), checks };
}
