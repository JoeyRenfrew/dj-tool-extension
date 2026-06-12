#!/usr/bin/env python3
"""
DJ Eva — Plexamp HTTP API Server (Flask)
Runs on Eva-PC, exposes Plexamp controls + FAISS semantic search to the LAN.
SillyTavern extension and other clients call this instead of dj_plex.py directly.

Base URL: http://eva-pc.ts.net:38250
"""

import sys
import os
import json
import sqlite3
import logging
import socket
import threading
from datetime import datetime

from flask import Flask, jsonify, request

# ── PlexAPI ( Plexamp venv ) ───────────────────────────────────────────────────
sys.path.insert(0, "/home/eva/plexamp-venv/lib/python3.14/site-packages")

import plexapi
from plexapi.server import PlexServer
from plexapi.client import PlexClient

# ── FAISS + numpy ( Plexamp venv ) ────────────────────────────────────────────
import numpy as np
import faiss

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="[DJ-API] %(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("dj_api")

# ── Config ────────────────────────────────────────────────────────────────────
PLEX_URL    = "http://100.65.48.19:32400"
PLEX_TOKEN  = os.environ.get("PLEX_TOKEN", "STXcK326j1emKkEkPrek")
VHX_URL     = "http://192.168.86.100:32500"
VHX_MACHINE = "135bba4e-b108-4a53-b5d1-a23f930d3c67"

DB_PATH     = "/home/eva/music_dj/music_library.db"
FAISS_PATH  = "/home/eva/music_dj/music_vectors.faiss"
ROWS_PATH   = "/home/eva/music_dj/raw_rows.pkl"
API_PORT    = 38250

# ── LAN Plexamp Discovery ─────────────────────────────────────────────────────
# Scans the local subnet for Plexamp instances listening on port 32500.

def _probe_plexamp(host, port=32500, timeout=1.5):
    """Probe a single host for Plexamp. Returns player dict or None."""
    try:
        import urllib.request
        url = f"http://{host}:{port}/resources"
        req = urllib.request.Request(url, headers={"X-Plex-Token": PLEX_TOKEN})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            import xml.etree.ElementTree as ET
            data = ET.fromstring(r.read())
            for p in data.findall("Player"):
                return {
                    "host":       host,
                    "port":       port,
                    "name":       p.attrib.get("title", host),
                    "machineId":  p.attrib.get("machineIdentifier", ""),
                    "product":    p.attrib.get("product", "Plexamp"),
                    "baseUrl":    f"http://{host}:{port}",
                }
    except Exception:
        pass
    return None

