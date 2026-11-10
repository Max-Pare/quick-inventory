// Transcript -> items using a local (or any self-hosted) model behind an
// OpenAI-compatible /chat/completions endpoint: Ollama, llama.cpp server,
// LM Studio, vLLM, LocalAI, ...

import { z } from 'zod';
import { Schema, SYSTEM, buildContext, cleanItems } from './llm.js';

// Small models follow an explicit shape far better than a bare schema.
const FORMAT_HINT = `

Reply with a single JSON object and nothing else, in exactly this shape:
{"items":[{"name":"USB-C cable","quantity":2,"details":["black"],"confidence":"high","note":""}]}
"confidence" is one of "high", "medium", "low". "details" may be []. "note" may be "".`;

// Local models are sloppier than a constrained API, so accept what can be repaired.
const LooseSchema = z.object({
  items: z.array(z.object({
    name: z.string(),
    quantity: z.coerce.number().catch(1),
    details: z.array(z.coerce.string()).nullish().transform((v) => v ?? []).catch([]),
    confidence: z.enum(['high', 'medium', 'low']).catch('medium'),
    note: z.string().nullish().transform((v) => v ?? '').catch(''),
  })),
});

export function localConfig() {
  const url = (process.env.QUICKINV_LOCAL_URL || '').trim().replace(/\/+$/, '');
  if (!url) return null;
  return {
    url: /\/chat\/completions$/.test(url) ? url : `${url}/chat/completions`,
    model: process.env.QUICKINV_LOCAL_MODEL || 'llama3.1',
    apiKey: process.env.QUICKINV_LOCAL_API_KEY || '',
    timeoutMs: Number(process.env.QUICKINV_LOCAL_TIMEOUT_MS) || 120_000,
  };
}

/** Pull the JSON object out of a reply that may carry reasoning tags, code fences or chatter. */
export function extractJson(text) {
  const s = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('model reply contained no JSON object');
  return JSON.parse(s.slice(start, end + 1));
}

async function chat(cfg, responseFormat, input) {
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      stream: false,
      messages: [
        { role: 'system', content: SYSTEM + FORMAT_HINT },
        { role: 'user', content: buildContext(input) },
      ],
      ...(responseFormat ? { response_format: responseFormat } : {}),
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!res.ok) {
    const err = new Error(`local model returned HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('local model returned an empty reply');
  return content;
}

/**
 * @param {{transcript:string, location?:string, existingNames?:string[]}} input
 */
export async function parseWithLocal(input, cfg = localConfig()) {
  if (!cfg) throw new Error('QUICKINV_LOCAL_URL is not set');
  const jsonSchema = z.toJSONSchema(Schema);
  delete jsonSchema.$schema;

  // Prefer schema-constrained output; servers that do not support it reject the
  // request, in which case fall back to JSON mode, then to plain prompting.
  const formats = [
    { type: 'json_schema', json_schema: { name: 'inventory_items', strict: true, schema: jsonSchema } },
    { type: 'json_object' },
    null,
  ];
  let content;
  for (const [i, format] of formats.entries()) {
    try {
      content = await chat(cfg, format, input);
      break;
    } catch (err) {
      const unsupported = err.status === 400 || err.status === 422;
      if (!unsupported || i === formats.length - 1) throw err;
    }
  }
  return cleanItems(LooseSchema.parse(extractJson(content)).items);
}
