/**
 * Extension-DJEva — SillyTavern UI Extension
 * DJ Eva: Plexamp control with semantic (FAISS) search via /dj slash commands.
 *
 * Settings panel lets you configure:
 *   - API URL: the base URL of the DJ API server (Eva-PC)
 *   - Use Proxy: route through SillyTavern's /proxy to avoid mixed-content blocks
 *   - Default Device: which Plexamp client to control (VHX or discovered clients)
 *
 * NOTE: For /clients discovery to work, use a full Plex token (not a claim token)
 * in the PLEX_TOKEN env var on Eva-PC. Claim tokens only allow playback, not client listing.
 *
 * Author: Joe Armella
 * License: AGPL-3.0
 */

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandEnumValue } from '../../../slash-commands/SlashCommandEnumValue.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';

// ── Default settings ─────────────────────────────────────────────────────────

const defaultSettings = {
    apiUrl: 'https://truenas-scale.tail7119fb.ts.net:30022',
    useProxy: false,
    deviceName: 'Android',
    deviceUrl: '',
    deviceId: '',
};

// ── State ────────────────────────────────────────────────────────────────────

let currentStatus  = { state: "idle", playing: false, track: null };
let suggestCache   = [];
let isLoading      = false;
let discoveredClients = [];

// ── API URL resolver ─────────────────────────────────────────────────────────

function getApiBase() {
    const base = extension_settings.djeva?.apiUrl || defaultSettings.apiUrl;
    if (extension_settings.djeva?.useProxy && window.location.origin) {
        // Route through SillyTavern's built-in proxy to avoid HTTPS→HTTP mixed-content blocks
        return window.location.origin + '/proxy' + base;
    }
    return base;
}

function addSlash(url) {
    return url.endsWith('/') ? url : url + '/';
}

// ── Fetch — direct only, no proxy ──────────────────────────────────────────

async function apiFetch(path, opts = {}) {
    const directBase = addSlash(extension_settings.djeva?.apiUrl || defaultSettings.apiUrl);
    const directUrl = directBase + 'api/dj' + path;

    async function tryFetch(url) {
        const r = await fetch(url, {
            signal: AbortSignal.timeout(8000),
            headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
            ...opts,
        });
        return r;
    }

    // Try direct first (always, since both machines are on tailnet)
    try {
        const r = await tryFetch(directUrl);
        // Treat 4xx/5xx as errors, but do NOT retry on 400 (bad request = user error, not network)
        if (r.ok) {
            const j = await r.json();
            if (!j.ok) {
                toastr.error(j.error || "DJ API error", "DJ Eva");
                return null;
            }
            return j;
        }
        // Network error or HTTP error on direct — try proxy once
        if (r.status >= 400) {
            const j = await r.json().catch(() => ({}));
            // If we get a JSON error from the API itself, don't retry (it's a real error, not a network block)
            if (j && (j.ok === false || j.error)) {
                toastr.error(j.error || `HTTP ${r.status}`, "DJ Eva");
                return null;
            }
        }
    } catch (e) {
        // Network error on direct — try proxy as fallback
        console.warn("[DJ-Eva] Direct fetch failed, trying proxy:", e.message);
    }

    // ── Direct fetch failed, no proxy fallback — just log ───────────────────────
    console.error("[DJ-Eva] Request failed:", directUrl, opts);
    return null;
}

// ── Refresh now-playing ──────────────────────────────────────────────────────

async function refreshStatus() {
    const url    = extension_settings.djeva?.deviceUrl || null;
    const clientId = extension_settings.djeva?.deviceId || null;
    const qs = url    ? `?client=${encodeURIComponent(url)}` : '';
    const cidQs = clientId ? `${qs ? '&' : '?'}clientId=${encodeURIComponent(clientId)}` : '';
    const res = await apiFetch("/status" + qs + cidQs);
    if (!res) {
        // API unreachable — show error in client indicator
        const indicator = document.getElementById("djeva_client_indicator");
        if (indicator) indicator.textContent = '⚠ API unreachable';
        return;
    }
    currentStatus = res.data || currentStatus;
    updateNowPlayingUI(currentStatus);
    // Update client indicator
    const indicator = document.getElementById("djeva_client_indicator");
    if (indicator) {
        const deviceName = extension_settings.djeva?.deviceName || 'VHX';
        indicator.textContent = `🎵 on ${deviceName}`;
    }
    return currentStatus;
}

// ── UI: Now Playing ─────────────────────────────────────────────────────────

function updateNowPlayingUI(status) {
    const el = document.getElementById("djeva_nowplaying");
    const vol = document.getElementById("djeva_vol_pct");
    if (!el) return;

    if (!status?.track) {
        const deviceName = extension_settings.djeva?.deviceName || 'VHX';
        el.innerHTML = `<span class="djeva_muted">Nothing playing</span><br><small style="color:var(--gray)">on ${escHtml(deviceName)}</small>`;
        return;
    }
    const t = status.track;
    const artist  = t.artist || "";
    const title   = t.title  || "Unknown";
    const state   = status.state || "unknown";
    const elapsed = status.time ? fmtDuration(status.time) : "?";
    const total   = t.duration ? fmtDuration(t.duration * 1000) : "?";
    // Show which client is active
    const deviceName = extension_settings.djeva?.deviceName || 'VHX';
    el.innerHTML = `
        <div class="djeva-track">
            <div class="djeva-track-title">${escHtml(title)}</div>
            <div class="djeva-track-artist">${escHtml(artist)}</div>
        </div>
        <div class="djeva-track-meta">
            <span class="djeva-badge djeva-state-${state}">${state}</span>
            ${elapsed} / ${total}
            <button id="djeva_refresh_np" class="menu_button" style="padding:1px 4px;margin-left:4px;font-size:0.7rem" title="Refresh now playing">
                <i class="fa-solid fa-rotate-right"></i>
            </button>
        </div>
    `;
    if (vol) vol.textContent = status.volume ?? "?";
}

