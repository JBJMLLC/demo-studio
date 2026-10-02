import { mkdir, writeFile } from 'node:fs/promises';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { planSchema, captureResultSchema, renderResultSchema, narrationResultSchema, missionReceiptSchema, reviewSubmissionSchema, reviewReceiptSchema, reviewHistorySchema } from '../src/schemas.js';
await mkdir('schemas', { recursive: true });
for (const [name, schema] of Object.entries({ plan: planSchema, capture: captureResultSchema, render: renderResultSchema, narration: narrationResultSchema, mission: missionReceiptSchema, review: reviewSubmissionSchema, 'review-receipt': reviewReceiptSchema, 'review-history': reviewHistorySchema })) await writeFile(`schemas/${name}.schema.json`, `${JSON.stringify(zodToJsonSchema(schema, name), null, 2)}\n`);
