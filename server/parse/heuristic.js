// Deterministic transcript parser. Used when no LLM is configured, and as the
// fallback when the LLM call fails. It is deliberately conservative: anything it
// is unsure about is flagged for the reviewer instead of being silently guessed.

import { normalize, displayName } from '../text.js';

const FILLER = /^(u+h+m*|u+m+|e+r+m*|a+h+|h+m+|e+h+|m+h+m+|erm+|well|okay|ok|so|right)$/i;
const FILLER_PHRASES = /\b(let'?s see|let me see|what else|i think|you know|i mean|there'?s|there is|there are|we have|we'?ve got|i'?ve got|i have|i see)\b/gi;

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100,
  couple: 2, pair: 2, dozen: 12,
};

// A leading number followed by one of these is a measurement, not a count ("3 meter cable").
const UNITS = new Set([
  'm', 'meter', 'meters', 'metre', 'metres', 'cm', 'mm', 'inch', 'inches', 'in', 'ft', 'foot', 'feet',
  'gb', 'tb', 'mb', 'gig', 'gigs', 'gigabyte', 'gigabytes', 'terabyte', 'terabytes',
  'v', 'volt', 'volts', 'w', 'watt', 'watts', 'a', 'amp', 'amps', 'mah', 'ah', 'hz', 'khz', 'mhz',
  'l', 'liter', 'liters', 'litre', 'litres', 'ml', 'kg', 'g', 'gram', 'grams', 'lb', 'lbs', 'oz',
  'port', 'pin', 'way', 'gang', 'channel', 'core', 'ohm', 'ohms', 'k', 'gauge', 'awg', 'piece',
]);

const ATTRIBUTES = new Set([
  // colours
  'black', 'white', 'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'pink', 'brown', 'grey', 'gray',
  'silver', 'gold', 'beige', 'transparent', 'clear', 'dark', 'light', 'bright',
  // size
  'small', 'medium', 'large', 'big', 'tiny', 'huge', 'long', 'short', 'thin', 'thick', 'mini', 'xl',
  // condition
  'new', 'used', 'old', 'broken', 'damaged', 'working', 'unopened', 'sealed', 'opened', 'empty', 'full',
  'half', 'spare', 'dead', 'faulty', 'untested', 'tested', 'dusty', 'rusty', 'worn',
  // material
  'plastic', 'metal', 'wooden', 'steel', 'aluminium', 'aluminum', 'rubber', 'glass', 'copper', 'braided',
  // glue words allowed inside an attribute-only phrase
  'and', 'very', 'quite', 'slightly', 'a', 'bit', 'one', 'ones', 'both',
]);
const MEASURE = /^\d+(\.\d+)?$/;

// Location inference. A phrase is only treated as a place when a preposition is
// followed (within a few words) by one of these, so "cable in black" or
// "plug in adapter" are left alone.
const PLACE_WORDS = new Set([
  'shelf', 'shelves', 'drawer', 'drawers', 'box', 'bin', 'cabinet', 'cupboard', 'closet', 'rack', 'toolbox',
  'desk', 'table', 'bench', 'workbench', 'room', 'garage', 'shed', 'attic', 'basement', 'office', 'lab',
  'kitchen', 'fridge', 'locker', 'crate', 'basket', 'bag', 'case', 'floor', 'wall', 'corner', 'door',
  'window', 'hallway', 'storage', 'container', 'tray', 'pegboard', 'wardrobe', 'trunk', 'counter', 'cart',
]);
const PREPS_DROPPED = new Set(['in', 'on', 'inside', 'at', 'to']); // "in the top drawer" -> "top drawer"
const PREPS_KEPT = new Set(['under', 'underneath', 'behind', 'by', 'above', 'below', 'beside', 'near', 'next']);
const MOVE_WORDS = new Set(['now', 'next', 'then', 'moving', 'going', 'over', 'on', 'and']);
const clean = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}-]/gu, '');