function fmtDuration(ms) {
    if (!ms) return "0:00";
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ── Search ──────────────────────────────────────────────────────────────────

async function doSearch(query, mode = "keyword") {
    if (isLoading) return;
    isLoading = true;
    setLoading(true);
    const path = mode === "semantic" ? `/semantic?q=${encodeURIComponent(query)}` : `/search?q=${encodeURIComponent(query)}`;
    const res = await apiFetch(path);
    isLoading = false;
    setLoading(false);
    if (!res || !res.data?.tracks?.length) {
        const el = document.getElementById("djeva_results");
        if (el) el.innerHTML = `<div class="djeva_empty">No tracks found for <em>${escHtml(query)}</em></div>`;
        suggestCache = [];
        return;
    }
    suggestCache = res.data.tracks;
    renderResults(suggestCache);
    // Show Play All bar when results exist
    const bar = document.getElementById("djeva_playall_bar");
    if (bar) bar.style.display = suggestCache.length > 0 ? "block" : "none";
}

function renderResults(tracks) {
    const list = document.getElementById("djeva_results");
    if (!list) return;
    list.innerHTML = tracks.map((t, i) => `
        <div class="djeva-result" data-index="${i}">
            <div class="djeva-result-info">
                <span class="djeva-result-title">${escHtml(t.title)}</span>
                <span class="djeva-result-artist">${escHtml(t.artist || "")} · ${escHtml(t.album || "")}</span>
            </div>
            <div class="djeva-result-right">
                ${t.score != null ? `<span class="djeva-score">${(t.score * 100).toFixed(0)}%</span>` : ""}
                <button class="menu_button djeva-play-btn" data-key="${t.ratingKey}" title="Play">
                    <i class="fa-solid fa-play"></i>
                </button>
            </div>
        </div>
    `).join("");
}

function renderLibraryTracks(tracks) {
    const list = document.getElementById("djeva_results");
    if (!list) return;
    suggestCache = tracks;
    list.innerHTML = tracks.map((t, i) => `
        <div class="djeva-result" data-index="${i}">
            <div class="djeva-result-info">
                <span class="djeva-result-title">${escHtml(t.title)}</span>
                <span class="djeva-result-artist">${escHtml(t.artist || "")} · ${escHtml(t.album || "")}</span>
            </div>
            <div class="djeva-result-right">
                <button class="menu_button djeva-play-btn" data-key="${t.ratingKey}" title="Play">
                    <i class="fa-solid fa-play"></i>
                </button>
            </div>
        </div>
    `).join("");
}

// ── Playback actions ─────────────────────────────────────────────────────────

async function playTrack(key) {
    const body = { ratingKey: String(key).split("/").pop() };
    const url    = extension_settings.djeva?.deviceUrl   || null;
    const clientId = extension_settings.djeva?.deviceId || null;
    if (url)    body.client    = url;
    if (clientId) body.clientId = clientId;
    const res = await apiFetch("/play", {
        method: "POST",
        body: JSON.stringify(body),
    });
    if (res) {
        toastr.success(`▶ ${res.data?.track?.title || "Track"}`, "DJ Eva");
        setTimeout(refreshStatus, 500);
    }
}

// ── Play next (queue after current track) ────────────────────────────────────
async function queueNext(key) {
    const body = { ratingKey: String(key).split("/").pop() };
    const url    = extension_settings.djeva?.deviceUrl   || null;
    const clientId = extension_settings.djeva?.deviceId || null;
    if (url)    body.client    = url;
    if (clientId) body.clientId = clientId;
    const res = await apiFetch("/playnext", {
        method: "POST",
        body: JSON.stringify(body),
    });
    if (res) {
        toastr.success(`⏭ ${res.data?.track?.title || "Queued next"}`, "DJ Eva");
        setTimeout(refreshStatus, 500);
    }
}

// ── Vibe → multi-track playlist session ───────────────────────────────────────
async function playlistSession({ query, mood, limit = 12, shuffle = true, playNext = false }) {
    const body = {
        query: query || undefined,
        mood: mood || undefined,
        limit: Math.min(Math.max(Number(limit) || 12, 1), 30),
        shuffle: shuffle !== false,
        play: true,
        playNext: !!playNext,
        diversify: true,
    };
    const url = extension_settings.djeva?.deviceUrl || null;
    const clientId = extension_settings.djeva?.deviceId || null;
    if (url) body.client = url;
    if (clientId) body.clientId = clientId;
    const res = await apiFetch("/playlist-session", {
        method: "POST",
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45000),
    });
    if (res) setTimeout(refreshStatus, 500);
    return res;
}

// ── Queue all results ─────────────────────────────────────────────────────────
async function playAll() {
    if (!suggestCache || suggestCache.length === 0) {
        toastr.warning("No tracks in results to play", "DJ Eva");
        return;
    }
    const url     = extension_settings.djeva?.deviceUrl   || null;
    const clientId = extension_settings.djeva?.deviceId || null;
    const body = {
        ratingKeys: suggestCache.map(t => Number(String(t.ratingKey).split("/").pop()))
    };
    if (url)     body.client    = url;
    if (clientId) body.clientId = clientId;
    const res = await apiFetch("/queue", {
        method: "POST",
        body: JSON.stringify(body),
    });
    if (res) {
        toastr.success(`▶ Queue: ${suggestCache.length} tracks`, "DJ Eva");
        setTimeout(refreshStatus, 800);
    }
}

async function doControl(action) {
    const body     = { action };
    const url      = extension_settings.djeva?.deviceUrl   || null;
    const clientId = extension_settings.djeva?.deviceId || null;
    if (url)     body.client    = url;
    if (clientId) body.clientId = clientId;
    const res = await apiFetch("/control", {
        method: "POST",
        body: JSON.stringify(body),
    });
    if (res) {
        toastr.info(action, "DJ Eva");
        setTimeout(refreshStatus, 500);
    }
}

