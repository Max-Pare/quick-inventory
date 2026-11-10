import { normalize, similarity } from './text.js';

const SIMILAR_THRESHOLD = 0.6;

/**
 * Find the existing item a spoken name most likely refers to.
 * @returns {{id:number, kind:'exact'|'similar'}|null}
 */
export function findMatch(db, inventoryId, name) {
  const norm = normalize(name);
  if (!norm) return null;
  const exact = db
    .prepare('SELECT id FROM items WHERE inventory_id = ? AND norm = ? ORDER BY id LIMIT 1')
    .get(inventoryId, norm);
  if (exact) return { id: exact.id, kind: 'exact' };

  let best = null;
  for (const row of db.prepare('SELECT id, name FROM items WHERE inventory_id = ?').all(inventoryId)) {
    const score = similarity(name, row.name);
    if (score >= SIMILAR_THRESHOLD && (!best || score > best.score)) best = { id: row.id, score };
  }
  return best ? { id: best.id, kind: 'similar' } : null;
}
