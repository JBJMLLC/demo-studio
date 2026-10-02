#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';
import { resolve } from 'node:path';
import { doctor } from './doctor.js';
import { prepareDemo, generateDemo, getStatus, cleanup, submitReview, reconcile } from './runtime.js';
import { missionDirectory, missionPath, readJson } from './store.js';
import type { ReviewSubmission } from './contracts.js';
import { packageVersion } from './version.js';

const path = z.string().min(1).max(4096);
const missionId = z.string().regex(/^demo-[a-f0-9]{24}$/);
const actor = z.string().min(1).max(256).default('demo-studio-producer');
const work = { workDir: path.default('.demo-studio') };
const output = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });

export function createMcpServer() {
  const server = new Server({ name: 'demo-studio', version: packageVersion }, { capabilities: { tools: {} } });
  const jobs = new Map<string, Promise<unknown>>();
  const definitions: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; annotations?: { readOnlyHint: boolean } }> = [];
  const handlers = new Map<string, (input: unknown) => Promise<ReturnType<typeof output>>>();
  const registerTool = <S extends z.ZodRawShape>(name: string, config: { description: string; inputSchema: S; annotations?: { readOnlyHint: boolean } }, handler: (input: z.output<z.ZodObject<S>>) => Promise<ReturnType<typeof output>>) => {
    const schema = z.object(config.inputSchema).strict();
    definitions.push({ name, description: config.description, inputSchema: zodToJsonSchema(schema) as Record<string, unknown>, annotations: config.annotations });
    handlers.set(name, (input) => handler(schema.parse(input)));
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const handler = handlers.get(request.params.name);
    if (!handler) return { isError: true, content: [{ type: 'text', text: 'Unknown tool.' }] };
    try { return await handler(request.params.arguments ?? {}); }
    catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: error instanceof Error ? error.name : 'Error', message: 'Operation failed. Read durable status and troubleshooting; provider output is not exposed.' }) }] }; }
  });
  registerTool('demo_reconcile', { description: 'Explicitly reconcile a failed or uncertain stage: accept verified captured artifacts or authorize an exact-stage retry. Never silently retries paid speech.', inputSchema: { missionId, ...work, actorId: actor, action: z.enum(['retry-uncertain-stage', 'accept-captured-artifacts']) } }, async ({ missionId, workDir, actorId, action }) => output(await reconcile(missionId, resolve(workDir), { actorId, action })));
  registerTool('demo_doctor', { description: 'Check only configured local browser, rendering, and optional speech requirements; never prints secrets.', inputSchema: { browser: z.boolean().default(true), renderer: z.boolean().default(true), narration: z.enum(['supplied', 'voicebox', 'elevenlabs']).optional() }, annotations: { readOnlyHint: true } }, async (input) => output(await doctor(input)));
  registerTool('demo_prepare', { description: 'Validate an approved plan, target and optional narration; resume compatible cached preparation. Never provisions infrastructure.', inputSchema: { planPath: path, ...work, actorId: actor } }, async ({ planPath, workDir, actorId }) => output(await prepareDemo(resolve(planPath), resolve(workDir), actorId)));
  registerTool('demo_generate', { description: 'Capture real interactions and render a review candidate. Defaults to asynchronous start; status and receipts survive client timeouts. Never publishes.', inputSchema: { missionId, ...work, actorId: actor, wait: z.boolean().default(false) } }, async ({ missionId, workDir, actorId, wait }) => {
    const key = `${resolve(workDir)}:${missionId}`;
    let job = jobs.get(key);
    if (!job) { job = generateDemo(missionId, resolve(workDir), actorId); jobs.set(key, job); void job.catch(() => undefined).finally(() => jobs.delete(key)); }
    return output(wait ? await job : { status: 'started', missionId, nextTool: 'demo_status' });
  });
  registerTool('demo_status', { description: 'Read validated durable stage receipts; distinguish ready, failed, running, review, and unknown after timeout.', inputSchema: { missionId, ...work }, annotations: { readOnlyHint: true } }, async ({ missionId, workDir }) => output(await getStatus(missionId, resolve(workDir))));
  registerTool('demo_cleanup', { description: 'Close only owned sessions through an adapter. Default retains every artifact and does not delete environments or files.', inputSchema: { missionId, ...work, actorId: actor } }, async ({ missionId, workDir, actorId }) => output(await cleanup(missionId, resolve(workDir), { actorId })));
  registerTool('demo_preview', { description: 'Read the exact scene wording, Before/During/After context, timeline and sampled final-media review packet.', inputSchema: { missionId, ...work }, annotations: { readOnlyHint: true } }, async ({ missionId, workDir }) => {
    const directory = missionDirectory(resolve(workDir), missionId);
    return output({ mission: await getStatus(missionId, resolve(workDir)), plan: readJson(missionPath(directory, 'plan.json', true)), reviewPacket: readJson(missionPath(directory, 'review-packet.json', true)) });
  });
  registerTool('demo_review', { description: 'Record an independent or operator content/UX review bound to exact artifact hashes. Stale approvals and a reviewer ID matching the declared producer ID are rejected. Identity and role are caller-attested, not authenticated.', inputSchema: { ...work, submission: z.object({ missionId, packetHash: z.string(), planHash: z.string(), videoHash: z.string(), reviewerId: z.string().min(1), reviewerType: z.enum(['independent', 'operator']), verdict: z.enum(['approved', 'revise']), checks: z.object({ contentTruth: z.enum(['pass', 'fail', 'inconclusive']), uxQuality: z.enum(['pass', 'fail', 'inconclusive']) }).strict(), findings: z.array(z.object({ id: z.string(), severity: z.enum(['P0', 'P1', 'P2', 'P3']), sceneId: z.string().optional(), summary: z.string(), disposition: z.enum(['fixed', 'accepted', 'rejected']).optional() }).strict()) }).strict() } }, async ({ workDir, submission }) => output(await submitReview(submission as ReviewSubmission, resolve(workDir))));
  return server;
}

export async function startMcp() { const server = createMcpServer(); await server.connect(new StdioServerTransport()); return server; }
if (process.argv[1] && /(?:^|[/\\])mcp\.(?:ts|js)$/.test(process.argv[1])) startMcp().catch(() => { process.stderr.write('MCP startup failed. Run the local doctor.\n'); process.exitCode = 1; });