/**
 * Try to read a location starting at tokens[at], which must be a preposition.
 * @returns {{location:string, end:number}|null} end = index after the location
 */
function readLocation(tokens, at) {
  const prep = clean(tokens[at]);
  let start = at + 1;
  if (prep === 'next') { if (clean(tokens[start] || '') !== 'to') return null; start++; }
  else if (!PREPS_DROPPED.has(prep) && !PREPS_KEPT.has(prep)) return null;

  let place = -1;
  for (let i = start; i < Math.min(tokens.length, start + 5); i++) {
    if (PLACE_WORDS.has(clean(tokens[i]))) { place = i; break; }
  }
  if (place < 0) return null;
  let end = place + 1;
  while (end < tokens.length && PLACE_WORDS.has(clean(tokens[end]))) end++;          // "storage room"
  if (end < tokens.length && /^(\d{1,3}|[a-z])$/i.test(clean(tokens[end]))) end++;     // "shelf B", "bin 3"

  const words = tokens.slice(start, end);
  let keep = '';
  if (PREPS_KEPT.has(prep)) keep = prep === 'next' ? 'next to ' : `${prep} `; // "under the desk" reads better whole
  else while (words.length > 1 && /^(the|my|our|a|an|that|this)$/i.test(words[0])) words.shift();
  return { location: (keep + words.join(' ')).replace(/[.,;:]+$/, ''), end };
}

function parseNumber(tok) {
  if (/^\d{1,4}$/.test(tok)) return Number(tok);
  const n = NUMBER_WORDS[tok.toLowerCase()];
  return n ?? null;
}

function isAttributePhrase(tokens) {
  if (!tokens.length) return false;
  let real = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].toLowerCase();
    if (MEASURE.test(t) && UNITS.has((tokens[i + 1] || '').toLowerCase())) { i++; real++; continue; }
    if (/^\d+(\.\d+)?(m|cm|mm|gb|tb|v|w|a|mah|kg|g|l|ml|ft|in)$/.test(t)) { real++; continue; }
    if (!ATTRIBUTES.has(t)) return false;
    if (!['and', 'very', 'quite', 'slightly', 'a', 'bit', 'one', 'ones', 'both'].includes(t)) real++;
  }
  return real > 0;
}

function splitSegments(text) {
  return text
    .replace(FILLER_PHRASES, ' ')
    // sentence punctuation, but keep decimals such as "3.5 mm"
    .split(/[,;\n!?]+|\.(?=\s|$)|\s+(?:and then|and also|then|also|next(?!\s+to\b)|plus)\s+/i)
    .flatMap((seg) => {
      // Split on "and" unless it joins two attributes ("black and white").
      const parts = seg.split(/\s+and\s+/i);
      if (parts.length < 2) return [seg];
      const out = [parts[0]];
      for (let i = 1; i < parts.length; i++) {
        const prevLast = out[out.length - 1].trim().split(/\s+/).pop()?.toLowerCase();
        const nextFirst = parts[i].trim().split(/\s+/)[0]?.toLowerCase();
        if (ATTRIBUTES.has(prevLast) && ATTRIBUTES.has(nextFirst)) out[out.length - 1] += ` and ${parts[i]}`;
        else out.push(parts[i]);
      }
      return out;
    });
}

/**
 * @param {string} transcript
 * @returns {{name:string, quantity:number, details:string[], location:string, confidence:'high'|'medium'|'low', notes:string[]}[]}
 */
