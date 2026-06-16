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
import random
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

DB_PATH     = "/home/eva/music_dj/music_library.db"
FAISS_PATH  = "/home/eva/music_dj/music_vectors.faiss"
ROWS_PATH   = "/home/eva/music_dj/raw_rows.pkl"
API_PORT    = 38250
PLEXAMP_PORT = 32500
PLEXAMP_CONNECT_TIMEOUT = float(os.environ.get("PLEXAMP_CONNECT_TIMEOUT", "3"))
PREFERRED_CLIENT = os.environ.get("PREFERRED_CLIENT", "auto").strip().lower()

# Registered playback targets (eva-pc is index/API only — no local Plexamp).
CLIENT_REGISTRY = {
    "android": {
        "name": "Android",
        "machineId": os.environ.get(
            "CLIENT_ANDROID_MACHINE",
            "b36d9adf-d9c9-40b6-981a-9f3531e741e6",
        ),
        "baseUrl": os.environ.get(
            "CLIENT_ANDROID_URL",
            "http://192.168.86.185:32500",
        ),
    },
    "vectorhxai": {
        "name": "VECTORHXAI",
        "machineId": os.environ.get(
            "CLIENT_VECTORHXAI_MACHINE",
            os.environ.get("VHX_MACHINE", "135bba4e-b108-4a53-b5d1-a23f930d3c67"),
        ),
        "baseUrl": os.environ.get("CLIENT_VECTORHXAI_URL", ""),
    },
}

# ── LAN Plexamp Discovery (optional; supplements registry base URLs) ─────────

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


def _player_machine_id(player):
    return (
        getattr(player, "machineIdentifier", None)
        or getattr(player, "deviceIdentifier", None)
        or ""
    )


def _player_base_url(player):
    addr = getattr(player, "address", None)
    if addr:
        return f"http://{addr}:{PLEXAMP_PORT}"
    return None


def _registry_by_machine_id(machine_id):
    if not machine_id:
        return None
    mid = machine_id.strip().lower()
    for alias, entry in CLIENT_REGISTRY.items():
        if entry.get("machineId", "").lower() == mid:
            return {**entry, "alias": alias}
    return None


def _registry_by_alias(alias):
    if not alias:
        return None
    key = alias.strip().lower()
    if key in CLIENT_REGISTRY:
        return {**CLIENT_REGISTRY[key], "alias": key}
    return None


def _resolve_target_machine_id(clientId=None, clientUrl=None):
    """Resolve desired player machine ID from explicit args, sticky state, or preference."""
    cid = (clientId or _CURRENT_CLIENT_ID or "").strip()
    if cid:
        reg = _registry_by_alias(cid) or _registry_by_machine_id(cid)
        if reg:
            return reg["machineId"], reg.get("baseUrl") or clientUrl or _CURRENT_CLIENT_URL
        return cid, clientUrl or _CURRENT_CLIENT_URL

    if PREFERRED_CLIENT in CLIENT_REGISTRY:
        reg = _registry_by_alias(PREFERRED_CLIENT)
        return reg["machineId"], reg.get("baseUrl") or clientUrl or _CURRENT_CLIENT_URL

    if PREFERRED_CLIENT == "auto":
        return None, clientUrl or _CURRENT_CLIENT_URL

    return None, clientUrl or _CURRENT_CLIENT_URL


def _client_from_player(player, server):
    base = _player_base_url(player)
    mid = _player_machine_id(player) or "unknown"
    if not base:
        reg = _registry_by_machine_id(mid)
        base = (reg or {}).get("baseUrl")
    if not base:
        raise RuntimeError(f"No reachable address for player {mid}")
    log.info(f"get_vhx: session player → {base} (mid={mid})")
    return PlexClient(
        baseurl=base,
        token=PLEX_TOKEN,
        identifier=mid,
        server=server,
        timeout=PLEXAMP_CONNECT_TIMEOUT,
    )


def _client_from_direct(base_url, machine_id, server):
    if not base_url or not machine_id:
        raise RuntimeError("direct Plexamp connect requires baseUrl and machineId")
    log.info(f"get_vhx: direct → {base_url} (mid={machine_id})")
    return PlexClient(
        baseurl=base_url,
        token=PLEX_TOKEN,
        identifier=machine_id,
        server=server,
        timeout=PLEXAMP_CONNECT_TIMEOUT,
    )


def _sessions_for_machine(server, machine_id):
    if not machine_id:
        return []
    mid = machine_id.lower()
    matches = []
    for s in server.sessions():
        player = getattr(s, "player", None)
        if player and _player_machine_id(player).lower() == mid:
            matches.append(s)
    return matches