async function doVolume(level) {
    const body     = { level };
    const url      = extension_settings.djeva?.deviceUrl   || null;
    const clientId = extension_settings.djeva?.deviceId || null;
    if (url)     body.client    = url;
    if (clientId) body.clientId = clientId;
    await apiFetch("/volume", {
        method: "POST",
        body: JSON.stringify(body),
    });
}

async function loadLibrary() {
    isLoading = true;
    setLoading(true);
    const res = await apiFetch("/library?limit=30");
    isLoading = false;
    setLoading(false);
    if (res?.data?.tracks) {
        renderLibraryTracks(res.data.tracks);
    }
}

// ── Client discovery ─────────────────────────────────────────────────────────

async function discoverClients() {
    const res = await apiFetch("/clients");
    if (!res?.data?.clients?.length) {
        discoveredClients = [];
        return [];
    }
    // Prepend VHX default
    const vhxDefault = { name: 'VHX (default)', baseUrl: '', clientId: '', product: 'Plexamp', state: 'online' };
    discoveredClients = [vhxDefault, ...res.data.clients];
    return discoveredClients;
}

// ── UI helpers ───────────────────────────────────────────────────────────────

function setLoading(on) {
    const el = document.getElementById("djeva_loading");
    if (el) el.style.display = on ? "inline-block" : "none";
}

function escHtml(s) {
    if (!s) return "";
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
}

// ── Settings panel ───────────────────────────────────────────────────────────

function renderSettingsPanel() {
    const html = `
    <div class="djeva_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🎧 DJ Eva — Settings</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div>
                    <label for="djeva_api_url">DJ API URL</label>
                    <div><small>Your nginx proxy URL for the DJ API, e.g. https://your-host/dj/. Same-origin avoids CORS issues.</small></div>
                    <input id="djeva_api_url" class="text_pole" type="text" placeholder="${defaultSettings.apiUrl}" />
                </div>
                <div>
                    <label for="djeva_device">Default Device</label>
                    <div><small>Which Plexamp client to control. Discover clients after setting a full Plex token on Eva-PC.</small></div>
                    <select id="djeva_device" class="text_pole">
                        <option value="VHX">VHX (default)</option>
                    </select>
                    <button id="djeva_discover_btn" class="menu_button" style="margin-top:4px">
                        <i class="fa-solid fa-magnifying-glass"></i> Discover Clients
                    </button>
                </div>
                <div class="djeva-status-bar">
                    <span id="djeva_status" class="djeva_muted">—</span>
                </div>
            </div>
        </div>
    </div>`;

    const container = document.getElementById('djeva_settings_container') ?? document.getElementById('extensions_settings');
    $(container).append(html);

    // Init settings
    if (extension_settings.djeva === undefined) extension_settings.djeva = {};
    for (const key in defaultSettings) {
        if (extension_settings.djeva[key] === undefined) {
            extension_settings.djeva[key] = defaultSettings[key];
        }
    }

    // Populate fields
    $('#djeva_api_url').val(extension_settings.djeva.apiUrl || defaultSettings.apiUrl);
    $('#djeva_use_proxy').prop('checked', !!extension_settings.djeva.useProxy);

    // Populate device dropdown
    rebuildDeviceDropdown(extension_settings.djeva.deviceName || 'VHX');
    if (extension_settings.djeva.deviceName) {
        $(`#djeva_device option[value="${escHtml(extension_settings.djeva.deviceName)}"]`).prop('selected', true).attr('selected', 'selected');
    }

    // Bind events
    $('#djeva_api_url').on('input', function () {
        extension_settings.djeva.apiUrl = String($(this).val());
        saveSettingsDebounced();
        checkConnection();
    });

    $('#djeva_use_proxy').on('change', function () {
        extension_settings.djeva.useProxy = !!$(this).prop('checked');
        saveSettingsDebounced();
        checkConnection();
    });

    $('#djeva_device').on('change', function () {
        const selected = $(this).val();
        const client = discoveredClients.find(c => c.name === selected);
        if (client) {
            extension_settings.djeva.deviceName = client.name;
            extension_settings.djeva.deviceUrl  = client.baseUrl;
            extension_settings.djeva.deviceId   = client.clientId;
            saveSettingsDebounced();
            refreshStatus();
        }
    });

    $('#djeva_discover_btn').on('click', async function () {
        const btn = $(this);
        btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Discovering…');
        try {
            const clients = await discoverClients();
            rebuildDeviceDropdown(extension_settings.djeva.deviceName || 'VHX');
            const el = document.getElementById('djeva_status');
            if (clients.length > 0) {
                if (el) el.textContent = `✓ ${clients.length} client(s) found`;
            } else {
                if (el) el.textContent = 'ℹ No managed clients — using auto-detect from active session';
            }
        } finally {
            btn.prop('disabled', false).html('<i class="fa-solid fa-magnifying-glass"></i> Discover Clients');
        }
    });

    setTimeout(checkConnection, 500);

    // Status bar shows a hint if clients come back empty
    const statusObserver = new MutationObserver(() => {
        const el = document.getElementById('djeva_status');
        if (el && el.textContent.includes('✓ Direct')) {
            // Connection is good — clear any stale error about token
            if (el.textContent.includes('auth error')) {
                el.textContent = '✓ Direct: direct — token valid, no managed clients found (Plexamp may be using direct/local playback mode)';
                el.style.color = 'var(--warning)';
            } else if (el.textContent === '✓ Direct: direct') {
                el.textContent = '✓ Direct: direct — connected (using default VHX client)';
                el.style.color = 'var(--success)';
            }
        }
    });
    const statusEl = document.getElementById('djeva_status');
    if (statusEl) statusObserver.observe(statusEl, { childList: true, characterData: true });
}

