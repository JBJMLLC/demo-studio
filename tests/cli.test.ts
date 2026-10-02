import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('runs the installed-style command through a symlink with a different filename', () => {
  const directory = mkdtempSync(join(tmpdir(), 'demo-studio-cli-'));
  const command = join(directory, 'demo-studio');
  try {
    symlinkSync(resolve('src/cli.ts'), command);
    const result = spawnSync(process.execPath, ['--import', 'tsx', command, 'help'], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('demo-studio v0.1.0');
    const doctor = spawnSync(process.execPath, ['--import', 'tsx', command, 'doctor', '--skills-only'], { encoding: 'utf8', timeout: 10_000 });
    expect(doctor.status).toBe(0);
    expect(JSON.parse(doctor.stdout).ready).toBe(true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 25_000);

it('can be imported from a stdin module without running the CLI', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-'], {
    input: 'import "./src/cli.ts"; console.log("imported");', encoding: 'utf8', timeout: 10_000,
  });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe('imported');
}, 15_000);
