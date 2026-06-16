# Extension-DJEva — SillyTavern UI Extension

DJ Eva: Plexamp control with natural-language (FAISS) search, keyword search, and `/dj` slash commands. Brings Joe's Plex library into SillyTavern as a first-class interface.

---

## Architecture

```
SillyTavern (Windows laptop)
  └── Extension-DJEva (browser JS)
        └── fetch() → http://eva-pc.ts.net:38250
                          └── dj_api.py (Flask)
                                ├── Plexapi → Plex Server (100.65.48.19)
                                ├── PlexClient → VHX Plexamp (192.168.86.100)
                                └── FAISS index → music_vectors.faiss
```

The DJ API (`dj_api.py`) and Plexamp run on **Eva-PC**. The SillyTavern extension runs in the browser on your Windows laptop. All calls stay on the LAN — no external traffic, no secrets leaving your network.

---

## API Reference

All endpoints return `{"ok": true, "data": ..., "ts": "…"}` on success, `{"ok": false, "error": "…"}` on failure.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/dj/ping` | Liveness check |
| GET | `/api/dj/status` | Current playback state + track info |
| GET | `/api/dj/search?q=<query>&limit=10` | Keyword search in Plex library |
| GET | `/api/dj/semantic?q=<query>&limit=10` | FAISS semantic / natural-language search |
| POST | `/api/dj/play` | `{"key": "/library/metadata/1234"}` |
| POST | `/api/dj/playlist-session` | `{"query":"chill coding","limit":12,"playNext":false,"clientId":"android"}` |
| POST | `/api/dj/playnext` | `{"ratingKey": "7758"}` — queue after current track |
| POST | `/api/dj/control` | `{"action": "pause\|stop\|skipnext\|skipprev\|resume"}` |
| POST | `/api/dj/volume` | `{"level": 80}` |
| GET | `/api/dj/library?limit=30` | Random tracks from local library |

---

## /dj Slash Commands

All via `/dj` (also aliases: `/music`, `/play`):

| Example | What it does |
|---|---|
| `/dj play Daft Punk` | Keyword search → play first result |
| `/dj driving at night songs` | Semantic search → play best match |
| `/dj i want something chill to study to` | Auto-detected semantic → play best match |
| `/dj mood energetic` | AI picks an energetic track |
| `/dj mode=semantic synthwave for coding` | Force semantic search |
| `/dj mode=keyword` | Force keyword search |
| `/dj library` | Random from library |
| `/dj pause\|stop\|skipnext\|resume` | Playback control |
| `/dj volume level=60` | Set volume |
| `/dj play key=7758` | Play by Plex ratingKey |

Also: `/nowplaying` (alias `/np`) — shows what's currently playing.

**LLM function tool:** `action: "playlist"` with `query` or `mood`, optional `limit` (default 12) and `playNext: true` for soft handoff.

---

## Installation

### Step 1 — Start the DJ API on Eva-PC

Copy `dj_api.py` to Eva-PC and register it as a systemd service:

```bash
# On Eva-PC — copy the file
cp /path/to/dj_api.py /home/eva/music_dj/dj_api.py

# Create the systemd unit (replace PLEX_TOKEN with real token)
sudo tee /etc/systemd/system/dj-api.service <<'EOF'
[Unit]
Description=DJ Eva Plexamp HTTP API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=eva
Environment="PLEX_TOKEN=YOUR_REAL_TOKEN_HERE"
ExecStart=/usr/bin/python3 /home/eva/music_dj/dj_api.py
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now dj-api
```

**Important:** Set `PLEX_TOKEN=STXcK3…Prek` (your actual Plex token) in the systemd environment, or export it before running.

### Step 2 — Verify the API is up

```bash
curl http://eva-pc.ts.net:38250/api/dj/ping
# → {"ok": true, "msg": "pong", …}
```

### Step 3 — Install the SillyTavern extension

On your Windows laptop (SillyTavern machine), copy the extension folder to:

```
<sillytavern-root>/public/scripts/extensions/third-party/Extension-DJEva/
```

Then in SillyTavern:
- Go to **Extensions → Manage Extensions**
- Find **DJ Eva — Plexamp** and enable it
- The panel appears in the right settings column (🔊 icon)

---

## Updating the FAISS Index

If you add music to Plex, rebuild the index on Eva-PC:

```bash
python3 /home/eva/music_dj/build_faiss.py
# Then restart the API to pick up the new index:
systemctl restart dj-api
```

---

## Files

```
music_dj/
  dj_api.py      ← Flask HTTP API (run on Eva-PC as systemd service)
  dj_plex.py     ← Original Plexamp CLI (still used for direct access)
  build_library.py   ← Seeds SQLite DB from Plex (run once)
  build_faiss.py     ← Builds FAISS index from SQLite (run after library seed)
  music_library.db   ← SQLite track index
  music_vectors.faiss ← FAISS semantic search index
  raw_rows.pkl   ← Artist/album/track rows for embedding

dj-tool-extension/   ← SillyTavern extension (install to SillyTavern machine)
  manifest.json  ← Extension manifest
  index.js       ← Main extension JS: slash commands, search, playback UI
  style.css      ← Panel styling
  README.md      ← This file
```

---

## Privacy

- All API calls are on your LAN (100.64.0.0/10 and 192.168.86.0/24)
- Plex token stays on Eva-PC in the systemd service environment
- No external services are called — your music stays on your server

---

## Roadmap

- [ ] Per-character playlists (save favorite tracks per character)
- [ ] `/dj lyric` — inject current song lyrics into the LLM prompt
- [ ] Now-playing announcement into chat when a new track starts
- [ ] BPM/key filtering on semantic search results
- [ ] Album art thumbnails in search results