def _pick_auto_session(sessions):
    if not sessions:
        return None
    order = []
    pref = PREFERRED_CLIENT
    if pref in CLIENT_REGISTRY:
        order.append(CLIENT_REGISTRY[pref]["machineId"].lower())
    for entry in CLIENT_REGISTRY.values():
        order.append(entry["machineId"].lower())
    for target_mid in order:
        for s in sessions:
            player = getattr(s, "player", None)
            if player and _player_machine_id(player).lower() == target_mid:
                return s
    return sessions[0]


def get_vhx(clientUrl=None, clientId=None):
    """Return a PlexClient for VECTORHXAI or Android (never local eva-pc Plexamp).

    Priority:
      1. Explicit clientId / sticky _CURRENT_CLIENT_ID (alias or machine ID)
      2. Active Plex session for that machine (Tailscale/LAN address from player)
      3. Registered baseUrl direct connect (short timeout)
      4. auto: first active session matching registry preference order
      5. Fail fast with a clear error (no stale LAN IP hang)
    """
    server = get_plex()
    sessions = list(server.sessions())
    target_mid, target_url = _resolve_target_machine_id(clientId, clientUrl)

    if target_url and not target_mid:
        for s in sessions:
            player = getattr(s, "player", None)
            if player and _player_base_url(player) == target_url.rstrip("/"):
                return _client_from_player(player, server)

    if target_mid:
        for s in _sessions_for_machine(server, target_mid):
            return _client_from_player(s.player, server)
        reg = _registry_by_machine_id(target_mid)
        direct_url = target_url or (reg or {}).get("baseUrl")
        if direct_url:
            try:
                return _client_from_direct(direct_url, target_mid, server)
            except Exception as e:
                log.warning(f"get_vhx: direct connect failed for {target_mid}: {e}")

    if PREFERRED_CLIENT == "auto" or not target_mid:
        picked = _pick_auto_session(sessions)
        if picked and getattr(picked, "player", None):
            return _client_from_player(picked.player, server)

    names = ", ".join(f"{v['name']} ({v['machineId'][:8]}…)" for v in CLIENT_REGISTRY.values())
    raise RuntimeError(
        "No reachable Plexamp player. Start playback on Android or VECTORHXAI, "
        f"or POST /api/dj/set-client with a registry alias ({names})."
    )


def _collect_registry_clients():
    out = []
    for alias, entry in CLIENT_REGISTRY.items():
        out.append({
            "alias": alias,
            "name": entry.get("name", alias),
            "clientId": entry.get("machineId", ""),
            "machineId": entry.get("machineId", ""),
            "baseUrl": entry.get("baseUrl") or None,
            "product": "Plexamp",
            "source": "registry",
            "preferred": alias == PREFERRED_CLIENT or (
                PREFERRED_CLIENT == "auto" and alias == "android"
            ),
        })
    return out


def _collect_session_clients(server):
    out = []
    for s in server.sessions():
        player = getattr(s, "player", None)
        if not player:
            continue
        mid = _player_machine_id(player)
        reg = _registry_by_machine_id(mid)
        out.append({
            "alias": (reg or {}).get("alias"),
            "name": getattr(player, "title", None) or getattr(player, "device", None) or "Unknown",
            "clientId": mid,
            "machineId": mid,
            "baseUrl": _player_base_url(player),
            "address": getattr(player, "address", None),
            "product": getattr(player, "product", None) or "Plexamp",
            "state": getattr(player, "state", None) or "unknown",
            "source": "session",
        })
    return out


@app.route("/api/dj/clients", methods=["GET", "OPTIONS"])
def list_clients():
    """List registered targets (Android, VECTORHXAI) plus live Plex sessions."""
    try:
        server = get_plex()
        registry = _collect_registry_clients()
        active = _collect_session_clients(server)

        force = request.args.get("refresh", "").lower() in ("1", "true", "yes")
        discovered = []
        if force:
            for c in get_plexamp_clients(force_refresh=True):
                mid = c.get("machineId", "")
                reg = _registry_by_machine_id(mid)
                discovered.append({
                    "alias": (reg or {}).get("alias"),
                    "name": c.get("name"),
                    "clientId": mid,
                    "machineId": mid,
                    "baseUrl": c.get("baseUrl"),
                    "host": c.get("host"),
                    "product": c.get("product", "Plexamp"),
                    "source": "lan",
                    "reachable": True,
                })

        return ok(data={
            "clients": registry + active + discovered,
            "registry": registry,
            "active": active,
            "discovered": discovered,
            "preferred": PREFERRED_CLIENT,
            "sticky": {
                "clientId": _CURRENT_CLIENT_ID,
                "baseUrl": _CURRENT_CLIENT_URL,
            },
        })
    except Exception as e:
        log.exception("clients error")
        return err(str(e), 500)


