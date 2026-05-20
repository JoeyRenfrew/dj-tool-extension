/**
 * Extension-DJEva — SillyTavern UI Extension
 * DJ Eva: Plexamp control with semantic (FAISS) search via /dj slash commands.
 *
 * Settings panel lets you configure:
 *   - API URL: the base URL of the DJ API server (Eva-PC)
 *   - Use Proxy: route through SillyTavern's /proxy to avoid mixed-content blocks
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
    apiUrl: 'http://100.120.54.7:38250',
    useProxy: true,
};

// ── State ────────────────────────────────────────────────────────────────────

let currentStatus = { state: "idle", playing: false, track: null };
let suggestCache  = [];
let isLoading     = false;

// ── API URL resolver ─────────────────────────────────────────────────────────

function getApiBase() {
    if (extension_settings.djeva?.useProxy && window.location.origin) {
        // SillyTavern's built-in proxy: https://host/proxy/http://target
        // This avoids mixed-content blocking when ST is served over HTTPS
        return window.location.origin + '/proxy' + extension_settings.djeva.apiUrl;
    }
    return extension_settings.djeva?.apiUrl || defaultSettings.apiUrl;
}

function addSlash(url) {
    return url.endsWith('/') ? url : url + '/';
}

// ── API helpers ──────────────────────────────────────────────────────────────

async function apiFetch(path, opts = {}) {
    const base = addSlash(getApiBase());
    const url = base + 'api/dj' + path;  // path starts with /
    try {
        const r = await fetch(url, {
            headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
            ...opts,
        });
        const j = await r.json();
        if (!j.ok) {
            toastr.error(j.error || "DJ API error", "DJ Eva");
            return null;
        }
        return j;
    } catch (e) {
        toastr.error(`DJ API unreachable: ${e.message}`, "DJ Eva");
        return null;
    }
}

// ── Refresh now-playing ──────────────────────────────────────────────────────

async function refreshStatus() {
    const res = await apiFetch("/status");
    if (!res) return;
    currentStatus = res.data || currentStatus;
    updateNowPlayingUI(currentStatus);
    return currentStatus;
}

// ── UI: Now Playing ─────────────────────────────────────────────────────────

function updateNowPlayingUI(status) {
    const el = document.getElementById("djeva_nowplaying");
    const vol = document.getElementById("djeva_vol_pct");
    if (!el) return;
    if (!status?.track) {
        el.innerHTML = '<span class="djeva_muted">Nothing playing</span>';
        return;
    }
    const t = status.track;
    const artist = t.artist || "";
    const title  = t.title  || "Unknown";
    const state  = status.state || "unknown";
    const elapsed = status.time ? fmtDuration(status.time) : "?";
    const total   = t.duration ? fmtDuration(t.duration * 1000) : "?";
    el.innerHTML = `
        <div class="djeva-track">
            <div class="djeva-track-title">${escHtml(title)}</div>
            <div class="djeva-track-artist">${escHtml(artist)}</div>
        </div>
        <div class="djeva-track-meta">
            <span class="djeva-badge djeva-state-${state}">${state}</span>
            ${elapsed} / ${total}
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
        document.getElementById("djeva_results").innerHTML =
            `<div class="djeva_empty">No tracks found for <em>${escHtml(query)}</em></div>`;
        suggestCache = [];
        return;
    }
    suggestCache = res.data.tracks;
    renderResults(suggestCache, mode);
}

function renderResults(tracks, mode) {
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
    const res = await apiFetch("/play", {
        method: "POST",
        body: JSON.stringify({ ratingKey: String(key).split("/").pop() }),
    });
    if (res) {
        toastr.success(`▶ ${res.data?.track?.title || "Track"}`, "DJ Eva");
        setTimeout(refreshStatus, 500);
    }
}

async function doControl(action) {
    const res = await apiFetch("/control", {
        method: "POST",
        body: JSON.stringify({ action }),
    });
    if (res) {
        toastr.info(action, "DJ Eva");
        setTimeout(refreshStatus, 500);
    }
}

async function doVolume(level) {
    await apiFetch("/volume", {
        method: "POST",
        body: JSON.stringify({ level }),
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
                <b>🎧 DJ Eva</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div>
                    <label for="djeva_api_url">DJ API URL</label>
                    <div><small>The base URL of Eva's DJ API server (e.g. http://100.120.54.7:38250)</small></div>
                    <input id="djeva_api_url" class="text_pole" type="text" placeholder="${defaultSettings.apiUrl}" />
                </div>
                <div>
                    <label class="checkbox_label for="djeva_use_proxy">
                        <input id="djeva_use_proxy" type="checkbox" />
                        <span>Use SillyTavern proxy</span>
                        <a rel="noopener" href="https://docs.sillytavern.app/usage/proxy/" class="notes-link" target="_blank">
                            <span class="note-link-span">?</span>
                        </a>
                    </label>
                    <div><small>Enable this if SillyTavern is served over HTTPS and the API is HTTP. Routes requests through SillyTavern's built-in proxy to avoid mixed-content blocking.</small></div>
                </div>
                <div class="djeva-status-bar">
                    <span id="djeva_status" class="djeva_muted">Checking connection…</span>
                </div>
            </div>
        </div>
    </div>`;

    const extensionContainer = document.getElementById('djeva_settings_container') ?? document.getElementById('extensions_settings');
    $(extensionContainer).append(html);

    // Populate from settings
    if (extension_settings.djeva === undefined) {
        extension_settings.djeva = {};
    }
    for (const key in defaultSettings) {
        if (extension_settings.djeva[key] === undefined) {
            extension_settings.djeva[key] = defaultSettings[key];
        }
    }

    $('#djeva_api_url').val(extension_settings.djeva.apiUrl).on('input', function () {
        extension_settings.djeva.apiUrl = String($(this).val());
        saveSettingsDebounced();
        checkConnection();
    });

    $('#djeva_use_proxy').prop('checked', extension_settings.djeva.useProxy).on('change', function () {
        extension_settings.djeva.useProxy = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    // Initial connection check
    setTimeout(checkConnection, 500);
}

async function checkConnection() {
    const el = document.getElementById('djeva_status');
    if (!el) return;
    const base = addSlash(getApiBase());
    const url = base + 'api/dj/ping';
    try {
        const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
        if (r.ok) {
            const j = await r.json();
            el.textContent = j?.ok ? `✓ Connected — ${j.ts}` : '✗ Unexpected response';
            el.style.color = 'var(--success)';
        } else {
            el.textContent = `✗ HTTP ${r.status}`;
            el.style.color = 'var(--error)';
        }
    } catch (e) {
        el.textContent = `✗ ${e.message || 'Unreachable'}`;
        el.style.color = 'var(--error)';
    }
}

// ── Main panel (now-playing, controls, search) ───────────────────────────────

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

            </div>
        </div>
    </div>`;

    const extensionContainer = document.getElementById('djeva_main_container') ?? document.getElementById('extensions_settings2');
    $(extensionContainer).append(html);
}

// ── Event bindings ───────────────────────────────────────────────────────────

function bindEvents() {
    // Playback controls
    $(document).on("click", "#djeva_play",  () => doControl("play"));
    $(document).on("click", "#djeva_pause", () => doControl("pause"));
    $(document).on("click", "#djeva_stop",  () => doControl("stop"));
    $(document).on("click", "#djeva_next",  () => doControl("skipnext"));
    $(document).on("click", "#djeva_prev",  () => doControl("skipprev"));

    // Volume slider
    $(document).on("input", "#djeva_volume", debounce(async e => {
        const lvl = parseInt($(e.target).val(), 10);
        $("#djeva_vol_pct").text(`${lvl}%`);
        await doVolume(lvl);
    }, 400));

    // Search bar: button
    $(document).on("click", "#djeva_search_btn", async () => {
        const q    = $("#djeva_query").val()?.trim();
        const mode = $("#djeva_mode").val();
        if (!q) return;
        if (mode === "keyword") {
            await doSearch(q, "keyword");
        } else if (mode === "semantic") {
            await doSearch(q, "semantic");
        } else {
            await doSearch(q, "auto");
        }
    });

    // Search bar: Enter key
    $(document).on("keydown", "#djeva_query", async e => {
        if (e.key !== "Enter") return;
        $("#djeva_search_btn").trigger("click");
    });

    // Mood chips
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
        renderResults(res.data.tracks, "semantic");
    });

    // Play result button
    $(document).on("click", ".djeva-play-btn", async e => {
        const key = $(e.currentTarget).data("key");
        if (key) await playTrack(key);
    });

    // Random library
    $(document).on("click", "#djeva_library_btn", loadLibrary);
}

// ── Slash Commands ───────────────────────────────────────────────────────────

function registerSlashCommands() {
    if (typeof SlashCommandParser === "undefined") return;

    SlashCommandParser.addCommandObject(
        SlashCommand.fromProps({
            name: "dj",
            aliases: ["music", "play"],
            callback: async (namedArgs, unnamedArgs) => {
                const query    = unnamedArgs.join(" ").trim();
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
<div>/dj play &lt;query&gt; — search + play</div>
<div>/dj &lt;natural language&gt; — semantic search + play</div>
<div>/dj key=&lt;key&gt; — play by Plex key</div>
<div>/dj pause|stop|skipnext|resume</div>
<div>/dj volume level=80</div>
<div>/dj mood happy|sad|energetic|chill|intense|romantic|nostalgic</div>
<div>/dj mode=semantic|keyword</div>
<div>/dj library|shuffle — random tracks</div>`;
            },
            returns: "DJ action result or track list",
            namedArgumentList: [
                SlashCommandNamedArgument.fromProps({
                    name: "action",
                    description: "Action: play, pause, stop, skipnext, skipprev, resume, library, shuffle, random",
                    typeList: [ARGUMENT_TYPE.STRING],
                    enumList: ["play", "pause", "stop", "skipnext", "skipprev", "resume", "next", "prev", "library", "shuffle", "random"],
                }),
                SlashCommandNamedArgument.fromProps({
                    name: "key",
                    description: "Plex ratingKey or /library/metadata/… path",
                    typeList: [ARGUMENT_TYPE.STRING],
                }),
                SlashCommandNamedArgument.fromProps({
                    name: "track",
                    description: "Alternate key field",
                    typeList: [ARGUMENT_TYPE.STRING],
                }),
                SlashCommandNamedArgument.fromProps({
                    name: "volume",
                    description: "Volume level 0-100",
                    typeList: [ARGUMENT_TYPE.NUMBER],
                }),
                SlashCommandNamedArgument.fromProps({
                    name: "level",
                    description: "Volume level (alias)",
                    typeList: [ARGUMENT_TYPE.NUMBER],
                }),
                SlashCommandNamedArgument.fromProps({
                    name: "mood",
                    description: "Mood filter: happy, sad, energetic, chill, intense, romantic, nostalgic",
                    typeList: [ARGUMENT_TYPE.STRING],
                    enumList: ["happy", "sad", "energetic", "chill", "intense", "romantic", "nostalgic"],
                }),
                SlashCommandNamedArgument.fromProps({
                    name: "mode",
                    description: "Search mode: semantic (AI) or keyword (Plex default)",
                    typeList: [ARGUMENT_TYPE.STRING],
                    enumList: ["semantic", "keyword", "auto"],
                }),
                SlashCommandNamedArgument.fromProps({
                    name: "limit",
                    description: "Max results (default 10)",
                    typeList: [ARGUMENT_TYPE.NUMBER],
                    defaultValue: "10",
                }),
            ],
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({
                    description: "Search query or natural-language request",
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: false,
                }),
            ],
            helpString: `
<div><b>DJ Eva — Plexamp Control</b></div>
<div>Use natural language or keywords to search your Plex library.</div>
<br/>
<div><b>Examples:</b></div>
<ul>
  <li><code>/dj play pumping music</code></li>
  <li><code>/dj driving at night songs</code></li>
  <li><code>/dj i need something chill to study to</code></li>
  <li><code>/dj mood energetic</code></li>
  <li><code>/dj library</code></li>
  <li><code>/dj volume level=60</code></li>
</ul>`,
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
            helpString: "<div><b>/nowplaying</b> — show what's playing on Plexamp</div>",
        })
    );
}

// ── Utilities ────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function debounce(fn, ms) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

// ── Entry point ──────────────────────────────────────────────────────────────

jQuery(async () => {
    renderSettingsPanel();
    renderMainPanel();
    bindEvents();
    registerSlashCommands();
    await refreshStatus();
    await loadLibrary();
    console.info("[DJ-Eva] Initialized");
});