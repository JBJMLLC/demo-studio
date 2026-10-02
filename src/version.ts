import { readFileSync } from 'node:fs';

const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
if (typeof metadata.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version)) {
  throw new Error('Package version metadata is invalid.');
}

export const packageVersion = metadata.version;
