import { html, render, useState, useEffect, useRef, useCallback } from '/vendor/preact.js';

// ---------------------------------------------------------------- storage/api

const ls = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const authHeader = () => ({ authorization: `Bearer ${ls.get('qi.token')}` });

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: { ...authHeader(), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('No connection to the server');
  }
  if (res.status === 401 && ls.get('qi.token')) {
    ls.set('qi.token', null);
    location.reload();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------------------------------------------------------------- small bits

const Icon = {
  mic: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>`,
  stop: html`<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`,
  review: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/></svg>`,
  items: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8M12 13v8"/></svg>`,
  log: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
};

function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}
const splitDetails = (s) => s.split(/[,;]/).map((d) => d.trim()).filter(Boolean);

/** Text input that keeps a local draft and commits on blur / Enter, so live
 *  refreshes from other users never overwrite what is being typed. */
function Field({ value, onCommit, ...rest }) {
  const [draft, setDraft] = useState(value);
  const ref = useRef(null);
  useEffect(() => { if (document.activeElement !== ref.current) setDraft(value); }, [value]);
  const commit = () => { if (draft.trim() !== value) onCommit(draft.trim()); };
  return html`<input type="text" ref=${ref} value=${draft} ...${rest}
    onInput=${(e) => setDraft(e.target.value)} onBlur=${commit}
    onKeyDown=${(e) => { if (e.key === 'Enter') e.target.blur(); }} />`;
}

function Stepper({ value, min = 0, onChange, label }) {
  return html`<div class="stepper" role="group" aria-label=${label}>
    <button type="button" aria-label="Decrease" disabled=${value <= min} onClick=${() => onChange(value - 1)}>−</button>
    <output aria-live="polite">${value}</output>
    <button type="button" aria-label="Increase" onClick=${() => onChange(value + 1)}>+</button>
  </div>`;
}

function Sheet({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);
  return html`<div class="scrim" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="sheet" role="dialog" aria-modal="true" aria-label=${title}>
      <h2>${title}</h2>
      ${children}
    </div>
  </div>`;
}

// ---------------------------------------------------------------- speech

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const IS_ANDROID = /Android/i.test(navigator.userAgent);

/** Continuous dictation on top of the Web Speech API. The browser ends a
 *  recognition session on its own after a pause, so it is restarted until the
 *  user stops it. Each finalised phrase (a pause) becomes one line. */
function useSpeech({ onFinalText, onStopped }) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState('');
  const st = useRef({ rec: null, want: false, session: '' });
  const cb = useRef({});
  cb.current = { onFinalText, onStopped };

  const begin = useCallback(() => {
    const rec = new SR();
    st.current.rec = rec;
    st.current.session = '';
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.continuous = !IS_ANDROID; // Android Chrome duplicates results in continuous mode
    rec.onresult = (e) => {
      const finals = [];
      let live = '';
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finals.push(r[0].transcript.trim());
        else live += r[0].transcript;
      }
      st.current.session = finals.filter(Boolean).join('\n');
      cb.current.onFinalText(st.current.session, false);
      setInterim(live.trim());
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      st.current.want = false;
      setError(
        e.error === 'not-allowed' || e.error === 'service-not-allowed'
          ? 'Microphone access was blocked. Allow it in the browser settings, or type instead.'
          : e.error === 'network' ? 'Speech recognition needs a network connection.'
          : `Speech recognition failed (${e.error}).`,
      );
    };
    rec.onend = () => {
      cb.current.onFinalText(st.current.session, true); // commit this session's lines
      setInterim('');
      if (st.current.want) {
        try { begin(); return; } catch { st.current.want = false; }
      }
      setListening(false);
      cb.current.onStopped();
    };
    rec.start();
  }, []);

  const start = useCallback(() => {
    setError('');
    st.current.want = true;
    try { begin(); setListening(true); } catch (err) { st.current.want = false; setError(String(err.message || err)); }
  }, [begin]);
  const stop = useCallback(() => {
    st.current.want = false;
    try { st.current.rec?.stop(); } catch { /* already stopped */ }
  }, []);
  useEffect(() => () => { st.current.want = false; try { st.current.rec?.abort(); } catch { /* noop */ } }, []);

  return { supported: Boolean(SR), listening, interim, error, start, stop };
}

// ---------------------------------------------------------------- onboarding

