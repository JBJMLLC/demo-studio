import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const packageUrl = import.meta.resolve('@jbjmllc/demo-studio');
const studioEntry = fileURLToPath(packageUrl);
const studio = await import(packageUrl);
assert.equal(typeof studio.createMcpServer, 'function', 'The public package entrypoint must import under Yarn PnP.');
assert.equal(typeof studio.planSchema?.parse, 'function', 'The public schema export must import under Yarn PnP.');
process.stdout.write('Public package import passed.\n');

const require = createRequire(import.meta.url);
const pnp = require('pnpapi');
const sdkEntry = fileURLToPath(import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'));
const sdkLocator = pnp.findPackageLocator(sdkEntry);
assert(sdkLocator, 'Yarn PnP must identify the installed SDK package.');
const sdkInfo = pnp.getPackageInformation(sdkLocator);
const sdkManifest = JSON.parse(await readFile(join(sdkInfo.packageLocation, 'package.json'), 'utf8'));
const zodEntry = createRequire(sdkEntry).resolve('zod/v3');
const zodLocator = pnp.findPackageLocator(zodEntry);
assert(zodLocator, 'Yarn PnP must identify the Zod version actually resolved for the SDK.');
const zodInfo = pnp.getPackageInformation(zodLocator);
const zodManifest = JSON.parse(await readFile(join(zodInfo.packageLocation, 'package.json'), 'utf8'));
assert(semver.satisfies(zodManifest.version, sdkManifest.peerDependencies.zod),
  `Resolved Zod ${zodManifest.version} does not satisfy the SDK peer range ${sdkManifest.peerDependencies.zod}.`);
process.stdout.write(`Resolved Zod ${zodManifest.version} satisfies SDK peer ${sdkManifest.peerDependencies.zod}.\n`);

const packageManifest = JSON.parse(await readFile(join(dirname(studioEntry), '..', 'package.json'), 'utf8'));
const client = new Client({ name: 'demo-studio-yarn-pnp-smoke', version: packageManifest.version });
const server = studio.createMcpServer();
process.stdout.write('MCP server instance created.\n');
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
process.stdout.write('MCP server transport connected.\n');
await client.connect(clientTransport);
process.stdout.write('MCP client connected.\n');
try {
  const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
  for (const name of ['demo_doctor', 'demo_prepare', 'demo_generate', 'demo_status', 'demo_cleanup', 'demo_preview', 'demo_review', 'demo_reconcile']) {
    assert(names.has(name), `The installed MCP server did not advertise ${name}.`);
  }
} finally {
  await client.close();
  await server.close();
}
