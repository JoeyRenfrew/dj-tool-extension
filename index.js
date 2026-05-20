/**
 * Extension-DJEva — SillyTavern UI Extension
 * DJ Eva: Plexamp control with semantic (FAISS) search via /dj slash commands.
 *
 * The extension calls the DJ API on Eva-PC (http://eva-pc.ts.net:38250)
 * instead of running Plexapi directly. This keeps secrets and the heavy
 * lifting on the server and keeps the SillyTavern install clean.
 *
 * Author: Joe Armella
 * License: AGPL-3.0
 */

// ── Constants ────────────────────────────────────────────────────────────────

const API = "http://eva-pc.ts.net:38250/api/dj";
const EXT  = "dj-eva";
const FOLDER = `scripts/extensions/third-party/${EXT}`;

// ── State ────────────────────────────────────────────────────────────────────

let currentStatus = { state: "idle", playing: false, track: null };
let suggestCache  = [];
let isLoading     = false;

// ── API helpers ──────────────────────────────────────────────────────────────

async function apiFetch(path, opts = {}) {
    const url = `${API}${path}`;
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

                // Direct actions
                if (action === "pause" || action === "stop" || action === "skipnext" ||
                    action === "skipprev" || action === "resume" || action === "next" ||
                    action === "prev") {
                    await doControl(action === "skipnext" ? "skipnext" :
                                   action === "skipprev" ? "skipprev" : action);
                    return;
                }

                // Volume
                if (volLevel !== undefined) {
                    await doVolume(clamp(+volLevel, 0, 100));
                    return `Volume set to ${volLevel}.`;
                }

                // Play by key
                if (key) {
                    await playTrack(key);
                    return;
                }

                // Library shuffle
                if (action === "library" || action === "shuffle" || action === "random") {
                    const res = await apiFetch("/library?limit=30");
                    if (!res?.data?.tracks?.length) return "Library unavailable.";
                    const pick = res.data.tracks[Math.floor(Math.random() * res.data.tracks.length)];
                    await playTrack(pick.ratingKey);
                    return `Playing: ${pick.title} — ${pick.artist}`;
                }

                // Mood-based semantic search
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

                // Natural language / semantic search
                if (query) {
                    // Auto-detect semantic vs keyword: if the query sounds like a description,
                    // use semantic. Otherwise keyword. Or respect explicit mode=.
                    const semanticTriggers = /^(play|find|music|songs|tracks|something|put on|i want|i feel|i need|lists|music for)/i;
                    const useSemantic = mode === "semantic" || (mode === "auto" && semanticTriggers.test(query));
                    const path = useSemantic
                        ? `/semantic?q=${encodeURIComponent(query)}&limit=${limit}`
                        : `/search?q=${encodeURIComponent(query)}&limit=${limit}`;
                    const res = await apiFetch(path);
                    if (!res?.data?.tracks?.length) {
                        return `No tracks found for: ${query}`;
                    }
                    const t = res.data.tracks[0];
                    await playTrack(t.ratingKey);
                    const label = useSemantic ? "Semantic" : "Keyword";
                    return `${label} match → ${t.title} — ${t.artist}`;
                }

                // Nothing: return help
                return `<b>DJ Eva — /dj</b>
<div>/dj play &lt;query&gt; — search + play</div>
<div>/dj &lt;natural language&gt; — semantic search + play</div>
<div>/dj play key=&lt;key&gt; — play by Plex key</div>
<div>/dj pause|stop|skipnext|resume</div>
<div>/dj volume level=80</div>
<div>/dj mood happy|sad|energetic|chill|intense|romantic|nostalgic</div>
<div>/dj mode=semantic|keyword</div>
<div>/dj library — random tracks</div>`;
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
                    description: "Search mode: semantic (AI) or keyword ( Plex default)",
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
  <li><code>/dj mode=semantic i need something chill to study to</code></li>
  <li><code>/dj mood energetic</code></li>
  <li><code>/dj library</code></li>
  <li><code>/dj volume level=60</code></li>
</ul>`,
        })
    );

    // Secondary /nowplaying
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

// ── Settings panel: render ───────────────────────────────────────────────────

async function renderPanel() {
    const { renderExtensionTemplateAsync } = SillyTavern.getContext();
    try {
        const html = await renderExtensionTemplateAsync(`third-party/${EXT}`, "settings");
        $("#extensions_settings2").append(html);
    } catch (e) {
        // Fallback: inline render if template unavailable
        console.warn("[DJ-Eva] Template render failed, using inline HTML:", e);
        $("#extensions_settings2").append(getInlinePanelHTML());
    }
    bindEvents();
    refreshStatus();
    loadLibrary();
}

function getInlinePanelHTML() {
    return `
    <div class="djeva-panel">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🎧 DJ Eva</b>
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
}

// ── Event bindings ───────────────────────────────────────────────────────────

function bindEvents() {
    // If the inline HTML was injected directly (no template render), we still
    // need to bind. Use delegation on the panel container.
    const $panel = $("#djeva-panel-root").length
        ? $("#djeva-panel-root")
        : $(".djeva-panel");

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
            // auto: detect
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
        toastr.info(`Mood: ${mood}`, "DJ Eva");
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
        renderResults(res.data.tracks, "semantic");
    });

    // Play result button (delegated)
    $(document).on("click", ".djeva-play-btn", async e => {
        const key = $(e.currentTarget).data("key");
        if (key) await playTrack(key);
    });

    // Random library
    $(document).on("click", "#djeva_library_btn", loadLibrary);
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
    await renderPanel();
    registerSlashCommands();
    console.info("[DJ-Eva] Initialized — API:", API);
});