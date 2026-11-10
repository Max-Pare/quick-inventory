// Minimal in-process pub/sub so clients of the same inventory see changes live.

const listeners = new Map(); // inventoryId -> Set<fn>

export function subscribe(inventoryId, fn) {
  let set = listeners.get(inventoryId);
  if (!set) listeners.set(inventoryId, (set = new Set()));
  set.add(fn);
  return () => {
    set.delete(fn);
    if (!set.size) listeners.delete(inventoryId);
  };
}

export function publish(inventoryId, event = { type: 'changed' }) {
  for (const fn of listeners.get(inventoryId) || []) {
    try { fn(event); } catch { /* a dead listener must not break the others */ }
  }
}
