# Quickinv

Voice-first shared inventory for an office, lab, garage — anything small to medium.
Walk around, say what you see, review what was understood, done.

> "usb C cable, uuuuh usb C cable, raspberry pi 4b, duct tape, black, lightning phone charger"

becomes a review queue of: **USB-C cable ×2** (flagged: said twice after a hesitation — verify), **Raspberry pi 4B**, **Duct tape** (black), **Lightning phone charger**.

## How it works

1. **Capture** — tap the mic and list things. Speech is transcribed in the browser (Web Speech API); you can also type or use keyboard dictation. An optional "where are you" is applied to everything in the capture.
2. **Parse** — the server turns the transcript into line items: with Claude if `ANTHROPIC_API_KEY` is set, otherwise (and on any AI failure) with a built-in heuristic parser.
3. **Review** — nothing enters the inventory unreviewed. Each proposal can be edited, accepted or rejected. Ambiguities are flagged, and proposals are matched to existing items (exact name → "add to existing" by default; similar name → suggestion).
4. **Audit log** — every capture (with its raw transcript), accept, merge, edit, delete and rejection is recorded with who and when.

Inventories are shared with an 8-character invite code or link. Everyone on the same inventory sees changes live.

## Run

Requires Node ≥ 22.13.

```sh
npm install
npm start                      # http://localhost:3000
ANTHROPIC_API_KEY=sk-... npm start   # with AI parsing
npm test
```

Or `docker build -t quickinv . && docker run -p 3000:3000 -v quickinv:/data -e ANTHROPIC_API_KEY quickinv`.

**Phones need HTTPS** for microphone access (localhost is exempt). Put it behind a TLS reverse proxy (Caddy, Tailscale Serve, Cloudflare Tunnel…), then open the URL and "Add to Home Screen".

| Variable | Default | |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | |
| `QUICKINV_DB` | `data/quickinv.db` | SQLite file |
| `ANTHROPIC_API_KEY` | – | enables AI parsing |
| `QUICKINV_MODEL` | `claude-opus-5-5` | model used for parsing |
| `QUICKINV_LLM` | – | `off` forces the heuristic parser |

## Limitations

- **Auth is deliberately light**: a display name plus a per-device token, no passwords or account recovery; clearing browser data loses the identity. Anyone with an invite code can join and edit. Fine for a team on a private network or behind an authenticating proxy; not hardened for the open internet (no rate limiting).
- Voice input depends on the browser: Chrome/Edge/Safari support it, Firefox does not (type or use keyboard dictation). Recognition language follows the browser language.
- No offline capture, photos, barcodes, roles, or undo-from-log yet.

## Layout

```
server/        Hono API + SQLite (node:sqlite), parsers in server/parse/
web/           no-build PWA (Preact + htm)
test/          node:test — parser and API flow
```
