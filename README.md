# Quickinv

Voice-first shared inventory for an office, lab, garage — anything small to medium.
Walk around, say what you see, review what was understood, done.

> "usb C cable, uuuuh usb C cable, raspberry pi 4b, duct tape, black, lightning phone charger"

becomes a review queue of: **USB-C cable ×2** (flagged: said twice after a hesitation — verify), **Raspberry pi 4B**, **Duct tape** (black), **Lightning phone charger**.

## How it works

1. **Capture** — tap the mic and list things. Speech is transcribed in the browser (Web Speech API); you can also type or use keyboard dictation. An optional "where are you" is applied to everything in the capture.
2. **Parse** — the server turns the transcript into line items: with a local model if `QUICKINV_LOCAL_URL` is set, with Claude if `ANTHROPIC_API_KEY` is set, otherwise (and on any model failure) with a built-in heuristic parser.
3. **Review** — nothing enters the inventory unreviewed. Each proposal can be edited, accepted or rejected. Ambiguities are flagged, and proposals are matched to existing items (exact name → "add to existing" by default; similar name → suggestion).
4. **Audit log** — every capture (with its raw transcript), accept, merge, edit, delete and rejection is recorded with who and when.

Inventories are shared with an 8-character invite code or link. Everyone on the same inventory sees changes live.

## Run

Requires Node ≥ 22.13.

```sh
npm install
npm start                      # http://localhost:3000
ANTHROPIC_API_KEY=sk-... npm start   # AI parsing with Claude
QUICKINV_LOCAL_URL=http://localhost:11434/v1 QUICKINV_LOCAL_MODEL=llama3.1 npm start   # AI parsing with a local model
npm test
```

Or `docker build -t quickinv . && docker run -p 3000:3000 -v quickinv:/data -e ANTHROPIC_API_KEY quickinv`.

**Phones need HTTPS** for microphone access (localhost is exempt). Put it behind a TLS reverse proxy (Caddy, Tailscale Serve, Cloudflare Tunnel…), then open the URL and "Add to Home Screen".

| Variable | Default | |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | |
| `QUICKINV_DB` | `data/quickinv.db` | SQLite file |
| `QUICKINV_LOCAL_URL` | – | base URL of an OpenAI-compatible API; enables local-model parsing |
| `QUICKINV_LOCAL_MODEL` | `llama3.1` | model name to request from it |
| `QUICKINV_LOCAL_API_KEY` | – | bearer token, if the server wants one |
| `QUICKINV_LOCAL_TIMEOUT_MS` | `120000` | per-request timeout |
| `ANTHROPIC_API_KEY` | – | enables parsing with Claude |
| `QUICKINV_MODEL` | `claude-opus-5-5` | Claude model used for parsing |
| `QUICKINV_LLM` | auto | `local`, `claude` or `off`. Auto prefers a configured local model, then Claude |

### Local models

Any server that speaks the OpenAI `/v1/chat/completions` API works; transcripts then never leave your network.

| Server | `QUICKINV_LOCAL_URL` |
|---|---|
| Ollama | `http://localhost:11434/v1` |
| llama.cpp `llama-server` | `http://localhost:8080/v1` |
| LM Studio | `http://localhost:1234/v1` |
| vLLM | `http://localhost:8000/v1` |

Quickinv asks for schema-constrained JSON and steps down to JSON mode, then plain prompting, if the server rejects that. Replies are repaired where possible (reasoning tags, code fences, missing fields); if the model is unreachable or returns garbage, the heuristic parser takes over and the capture is marked for careful review. From Docker, `localhost` is the container: use `http://host.docker.internal:11434/v1` (on Linux add `--add-host=host.docker.internal:host-gateway`).

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