@app.route("/api/dj/set-client", methods=["POST", "OPTIONS"])
def set_client():
    """Set the active Plex client for subsequent commands (alias or machine ID)."""
    global _CURRENT_CLIENT_URL, _CURRENT_CLIENT_ID
    body = request.get_json(silent=True) or {}
    url = (body.get("baseUrl") or "").strip() or None
    client_id = (body.get("clientId") or body.get("alias") or "").strip()

    if not client_id:
        return err("clientId or alias is required (android | vectorhxai | machine ID)")

    reg = _registry_by_alias(client_id) or _registry_by_machine_id(client_id)
    if reg:
        _CURRENT_CLIENT_ID = reg["machineId"]
        _CURRENT_CLIENT_URL = url or reg.get("baseUrl") or _CURRENT_CLIENT_URL
        label = reg.get("name", client_id)
    else:
        _CURRENT_CLIENT_ID = client_id
        if url:
            _CURRENT_CLIENT_URL = url

    if not _CURRENT_CLIENT_URL and not _CURRENT_CLIENT_ID:
        return err("Could not resolve client — provide baseUrl or a known alias")

    log.info(f"Set client → {_CURRENT_CLIENT_URL} ({_CURRENT_CLIENT_ID})")
    return ok(
        msg=f"Client set to {_CURRENT_CLIENT_ID}",
        data={"clientId": _CURRENT_CLIENT_ID, "baseUrl": _CURRENT_CLIENT_URL},
    )


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
        tracks, _ = _semantic_search_matches(q, limit=limit)
        return ok(data={"tracks": tracks, "query": q, "count": len(tracks)})
    except Exception as e:
        log.exception("semantic search error")
        return err(str(e), 500)

# ── Semantic search + playlist sessions ───────────────────────────────────────

MOOD_QUERIES = {
    "happy": "upbeat cheerful feel-good",
    "sad": "melancholic emotional",
    "energetic": "high energy pump it",
    "chill": "relaxed chill lofi downtempo",
    "intense": "dark heavy aggressive",
    "romantic": "romantic love ballads",
    "nostalgic": "90s 2000s throwback",
    "dark": "dark moody atmospheric",
    "upbeat": "upbeat energetic positive",
}

_suggest_model = None

def _resolve_vibe_query(body):
    """Build a semantic search string from query and/or mood tag."""
    mood = (body.get("mood") or "").strip().lower()
    query = (body.get("query") or body.get("q") or "").strip()
    mood_text = MOOD_QUERIES.get(mood, mood) if mood else ""
    if mood_text and query:
        return f"{query} {mood_text}"
    return query or mood_text


def _semantic_search_matches(query, limit=10, min_score=None, diversify=False, max_per_artist=2):
    """FAISS semantic search → track metadata dicts + Plex Track objects."""
    index, rows = load_faiss()
    model = _get_suggest_model()
    q_emb = model.encode([query], convert_to_numpy=True, normalize_embeddings=True).astype("float32")

    k = min(max(limit * 5, limit), index.ntotal)
    D, I = index.search(q_emb, k=k)

    seen_keys = set()
    artist_counts = {}
    tracks_meta = []
    plex_tracks = []

    for dist, idx in zip(D[0], I[0]):
        if idx < 0 or idx >= len(rows):
            continue
        score = float(dist)
        if min_score is not None and score < min_score:
            continue

        artist, album, title, key = rows[idx]
        if key in seen_keys:
            continue

        if diversify:
            artist_key = (artist or "").lower().strip() or "unknown"
            if artist_counts.get(artist_key, 0) >= max_per_artist:
                continue

        try:
            plex_track = get_plex().fetchItem(int(key))
        except Exception:
            log.warning(f"semantic: skip missing track key={key}")
            continue

        seen_keys.add(key)
        if diversify:
            artist_key = (artist or "").lower().strip() or "unknown"
            artist_counts[artist_key] = artist_counts.get(artist_key, 0) + 1

        tracks_meta.append({**track_dict(plex_track), "score": round(score, 4)})
        plex_tracks.append(plex_track)
        if len(tracks_meta) >= limit:
            break

    return tracks_meta, plex_tracks


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

