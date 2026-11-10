import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { parseWithLocal, extractJson } from '../server/parse/local.js';
import { parseTranscript, llmBackend } from '../server/parse/index.js';

/** Fake OpenAI-compatible server; `handler(body)` returns {status, content}. */
async function fakeServer(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      requests.push({ url: req.url, auth: req.headers.authorization, body });
      const { status = 200, content = '' } = handler(body, requests.length);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status === 200 ? { choices: [{ message: { role: 'assistant', content } }] } : { error: 'nope' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { requests, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((r) => server.close(r)) };
}
const cfg = (url) => ({ url: `${url}/chat/completions`, model: 'test-model', apiKey: 'k', timeoutMs: 5000 });
const REPLY = JSON.stringify({ items: [
  { name: 'USB-C cable', quantity: 2, details: [], confidence: 'low', note: 'Said twice.' },
  { name: 'Duct tape', quantity: 1, details: ['black'], location: ' top  shelf ', confidence: 'high', note: '' },
] });

test('schema-constrained request and parsed reply', async () => {
  const srv = await fakeServer(() => ({ content: REPLY }));
  try {
    const items = await parseWithLocal({ transcript: 'usb c cable usb c cable duct tape black', location: 'Shelf A', existingNames: ['Hammer'] }, cfg(srv.url));
    assert.deepEqual(items, [
      { name: 'USB-C cable', quantity: 2, details: [], location: '', confidence: 'low', notes: ['Said twice.'] },
      { name: 'Duct tape', quantity: 1, details: ['black'], location: 'top shelf', confidence: 'high', notes: [] },
    ]);
    const [req] = srv.requests;
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.auth, 'Bearer k');
    assert.equal(req.body.model, 'test-model');
    assert.equal(req.body.response_format.type, 'json_schema');
    assert.deepEqual(req.body.response_format.json_schema.schema.required, ['items']);
    assert.match(req.body.messages[1].content, /<transcript>\nusb c cable/);
    assert.match(req.body.messages[1].content, /Hammer/);
  } finally { await srv.close(); }
});

test('falls back to JSON mode, then no format, when the server rejects them', async () => {
  const srv = await fakeServer((body) => (body.response_format ? { status: 400 } : { content: REPLY }));
  try {
    const items = await parseWithLocal({ transcript: 'x' }, cfg(srv.url));
    assert.equal(items.length, 2);
    assert.deepEqual(srv.requests.map((r) => r.body.response_format?.type ?? null), ['json_schema', 'json_object', null]);
  } finally { await srv.close(); }
});

test('tolerates sloppy replies', async () => {
  const sloppy = '<think>hmm, two cables?</think>Sure! Here you go:\n```json\n{"items":[{"name":" hammer ","quantity":"3","details":null,"confidence":"certain"},{"name":"","quantity":1}]}\n```';
  const srv = await fakeServer(() => ({ content: sloppy }));
  try {
    assert.deepEqual(await parseWithLocal({ transcript: 'x' }, cfg(srv.url)), [
      { name: 'hammer', quantity: 3, details: [], location: '', confidence: 'medium', notes: [] },
    ]);
  } finally { await srv.close(); }
  assert.throws(() => extractJson('no json here'));
});

test('backend selection and heuristic fallback when the local model is down', async () => {
  const saved = { ...process.env };
  try {
    delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.QUICKINV_LLM; delete process.env.QUICKINV_LOCAL_URL;
    assert.equal(llmBackend(), null);
    process.env.ANTHROPIC_API_KEY = 'x';
    assert.equal(llmBackend(), 'claude');
    process.env.QUICKINV_LOCAL_URL = 'http://127.0.0.1:9/v1'; // nothing listens here
    assert.equal(llmBackend(), 'local');
    process.env.QUICKINV_LLM = 'claude';
    assert.equal(llmBackend(), 'claude');
    process.env.QUICKINV_LLM = 'off';
    assert.equal(llmBackend(), null);
    process.env.QUICKINV_LLM = 'local';
    const out = await parseTranscript({ transcript: 'two hammers' });
    assert.equal(out.parser, 'heuristic');
    assert.ok(out.warning);
    assert.deepEqual(out.items.map((i) => [i.name, i.quantity]), [['Hammers', 2]]);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