function rebuildDeviceDropdown(selectedName) {
    const sel = $('#djeva_device');
    sel.empty();
    discoveredClients.forEach(c => {
        const label = c.name + (c.product ? ` (${c.product})` : '');
        sel.append(`<option value="${escHtml(c.name)}">${escHtml(label)}</option>`);
    });
    if (selectedName) {
        $(`#djeva_device option[value="${escHtml(selectedName)}"]`).prop('selected', true);
    }
}

async function checkConnection() {
    const el = document.getElementById('djeva_status');
    if (!el) return;
    el.textContent = "Checking…";
    el.style.color = "";

    const baseUrl = extension_settings.djeva?.apiUrl || defaultSettings.apiUrl;
    if (!baseUrl) {
        // Same-origin mode — no need to probe, nginx handles it
        el.textContent = '✓ Same-origin (nginx proxy)';
        el.style.color = 'var(--success)';
        return;
    }

    const directBase = addSlash(baseUrl);
    const directUrl  = directBase + 'api/dj/ping';
    const proxyBase  = addSlash(getProxyBase());
    const proxyUrl   = proxyBase  + 'api/dj/ping';

    async function probe(url, label) {
        try {
            const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
            if (r.ok) {
                const j = await r.json();
                if (j?.ok) return `✓ Direct: ${label}`;
            }
            if (r.status === 401 || r.status === 403) return `✗ ${label} (HTTP 401 — Plex token may be a claim token, not full access token)`;
            return `✗ ${label} (HTTP ${r.status})`;
        } catch (e) {
            return null;  // unreachable
        }
    }

    const directResult = await probe(directUrl, 'direct');
    if (directResult) {
        el.textContent = directResult;
        el.style.color = directResult.startsWith("✓") ? 'var(--success)' : 'var(--error)';
        return;
    }

    // Try proxy
    if (extension_settings.djeva?.useProxy !== false) {
        const proxyResult = await probe(proxyUrl, 'proxy');
        if (proxyResult) {
            el.textContent = proxyResult + ' — enable proxy in settings';
            el.style.color = 'var(--warning)';
            return;
        }
    }

    el.textContent = "✗ Unreachable (both direct and proxy failed)";
    el.style.color = 'var(--error)';
}

// ── Main panel ───────────────────────────────────────────────────────────────

function renderMainPanel() {
    const html = `
    <div class="djeva_main">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🎶 DJ Eva — Plexamp</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">

                <!-- Now Playing -->
                <div id="djeva_nowplaying" class="djeva-nowplaying">
                    <span class="djeva_muted">Loading…</span>
                </div>
                <div id="djeva_client_indicator" style="font-size:0.7rem; color:var(--gray); margin-bottom:4px"></div>

                <!-- Playback controls -->
                <div class="djeva-controls">
                    <button id="djeva_prev"  class="menu_button" title="Previous"><i class="fa-solid fa-backward-step"></i></button>
                    <button id="djeva_pause" class="menu_button" title="Pause"><i class="fa-solid fa-pause"></i></button>
                    <button id="djeva_play"  class="menu_button" title="Play"><i class="fa-solid fa-play"></i></button>
                    <button id="djeva_stop"  class="menu_button" title="Stop"><i class="fa-solid fa-stop"></i></button>
                    <button id="djeva_next"  class="menu_button" title="Next"><i class="fa-solid fa-forward-step"></i></button>
                    <span id="djeva_loading" class="djeva-spinner" style="display:none">
                        <i class="fa-solid fa-spinner fa-spin"></i>
                    </span>
                </div>

                <!-- Volume -->
                <div class="djeva-volume">
                    <i class="fa-solid fa-volume-low"></i>
                    <input type="range" id="djeva_volume" min="0" max="100" value="75" style="flex:1" />
                    <span id="djeva_vol_pct">75%</span>
                </div>

                <hr class="sysHR"/>

                <!-- Search bar -->
                <div class="djeva-search-bar">
                    <input type="text" id="djeva_query" class="text_pole"
                           placeholder="Search or describe music…" style="flex:1" />
                    <select id="djeva_mode" class="text_pole" style="width:110px">
                        <option value="auto">Auto</option>
                        <option value="semantic">AI Search</option>
                        <option value="keyword">Keyword</option>
                    </select>
                    <button id="djeva_search_btn" class="menu_button"><i class="fa-solid fa-magnifying-glass"></i></button>
                </div>

                <!-- Quick mood chips -->
                <div class="djeva-moods">
                    <button class="menu_button djeva-mood-btn" data-mood="energetic">⚡ Energetic</button>
                    <button class="menu_button djeva-mood-btn" data-mood="chill">🌙 Chill</button>
                    <button class="menu_button djeva-mood-btn" data-mood="happy">☀️ Happy</button>
                    <button class="menu_button djeva-mood-btn" data-mood="nostalgic">📼 Nostalgic</button>
                    <button class="menu_button djeva-mood-btn" data-mood="romantic">💜 Romantic</button>
                    <button class="menu_button djeva-mood-btn" data-mood="sad">😢 Sad</button>
                </div>

                <hr class="sysHR"/>

                <!-- Library button -->
                <div class="djeva-library-bar">
                    <button id="djeva_library_btn" class="menu_button">
                        <i class="fa-solid fa-shuffle"></i> Random Library
                    </button>
                    <span style="font-size:0.75rem; color:var(--gray)">
                        or type <code style="background:rgba(255,255,255,0.06); padding:1px 4px; border-radius:2px">/dj</code> in chat
                    </span>
                </div>

                <!-- Results list -->
                <div id="djeva_results" class="djeva-results"></div>

                <!-- Play All button -->
                <div id="djeva_playall_bar" style="display:none; margin-top:4px">
                    <button id="djeva_playall_btn" class="menu_button" style="width:100%">
                        <i class="fa-solid fa-list"></i> Play All (Queue)
                    </button>
                </div>

            </div>
        </div>
    </div>`;

    const container = document.getElementById('djeva_main_container') ?? document.getElementById('extensions_settings2');
    $(container).append(html);
}

