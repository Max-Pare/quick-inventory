// Text helpers shared by the parser and the matcher.

const ACRONYMS = new Set([
  'usb', 'hdmi', 'vga', 'dvi', 'led', 'lcd', 'oled', 'ssd', 'hdd', 'sd', 'ram', 'cpu', 'gpu', 'pc',
  'ac', 'dc', 'rj45', 'rj11', 'aa', 'aaa', 'pcb', 'nfc', 'rfid', 'gps', 'ups', 'psu', 'kvm', 'nas',
  'xlr', 'sata', 'nvme', 'tv', 'ir', 'uv', 'pvc', 'diy', 'm2', 'poe', 'sim', 'esp32', 'esp8266',
]);

/** Collapse spelling variants that speech recognisers produce for the same thing. */
function canonicalise(s) {
  return s
    .replace(/\b(usb|type)[\s-]*([abc])\b/gi, (_, a, b) => `${a.toLowerCase()}-${b.toLowerCase()}`)
    .replace(/\bmicro[\s-]*usb\b/gi, 'micro-usb')
    .replace(/\bmini[\s-]*usb\b/gi, 'mini-usb')
    .replace(/\bwi[\s-]*fi\b/gi, 'wifi');
}

function singular(tok) {
  if (tok.length <= 3 || /\d/.test(tok)) return tok;
  if (tok.endsWith('ies')) return tok.slice(0, -3) + 'y';
  if (/(ches|shes|xes|sses)$/.test(tok)) return tok.slice(0, -2);
  if (tok.endsWith('s') && !tok.endsWith('ss') && !tok.endsWith('us')) return tok.slice(0, -1);
  return tok;
}

/** Key used to decide whether two names refer to the same item. */
export function normalize(name) {
  return canonicalise(String(name).toLowerCase())
    .replace(/[^\p{L}\p{N}-]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(singular)
    .join(' ');
}

/** Tidy a spoken name for display: "usb c cable" -> "USB-C cable". */
export function displayName(name) {
  const words = canonicalise(String(name).trim().replace(/\s+/g, ' ')).split(' ');
  const out = words.map((w) => {
    const parts = w.split('-').map((p) => {
      const low = p.toLowerCase();
      if (ACRONYMS.has(low)) return low.toUpperCase();
      // Model numbers such as "4b" or "m3x10" read better upper-cased when short.
      if (/^\d+[a-z]$/i.test(p)) return p.toUpperCase();
      return p;
    });
    // "usb-c" -> "USB-C"
    if (parts.length === 2 && /^[a-z]$/.test(parts[1]) && parts[0] === parts[0].toUpperCase()) {
      parts[1] = parts[1].toUpperCase();
    }
    return parts.join('-');
  });
  const s = out.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function bigrams(s) {
  const m = new Map();
  const t = ` ${s} `;
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}

/** Dice coefficient over character bigrams of the normalised names, 0..1. */
export function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const A = bigrams(na);
  const B = bigrams(nb);
  let overlap = 0;
  let total = 0;
  for (const [g, n] of A) {
    total += n;
    if (B.has(g)) overlap += Math.min(n, B.get(g));
  }
  for (const n of B.values()) total += n;
  return (2 * overlap) / total;
}
