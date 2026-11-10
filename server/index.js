import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { llmBackend } from './parse/index.js';
import { localConfig } from './parse/local.js';

const port = Number(process.env.PORT) || 3000;
const dbPath = process.env.QUICKINV_DB || 'data/quickinv.db';
if (dbPath !== ':memory:') mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });

const app = createApp({ db: openDb(dbPath) });

serve({ fetch: app.fetch, port, hostname: process.env.HOST || '0.0.0.0' }, (info) => {
  console.log(`quickinv listening on http://localhost:${info.port}`);
  console.log(`  database: ${dbPath}`);
  const backend = llmBackend();
  const parser = backend === 'local' ? `local model ${localConfig().model} at ${localConfig().url}, heuristic fallback`
    : backend === 'claude' ? `Claude (${process.env.QUICKINV_MODEL || 'claude-opus-5-5'}), heuristic fallback`
    : 'heuristic (set QUICKINV_LOCAL_URL or ANTHROPIC_API_KEY for AI parsing)';
  console.log(`  parser:   ${parser}`);
});