// ── Event bindings ───────────────────────────────────────────────────────────

function bindEvents() {
    $(document).on("click", "#djeva_play",  () => doControl("play"));
    $(document).on("click", "#djeva_pause", () => doControl("pause"));
    $(document).on("click", "#djeva_stop",  () => doControl("stop"));
    $(document).on("click", "#djeva_next",  () => doControl("skipnext"));
    $(document).on("click", "#djeva_prev",  () => doControl("skipprev"));
    $(document).on("click", "#djeva_playall_btn", () => playAll());

    $(document).on("input", "#djeva_volume", debounce(async e => {
        const lvl = parseInt($(e.target).val(), 10);
        $("#djeva_vol_pct").text(`${lvl}%`);
        await doVolume(lvl);
    }, 400));

    $(document).on("click", "#djeva_search_btn", async () => {
        const q    = $("#djeva_query").val()?.trim();
        const mode = $("#djeva_mode").val();
        if (!q) return;
        await doSearch(q, mode);
    });

    $(document).on("keydown", "#djeva_query", e => {
        if (e.key !== "Enter") return;
        $("#djeva_search_btn").trigger("click");
    });

    $(document).on("click", ".djeva-mood-btn", async e => {
        const mood = $(e.currentTarget).data("mood");
        if (!mood) return;
        const moodMap = {
            happy: "upbeat cheerful feel-good",
            sad: "melancholic emotional",
            energetic: "high energy pump it",
            chill: "relaxed chill lofi downtempo",
            intense: "dark heavy aggressive",
            romantic: "romantic love ballads",
            nostalgic: "90s 2000s throwback",
        };
        const desc = moodMap[mood] || mood;
        isLoading = true;
        setLoading(true);
        const res = await apiFetch(`/semantic?q=${encodeURIComponent(desc)}&limit=5`);
        isLoading = false;
        setLoading(false);
        if (!res?.data?.tracks?.length) {
            toastr.warning(`No tracks for mood: ${mood}`, "DJ Eva");
            return;
        }
        toastr.success(`${mood} → ${res.data.tracks[0].title}`, "DJ Eva");
        renderResults(res.data.tracks);
    });

    $(document).on("click", ".djeva-play-btn", async e => {
        const key = $(e.currentTarget).data("key");
        if (key) await playTrack(key);
    });

    $(document).on("click", "#djeva_library_btn", loadLibrary);
    $(document).on("click", "#djeva_refresh_np", () => refreshStatus());
}

// ── Slash Commands ───────────────────────────────────────────────────────────

