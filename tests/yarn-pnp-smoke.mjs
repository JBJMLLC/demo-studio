import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const yarnVersion = '4.12.0';
const archive = process.argv[2] ? resolve(process.argv[2]) : undefined;
if (!archive) throw new Error('Pass the production npm archive path.');

const run = (command, args, cwd, env) => {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const diagnostic = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(-12_000);
    throw new Error(`${command} ${args[0]} failed with exit ${result.status}:\n${diagnostic}`);
  }
  return result.stdout ?? '';
};

const packageManifestFromArchive = (compressed) => {
  const tar = gunzipSync(compressed);
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/s, '');
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/s, '');
    const memberName = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(header.toString('ascii', 124, 136).replace(/\0.*$/s, '').trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Production archive contains an invalid tar member size.');
    const start = offset + 512;
    if (memberName === 'package/package.json') return JSON.parse(tar.toString('utf8', start, start + size));
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new Error('Production archive does not contain package/package.json.');
};

const directory = await realpath(await mkdtemp(join(tmpdir(), 'demo-studio-yarn-pnp-')));
const cache = join(directory, '.yarn', 'cache');
const environment = { ...process.env, YARN_ENABLE_GLOBAL_CACHE: 'false', YARN_CACHE_FOLDER: cache };
const packageManifest = packageManifestFromArchive(await readFile(archive));
const dependencies = packageManifest.dependencies;
if (!dependencies?.['@modelcontextprotocol/sdk'] || !dependencies.zod || !dependencies['zod-to-json-schema'] || !dependencies.react || !dependencies['react-dom']) {
  throw new Error('Production archive is missing declared MCP/Zod/React dependencies.');
}
const manifest = {
  name: 'demo-studio-yarn-pnp-smoke',
  private: true,
  type: 'module',
  packageManager: `yarn@${yarnVersion}`,
  dependencies: {
    '@jbjmllc/demo-studio': `file:${archive}`,
    '@modelcontextprotocol/sdk': dependencies['@modelcontextprotocol/sdk'],
    react: dependencies.react,
    'react-dom': dependencies['react-dom'],
    semver: '7.7.2',
    zod: dependencies.zod,
    'zod-to-json-schema': dependencies['zod-to-json-schema'],
  },
};

try {
  await writeFile(join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(directory, '.yarnrc.yml'), 'nodeLinker: pnp\n', { mode: 0o600 });
  run('corepack', [`yarn@${yarnVersion}`, 'install'], directory, environment);
  await writeFile(join(directory, 'smoke.mjs'), await readFile(new URL('./yarn-pnp-consumer.mjs', import.meta.url), 'utf8'), { mode: 0o600 });
  run('corepack', [`yarn@${yarnVersion}`, 'node', 'smoke.mjs'], directory, environment);
  process.stdout.write(`Yarn PnP archive import, SDK/Zod peer compatibility, and MCP tool discovery passed (${yarnVersion}).\n`);
} finally {
  if (process.env.DEMO_STUDIO_KEEP_YARN_PNP === '1') process.stderr.write(`Retained temporary consumer: ${directory}\n`);
  else await rm(directory, { recursive: true, force: true });
}