def _scan_subnet(subnet="192.168.86", ports=(32500,), timeout=1.5, max_workers=50):
    """Concurrent scan of a /24 subnet for open Plexamp ports.
    Returns list of discovered PlexampPlayer dicts.
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed
    found = []
    # Expand subnet to IPs
    targets = [f"{subnet}.{i}" for i in range(1, 255)]
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futures = {ex.submit(_probe_plexamp, t, 32500, timeout): t for t in targets}
        for fut in as_completed(futures):
            r = fut.result()
            if r:
                found.append(r)
    return found

# Cached discovery result (refreshed on each /clients call)
_clients_cache = []
_clients_cache_time = 0
_CACHE_TTL = 30  # seconds

def get_plexamp_clients(force_refresh=False):
    """Return cached discovered Plexamp clients; refreshes every CACHE_TTL seconds."""
    global _clients_cache, _clients_cache_time
    now = datetime.now().timestamp()
    if force_refresh or not _clients_cache or (now - _clients_cache_time) > _CACHE_TTL:
        log.info("Scanning LAN for Plexamp instances…")
        _clients_cache = _scan_subnet()
        _clients_cache_time = now
        log.info(f"Discovery → {len(_clients_cache)} client(s): {[c['name'] for c in _clients_cache]}")
    return _clients_cache

# ── Plex connection (lazy) ────────────────────────────────────────────────────
_plex_server = None

def get_plex():
    global _plex_server
    if _plex_server is None:
        _plex_server = PlexServer(PLEX_URL, PLEX_TOKEN, timeout=30)
    return _plex_server

def get_music_section():
    return get_plex().library.section("Music")

# ── Flask app (must be before routes) ────────────────────────────────────────
app = Flask(__name__)

# Routes are defined at `/api/dj/...` but nginx strips the prefix.
# Wrap the WSGI app to rewrite /path → /api/dj/path so both work.
class PrefixMiddleware:
    def __init__(self, app, prefix="/api/dj"):
        self.app = app
        self.prefix = prefix
    def __call__(self, environ, start_response):
        path = environ.get("PATH_INFO", "")
        if not path.startswith(self.prefix) and path != "/":
            environ["PATH_INFO"] = self.prefix + path
        return self.app(environ, start_response)

app.wsgi_app = PrefixMiddleware(app.wsgi_app)

@app.before_request
def handle_options_preflight():
    """Handle ALL CORS preflight OPTIONS requests before route handlers run."""
    if request.method == "OPTIONS":
        from flask import make_response
        r = make_response("", 204)
        r.headers["Access-Control-Allow-Origin"]   = "*"
        r.headers["Access-Control-Allow-Methods"]  = "GET, POST, OPTIONS"
        r.headers["Access-Control-Allow-Headers"]  = "Content-Type"
        r.headers["Access-Control-Max-Age"]        = "86400"
        return r

@app.after_request
def add_cors(resp):
    resp.headers["Access-Control-Allow-Origin"]   = "*"
    resp.headers["Access-Control-Allow-Methods"]  = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"]  = "Content-Type"
    resp.headers["Access-Control-Max-Age"]        = "86400"
    return resp

# ── Plex client management ────────────────────────────────────────────────────
_CURRENT_CLIENT_URL  = None
_CURRENT_CLIENT_ID   = None

def get_vhx(clientUrl=None, clientId=None):
    """Return a PlexClient for the target player.

    Strategy (in order):
      1. If clientId given, look for it in active Plex server sessions.
         If found, use the session player's address (Tailscale IP) — this
         avoids direct-TCP failures when the LAN IP isn't reachable from Eva-PC.
      2. If no match but a session exists, use the first active session.
      3. Fallback: direct PlexClient from env/defaults (may fail on subnet mismatch).
    """
    server = get_plex()
    sessions = list(server.sessions())

    # Helper: create PlexClient from a session player
    def _client_from_player(player):
        addr = getattr(player, "address", None)
        if addr:
            base = f"http://{addr}:32500"
        else:
            base = VHX_URL
        mid = getattr(player, "machineIdentifier", None) or getattr(player, "deviceIdentifier", None) or "unknown"
        log.info(f"get_vhx: creating client from session → {base} (mid={mid})")
        return PlexClient(baseurl=base, token=PLEX_TOKEN, identifier=mid, server=server)

    # 1. Match by clientId
    if clientId or _CURRENT_CLIENT_ID:
        cid = clientId or _CURRENT_CLIENT_ID
        for s in sessions:
            player = getattr(s, "player", None)
            if player:
                mid = getattr(player, "machineIdentifier", None) or getattr(player, "deviceIdentifier", None)
                if mid == cid:
                    log.info(f"get_vhx: matched client by ID {cid}")
                    return _client_from_player(player)

    # 2. Match by client URL fallback (prefer session address)
    target_url = clientUrl or _CURRENT_CLIENT_URL or ""
    if target_url:
        for s in sessions:
            player = getattr(s, "player", None)
            if player and getattr(player, "address", None):
                if f"http://{player.address}:32500".rstrip("/") == target_url.rstrip("/"):
                    log.info(f"get_vhx: matched client by address {player.address}")
                    return _client_from_player(player)

    # 3. Use most recent active session
    if sessions:
        player = getattr(sessions[0], "player", None)
        if player and getattr(player, "address", None):
            log.info(f"get_vhx: using first active session → {player.address}")
            return _client_from_player(player)

    # 4. Last resort: direct PlexClient (will fail if on different subnet)
    url = clientUrl or os.environ.get("VHX_URL") or _CURRENT_CLIENT_URL or VHX_URL
    cid = clientId or os.environ.get("VHX_MACHINE") or _CURRENT_CLIENT_ID or VHX_MACHINE
    log.warning(f"get_vhx: no active sessions, direct connect fallback {url}")
    return PlexClient(
        baseurl=url, token=PLEX_TOKEN,
        identifier=cid, server=server
    )

@app.route("/api/dj/clients", methods=["GET", "OPTIONS"])
def list_clients():
    """Discover Plexamp clients on the LAN via concurrent port 32500 scan.
    Falls back to Plex server sessions if no LAN clients found.
    """
    try:
        force = request.args.get("refresh", "").lower() in ("1", "true", "yes")
        lan_clients = get_plexamp_clients(force_refresh=force)
        if lan_clients:
            return ok(data={"clients": lan_clients, "source": "lan"})
        # Fallback: try Plex server sessions
        server = get_plex()
        sessions = []
        try:
            for s in server.sessions():
                if s.player:
                    sessions.append({
                        "clientId":  s.player.deviceIdentifier or s.player.machineIdentifier or "",
                        "name":      s.player.title or s.player.device or "Unknown",
                        "baseUrl":   None,
                        "product":   s.player.product or "",
                        "state":     s.player.state or "unknown",
                    })
        except Exception:
            pass
        return ok(data={"clients": sessions, "source": "plex"})
    except Exception as e:
        log.exception("clients error")
        return err(str(e), 500)

@app.route("/api/dj/set-client", methods=["POST", "OPTIONS"])
def set_client():
    """Set the active Plex client for subsequent commands."""
    global _CURRENT_CLIENT_URL, _CURRENT_CLIENT_ID
    body    = request.get_json(silent=True) or {}
    url     = body.get("baseUrl")
    clientId= body.get("clientId")
    if not url or not clientId:
        return err("baseUrl and clientId are required")
    _CURRENT_CLIENT_URL = url
    _CURRENT_CLIENT_ID  = clientId
    log.info(f"Set client → {url} ({clientId})")
    return ok(msg=f"Client set to {url}")


# ── FAISS index (lazy load) ───────────────────────────────────────────────────
_index = None
_rows   = None

def load_faiss():
    global _index, _rows
    if _index is None:
        log.info(f"Loading FAISS index from {FAISS_PATH}")
        import pickle
        _index = faiss.read_index(FAISS_PATH)
        with open(ROWS_PATH, "rb") as f:
            _rows = pickle.load(f)
        log.info(f"FAISS ready — {_index.ntotal} vectors")
    return _index, _rows

# ── Helpers ───────────────────────────────────────────────────────────────────
def ok(data=None, msg=None, **kwargs):
    out = {"ok": True, "ts": datetime.now().isoformat()}
    if msg:
        out["msg"] = msg
    if data is not None:
        out["data"] = data
    out.update(kwargs)
    return jsonify(out)

def err(msg, status=400):
    return jsonify({"ok": False, "error": msg, "ts": datetime.now().isoformat()}), status

def track_dict(t):
    """Map a plexapi Track object to a clean dict for JSON serialization."""
    try:
        artist_name = t.artist().title
    except Exception:
        artist_name = None
    try:
        album_title = t.album().title
    except Exception:
        album_title = None
    return {
        "key":         t.key,
        "title":       t.title,
        "artist":      artist_name,
        "album":       album_title,
        "duration":    round(t.duration / 1000, 1) if t.duration else None,
        "year":        getattr(t, "year", None),
        "trackNumber": getattr(t, "index", None),
        "ratingKey":   t.ratingKey,
    }

# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/api/dj/ping", methods=["GET", "OPTIONS"])
def ping():
    return ok(msg="pong")

@app.route("/api/dj/status", methods=["GET", "OPTIONS"])
def status():
    """Current playback status via Plex server sessions."""
    try:
        client_url    = request.args.get("client")
        client_id     = request.args.get("clientId")
        server        = get_plex()
        selected      = None
        sessions      = server.sessions()

        if client_id:
            for s in sessions:
                player = getattr(s, "player", None)
                if player and getattr(player, "machineIdentifier", None) == client_id:
                    selected = s
                    break

        if selected is None and client_url:
            # Some older Plex clients advertise baseUrl instead of machine ID.
            for s in sessions:
                player = getattr(s, "player", None)
                if player and client_url in (getattr(player, "baseurl", None), getattr(player, "baseUrl", None)):
                    selected = s
                    break

        if selected is None and len(sessions) == 1:
            selected = sessions[0]

        if selected is None:
            return ok(data={"state": "idle", "playing": False})

        player = getattr(selected, "player", None)
        if player is None:
            return ok(data={"state": "idle", "playing": False})

        track = {
            "ratingKey": getattr(selected, "ratingKey", None),
            "sessionKey": getattr(selected, "sessionKey", None),
            "title": getattr(selected, "title", None),
            "artist": getattr(selected, "grandparentTitle", None) or getattr(selected, "artistTitle", None),
            "album": getattr(selected, "parentTitle", None),
            "duration": (round(getattr(selected, "duration", 0) / 1000, 1)
                         if getattr(selected, "duration", None) else None),
            "year": getattr(selected, "year", None),
            "trackNumber": getattr(selected, "index", None),
        }
        client = {
            "name": getattr(player, "title", None) or getattr(player, "name", None),
            "product": getattr(player, "product", None),
            "machineIdentifier": getattr(player, "machineIdentifier", None),
            "address": getattr(player, "address", None),
            "state": getattr(player, "state", None),
        }

        return ok(data={
            "state":       getattr(player, "state", None) or "unknown",
            "playing":     getattr(player, "state", None) == "playing",
            "paused":      getattr(player, "state", None) == "paused",
            "time":        getattr(selected, "viewOffset", None) or getattr(player, "time", None),
            "duration":    getattr(selected, "duration", None),
            "volume":      getattr(player, "volume", None),
            "track": track,
            "client":      client,
        })
    except Exception as e:
        log.exception("status error")
        return err(str(e), 500)

@app.route("/api/dj/search", methods=["GET", "OPTIONS"])
def search():
    """
    Keyword search against Plex library.
    GET /api/dj/search?q=daft+punk&limit=10
    """
    q     = request.args.get("q", "").strip()
    limit = min(int(request.args.get("limit", 10)), 50)
    if not q:
        return err("q is required")
    try:
        results = get_music_section().search(libtype="track", title=q, limit=limit)
        return ok(data={"tracks": [track_dict(t) for t in results], "query": q, "count": len(results)})
    except Exception as e:
        log.exception("search error")
        return err(str(e), 500)

@app.route("/api/dj/semantic", methods=["GET", "OPTIONS"])
def semantic():
    """
    FAISS semantic / natural-language search.
    GET /api/dj/semantic?q=driving+at+night&limit=10
    """
    q     = request.args.get("q", "").strip()
    limit = min(int(request.args.get("limit", 10)), 50)
    if not q:
        return err("q is required")
    try:
        index, rows = load_faiss()
        model = _get_suggest_model()
        q_emb = model.encode([q], convert_to_numpy=True, normalize_embeddings=True).astype("float32")

        D, I = index.search(q_emb, k=min(limit * 3, index.ntotal))
        seen   = set()
        tracks = []
        for dist, idx in zip(D[0], I[0]):
            if idx < 0 or idx >= len(rows):
                continue
            _, album, title, key = rows[idx]
            if key in seen:
                continue
            seen.add(key)
            try:
                plex_track = get_plex().fetchItem(int(key))
                tracks.append({**track_dict(plex_track), "score": round(float(dist), 4)})
            except Exception:
                tracks.append({"key": key, "title": title, "artist": _, "album": album, "score": round(float(dist), 4)})
            if len(tracks) >= limit:
                break

        return ok(data={"tracks": tracks, "query": q, "count": len(tracks)})
    except Exception as e:
        log.exception("semantic search error")
        return err(str(e), 500)

# ── Suggest: natural language → Joe's library first, enrich from Plex ─────────

_suggest_model = None

def _get_suggest_model():
    global _suggest_model
    if _suggest_model is None:
        sys.path.insert(0, "/home/eva/plexamp-venv/lib/python3.14/site-packages")
        from sentence_transformers import SentenceTransformer
        log.info("Loading sentence transformer for suggest…")
        _suggest_model = SentenceTransformer("BAAI/bge-small-en-v1.5")
        log.info("Sentence transformer ready")
    return _suggest_model

def _build_library_lookup():
    """Fast O(1) lookup from (norm_title, norm_artist) → raw row."""
    index, rows = load_faiss()
    lookup = {}
    for row in rows:
        artist, album, title, key = row
        lookup[(title.lower().strip(), artist.lower().strip())] = row
    return lookup

@app.route("/api/dj/suggest", methods=["POST", "OPTIONS"])
def suggest():
    """
    Natural-language vibe/scene query → semantic search of Joe's library → Plex metadata enrichment.

    Strategy:
      1. Semantic-search Joe's 17k indexed tracks using the natural-language query
         → This is the PRIMARY source — tracks Joe actually owns
      2. For top matches: try to fetch full Plex metadata (artist, genre, year, album)
         → Enrich with what Plex knows for context
      3. ALSO do a Plex keyword search for the same query
         → Compare results — if Plex found something Joe doesn't have, note it
      4. Return: what we found in Joe's library (action=PLAY),
                 and what Plex suggests he could add (action=SUGGEST_ADD)

    POST /api/dj/suggest
    body: { "query": "heist movie music", "limit": 5 }
    """
    body  = request.get_json(silent=True) or {}
    q     = (body.get("query") or "").strip()
    limit = min(int(body.get("limit", 5)), 20)
    if not q:
        return err("query is required")

    try:
        index, rows = load_faiss()
        model = _get_suggest_model()

        # Step 1: Semantic search Joe's 17k library (PRIMARY)
        q_emb = model.encode([q], convert_to_numpy=True, normalize_embeddings=True).astype("float32")
        D, I  = index.search(q_emb, k=limit * 3)
        seen  = set()
        library_tracks = []
        for dist, idx in zip(D[0], I[0]):
            if idx < 0 or idx >= len(rows):
                continue
            artist, album, title, key = rows[idx]
            if key in seen:
                continue
            seen.add(key)
            library_tracks.append({
                "artist":   artist,
                "album":    album,
                "title":    title,
                "key":      key,
                "score":    round(float(dist), 4),
                "keyPath":  f"/library/metadata/{key}",
            })
            if len(library_tracks) >= limit:
                break

        # Step 2: Enrich with Plex metadata (fetch full track data for library matches)
        enriched   = []
        plex_tags  = {}  # key → {genre, year} from Plex
        plex_found = set()
        for lt in library_tracks:
            try:
                plex_t = get_plex().fetchItem(lt["keyPath"])
                try:
                    genre_list = [g.tag for g in getattr(plex_t, "genres", []) or []]
                except Exception:
                    genre_list = []
                try:
                    plex_artist_name = plex_t.artist().title
                except Exception:
                    plex_artist_name = lt["artist"]
                try:
                    plex_album_name = plex_t.album().title
                except Exception:
                    plex_album_name = lt["album"]
                enriched.append({
                    "action":     "PLAY",
                    "available":  True,
                    "from_plex":  True,
                    "ratingKey":  lt["key"],
                    "key":        lt["keyPath"],
                    "title":      plex_t.title,
                    "artist":     plex_artist_name,
                    "album":      plex_album_name,
                    "year":       getattr(plex_t, "year", None),
                    "genre":      genre_list[0] if genre_list else None,
                    "score":      lt["score"],
                    "message":    f"Playing: '{plex_t.title}' by {plex_artist_name}",
                })
                if genre_list:
                    plex_tags[lt["key"]] = {"genre": genre_list[0], "year": getattr(plex_t, "year", None)}
            except Exception as e:
                # Fall back to raw row data
                enriched.append({
                    "action":    "PLAY",
                    "available": True,
                    "from_plex": False,
                    "ratingKey": lt["key"],
                    "key":       lt["keyPath"],
                    "title":     lt["title"],
                    "artist":    lt["artist"],
                    "album":     lt["album"],
                    "year":      None,
                    "genre":     None,
                    "score":     lt["score"],
                    "message":   f"Playing: '{lt['title']}' by {lt['artist']} (library match)",
                })

        # Step 3: Plex keyword search for same query — what else is out there?
        try:
            plex_results = get_music_section().search(libtype="track", title=q, limit=limit * 2)
        except Exception:
            plex_results = []

        add_suggestions = []
        plex_keys_seen  = set()
        for pt in plex_results:
            try:
                pt_key = pt.key
                if pt_key in plex_keys_seen:
                    continue
                plex_keys_seen.add(pt_key)
                # Skip if Joe already has it in his library
                try:
                    pt_artist = pt.artist().title
                except Exception:
                    pt_artist = ""
                norm_title  = pt.title.lower().strip()
                norm_artist = pt_artist.lower().strip()
                # Check if Joe already has this (via enriched results)
                already_have = any(
                    t["ratingKey"] == int(pt_key.split("/")[-1])
                    for t in enriched
                )
                if already_have:
                    continue
                try:
                    genre_list = [g.tag for g in getattr(pt, "genres", []) or []]
                except Exception:
                    genre_list = []
                add_suggestions.append({
                    "action":    "SUGGEST_ADD",
                    "key":       pt_key,
                    "ratingKey": int(pt_key.split("/")[-1]) if "/" in pt_key else pt_key,
                    "title":     pt.title,
                    "artist":    pt_artist,
                    "album":     pt.album().title if getattr(pt, "album", None) else "",
                    "year":      getattr(pt, "year", None),
                    "genre":     genre_list[0] if genre_list else None,
                    "score":     0.0,
                    "message":   f"Add to Plex: '{pt.title}' by {pt_artist}",
                })
            except Exception:
                pass
            if len(add_suggestions) >= 3:
                break

        total_in_library = sum(1 for t in enriched if t["available"])

        return ok(data={
            "query":            q,
            "suggestions":      enriched + add_suggestions,
            "total_in_library": total_in_library,
            "total_found":      len(enriched),
            "library_message":  f"Found {total_in_library} track(s) in your library matching '{q}'."
                                 if total_in_library > 0
                                 else f"Nothing in your library matches '{q}'.",
            "add_message":      (f"Plex also suggests adding: {[s['title'] for s in add_suggestions]}"
                                 if add_suggestions else ""),
        })

    except Exception as e:
        log.exception("suggest error")
        return err(str(e), 500)

@app.route("/api/dj/play", methods=["POST", "OPTIONS"])
def play():
    """
    Play a track by Plex metadata key.
    POST /api/dj/play  {"key": "/library/metadata/7758"}
    or                   {"ratingKey": "7758"}
    """
    body = request.get_json(silent=True) or {}
    key  = body.get("key") or body.get("ratingKey")
    if not key:
        return err("key or ratingKey is required")
    if not str(key).startswith("/library/metadata/"):
        key = f"/library/metadata/{key}"
    try:
        track = get_plex().fetchItem(key)
        url     = body.get("client") or _CURRENT_CLIENT_URL or None
        clientId= body.get("clientId") or _CURRENT_CLIENT_ID or None
        get_vhx(url, clientId).playMedia(track)
        log.info(f"Playing: {track.title}")
        return ok(msg=f"Playing: {track.title}", data={"track": track_dict(track)})
    except Exception as e:
        log.exception("play error")
        return err(str(e), 500)

@app.route("/api/dj/queue", methods=["POST", "OPTIONS"])
def queue():
    """
    Build and play a queue of tracks by ratingKey list.
    POST /api/dj/queue  {"ratingKeys": [7761, 7758, 19625], "shuffle": false}
    """
    body = request.get_json(silent=True) or {}
    rating_keys = body.get("ratingKeys") or body.get("ratingKeys")
    if not rating_keys:
        return err("ratingKeys list is required")
    if not isinstance(rating_keys, list):
        return err("ratingKeys must be a list")
    try:
        url     = body.get("client") or _CURRENT_CLIENT_URL or None
        clientId = body.get("clientId") or _CURRENT_CLIENT_ID or None
        vhx     = get_vhx(url, clientId)
        # Fetch all tracks first
        tracks = [get_plex().fetchItem(f"/library/metadata/{rk}") for rk in rating_keys]
        # Create proper Plex playQueue (server-side, not client-replace)
        from plexapi.playqueue import PlayQueue
        pq = PlayQueue.create(get_plex(), tracks, continuous=0)
        # Tell client to play the queue
        vhx.playMedia(pq)
        log.info(f"Queue: {len(tracks)} tracks → {pq.key}")
        return ok(msg=f"Queue: {len(tracks)} tracks", data={"count": len(tracks), "queueKey": pq.key})
    except Exception as e:
        log.exception("queue error")
        return err(str(e), 500)

@app.route("/api/dj/playnext", methods=["POST", "OPTIONS"])
def playnext():
    """
    Add a track to play next (after current track) in the active queue.
    POST /api/dj/playnext  {"ratingKey": "7758"}
    """
    body = request.get_json(silent=True) or {}
    key  = body.get("key") or body.get("ratingKey")
    if not key:
        return err("key or ratingKey is required")
    if not str(key).startswith("/library/metadata/"):
        key = f"/library/metadata/{key}"
    try:
        track = get_plex().fetchItem(key)
        url     = body.get("client") or _CURRENT_CLIENT_URL or None
        clientId= body.get("clientId") or _CURRENT_CLIENT_ID or None
        vhx     = get_vhx(url, clientId)

        # Get current timeline to find active playQueueID
        from plexapi.playqueue import PlayQueue
        timelines = vhx.timelines()
        pq_id = None
        for tl in timelines:
            if tl.playQueueID:
                pq_id = tl.playQueueID
                break

        if pq_id:
            # Add to existing queue — play next
            pq = PlayQueue.get(get_plex(), pq_id)
            pq.addItem(track, playNext=True)
            pq.refresh()
            log.info(f"playNext: {track.title} added to queue {pq_id}")
            return ok(msg=f"'{track.title}' will play next")
        else:
            # No active queue — just play directly
            vhx.playMedia(track)
            log.info(f"playNext (fallback): {track.title}")
            return ok(msg=f"Playing: {track.title}")
    except Exception as e:
        log.exception("playnext error")
        return err(str(e), 500)

@app.route("/api/dj/control", methods=["POST", "OPTIONS"])
def control():
    """
    Playback controls.
    POST /api/dj/control  {"action": "pause|stop|skipnext|skipprev|resume"}
    """
    body   = request.get_json(silent=True) or {}
    action = (body.get("action") or "").lower()
    if not action:
        return err("action is required")
    try:
        url     = body.get("client") or _CURRENT_CLIENT_URL or None
        clientId= body.get("clientId") or _CURRENT_CLIENT_ID or None
        vhx = get_vhx(url, clientId)
        if   action == "pause":    vhx.pause()
        elif action == "stop":     vhx.stop()
        elif action in ("skipnext", "next"): vhx.skipNext()
        elif action in ("skipprev", "prev"): vhx.skipPrevious()
        elif action in ("resume", "play"):   vhx.play()
        else: return err(f"Unknown action: {action}")
        return ok(msg=f"Done: {action}")
    except Exception as e:
        log.exception("control error")
        return err(str(e), 500)

@app.route("/api/dj/volume", methods=["POST", "OPTIONS"])
def volume():
    """POST /api/dj/volume  {"level": 80}"""
    body = request.get_json(silent=True) or {}
    lvl  = body.get("level")
    if lvl is None:
        return err("level is required (0-100)")
    try:
        url     = body.get("client") or _CURRENT_CLIENT_URL or None
        clientId= body.get("clientId") or _CURRENT_CLIENT_ID or None
        get_vhx(url, clientId).setParameters(volume=int(lvl))
        return ok(msg=f"Volume set to {lvl}")
    except Exception as e:
        log.exception("volume error")
        return err(str(e), 500)

@app.route("/api/dj/library", methods=["GET", "OPTIONS"])
def library():
    """
    Random tracks from the local library (for "play something").
    GET /api/dj/library?limit=10
    """
    limit = min(int(request.args.get("limit", 10)), 50)
    try:
        conn  = sqlite3.connect(DB_PATH)
        rows  = conn.execute(
            "SELECT track_id FROM tracks ORDER BY RANDOM() LIMIT ?",
            (limit * 3,)
        ).fetchall()
        conn.close()
        tracks = []
        seen   = set()
        for (key,) in rows:
            k = str(key)
            if k in seen:
                continue
            seen.add(k)
            try:
                t = get_plex().fetchItem(int(k))
                tracks.append(track_dict(t))
            except Exception:
                pass
            if len(tracks) >= limit:
                break
        return ok(data={"tracks": tracks, "count": len(tracks)})
    except Exception as e:
        log.exception("library error")
        return err(str(e), 500)


# ── Main ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    log.info(f"Starting DJ API on port {API_PORT}")
    app.run(
        host="0.0.0.0",
        port=API_PORT,
        debug=False,
        threaded=True,
        use_reloader=False,
    )