function registerSlashCommands() {
    if (typeof SlashCommandParser === "undefined") return;

    SlashCommandParser.addCommandObject(
        SlashCommand.fromProps({
            name: "dj",
            aliases: ["music", "play"],
            callback: async (namedArgs, unnamedArgs) => {
                const query    = Array.isArray(unnamedArgs) ? unnamedArgs.join(" ").trim() : (unnamedArgs || "").trim();
                const action   = (namedArgs.action || "").toLowerCase();
                const key      = namedArgs.key || namedArgs.track;
                const volLevel = namedArgs.volume ?? namedArgs.level;
                const mood     = namedArgs.mood;
                const mode     = (namedArgs.mode || "auto").toLowerCase();
                const limit    = parseInt(namedArgs.limit || "10", 10);

                if (action === "pause" || action === "stop" || action === "skipnext" ||
                    action === "skipprev" || action === "resume" || action === "next" ||
                    action === "prev") {
                    await doControl(action === "skipnext" ? "skipnext" :
                                   action === "skipprev" ? "skipprev" : action);
                    return;
                }

                if (volLevel !== undefined) {
                    await doVolume(clamp(+volLevel, 0, 100));
                    return `Volume set to ${volLevel}.`;
                }

                if (key) {
                    await playTrack(key);
                    return;
                }

                if (action === "library" || action === "shuffle" || action === "random") {
                    const res = await apiFetch("/library?limit=30");
                    if (!res?.data?.tracks?.length) return "Library unavailable.";
                    const pick = res.data.tracks[Math.floor(Math.random() * res.data.tracks.length)];
                    await playTrack(pick.ratingKey);
                    return `Playing: ${pick.title} — ${pick.artist}`;
                }

                if (mood) {
                    const moodMap = {
                        happy: "upbeat cheerful feel-good",
                        sad: "melancholic emotional",
                        energetic: "high energy pump it",
                        chill: "relaxed chill lofi downtempo",
                        intense: "dark heavy aggressive",
                        romantic: "romantic love ballads",
                        nostalgic: "90s 2000s throwback",
                    };
                    const desc = moodMap[mood] || mood;
                    const semRes = await apiFetch(`/semantic?q=${encodeURIComponent(desc)}&limit=5`);
                    if (!semRes?.data?.tracks?.length) return `No tracks found for mood: ${mood}`;
                    const pick = semRes.data.tracks[0];
                    await playTrack(pick.ratingKey);
                    return `Playing (${mood}): ${pick.title} — ${pick.artist}`;
                }

                // Single-word action commands: "/dj pause" or "/dj stop" → execute as control, not search
                if (query && !mood && !action && !key) {
                    const raw = query.toLowerCase().trim();
                    if (/^(pause|stop|resume|skipnext|skipprev|next|prev|shuffle|library|random|nowplaying|np)$/.test(raw)) {
                        if (raw === "shuffle" || raw === "library" || raw === "random") {
                            const res = await apiFetch("/library?limit=30");
                            if (!res?.data?.tracks?.length) return "Library unavailable.";
                            const pick = res.data.tracks[Math.floor(Math.random() * res.data.tracks.length)];
                            await playTrack(pick.ratingKey);
                            return `Playing: ${pick.title} — ${pick.artist}`;
                        }
                        if (raw === "nowplaying" || raw === "np") {
                            const s = await refreshStatus();
                            if (!s?.track) return "Nothing is currently playing.";
                            return `Now playing: "${s.track.title}" by ${s.track.artist}`;
                        }
                        await doControl(raw === "skipnext" ? "skipnext" :
                                       raw === "skipprev" ? "skipprev" : raw);
                        return;
                    }
                }

                // Bare suggest command: "/dj suggest put on heist music"
                if (query && !mood && !action && !key) {
                    const raw = query.toLowerCase().trim();
                    const suggestMatch = raw.match(/^(suggest\s+.*)$/i);
                    if (suggestMatch) {
                        const desc = suggestMatch[1].replace(/^suggest\s+/i, "").trim();
                        if (!desc) return "Usage: /dj suggest &lt;scene or mood description&gt; (e.g. \"heist movie music\")";
                        const res = await apiFetch("/suggest", "POST", { query: desc, limit: 5 });
                        if (!res) return "DJ API unreachable for suggest.";
                        const suggestions = res?.data?.suggestions || [];
                        const total = res?.data?.total_in_library || 0;
                        const libMsg = res?.data?.library_message || "";
                        if (total === 0) {
                            const addTips = suggestions
                                .filter(s => s.action === "SUGGEST_ADD")
                                .slice(0, 3)
                                .map(s => `"${s.title}" by ${s.artist}`)
                                .join(", ");
                            if (addTips) return `Nothing in your library matches "${desc}". Add to Plex: ${addTips}.`;
                            return `No library or Plex matches for "${desc}". Try a different description.`;
                        }
                        const pick = suggestions.find(s => s.available && s.ratingKey);
                        if (pick) {
                            await playTrack(pick.ratingKey);
                            return `${libMsg} Playing: "${pick.title}" by ${pick.artist}.`;
                        }
                        return libMsg;
                    }
                }

                if (query) {
                    const semanticTriggers = /^(play|find|music|songs|tracks|something|put on|i want|i feel|i need|lists|music for)/i;
                    const useSemantic = mode === "semantic" || (mode === "auto" && semanticTriggers.test(query));
                    const path = useSemantic
                        ? `/semantic?q=${encodeURIComponent(query)}&limit=${limit}`
                        : `/search?q=${encodeURIComponent(query)}&limit=${limit}`;
                    const res = await apiFetch(path);
                    if (!res?.data?.tracks?.length) return `No tracks found for: ${query}`;
                    const t = res.data.tracks[0];
                    await playTrack(t.ratingKey);
                    const label = useSemantic ? "Semantic" : "Keyword";
                    return `${label} match → ${t.title} — ${t.artist}`;
                }

                return `<b>DJ Eva — /dj</b>
<div>/dj &lt;query&gt; — search + play</div>
<div>/dj &lt;natural language&gt; — AI semantic search + play</div>
<div>/dj key=&lt;key&gt; — play by Plex key</div>
<div>/dj pause|stop|skipnext|resume</div>
<div>/dj volume level=80</div>
<div>/dj mood happy|sad|energetic|chill|intense|romantic|nostalgic</div>
<div>/dj library|shuffle</div>
<div>/dj suggest &lt;scene/vibe&gt; — cross-check library, play best match or suggest additions</div>`;
            },
            returns: "DJ action result or track list",
            namedArgumentList: [
                SlashCommandNamedArgument.fromProps({ name: "action",  description: "pause|stop|skipnext|resume|play|key=|volume|mood", typeList: [ARGUMENT_TYPE.STRING] }),
                SlashCommandNamedArgument.fromProps({ name: "key",     description: "Plex ratingKey", typeList: [ARGUMENT_TYPE.STRING] }),
                SlashCommandNamedArgument.fromProps({ name: "track",   description: "Plex key (alias)", typeList: [ARGUMENT_TYPE.STRING] }),
                SlashCommandNamedArgument.fromProps({ name: "volume",  description: "Volume 0-100", typeList: [ARGUMENT_TYPE.NUMBER] }),
                SlashCommandNamedArgument.fromProps({ name: "level",   description: "Volume (alias)", typeList: [ARGUMENT_TYPE.NUMBER] }),
                SlashCommandNamedArgument.fromProps({ name: "mood",    description: "happy|sad|energetic|chill|intense|romantic|nostalgic", typeList: [ARGUMENT_TYPE.STRING] }),
                SlashCommandNamedArgument.fromProps({ name: "mode",    description: "semantic|keyword|auto", typeList: [ARGUMENT_TYPE.STRING] }),
                SlashCommandNamedArgument.fromProps({ name: "limit",   description: "Max results", typeList: [ARGUMENT_TYPE.NUMBER], defaultValue: "10" }),
            ],
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({ description: "search query or natural language", typeList: [ARGUMENT_TYPE.STRING], isRequired: false }),
            ],
            helpString: `<b>DJ Eva — Plexamp</b><br/><code>/dj pumping music</code><br/><code>/dj mood energetic</code><br/><code>/dj library</code><br/><code>/dj i want something chill to study to</code>`,
        })
    );

    SlashCommandParser.addCommandObject(
        SlashCommand.fromProps({
            name: "nowplaying",
            aliases: ["np"],
            callback: async () => {
                const s = await refreshStatus();
                if (!s?.track) return "Nothing playing.";
                const t = s.track;
                return `Now playing: ${t.title} — ${t.artist} (${t.album})`;
            },
            returns: "Current track",
            helpString: "<b>/nowplaying</b> — show what's playing",
        })
    );
}

// ── Function calling tool (LLM-native, no keyword needed) ───────────────────────

