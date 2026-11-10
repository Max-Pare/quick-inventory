import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { parseHeuristic } from '../server/parse/heuristic.js';

function setup() {
  const app = createApp({
    db: openDb(':memory:'),
    parse: async ({ transcript }) => ({ parser: 'heuristic', items: parseHeuristic(transcript) }),
    hasLLM: () => false,
  });
  const call = async (method, url, token, json) => {
    const res = await app.request(url, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json ? { 'content-type': 'application/json' } : {}) },
      body: json ? JSON.stringify(json) : undefined,
    });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
  };
  const signup = async (name) => (await call('POST', '/api/users', null, { name })).body.token;
  return { call, signup };
}

test('capture -> review -> inventory, shared between two users', async () => {
  const { call, signup } = setup();
  const alice = await signup('Alice');
  const bob = await signup('Bob');

  const inv = (await call('POST', '/api/inventories', alice, { name: 'Lab' })).body;
  assert.match(inv.join_code, /^[A-Z2-9]{8}$/);
  const base = `/api/inventories/${inv.id}`;

  // Bob cannot see it until he joins.
  assert.equal((await call('GET', `${base}/state`, bob)).status, 403);
  assert.equal((await call('POST', '/api/inventories/join', bob, { code: 'NOPE1234' })).status, 404);
  assert.equal((await call('POST', '/api/inventories/join', bob, { code: inv.join_code.toLowerCase() })).status, 200);

  // Alice dictates.
  const cap = await call('POST', `${base}/captures`, alice, {
    transcript: 'usb C cable, uuuuh usb C cable, raspberry pi 4b, duct tape, black, lightning phone charger',
    location: 'Shelf A',
  });
  assert.equal(cap.status, 201);
  assert.equal(cap.body.proposals.length, 4);

  // Nothing is in the inventory before review.
  let state = (await call('GET', `${base}/state`, bob)).body;
  assert.equal(state.items.length, 0);
  assert.equal(state.proposals.length, 4);
  assert.equal(state.captures[0].user_name, 'Alice');
  assert.equal(state.inventory.members.length, 2);

  const [usb, pi, tape, charger] = state.proposals;
  assert.equal(usb.quantity, 2);
  assert.ok(usb.notes.length);

  // Bob fixes the stutter, renames, rejects one, accepts the rest.
  assert.equal((await call('PATCH', `${base}/proposals/${usb.id}`, bob, { quantity: 1 })).body.quantity, 1);
  assert.equal((await call('PATCH', `${base}/proposals/${pi.id}`, bob, { name: 'Raspberry Pi 4B' })).body.name, 'Raspberry Pi 4B');
  assert.equal((await call('PATCH', `${base}/proposals/${usb.id}`, bob, { quantity: 0 })).status, 400);
  assert.equal((await call('POST', `${base}/proposals/${charger.id}/reject`, bob)).status, 200);
  assert.equal((await call('POST', `${base}/proposals/${charger.id}/accept`, bob)).status, 409);
  assert.equal((await call('POST', `${base}/proposals/accept-all`, bob)).body.accepted, 3);

  state = (await call('GET', `${base}/state`, alice)).body;
  assert.deepEqual(state.items.map((i) => [i.name, i.quantity, i.details, i.location]), [
    ['Duct tape', 1, ['black'], 'Shelf A'],
    ['Raspberry Pi 4B', 1, [], 'Shelf A'],
    ['USB-C cable', 1, [], 'Shelf A'],
  ]);
  assert.equal(state.proposals.length, 0);
  assert.equal(tape.details[0], 'black');

  // A later capture matches existing items: exact -> merge by default, fuzzy -> suggestion only.
  const cap2 = (await call('POST', `${base}/captures`, bob, { transcript: 'three usb-c cables, duct tapes roll' })).body;
  const [usb2, tape2] = cap2.proposals;
  assert.equal(usb2.match.kind, 'exact');
  assert.equal(usb2.merge, true);
  assert.equal(tape2.match.kind, 'similar');
  assert.equal(tape2.merge, false);
  await call('PATCH', `${base}/proposals/${tape2.id}`, bob, { merge: true });
  await call('POST', `${base}/proposals/accept-all`, bob);

  state = (await call('GET', `${base}/state`, alice)).body;
  assert.deepEqual(state.items.map((i) => [i.name, i.quantity]), [
    ['Duct tape', 2], ['Raspberry Pi 4B', 1], ['USB-C cable', 4],
  ]);

  // Forcing a new item instead of merging.
  const cap3 = (await call('POST', `${base}/captures`, alice, { transcript: 'usb c cable' })).body;
  await call('PATCH', `${base}/proposals/${cap3.proposals[0].id}`, alice, { merge: false, details: ['white'] });
  await call('POST', `${base}/proposals/${cap3.proposals[0].id}/accept`, alice);
  state = (await call('GET', `${base}/state`, alice)).body;
  assert.equal(state.items.filter((i) => i.name === 'USB-C cable').length, 2);

  // Manual edits and deletes are audited too.
  const tapeItem = state.items.find((i) => i.name === 'Duct tape');
  assert.equal((await call('PATCH', `${base}/items/${tapeItem.id}`, alice, { quantity: 5 })).body.quantity, 5);
  assert.equal((await call('DELETE', `${base}/items/${tapeItem.id}`, alice)).status, 200);
  assert.equal((await call('PATCH', `${base}/items/${tapeItem.id}`, alice, { quantity: 1 })).status, 404);

  const log = (await call('GET', `${base}/audit`, bob)).body.entries;
  const actions = log.map((e) => e.action);
  for (const a of ['inventory.created', 'member.joined', 'capture.created', 'item.created', 'item.merged', 'proposal.rejected', 'item.updated', 'item.deleted']) {
    assert.ok(actions.includes(a), `audit log has ${a}`);
  }
  const merged = log.find((e) => e.action === 'item.merged' && e.data.name === 'USB-C cable');
  assert.equal(merged.user_name, 'Bob');
  assert.equal(merged.data.added, 3);
  assert.ok(merged.capture_id);

  const csv = (await call('GET', `${base}/export.csv`, alice)).body;
  assert.match(csv, /^name,quantity,details,location,updated_at\r\n/);
  assert.match(csv, /Raspberry Pi 4B,1,,Shelf A,/);
});