export function parseHeuristic(transcript) {
  const items = [];
  const byNorm = new Map();
  let currentLocation = ''; // set by a location said on its own, applies until the next one

  for (const rawSeg of splitSegments(String(transcript || ''))) {
    let tokens = rawSeg.trim().split(/\s+/).filter(Boolean);
    const before = tokens.length;
    tokens = tokens.filter((t) => !FILLER.test(t.replace(/[^\p{L}]/gu, '')) || /\d/.test(t));
    const hadFiller = tokens.length !== before;
    if (!tokens.length) continue;

    // A location said on its own ("on the top shelf", "now in the garage")
    // applies to the items that follow.
    let lead = 0;
    while (lead < tokens.length - 1 && MOVE_WORDS.has(clean(tokens[lead])) && readLocation(tokens, lead) === null) lead++;
    const standalone = readLocation(tokens, lead);
    if (standalone) {
      currentLocation = standalone.location;
      tokens = tokens.slice(standalone.end);
      if (!tokens.length) continue;
    }

    // Attribute-only phrase ("black", "2 meters") describes the previous item.
    if (items.length && isAttributePhrase(tokens)) {
      const prev = items[items.length - 1];
      const detail = tokens.join(' ').toLowerCase();
      if (!prev.details.includes(detail)) prev.details.push(detail);
      continue;
    }

    // A location at the end of an item ("hammer in the red toolbox") is for that item only.
    let location = currentLocation;
    for (let i = tokens.length - 2; i > 0; i--) {
      if (clean(tokens[i]) === 'to') continue; // "to" only starts a standalone location ("moving to the garage")
      const trailing = readLocation(tokens, i);
      if (trailing && trailing.end === tokens.length) {
        location = trailing.location;
        tokens = tokens.slice(0, i);
        break;
      }
    }

    let quantity = 1;
    let explicitQty = false;
    const notes = [];

    // trailing "x3" / "x 3" / "times three"
    const last = tokens[tokens.length - 1].toLowerCase();
    const prevTok = (tokens[tokens.length - 2] || '').toLowerCase();
    let m;
    if (tokens.length > 1 && (m = /^[x×](\d{1,4})$/.exec(last))) {
      quantity = Number(m[1]); explicitQty = true; tokens = tokens.slice(0, -1);
    } else if (tokens.length > 2 && ['x', '×', 'times'].includes(prevTok) && parseNumber(last) !== null) {
      quantity = parseNumber(last); explicitQty = true; tokens = tokens.slice(0, -2);
    }

    // leading article / count
    while (tokens.length > 1 && /^(a|an|the|some|another|of)$/i.test(tokens[0])) tokens.shift();
    if (!explicitQty && tokens.length > 1) {
      const first = tokens[0].toLowerCase();
      let n = null;
      if ((m = /^(\d{1,4})[x×]$/.exec(first))) n = Number(m[1]);
      else n = parseNumber(first);
      const next = (tokens[1] || '').toLowerCase();
      if (n !== null && n > 0 && !UNITS.has(next)) {
        quantity = n;
        explicitQty = true;
        tokens.shift();
        while (tokens.length > 1 && /^(x|×|times|of|pcs|pieces|more)$/i.test(tokens[0])) tokens.shift();
      }
    }
    if (!tokens.length) continue;

    const name = displayName(tokens.join(' ').replace(/[.]+$/, ''));
    const norm = normalize(name);
    if (!norm) continue;

    if (quantity > 20) notes.push(`Large quantity (${quantity}) — check it wasn't part of the name.`);
    if (tokens.length > 6) notes.push('Long phrase — may be several items run together.');

    const key = `${norm}|${location.toLowerCase()}`;
    const existing = byNorm.get(key);
    if (existing) {
      existing.quantity += quantity;
      existing.said += 1;
      existing.stutter ||= hadFiller && !explicitQty;
      continue;
    }
    const item = { name, quantity, details: [], location, notes, said: 1, stutter: false };
    byNorm.set(key, item);
    items.push(item);
  }

  return items.map(({ said, stutter, ...it }) => {
    if (said > 1) {
      it.notes.unshift(
        stutter
          ? `Said ${said} times (once after a hesitation) — counted as ${it.quantity}, verify the quantity.`
          : `Said ${said} times — counted as ${it.quantity}, verify the quantity.`,
      );
    }
    return { ...it, confidence: it.notes.length ? 'low' : 'high' };
  });
}