function registerFunctionTools() {
    const { registerFunctionTool, isToolCallingSupported } = SillyTavern.getContext();
    if (!isToolCallingSupported()) {
        console.info("[DJ-Eva] Function calling not supported on this backend");
        return;
    }

    registerFunctionTool({
        name: "DJ",
        displayName: "DJ Eva",
        description:
            "Use this tool whenever you need to check what music is currently playing, " +
            "control playback (play/pause/stop/skip), change the volume, search for or play music, " +
            "or respond to any music-related question in a roleplay scene. " +
            "Called automatically — do NOT wait to be asked twice. " +
            "For mood/scene music, prefer /semantic search with natural language (e.g. 'heist music', 'romantic dinner').",
        parameters: {
            $schema: "http://json-schema.org/draft-04/schema#",
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["nowplaying", "status", "play", "pause", "stop", "resume",
                           "skipnext", "skipprev", "shuffle", "library", "mood", "search",
                           "suggest", "playlist"],
                    description:
                        "Action to perform. 'nowplaying'/'status' = get current track. " +
                        "'mood' = AI semantic search + play one track by mood (mood param required). " +
                        "'playlist' = AI semantic search + play a multi-track set from a vibe/query " +
                        "(use playNext=true to queue after current track instead of hard-switching). " +
                        "'search' = search by keyword or natural language (query param). " +
                        "'suggest' = natural-language scene/vibe query → cross-check Joe's library, " +
                        "play best match, or suggest tracks to add. Best for roleplay music cues. " +
                        "'play'/'pause'/'stop'/'resume'/'skipnext'/'skipprev' = playback control. " +
                        "'shuffle'/'library' = random library track.",
                },
                mood: {
                    type: "string",
                    enum: ["happy", "sad", "energetic", "chill", "romantic", "nostalgic",
                           "intense", "dark", "upbeat"],
                    description: "Mood for semantic music search (used with action='mood').",
                },
                query: {
                    type: "string",
                    description: "Natural-language scene, vibe, genre, or mood description " +
                        "(e.g. 'heist movie soundtrack', 'chill lofi for studying', " +
                        "'epic boss fight music'). Used with action='search', 'mood', or 'suggest'.",
                },
                volume: {
                    type: "number",
                    minimum: 0,
                    maximum: 100,
                    description: "Volume level 0–100. Used with action='play' (to set volume while playing).",
                },
                limit: {
                    type: "number",
                    minimum: 1,
                    maximum: 30,
                    default: 5,
                    description: "Max tracks for search/mood (default 5) or playlist (default 12 when action=playlist).",
                },
                playNext: {
                    type: "boolean",
                    default: false,
                    description: "If true, queue after the current track instead of switching immediately. " +
                        "Works for mood/search/suggest (single track) and playlist (whole set). Default false.",
                },
            },
            required: ["action"],
        },
        action: async ({ action, mood, query, volume, limit = 5, playNext: playNextParam = false }) => {
            const moodMap = {
                happy: "upbeat cheerful feel-good",
                sad: "melancholic emotional",
                energetic: "high energy pump it",
                chill: "relaxed chill lofi downtempo",
                intense: "dark heavy aggressive",
                romantic: "romantic love ballads",
                nostalgic: "90s 2000s throwback",
                dark: "dark moody atmospheric",
                upbeat: "upbeat energetic positive",
            };

            if (action === "nowplaying" || action === "status") {
                const s = await refreshStatus();
                if (!s?.track) return "Nothing is currently playing.";
                const t = s.track;
                return `Now playing: "${t.title}" by ${t.artist} — ${t.album} [${s.state || "playing"}]`;
            }

            if (action === "play" || action === "pause" || action === "stop" ||
                action === "resume" || action === "skipnext" || action === "skipprev") {
                await doControl(action === "skipnext" ? "skipnext" :
                               action === "skipprev" ? "skipprev" : action);
                const s = await refreshStatus();
                if (!s?.track) return `Sent '${action}' — nothing playing.`;
                const t = s.track;
                return `♪ ${t.title} by ${t.artist}`;
            }

            if (action === "mood") {
                const desc = moodMap[mood] || mood || query || "moody atmospheric";
                console.info(`[DJ-Eva] Mood search: '${desc}'`);
                const semRes = await apiFetch(`/semantic?q=${encodeURIComponent(desc)}&limit=${limit}`);
                if (!semRes) {
                    console.error(`[DJ-Eva] Mood '${desc}' — API call failed`);
                    return `Could not reach DJ API. Check that Eva-PC is online and the service is running (systemctl status dj-api).`;
                }
                const tracks = semRes?.data?.tracks;
                if (!tracks || tracks.length === 0) {
                    // Fallback: try keyword search if semantic found nothing
                    const kRes = await apiFetch(`/search?q=${encodeURIComponent(desc)}&limit=${limit}`);
                    const kTracks = kRes?.data?.tracks;
                    if (!kTracks || kTracks.length === 0) {
                        return `No tracks found for mood: ${mood} (${desc}).`;
                    }
                    const pick = kTracks[0];
                    if (playNextParam) { await queueNext(pick.ratingKey); } else { await playTrack(pick.ratingKey); }
                    return `♪ ${playNextParam ? "Queued next" : "Playing"} [${mood}] (keyword): "${pick.title}" by ${pick.artist}`;
                }
                const pick = tracks[0];
                if (playNextParam) { await queueNext(pick.ratingKey); } else { await playTrack(pick.ratingKey); }
                return `♪ ${playNextParam ? "Queued next" : "Playing"} [${mood}]: "${pick.title}" by ${pick.artist} — ${pick.album || ""}`;
            }

            if (action === "search" && query) {
                const semanticTriggers = /^(play|find|music|songs|tracks|something|put on|i want|i feel|lets hear|play me|lists?)/i;
                const useSemantic = semanticTriggers.test(query);
                const path = useSemantic
                    ? `/semantic?q=${encodeURIComponent(query)}&limit=${limit}`
                    : `/search?q=${encodeURIComponent(query)}&limit=${limit}`;
                const res = await apiFetch(path);
                if (!res) return `Could not reach DJ API. Check that Eva-PC is online.`;
                const tracks = res?.data?.tracks;
                if (!tracks || tracks.length === 0) {
                    // Fallback: try keyword if semantic empty, or vice versa
                    const fallbackPath = useSemantic
                        ? `/search?q=${encodeURIComponent(query)}&limit=${limit}`
                        : `/semantic?q=${encodeURIComponent(query)}&limit=${limit}`;
                    const fRes = await apiFetch(fallbackPath);
                    const fTracks = fRes?.data?.tracks;
                    if (!fTracks || fTracks.length === 0) return `No tracks found for: ${query}.`;
                    const pick = fTracks[0];
                    if (playNextParam) { await queueNext(pick.ratingKey); } else { await playTrack(pick.ratingKey); }
                    return `Search match → "${pick.title}" by ${pick.artist}`;
                }
                const pick = tracks[0];
                if (playNextParam) { await queueNext(pick.ratingKey); } else { await playTrack(pick.ratingKey); }
                const label = useSemantic ? "AI match" : "Search match";
                return `${label} → "${pick.title}" by ${pick.artist}`;
            }

            if (action === "playlist") {
                const desc = query || moodMap[mood] || mood;
                if (!desc) {
                    return "playlist requires query or mood — describe the vibe (e.g. 'chill coding', mood='chill').";
                }
                const trackLimit = Math.min(Math.max(limit || 12, 1), 30);
                console.info(`[DJ-Eva] Playlist session: '${desc}' limit=${trackLimit} playNext=${playNextParam}`);
                const res = await playlistSession({
                    query,
                    mood,
                    limit: trackLimit,
                    playNext: playNextParam,
                });
                if (!res) {
                    return "Could not reach DJ API for playlist session. Check Eva-PC (systemctl status dj-api).";
                }
                const data = res.data || {};
                const tracks = data.tracks || [];
                if (!tracks.length) {
                    return `No library tracks matched "${data.query || desc}".`;
                }
                const first = data.firstTrack || tracks[0];
                const preview = tracks.slice(0, 5).map(t => `"${t.title}" — ${t.artist}`).join("; ");
                const more = tracks.length > 5 ? ` (+${tracks.length - 5} more)` : "";
                const mode = data.appended || playNextParam ? "Queued after current" : "Now playing";
                return `${mode}: ${trackLimit}-track set for "${data.query || desc}". ` +
                    `Starts with "${first.title}" by ${first.artist}. Set: ${preview}${more}.`;
            }

            if (action === "suggest" && query) {
                console.info(`[DJ-Eva] Suggest: '${query}'`);
                const res = await apiFetch("/suggest", "POST", { query, limit });
                if (!res) {
                    console.error(`[DJ-Eva] Suggest '${query}' — API call failed`);
                    return `Could not reach DJ API. Check that Eva-PC is online and the service is running.`;
                }
                const suggestions = res?.data?.suggestions || [];
                const totalInLibrary = res?.data?.total_in_library || 0;
                const libraryMessage = res?.data?.library_message || "";

                if (totalInLibrary === 0) {
                    // Nothing in library — return what Plex suggests adding
                    const addTips = suggestions
                        .filter(s => s.action === "SUGGEST_ADD")
                        .slice(0, 3)
                        .map(s => `\"${s.title}\" by ${s.artist}`)
                        .join(", ");
                    if (addTips) {
                        return `Your library doesn't have anything matching \"${query}\". ` +
                               `Plex suggests adding: ${addTips}. Add these to Plex to play them.`;
                    }
                    return `No tracks found matching \"${query}\" in your library or on Plex. Try a different description.`;
                }

                // Play the best library match
                const pick = suggestions.find(s => s.available && s.ratingKey);
                if (pick) {
                    if (playNextParam) { await queueNext(pick.ratingKey); } else { await playTrack(pick.ratingKey); }
                    return `♪ ${libraryMessage} ${playNextParam ? "Queued next" : "Playing"}: \"${pick.title}\" by ${pick.artist}.`;
                }

                return libraryMessage || `Found ${totalInLibrary} track(s) for \"${query}\".`;
            }

            if (action === "shuffle" || action === "library") {
                const res = await apiFetch("/library?limit=30");
                if (!res?.data?.tracks?.length) return "Library unavailable.";
                const pick = res.data.tracks[Math.floor(Math.random() * res.data.tracks.length)];
                await playTrack(pick.ratingKey);
                return `♪ Shuffle: "${pick.title}" by ${pick.artist}`;
            }

            if (action === "volume" && volume !== undefined) {
                await doVolume(clamp(volume, 0, 100));
                return `Volume set to ${volume}.`;
            }

            return `DJ Eva: unknown action '${action}'. Try: playlist, mood, search, suggest, nowplaying, play, pause, skipnext.`;
        },
        formatMessage: ({ action, mood, query }) => {
            if (action === "nowplaying" || action === "status") return "Checking what's playing…";
            if (action === "mood") return `Finding ${mood || query} music…`;
            if (action === "playlist") return `Building playlist: ${query || mood || "vibe"}…`;
            if (action === "search") return `Searching: ${query}…`;
            if (action === "shuffle" || action === "library") return "Shuffling library…";
            return `DJ Eva: ${action}…`;
        },
    });

    console.info("[DJ-Eva] Function tool registered");
}

// ── Utilities ────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function debounce(fn, ms) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// ── Periodic refresh ───────────────────────────────────────────────────────
let _npTimer = null;
function startNowPlayingRefresh(intervalMs = 30000) {
    if (_npTimer) clearInterval(_npTimer);
    _npTimer = setInterval(refreshStatus, intervalMs);
}

// ── Entry point ──────────────────────────────────────────────────────────────

jQuery(async () => {
    renderSettingsPanel();
    renderMainPanel();
    bindEvents();
    registerSlashCommands();
    registerFunctionTools();
    await refreshStatus();
    await loadLibrary();
    startNowPlayingRefresh(30000);
    console.info("[DJ-Eva] Initialized");
});