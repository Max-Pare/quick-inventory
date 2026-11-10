import { createHash, randomBytes, randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { serveStatic } from '@hono/node-server/serve-static';

import { tx } from './db.js';
import { normalize } from './text.js';
import { findMatch } from './match.js';
import { publish, subscribe } from './events.js';
import { parseTranscript, llmAvailable } from './parse/index.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const MAX_TRANSCRIPT = 8000;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const now = () => new Date().toISOString();
const bad = (msg, status = 400) => new HTTPException(status, { message: msg });

function text(v, { max = 200, required = false, field = 'value' } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw bad(`${field} must be a string`);
  v = v.trim().replace(/\s+/g, ' ');
  if (required && !v) throw bad(`${field} is required`);
  if (v.length > max) throw bad(`${field} is too long (max ${max})`);
  return v;
}
function quantity(v, field = 'quantity') {
  if (!Number.isInteger(v) || v < 0 || v > 1_000_000) throw bad(`${field} must be an integer between 0 and 1000000`);
  return v;
}
function detailList(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 30) throw bad('details must be a list of up to 30 strings');
  const out = [];
  for (const d of v) {
    const t = text(d, { max: 100, field: 'detail' });
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}
const parseJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

function newJoinCode(db) {
  for (;;) {
    let code = '';
    for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    if (!db.prepare('SELECT 1 FROM inventories WHERE join_code = ?').get(code)) return code;
  }
}

const itemJson = (r) => ({
  id: r.id, name: r.name, quantity: r.quantity, details: parseJson(r.details, []),
  location: r.location, created_at: r.created_at, updated_at: r.updated_at,
});

export function createApp({ db, parse = parseTranscript, hasLLM = llmAvailable }) {
  const app = new Hono();

  const audit = (inventoryId, userId, action, { itemId = null, captureId = null, data = {} } = {}) =>
    db.prepare('INSERT INTO audit_log (inventory_id, user_id, action, item_id, capture_id, data) VALUES (?,?,?,?,?,?)')
      .run(inventoryId, userId, action, itemId, captureId, JSON.stringify(data));

  const proposalJson = (r) => {
    const match = r.match_item_id
      ? db.prepare('SELECT id, name, quantity, location FROM items WHERE id = ?').get(r.match_item_id)
      : null;
    return {
      id: r.id, capture_id: r.capture_id, name: r.name, quantity: r.quantity,
      details: parseJson(r.details, []), location: r.location, confidence: r.confidence,
      notes: parseJson(r.notes, []), status: r.status,
      match: match ? { ...match, kind: r.match_kind } : null,
      // What will happen on accept unless the reviewer changes it.
      merge: match ? (r.merge === null ? r.match_kind === 'exact' : r.merge === 1) : false,
    };
  };

  const stateOf = (inventoryId) => {
    const inv = db.prepare('SELECT id, name, join_code FROM inventories WHERE id = ?').get(inventoryId);
    const members = db.prepare(
      'SELECT u.id, u.name FROM members m JOIN users u ON u.id = m.user_id WHERE m.inventory_id = ? ORDER BY m.joined_at',
    ).all(inventoryId);
    const items = db.prepare('SELECT * FROM items WHERE inventory_id = ? ORDER BY name COLLATE NOCASE').all(inventoryId).map(itemJson);
    const captures = db.prepare(
      `SELECT c.id, c.transcript, c.location, c.parser, c.created_at, u.name AS user_name
       FROM captures c JOIN users u ON u.id = c.user_id
       WHERE c.id IN (SELECT capture_id FROM proposals WHERE inventory_id = ? AND status = 'pending')
       ORDER BY c.id`,
    ).all(inventoryId);
    const proposals = db.prepare("SELECT * FROM proposals WHERE inventory_id = ? AND status = 'pending' ORDER BY id")
      .all(inventoryId).map(proposalJson);
    return { inventory: { ...inv, members }, items, captures, proposals };
  };

  /** Turn a pending proposal into inventory. Must run inside a transaction. */
  const acceptProposal = (p, userId) => {
    const details = parseJson(p.details, []);
    let target = null;
    if (p.merge !== 0) {
      if (p.match_item_id && (p.merge === 1 || p.match_kind === 'exact')) {
        target = db.prepare('SELECT * FROM items WHERE id = ? AND inventory_id = ?').get(p.match_item_id, p.inventory_id);
      }
      // The inventory may have changed since the proposal was created (another
      // capture accepted first), so look again rather than create a duplicate.
      target ??= db.prepare('SELECT * FROM items WHERE inventory_id = ? AND norm = ? ORDER BY id LIMIT 1')
        .get(p.inventory_id, normalize(p.name));
    }
    let itemId;
    if (target) {
      const merged = parseJson(target.details, []);
      for (const d of details) if (!merged.some((x) => x.toLowerCase() === d.toLowerCase())) merged.push(d);
      db.prepare('UPDATE items SET quantity = quantity + ?, details = ?, location = ?, updated_at = ? WHERE id = ?')
        .run(p.quantity, JSON.stringify(merged), target.location || p.location, now(), target.id);
      itemId = target.id;
      audit(p.inventory_id, userId, 'item.merged', {
        itemId, captureId: p.capture_id,
        data: { name: target.name, said: p.name, added: p.quantity, quantity: target.quantity + p.quantity },
      });
    } else {
      const res = db.prepare(
        'INSERT INTO items (inventory_id, name, norm, quantity, details, location, created_by) VALUES (?,?,?,?,?,?,?)',
      ).run(p.inventory_id, p.name, normalize(p.name), p.quantity, p.details, p.location, userId);
      itemId = Number(res.lastInsertRowid);
      audit(p.inventory_id, userId, 'item.created', {
        itemId, captureId: p.capture_id,
        data: { name: p.name, quantity: p.quantity, details, location: p.location },
      });
    }
    db.prepare("UPDATE proposals SET status = 'accepted', resolved_by = ?, resolved_at = ?, item_id = ? WHERE id = ?")
      .run(userId, now(), itemId, p.id);
    return itemId;
  };

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    if (err instanceof SyntaxError) return c.json({ error: 'invalid JSON body' }, 400);
    console.error(err);
    return c.json({ error: 'internal error' }, 500);
  });

  const body = async (c) => {
    const b = await c.req.json().catch(() => { throw bad('invalid JSON body'); });
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('body must be a JSON object');
    return b;
  };

  // ---- public -------------------------------------------------------------

  app.get('/api/config', (c) => c.json({ llm: hasLLM() }));

  app.post('/api/users', async (c) => {
    const b = await body(c);
    const name = text(b.name, { max: 40, required: true, field: 'name' });
    const token = randomBytes(32).toString('base64url');
    const res = db.prepare('INSERT INTO users (name, token_hash) VALUES (?, ?)').run(name, sha256(token));
    return c.json({ user: { id: Number(res.lastInsertRowid), name }, token }, 201);
  });

  // ---- authenticated ------------------------------------------------------

  app.use('/api/*', async (c, next) => {
    const m = /^Bearer (.+)$/.exec(c.req.header('authorization') || '');
    const user = m && db.prepare('SELECT id, name FROM users WHERE token_hash = ?').get(sha256(m[1]));
    if (!user) throw bad('not signed in', 401);
    c.set('user', user);
    await next();
  });

  app.get('/api/me', (c) => {
    const user = c.get('user');
    const inventories = db.prepare(
      `SELECT i.id, i.name, i.join_code,
              (SELECT count(*) FROM proposals p WHERE p.inventory_id = i.id AND p.status = 'pending') AS pending
       FROM members m JOIN inventories i ON i.id = m.inventory_id WHERE m.user_id = ? ORDER BY m.joined_at`,
    ).all(user.id);
    return c.json({ user, inventories });
  });

  app.post('/api/inventories', async (c) => {
    const user = c.get('user');
    const name = text((await body(c)).name, { max: 60, required: true, field: 'name' });
    const inv = tx(db, () => {
      const code = newJoinCode(db);
      const id = Number(db.prepare('INSERT INTO inventories (name, join_code) VALUES (?, ?)').run(name, code).lastInsertRowid);
      db.prepare('INSERT INTO members (inventory_id, user_id) VALUES (?, ?)').run(id, user.id);
      audit(id, user.id, 'inventory.created', { data: { name } });
      return { id, name, join_code: code, pending: 0 };
    });
    return c.json(inv, 201);
  });

  app.post('/api/inventories/join', async (c) => {
    const user = c.get('user');
    const code = text((await body(c)).code, { max: 20, required: true, field: 'code' }).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const inv = db.prepare('SELECT id, name, join_code FROM inventories WHERE join_code = ?').get(code);
    if (!inv) throw bad('No inventory with that code', 404);
    const added = db.prepare('INSERT OR IGNORE INTO members (inventory_id, user_id) VALUES (?, ?)').run(inv.id, user.id);
    if (added.changes) {
      audit(inv.id, user.id, 'member.joined', { data: { name: user.name } });
      publish(inv.id);
    }
    return c.json({ ...inv, pending: 0 });
  });

  // Everything below is scoped to an inventory the caller is a member of.
  const inv = new Hono();
  inv.use('*', async (c, next) => {
    const id = Number(c.req.param('inv'));
    const ok = Number.isInteger(id) &&
      db.prepare('SELECT 1 FROM members WHERE inventory_id = ? AND user_id = ?').get(id, c.get('user').id);
    if (!ok) throw bad('not a member of this inventory', 403);
    c.set('inv', id);
    await next();
  });

  inv.get('/state', (c) => c.json(stateOf(c.get('inv'))));

  inv.post('/captures', async (c) => {
    const user = c.get('user');
    const invId = c.get('inv');
    const b = await body(c);
    if (typeof b.transcript !== 'string') throw bad('transcript must be a string');
    const transcript = b.transcript.trim();
    if (!transcript) throw bad('transcript is empty');
    if (transcript.length > MAX_TRANSCRIPT) throw bad(`transcript is too long (max ${MAX_TRANSCRIPT} characters)`);
    const location = text(b.location, { max: 80, field: 'location' });

    const existingNames = db.prepare('SELECT name FROM items WHERE inventory_id = ? ORDER BY updated_at DESC').all(invId).map((r) => r.name);
    const parsed = await parse({ transcript, location, existingNames });

    const result = tx(db, () => {
      const captureId = Number(db.prepare(
        'INSERT INTO captures (inventory_id, user_id, transcript, location, parser) VALUES (?,?,?,?,?)',
      ).run(invId, user.id, transcript, location, parsed.parser).lastInsertRowid);
      const ids = [];
      for (const it of parsed.items) {
        const match = findMatch(db, invId, it.name);
        const notes = [...(it.notes || [])];
        // The box on the Capture tab wins; otherwise use what was heard, if anything.
        const itemLocation = location || String(it.location || '').trim().replace(/\s+/g, ' ').slice(0, 80);
        const res = db.prepare(
          `INSERT INTO proposals (inventory_id, capture_id, name, quantity, details, location, confidence, notes, match_item_id, match_kind)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        ).run(invId, captureId, it.name, it.quantity, JSON.stringify(it.details || []), itemLocation,
          it.confidence || 'high', JSON.stringify(notes), match?.id ?? null, match?.kind ?? null);
        ids.push(Number(res.lastInsertRowid));
      }
      audit(invId, user.id, 'capture.created', {
        captureId, data: { transcript, location, parser: parsed.parser, proposed: parsed.items.length },
      });
      return { captureId, ids };
    });

    publish(invId);
    const proposals = result.ids.map((id) => proposalJson(db.prepare('SELECT * FROM proposals WHERE id = ?').get(id)));
    return c.json({ capture_id: result.captureId, parser: parsed.parser, warning: parsed.warning || null, proposals }, 201);
  });

  const pendingProposal = (c) => {
    const p = db.prepare('SELECT * FROM proposals WHERE id = ? AND inventory_id = ?').get(Number(c.req.param('pid')), c.get('inv'));
    if (!p) throw bad('proposal not found', 404);
    if (p.status !== 'pending') throw bad(`proposal was already ${p.status}`, 409);
    return p;
  };

  inv.patch('/proposals/:pid', async (c) => {
    const p = pendingProposal(c);
    const b = await body(c);
    const next = { ...p };
    if ('name' in b) next.name = text(b.name, { required: true, field: 'name' });
    if ('quantity' in b) { next.quantity = quantity(b.quantity); if (next.quantity < 1) throw bad('quantity must be at least 1'); }
    if ('details' in b) next.details = JSON.stringify(detailList(b.details));
    if ('location' in b) next.location = text(b.location, { max: 80, field: 'location' });
    if (next.name !== p.name) {
      const match = findMatch(db, p.inventory_id, next.name);
      next.match_item_id = match?.id ?? null;
      next.match_kind = match?.kind ?? null;
      next.merge = null;
    }
    if ('merge' in b) {
      if (typeof b.merge !== 'boolean') throw bad('merge must be true or false');
      next.merge = b.merge ? 1 : 0;
    }
    db.prepare(
      'UPDATE proposals SET name=?, quantity=?, details=?, location=?, match_item_id=?, match_kind=?, merge=? WHERE id=?',
    ).run(next.name, next.quantity, next.details, next.location, next.match_item_id, next.match_kind, next.merge, p.id);
    publish(p.inventory_id);
    return c.json(proposalJson(db.prepare('SELECT * FROM proposals WHERE id = ?').get(p.id)));
  });

  inv.post('/proposals/accept-all', (c) => {
    const invId = c.get('inv');
    const count = tx(db, () => {
      const pending = db.prepare("SELECT * FROM proposals WHERE inventory_id = ? AND status = 'pending' ORDER BY id").all(invId);
      for (const p of pending) acceptProposal(p, c.get('user').id);
      return pending.length;
    });
    publish(invId);
    return c.json({ accepted: count });
  });

  inv.post('/proposals/:pid/accept', (c) => {
    const p = pendingProposal(c);
    const itemId = tx(db, () => acceptProposal(p, c.get('user').id));
    publish(p.inventory_id);
    return c.json({ item: itemJson(db.prepare('SELECT * FROM items WHERE id = ?').get(itemId)) });
  });

  inv.post('/proposals/:pid/reject', (c) => {
    const p = pendingProposal(c);
    tx(db, () => {
      db.prepare("UPDATE proposals SET status = 'rejected', resolved_by = ?, resolved_at = ? WHERE id = ?")
        .run(c.get('user').id, now(), p.id);
      audit(p.inventory_id, c.get('user').id, 'proposal.rejected', {
        captureId: p.capture_id, data: { name: p.name, quantity: p.quantity },
      });
    });
    publish(p.inventory_id);
    return c.json({ ok: true });
  });

  inv.post('/items', async (c) => {
    const invId = c.get('inv');
    const b = await body(c);
    const name = text(b.name, { required: true, field: 'name' });
    const qty = quantity(b.quantity ?? 1);
    const details = detailList(b.details);
    const location = text(b.location, { max: 80, field: 'location' });
    const id = tx(db, () => {
      const itemId = Number(db.prepare(
        'INSERT INTO items (inventory_id, name, norm, quantity, details, location, created_by) VALUES (?,?,?,?,?,?,?)',
      ).run(invId, name, normalize(name), qty, JSON.stringify(details), location, c.get('user').id).lastInsertRowid);
      audit(invId, c.get('user').id, 'item.created', { itemId, data: { name, quantity: qty, details, location, manual: true } });
      return itemId;
    });
    publish(invId);
    return c.json(itemJson(db.prepare('SELECT * FROM items WHERE id = ?').get(id)), 201);
  });

  const itemOf = (c) => {
    const it = db.prepare('SELECT * FROM items WHERE id = ? AND inventory_id = ?').get(Number(c.req.param('item')), c.get('inv'));
    if (!it) throw bad('item not found', 404);
    return it;
  };

  inv.patch('/items/:item', async (c) => {
    const it = itemOf(c);
    const b = await body(c);
    const next = { name: it.name, quantity: it.quantity, details: parseJson(it.details, []), location: it.location };
    if ('name' in b) next.name = text(b.name, { required: true, field: 'name' });
    if ('quantity' in b) next.quantity = quantity(b.quantity);
    if ('details' in b) next.details = detailList(b.details);
    if ('location' in b) next.location = text(b.location, { max: 80, field: 'location' });

    const before = { name: it.name, quantity: it.quantity, details: parseJson(it.details, []), location: it.location };
    const changes = {};
    for (const k of Object.keys(next)) {
      if (JSON.stringify(before[k]) !== JSON.stringify(next[k])) changes[k] = { from: before[k], to: next[k] };
    }
    if (Object.keys(changes).length) {
      tx(db, () => {
        db.prepare('UPDATE items SET name=?, norm=?, quantity=?, details=?, location=?, updated_at=? WHERE id=?')
          .run(next.name, normalize(next.name), next.quantity, JSON.stringify(next.details), next.location, now(), it.id);
        audit(it.inventory_id, c.get('user').id, 'item.updated', { itemId: it.id, data: { name: next.name, changes } });
      });
      publish(it.inventory_id);
    }
    return c.json(itemJson(db.prepare('SELECT * FROM items WHERE id = ?').get(it.id)));
  });

  inv.delete('/items/:item', (c) => {
    const it = itemOf(c);
    tx(db, () => {
      db.prepare('DELETE FROM items WHERE id = ?').run(it.id);
      audit(it.inventory_id, c.get('user').id, 'item.deleted', {
        itemId: it.id, data: { name: it.name, quantity: it.quantity, details: parseJson(it.details, []), location: it.location },
      });
    });
    publish(it.inventory_id);
    return c.json({ ok: true });
  });

  inv.get('/audit', (c) => {
    const before = Number(c.req.query('before')) || Number.MAX_SAFE_INTEGER;
    const rows = db.prepare(
      `SELECT a.id, a.action, a.item_id, a.capture_id, a.data, a.created_at, u.name AS user_name
       FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.inventory_id = ? AND a.id < ? ORDER BY a.id DESC LIMIT 100`,
    ).all(c.get('inv'), before);
    return c.json({ entries: rows.map((r) => ({ ...r, data: parseJson(r.data, {}) })) });
  });

  inv.get('/export.csv', (c) => {
    // Leading =,+,-,@ would be run as a formula by spreadsheet apps.
    const cell = (v) => {
      let s = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = db.prepare('SELECT * FROM items WHERE inventory_id = ? ORDER BY name COLLATE NOCASE').all(c.get('inv'));
    const lines = ['name,quantity,details,location,updated_at'];
    for (const r of rows) {
      lines.push([cell(r.name), r.quantity, cell(parseJson(r.details, []).join('; ')), cell(r.location), r.updated_at].join(','));
    }
    return c.body(lines.join('\r\n') + '\r\n', 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="inventory.csv"',
    });
  });

  inv.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      let open = true;
      const unsubscribe = subscribe(c.get('inv'), (ev) => { stream.writeSSE({ data: JSON.stringify(ev) }).catch(() => {}); });
      stream.onAbort(() => { open = false; unsubscribe(); });
      await stream.writeSSE({ data: JSON.stringify({ type: 'hello' }) });
      while (open) {
        await stream.sleep(25_000);
        if (open) await stream.writeSSE({ event: 'ping', data: '' }).catch(() => { open = false; });
      }
      unsubscribe();
    }));

  app.route('/api/inventories/:inv', inv);
  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

  // ---- static PWA ---------------------------------------------------------

  const preact = readFileSync(path.join(ROOT, 'node_modules/htm/preact/standalone.module.js'));
  app.get('/vendor/preact.js', (c) =>
    c.body(preact, 200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400' }));
  app.use('*', serveStatic({ root: path.relative(process.cwd(), path.join(ROOT, 'web')) || '.' }));

  return app;
}
