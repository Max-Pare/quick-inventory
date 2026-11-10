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
    .split(/[,;\n!?]+|\.(?=\s|$)|\s+(?:and then|and also|then|also|next|plus)\s+/i)
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
 * @returns {{name:string, quantity:number, details:string[], confidence:'high'|'medium'|'low', notes:string[]}[]}
 */
export function parseHeuristic(transcript) {
  const items = [];
  const byNorm = new Map();

  for (const rawSeg of splitSegments(String(transcript || ''))) {
    let tokens = rawSeg.trim().split(/\s+/).filter(Boolean);
    const before = tokens.length;
    tokens = tokens.filter((t) => !FILLER.test(t.replace(/[^\p{L}]/gu, '')) || /\d/.test(t));
    const hadFiller = tokens.length !== before;
    if (!tokens.length) continue;

    // Attribute-only phrase ("black", "2 meters") describes the previous item.
    if (items.length && isAttributePhrase(tokens)) {
      const prev = items[items.length - 1];
      const detail = tokens.join(' ').toLowerCase();
      if (!prev.details.includes(detail)) prev.details.push(detail);
      continue;
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

    const existing = byNorm.get(norm);
    if (existing) {
      existing.quantity += quantity;
      existing.said += 1;
      existing.stutter ||= hadFiller && !explicitQty;
      continue;
    }
    const item = { name, quantity, details: [], notes, said: 1, stutter: false };
    byNorm.set(norm, item);
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
