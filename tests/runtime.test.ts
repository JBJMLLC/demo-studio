import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { prepare } from '../src/mission.js';
import { generateDemo, runtimeFingerprint } from '../src/runtime.js';

it('refuses generation from a preparation made with a different runtime implementation', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'demo-studio-runtime-test-'));
  const receipt = await prepare(resolve('examples/quickstart/plan.json'), directory, {
    actorId: 'test-producer', runtimeProfile: 'older-implementation',
    checkTargetReady: () => ({ ready: true, evidenceHash: `sha256:${'a'.repeat(64)}` }),
  });
  expect(runtimeFingerprint()).toMatch(/^playwright-remotion-native-v1:[a-f0-9]{64}$/);
  await expect(generateDemo(receipt.missionId, directory, 'test-producer')).rejects.toThrow('Runtime changed');
  await expect(generateDemo(`demo-${'0'.repeat(24)}`, directory, 'test-producer')).rejects.toThrow('preparation is missing');
});