test('two pending captures of the same new item do not create duplicates', async () => {
  const { call, signup } = setup();
  const t = await signup('A');
  const inv = (await call('POST', '/api/inventories', t, { name: 'Garage' })).body;
  const base = `/api/inventories/${inv.id}`;
  await call('POST', `${base}/captures`, t, { transcript: 'hammer' });
  await call('POST', `${base}/captures`, t, { transcript: 'two hammers' });
  await call('POST', `${base}/proposals/accept-all`, t);
  const { items } = (await call('GET', `${base}/state`, t)).body;
  assert.deepEqual(items.map((i) => [i.name, i.quantity]), [['Hammer', 3]]);
});

test('auth and validation', async () => {
  const { call, signup } = setup();
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('GET', '/api/me', 'bogus')).status, 401);
  assert.equal((await call('POST', '/api/users', null, { name: '  ' })).status, 400);
  assert.deepEqual((await call('GET', '/api/config')).body, { llm: false });

  const t = await signup('A');
  const inv = (await call('POST', '/api/inventories', t, { name: 'X' })).body;
  const base = `/api/inventories/${inv.id}`;
  assert.equal((await call('POST', `${base}/captures`, t, { transcript: '' })).status, 400);
  assert.equal((await call('POST', `${base}/captures`, t, { transcript: 'x'.repeat(9000) })).status, 400);
  assert.equal((await call('POST', `${base}/items`, t, { name: 'Bolt', quantity: -1 })).status, 400);
  assert.equal((await call('POST', `${base}/items`, t, { name: '=cmd()', quantity: 2 })).status, 201);
  assert.match((await call('GET', `${base}/export.csv`, t)).body, /'=cmd\(\),2/);
  assert.equal((await call('GET', '/api/inventories/999/state', t)).status, 403);
  assert.equal((await call('GET', '/api/nope', t)).status, 404);
});