@app.route("/api/dj/playlist-session", methods=["POST", "OPTIONS"])
def playlist_session():
    """
    Natural-language vibe → FAISS picks → Plex PlayQueue on chosen device.

    POST /api/dj/playlist-session
    {
      "query": "chill late night coding",
      "mood": "chill",
      "limit": 15,
      "shuffle": true,
      "play": true,
      "diversify": true,
      "clientId": "android"
    }
    """
    body = request.get_json(silent=True) or {}
    query = _resolve_vibe_query(body)
    if not query:
        return err("query or mood is required")

    limit = min(max(int(body.get("limit", 12)), 1), 50)

    shuffle = body.get("shuffle", True)
    if isinstance(shuffle, str):
        shuffle = shuffle.strip().lower() in ("1", "true", "yes", "on")

    play = body.get("play", True)
    if isinstance(play, str):
        play = play.strip().lower() in ("1", "true", "yes", "on")

    play_next = body.get("playNext", body.get("play_next", False))
    if isinstance(play_next, str):
        play_next = play_next.strip().lower() in ("1", "true", "yes", "on")

    diversify = body.get("diversify", True)
    if isinstance(diversify, str):
        diversify = diversify.strip().lower() in ("1", "true", "yes", "on")

    min_score = body.get("minScore")
    if min_score is not None:
        min_score = float(min_score)

    try:
        tracks_meta, plex_tracks = _semantic_search_matches(
            query,
            limit=limit,
            min_score=min_score,
            diversify=diversify,
        )
        if not plex_tracks:
            return err(f"No library tracks matched '{query}'", 404)

        if shuffle and len(plex_tracks) > 1:
            paired = list(zip(tracks_meta, plex_tracks))
            random.shuffle(paired)
            tracks_meta, plex_tracks = zip(*paired)
            tracks_meta = list(tracks_meta)
            plex_tracks = list(plex_tracks)

        queue_key = None
        client_id = body.get("clientId") or body.get("alias") or _CURRENT_CLIENT_ID
        client_url = body.get("client") or _CURRENT_CLIENT_URL

        appended = False
        if play:
            from plexapi.playqueue import PlayQueue

            vhx = get_vhx(client_url, client_id)
            if play_next:
                pq_id = None
                for tl in vhx.timelines():
                    if tl.playQueueID:
                        pq_id = tl.playQueueID
                        break
                if pq_id:
                    pq = PlayQueue.get(get_plex(), pq_id)
                    for i, track in enumerate(plex_tracks):
                        pq.addItem(track, playNext=(i == 0))
                    pq.refresh()
                    queue_key = pq_id
                    appended = True
                    log.info(
                        f"playlist-session: appended {len(plex_tracks)} tracks after current "
                        f"→ queue {queue_key} (query={query!r})"
                    )
                else:
                    log.info("playlist-session: playNext requested but no active queue — starting new set")
                    pq = PlayQueue.create(get_plex(), plex_tracks, continuous=0)
                    vhx.playMedia(pq)
                    queue_key = getattr(pq, "playQueueID", None) or getattr(pq, "key", None)
            else:
                pq = PlayQueue.create(get_plex(), plex_tracks, continuous=0)
                vhx.playMedia(pq)
                queue_key = getattr(pq, "playQueueID", None) or getattr(pq, "key", None)
                log.info(
                    f"playlist-session: {len(plex_tracks)} tracks → queue {queue_key} "
                    f"(query={query!r}, shuffle={shuffle})"
                )

        first = tracks_meta[0]
        if play:
            if appended:
                msg = (
                    f"Queued {len(tracks_meta)}-track set after current track for '{query}' "
                    f"— up next: '{first['title']}' by {first.get('artist') or 'unknown'}"
                )
            else:
                msg = (
                    f"Playing {len(tracks_meta)}-track set for '{query}' "
                    f"— starts with '{first['title']}' by {first.get('artist') or 'unknown'}"
                )
        else:
            msg = f"Built {len(tracks_meta)}-track set for '{query}' (preview only, not playing)"

        return ok(
            msg=msg,
            data={
                "query": query,
                "count": len(tracks_meta),
                "shuffle": shuffle,
                "diversify": diversify,
                "played": play,
                "playNext": play_next,
                "appended": appended,
                "queueKey": queue_key,
                "clientId": client_id,
                "baseUrl": client_url,
                "firstTrack": first,
                "tracks": tracks_meta,
            },
        )
    except Exception as e:
        log.exception("playlist-session error")
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
        queue_key = getattr(pq, "playQueueID", None) or getattr(pq, "key", None)
        log.info(f"Queue: {len(tracks)} tracks → queue {queue_key}")
        return ok(msg=f"Queue: {len(tracks)} tracks", data={"count": len(tracks), "queueKey": queue_key})
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