function Onboard({ me, onDone }) {
  const joinParam = new URLSearchParams(location.search).get('join') || '';
  const [name, setName] = useState('');
  const [invName, setInvName] = useState('');
  const [code, setCode] = useState(joinParam);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const run = async (fn) => {
    setBusy(true); setErr('');
    try { await fn(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const signup = () => run(async () => {
    const { token } = await api('POST', '/users', { name });
    ls.set('qi.token', token);
    await onDone();
  });
  const create = () => run(async () => {
    const inv = await api('POST', '/inventories', { name: invName });
    history.replaceState(null, '', '/');
    await onDone(inv.id);
  });
  const join = () => run(async () => {
    const inv = await api('POST', '/inventories/join', { code });
    history.replaceState(null, '', '/');
    await onDone(inv.id);
  });

  return html`<div class="app"><div class="onboard stack">
    <img class="logo" src="/icon.svg" alt="" />
    <h1>Quickinv</h1>
    <p class="muted">Say what you see. Review it. Done.</p>
    ${err && html`<p class="notice" role="alert">${err}</p>`}
    ${!me ? html`
      <form class="stack" onSubmit=${(e) => { e.preventDefault(); signup(); }}>
        <label class="field">Your name
          <input type="text" value=${name} onInput=${(e) => setName(e.target.value)} maxlength="40" autocomplete="given-name" placeholder="Shown to your teammates" />
        </label>
        <button class="btn primary block" disabled=${busy || !name.trim()}>Continue</button>
      </form>
    ` : html`
      <p>Hi ${me.user.name}.</p>
      <form class="stack" onSubmit=${(e) => { e.preventDefault(); join(); }}>
        <label class="field">Join with a code
          <input type="text" value=${code} onInput=${(e) => setCode(e.target.value.toUpperCase())} maxlength="12" autocapitalize="characters" autocomplete="off" placeholder="8 characters" />
        </label>
        <button class="btn ${joinParam ? 'primary' : ''} block" disabled=${busy || code.trim().length < 8}>Join inventory</button>
      </form>
      <div class="or">or</div>
      <form class="stack" onSubmit=${(e) => { e.preventDefault(); create(); }}>
        <label class="field">Start a new inventory
          <input type="text" value=${invName} onInput=${(e) => setInvName(e.target.value)} maxlength="60" placeholder="e.g. Garage, Lab 2, Office" />
        </label>
        <button class="btn ${joinParam ? '' : 'primary'} block" disabled=${busy || !invName.trim()}>Create inventory</button>
      </form>
    `}
  </div></div>`;
}

// ---------------------------------------------------------------- capture

function Capture({ invId, llm, onCaptured, goReview, pending }) {
  const locKey = `qi.loc.${invId}`;
  const [place, setPlace] = useState(ls.get(locKey) || '');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null);
  const base = useRef('');      // lines committed by earlier recognition sessions
  const textRef = useRef('');
  textRef.current = text;
  const placeRef = useRef(place);
  placeRef.current = place;

  const send = useCallback(async () => {
    const transcript = textRef.current.trim();
    if (!transcript) return;
    setBusy(true); setErr('');
    try {
      const res = await api('POST', `/inventories/${invId}/captures`, { transcript, location: placeRef.current.trim() });
      base.current = '';
      setText('');
      setResult(res);
      onCaptured();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }, [invId, onCaptured]);

  const speech = useSpeech({
    onFinalText: (session, commit) => {
      const joined = [base.current, session].filter(Boolean).join('\n');
      setText(joined);
      if (commit) base.current = joined;
    },
    onStopped: () => { send(); },
  });

  const toggle = () => {
    if (speech.listening) return speech.stop();
    setResult(null);
    base.current = textRef.current.trim();
    speech.start();
  };

  return html`<div class="stack">
    <label class="field">Where are you? <span>(applied to everything you add)</span>
      <input type="text" value=${place} maxlength="80" placeholder="e.g. Shelf A, top drawer — optional"
        onInput=${(e) => { setPlace(e.target.value); ls.set(locKey, e.target.value); }} />
    </label>

    <div class="mic-wrap">
      <button class="mic ${speech.listening ? 'on' : ''}" onClick=${toggle} disabled=${!speech.supported || busy}
        aria-pressed=${speech.listening} aria-label=${speech.listening ? 'Stop listening' : 'Start listening'}>
        ${speech.listening ? Icon.stop : Icon.mic}
      </button>
      <p class="muted small center" aria-live="polite">
        ${!speech.supported ? 'Voice input isn’t available in this browser. Type below, or use your keyboard’s dictation key.'
          : busy ? 'Working out what you said…'
          : speech.listening ? 'Listening — just list things. Tap to finish.'
          : 'Tap and list what you see'}
      </p>
    </div>

    ${(speech.error || err) && html`<p class="notice" role="alert">${speech.error || err}</p>`}

    <label class="field">Transcript
      <textarea value=${text} readonly=${speech.listening} placeholder="usb c cable, raspberry pi 4b, duct tape, black…"
        onInput=${(e) => { setText(e.target.value); }}></textarea>
    </label>
    <p class="interim" aria-hidden="true">${speech.interim}</p>

    ${!speech.listening && text.trim() && html`<div class="actions">
      <button class="btn" onClick=${() => { base.current = ''; setText(''); }} disabled=${busy}>Clear</button>
      <button class="btn primary" onClick=${send} disabled=${busy}>${busy ? 'Sending…' : 'Send to review'}</button>
    </div>`}

    ${result && html`<div class="ok stack" role="status">
      <p>${result.proposals.length
        ? html`<b>${result.proposals.length} ${result.proposals.length === 1 ? 'item' : 'items'}</b> waiting for review: ${result.proposals.map((p) => `${p.name}${p.quantity > 1 ? ` ×${p.quantity}` : ''}`).join(', ')}`
        : 'Nothing that looks like an item was heard.'}</p>
      ${result.warning && html`<p class="notice">${result.warning}</p>`}
      ${result.proposals.length > 0 && html`<button class="btn primary" onClick=${goReview}>Review now</button>`}
    </div>`}
    ${!result && pending > 0 && html`<button class="btn" onClick=${goReview}>${pending} waiting for review</button>`}
    ${!llm && html`<p class="muted small center">Basic parser in use — the server has no AI key configured.</p>`}
  </div>`;
}

// ---------------------------------------------------------------- review

function Proposal({ p, base, act }) {
  const patch = (body) => act(() => api('PATCH', `${base}/proposals/${p.id}`, body));
  const flagged = p.notes.length > 0 || p.confidence === 'low';
  return html`<div class="card proposal ${flagged ? 'flagged' : ''}">
    <div class="row">
      <div class="grow"><${Field} class="name" value=${p.name} aria-label="Item name" maxlength="200" onCommit=${(v) => v && patch({ name: v })} /></div>
      <${Stepper} value=${p.quantity} min=${1} label="Quantity" onChange=${(q) => patch({ quantity: q })} />
    </div>
    <div class="two">
      <label class="field">Details
        <${Field} value=${p.details.join(', ')} placeholder="colour, size…" onCommit=${(v) => patch({ details: splitDetails(v) })} />
      </label>
      <label class="field">Location
        <${Field} value=${p.location} placeholder="—" maxlength="80" onCommit=${(v) => patch({ location: v })} />
      </label>
    </div>
    ${p.notes.map((n) => html`<p class="notice">${n}</p>`)}
    ${p.match && html`<label class="match">
      <input type="checkbox" checked=${p.merge} onChange=${(e) => patch({ merge: e.target.checked })} />
      <span>${p.match.kind === 'exact' ? 'Add to existing' : 'Same as existing'} <b>${p.match.name}</b> (have ${p.match.quantity}${p.match.location ? `, ${p.match.location}` : ''})${p.match.kind === 'similar' ? '?' : ''}</span>
    </label>`}
    <div class="actions">
      <button class="btn danger" onClick=${() => act(() => api('POST', `${base}/proposals/${p.id}/reject`))}>Reject</button>
      <button class="btn primary" onClick=${() => act(() => api('POST', `${base}/proposals/${p.id}/accept`))}>${p.merge ? `Add ${p.quantity}` : 'Accept'}</button>
    </div>
  </div>`;
}

function Review({ state, base, act }) {
  if (!state.proposals.length) {
    return html`<div class="empty"><p><b>Nothing to review</b></p><p class="small">Items you dictate show up here before they enter the inventory.</p></div>`;
  }
  return html`<div class="stack">
    <button class="btn primary block" onClick=${() => act(() => api('POST', `${base}/proposals/accept-all`))}>
      Accept all ${state.proposals.length}
    </button>
    ${state.captures.map((c) => html`
      <div class="cap-head" key=${`c${c.id}`}>
        ${c.user_name} · ${ago(c.created_at)}${c.location ? ` · ${c.location}` : ''}
        <q>${c.transcript.replace(/\n/g, ' / ')}</q>
      </div>
      ${state.proposals.filter((p) => p.capture_id === c.id).map((p) => html`<${Proposal} key=${p.id} p=${p} base=${base} act=${act} />`)}
    `)}
  </div>`;
}

// ---------------------------------------------------------------- items

function ItemSheet({ item, base, act, onClose }) {
  const isNew = !item.id;
  const [f, setF] = useState({ name: item.name || '', quantity: item.quantity ?? 1, details: (item.details || []).join(', '), location: item.location || '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = () => {
    const body = { name: f.name, quantity: Math.max(0, Math.round(Number(f.quantity)) || 0), details: splitDetails(f.details), location: f.location };
    act(() => (isNew ? api('POST', `${base}/items`, body) : api('PATCH', `${base}/items/${item.id}`, body))).then((ok) => ok && onClose());
  };
  const remove = () => {
    if (confirm(`Delete “${item.name}” from the inventory?`)) act(() => api('DELETE', `${base}/items/${item.id}`)).then((ok) => ok && onClose());
  };
  return html`<${Sheet} title=${isNew ? 'Add item' : 'Edit item'} onClose=${onClose}>
    <form class="stack" onSubmit=${(e) => { e.preventDefault(); save(); }}>
      <label class="field">Name<input type="text" value=${f.name} onInput=${set('name')} maxlength="200" /></label>
      <label class="field">Quantity<input type="number" inputmode="numeric" min="0" step="1" value=${f.quantity} onInput=${set('quantity')} /></label>
      <label class="field">Details (comma separated)<input type="text" value=${f.details} onInput=${set('details')} /></label>
      <label class="field">Location<input type="text" value=${f.location} onInput=${set('location')} maxlength="80" /></label>
      <div class="actions">
        ${!isNew && html`<button type="button" class="btn danger" onClick=${remove}>Delete</button>`}
        <button type="button" class="btn" onClick=${onClose}>Cancel</button>
        <button class="btn primary" disabled=${!f.name.trim()}>Save</button>
      </div>
    </form>
  <//>`;
}

function Items({ state, base, act, toast }) {
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null);
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? state.items.filter((i) => [i.name, i.location, ...i.details].join(' ').toLowerCase().includes(needle))
    : state.items;
  const total = state.items.reduce((n, i) => n + i.quantity, 0);

  const exportCsv = async () => {
    try {
      const res = await fetch(`/api${base}/export.csv`, { headers: authHeader() });
      if (!res.ok) throw new Error('Export failed');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await res.blob());
      a.download = `${state.inventory.name.replace(/[^\w-]+/g, '_') || 'inventory'}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) { toast(e.message); }
  };

  return html`<div class="stack">
    <div class="row">
      <input class="grow" type="search" value=${q} onInput=${(e) => setQ(e.target.value)} placeholder="Search ${state.items.length} items" aria-label="Search items" />
      <button class="btn" onClick=${() => setEditing({})}>Add</button>
    </div>
    ${state.items.length === 0
      ? html`<div class="empty"><p><b>No items yet</b></p><p class="small">Dictate some on the Capture tab.</p></div>`
      : html`<div class="card" style="padding: 2px 14px">
          ${shown.map((i) => html`<div class="item ${i.quantity === 0 ? 'zero' : ''}" key=${i.id}>
            <button class="main" onClick=${() => setEditing(i)} aria-label="Edit ${i.name}">
              <b>${i.name}</b>
              ${(i.details.length > 0 || i.location) && html`<span>${[...i.details, i.location && `@ ${i.location}`].filter(Boolean).join(' · ')}</span>`}
            </button>
            <${Stepper} value=${i.quantity} label="Quantity of ${i.name}" onChange=${(n) => act(() => api('PATCH', `${base}/items/${i.id}`, { quantity: n }))} />
          </div>`)}
          ${shown.length === 0 && html`<p class="empty">No match for “${q}”.</p>`}
        </div>
        <div class="row">
          <span class="muted small grow">${state.items.length} lines · ${total} units</span>
          <button class="btn ghost" onClick=${exportCsv}>Export CSV</button>
        </div>`}
    ${editing && html`<${ItemSheet} item=${editing} base=${base} act=${act} onClose=${() => setEditing(null)} />`}
  </div>`;
}

// ---------------------------------------------------------------- log

function describe(e) {
  const d = e.data || {};
  switch (e.action) {
    case 'inventory.created': return html`created the inventory <b>${d.name}</b>`;
    case 'member.joined': return 'joined';
    case 'capture.created': return html`dictated ${d.proposed} ${d.proposed === 1 ? 'item' : 'items'}${d.location ? ` at ${d.location}` : ''}: <q>${String(d.transcript || '').replace(/\n/g, ' / ')}</q>`;
    case 'item.created': return html`${d.manual ? 'added' : 'accepted'} <b>${d.name}</b> ×${d.quantity}`;
    case 'item.merged': return html`added ${d.added} to <b>${d.name}</b> (now ${d.quantity})${d.said && d.said !== d.name ? ` — heard as “${d.said}”` : ''}`;
    case 'item.updated': return html`edited <b>${d.name}</b>: ${Object.entries(d.changes || {}).map(([k, v]) => `${k} ${JSON.stringify(v.from)} → ${JSON.stringify(v.to)}`).join(', ')}`;
    case 'item.deleted': return html`deleted <b>${d.name}</b> (was ×${d.quantity})`;
    case 'proposal.rejected': return html`rejected <b>${d.name}</b> ×${d.quantity}`;
    default: return e.action;
  }
}

function Log({ base, version }) {
  const [entries, setEntries] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    api('GET', `${base}/audit`).then((r) => live && setEntries(r.entries)).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [base, version]);
  const more = async () => {
    try {
      const r = await api('GET', `${base}/audit?before=${entries[entries.length - 1].id}`);
      setEntries([...entries, ...r.entries]);
    } catch (e) { setErr(e.message); }
  };
  if (err) return html`<p class="notice" role="alert">${err}</p>`;
  if (!entries) return html`<p class="empty">Loading…</p>`;
  return html`<div class="stack">
    <div class="card" style="padding: 2px 14px">
      ${entries.map((e) => html`<div class="log" key=${e.id}>
        <span><b>${e.user_name || 'Someone'}</b> ${describe(e)}</span>
        <time datetime=${e.created_at}>${ago(e.created_at)}</time>
      </div>`)}
    </div>
    ${entries.length > 0 && entries.length % 100 === 0 && html`<button class="btn" onClick=${more}>Load older</button>`}
  </div>`;
}

// ---------------------------------------------------------------- menu

function Menu({ me, state, onSwitch, onNew, onClose, toast }) {
  const inv = state.inventory;
  const link = `${location.origin}/?join=${inv.join_code}`;
  const share = async () => {
    try {
      if (navigator.share) await navigator.share({ title: `Quickinv: ${inv.name}`, text: `Join “${inv.name}” on Quickinv`, url: link });
      else { await navigator.clipboard.writeText(link); toast('Invite link copied'); }
    } catch { /* share sheet dismissed */ }
  };
  return html`<${Sheet} title=${inv.name} onClose=${onClose}>
    <div class="stack">
      <div class="card stack">
        <p class="muted small center">Invite code — anyone with it can join and edit</p>
        <p class="code">${inv.join_code}</p>
        <button class="btn primary block" onClick=${share}>Share invite link</button>
        <p class="muted small">Members: ${inv.members.map((m) => m.name).join(', ')}</p>
      </div>
      ${me.inventories.length > 1 && html`<div class="stack">
        <p class="muted small">Your inventories</p>
        ${me.inventories.map((i) => html`<button class="list-btn" key=${i.id} aria-current=${i.id === inv.id} onClick=${() => onSwitch(i.id)}>
          <span>${i.name}</span>${i.pending > 0 && html`<span class="muted small">${i.pending} to review</span>`}
        </button>`)}
      </div>`}
      <button class="btn block" onClick=${onNew}>Create or join another inventory</button>
      <p class="muted small center">Signed in as ${me.user.name}</p>
    </div>
  <//>`;
}

// ---------------------------------------------------------------- app

function useLive(invId, onChange) {
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    if (!invId) return undefined;
    const ctl = new AbortController();
    let stopped = false;
    (async () => {
      let delay = 1000;
      while (!stopped) {
        try {
          const res = await fetch(`/api/inventories/${invId}/events`, { headers: authHeader(), signal: ctl.signal });
          if (!res.ok || !res.body) throw new Error('stream unavailable');
          delay = 1000;
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              if (buf.slice(0, i).includes('"changed"')) cb.current();
              buf = buf.slice(i + 2);
            }
          }
        } catch { /* reconnect below */ }
        if (stopped) break;
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 15000);
        if (!stopped) cb.current(); // catch up on anything missed while disconnected
      }
    })();
    const onVisible = () => { if (document.visibilityState === 'visible') cb.current(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { stopped = true; ctl.abort(); document.removeEventListener('visibilitychange', onVisible); };
  }, [invId]);
}

function App() {
  const [me, setMe] = useState(undefined); // undefined = loading, null = signed out
  const [invId, setInvId] = useState(Number(ls.get('qi.inv')) || null);
  const [adding, setAdding] = useState(false);
  const [state, setState] = useState(null);
  const [version, setVersion] = useState(0);
  const [tab, setTab] = useState('capture');
  const [menu, setMenu] = useState(false);
  const [llm, setLlm] = useState(true);
  const [toastMsg, setToastMsg] = useState('');
  const toastTimer = useRef(0);

  const toast = useCallback((msg) => {
    setToastMsg(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(''), 3500);
  }, []);

  const loadMe = useCallback(async (selectId) => {
    if (!ls.get('qi.token')) { setMe(null); return; }
    try {
      const data = await api('GET', '/me');
      setMe(data);
      const ids = data.inventories.map((i) => i.id);
      const pick = selectId && ids.includes(selectId) ? selectId : null;
      setInvId((cur) => {
        const next = pick ?? (ids.includes(cur) ? cur : ids[0] ?? null);
        ls.set('qi.inv', next ? String(next) : null);
        return next;
      });
      if (pick) { setAdding(false); setState(null); }
    } catch (e) { toast(e.message); setMe((m) => m ?? null); }
  }, [toast]);

  const refresh = useCallback(async () => {
    if (!invId) return;
    try {
      const s = await api('GET', `/inventories/${invId}/state`);
      setState(s);
      setVersion((v) => v + 1);
    } catch (e) { toast(e.message); }
  }, [invId, toast]);

  useEffect(() => { loadMe(); api('GET', '/config').then((c) => setLlm(c.llm)).catch(() => {}); }, [loadMe]);
  useEffect(() => { setState(null); refresh(); }, [refresh]);
  useLive(invId, refresh);

  /** Run a mutation, surface failures, and resync. Resolves true on success. */
  const act = useCallback(async (fn) => {
    try { await fn(); return true; } catch (e) { toast(e.message); return false; } finally { refresh(); }
  }, [refresh, toast]);

  if (me === undefined) return html`<div class="app"><p class="empty">Loading…</p></div>`;
  if (!me || !invId || adding || new URLSearchParams(location.search).get('join')) {
    return html`<${Onboard} me=${me} onDone=${loadMe} />`;
  }
  if (!state || state.inventory.id !== invId) return html`<div class="app"><p class="empty">Loading…</p></div>`;

  const base = `/inventories/${invId}`;
  const pending = state.proposals.length;
  const tabs = [
    ['capture', 'Capture', Icon.mic],
    ['review', 'Review', Icon.review],
    ['items', 'Items', Icon.items],
    ['log', 'Log', Icon.log],
  ];

  return html`<div class="app">
    <header class="top">
      <button class="inv" onClick=${() => setMenu(true)} aria-haspopup="dialog">${state.inventory.name}<small>▾</small></button>
      <button class="btn ghost" onClick=${() => setMenu(true)}>Share</button>
    </header>
    <main>
      ${tab === 'capture' && html`<${Capture} invId=${invId} llm=${llm} pending=${pending} onCaptured=${refresh} goReview=${() => setTab('review')} />`}
      ${tab === 'review' && html`<${Review} state=${state} base=${base} act=${act} />`}
      ${tab === 'items' && html`<${Items} state=${state} base=${base} act=${act} toast=${toast} />`}
      ${tab === 'log' && html`<${Log} base=${base} version=${version} />`}
    </main>
    <nav class="tabs" aria-label="Sections"><div>
      ${tabs.map(([id, label, icon]) => html`<button key=${id} aria-current=${tab === id ? 'page' : undefined} onClick=${() => setTab(id)}>
        ${icon}${label}
        ${id === 'review' && pending > 0 && html`<span class="badge" aria-label="${pending} waiting">${pending}</span>`}
      </button>`)}
    </div></nav>
    ${menu && html`<${Menu} me=${me} state=${state} toast=${toast} onClose=${() => setMenu(false)}
      onSwitch=${(id) => { setMenu(false); ls.set('qi.inv', String(id)); setInvId(id); }}
      onNew=${() => { setMenu(false); setAdding(true); }} />`}
    ${toastMsg && html`<div class="toast" role="status">${toastMsg}</div>`}
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
