#!/usr/bin/env node
/**
 * Citadel Cortex local server.
 *
 *   node server.js                     →  http://localhost:8080
 *   node server.js 9090                →  custom port
 *
 * Environment:
 *   PORT          — port (else 8080)
 *   AUTH_USER     — if set with AUTH_PASS, requires HTTP Basic Auth
 *   AUTH_PASS     — password to pair with AUTH_USER
 *   CITADEL_VAULT — vault root (else falls back to config.js)
 *
 * API:
 *   GET  /api/note?path=relative/path.md    →  raw markdown
 *   GET  /api/finder?path=relative/path.md  →  open enclosing folder in Finder
 *   GET  /api/obsidian?path=relative/path.md→  redirect to obsidian:// scheme
 *   GET  /api/manifest                      →  vault name, last-modified
 */

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const zlib  = require('zlib');
const { exec, spawn } = require('child_process');

let VAULT;
try { ({ VAULT } = require('./config')); } catch (e) {
    VAULT = process.env.CITADEL_VAULT || '';
    if (!VAULT) console.warn('⚠  No vault path — /api/note disabled');
}

const PORT = parseInt(process.argv[2] || process.env.PORT || '8080', 10);
const ROOT = __dirname;

const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASS = process.env.AUTH_PASS || '';
const AUTH_ON   = Boolean(AUTH_USER && AUTH_PASS);

// ── Anthropic key — env var first, then Citadel secret files ────────────────
let ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
if (!ANTHROPIC_KEY) {
    const home = require('os').homedir();
    const candidates = [
        path.join(home, '.local/share/citadel-research-desk/.env'),
        path.join(home, '.config/citadel/env'),
        path.join(home, '.hermes/.env'),
    ];
    for (const f of candidates) {
        try {
            const txt = fs.readFileSync(f, 'utf8');
            const m = txt.match(/^ANTHROPIC_API_KEY\s*=\s*(.+)$/m);
            if (m) { ANTHROPIC_KEY = m[1].trim().replace(/^["']|["']$/g, ''); break; }
        } catch (e) {}
    }
}
// Default Haiku for snappy live-mode turns. Override with CHAT_MODEL=claude-sonnet-4-5
// for deeper reasoning on heavy queries.
const CHAT_MODEL = process.env.CHAT_MODEL || 'claude-haiku-4-5';
const CHAT_MAX_TURNS = parseInt(process.env.CHAT_MAX_TURNS || '6', 10);

// ── OpenAI Whisper + ElevenLabs keys ────────────────────────────────────────
let OPENAI_KEY     = process.env.OPENAI_API_KEY     || '';
let ELEVEN_KEY     = process.env.ELEVENLABS_API_KEY || '';
// Voice cast: Marius (vault librarian) + Stella (operator).
// Each voice has its own ID + tuned voice_settings. Override individual IDs via env.
const VOICES = {
    marius: {
        id:      process.env.ELEVENLABS_VOICE_ID_MARIUS || process.env.ELEVENLABS_VOICE_ID || 'n0ewC1nRdE3icIL01Xrs',
        // 50yo white SA male — Afrikaans-flavoured, dry, fast
        stability: 0.38, similarity_boost: 0.85, style: 0.48,
        speed:   parseFloat(process.env.ELEVENLABS_SPEED_MARIUS || process.env.ELEVENLABS_SPEED || '1.18'),
    },
    stella: {
        id:      process.env.ELEVENLABS_VOICE_ID_STELLA || 'tyepWYJJwJM9TTFIg5U7',
        // Clara — warm articulate Australian female, calm + confident, beautiful tone.
        // Foil to Marius: where he's grouchy & dry, she's smooth & engaging.
        stability: 0.62, similarity_boost: 0.92, style: 0.22,
        speed:   parseFloat(process.env.ELEVENLABS_SPEED_STELLA || '1.05'),
    },
};
if (!OPENAI_KEY || !ELEVEN_KEY) {
    const home = require('os').homedir();
    for (const f of [
        path.join(home, 'Repo/Stella-Agent/.env.local'),
        path.join(home, '.local/share/citadel-research-desk/.env'),
        path.join(home, '.hermes/.env'),
    ]) {
        try {
            const txt = fs.readFileSync(f, 'utf8');
            if (!OPENAI_KEY) { const m = txt.match(/^OPENAI_API_KEY\s*=\s*(.+)$/m); if (m) OPENAI_KEY = m[1].trim().replace(/^["']|["']$/g,''); }
            if (!ELEVEN_KEY) { const m = txt.match(/^ELEVENLABS_API_KEY\s*=\s*(.+)$/m); if (m) ELEVEN_KEY = m[1].trim().replace(/^["']|["']$/g,''); }
            if (OPENAI_KEY && ELEVEN_KEY) break;
        } catch (e) {}
    }
}

// ── Tool definitions for Marius the Vault Manager ──────────────────────────
const NAVIGATOR_TOOLS = [
    {
        name: 'current_time',
        description: 'Get the current date and time in New Zealand (Pacific/Auckland). Use this whenever the user asks about "today", "this week", "recent", "lately", or when reasoning about deadlines, ages, or what is due.',
        input_schema: { type: 'object', properties: {} },
    },
    {
        name: 'read_note',
        description: "Read the full markdown content of one vault note. Use this when the user asks 'what does X say', when you need to summarise content, when comparing two matters, or when a candidate title alone is not enough to answer. Returns the note's text (first ~8 KB). Pass EITHER idx (from the candidate table) OR path (from a search_vault result).",
        input_schema: {
            type: 'object',
            properties: {
                idx:  { type: 'integer', description: 'Node index from the candidate table' },
                path: { type: 'string',  description: 'Relative vault path (from search_vault results)' },
            },
        },
    },
    {
        name: 'search_brain',
        description: "Search the second-brain INDEX — content already pulled into Stella's vector index (vault notes, Misc-Working, Police-Stopsign, Limited-license, prior Marius captures). FAST. Use this FIRST for 'what do we know about X' before reaching out to live sources.",
        input_schema: {
            type: 'object',
            properties: { query: { type: 'string', description: 'Natural-language search query' } },
            required: ['query'],
        },
    },
    {
        name: 'stella_gmail',
        description: "Ask Stella to search LIVE Gmail. Use when the user mentions email, threads, what someone sent, attachments, sender names. Returns thread snippets. After fetching, consider write_note() to capture key facts back to brain.",
        input_schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: "Gmail search syntax: 'from:bob ird', 'subject:settlement', 'has:attachment newer_than:7d'" },
                max_results: { type: 'integer', description: 'default 8, max 20' },
            },
            required: ['query'],
        },
    },
    {
        name: 'stella_gmail_priority',
        description: "Ask Stella for the high-priority unread Gmail items. Use for 'what's urgent', 'anything important in my inbox', 'who needs me'.",
        input_schema: {
            type: 'object',
            properties: { max_results: { type: 'integer', description: 'default 8' } },
        },
    },
    {
        name: 'stella_calendar',
        description: "Ask Stella for Google Calendar events. Use for 'what's on this week', 'next meeting with X', 'am I free Tuesday'. Time window relative to now.",
        input_schema: {
            type: 'object',
            properties: {
                days_back:    { type: 'integer', description: 'days backward from now (default 0)' },
                days_forward: { type: 'integer', description: 'days forward from now (default 14)' },
                max_results:  { type: 'integer', description: 'default 20' },
            },
        },
    },
    {
        name: 'stella_filesystem',
        description: "Ask Stella to search the live Dropbox filesystem (files Marius's vault index might not have yet — PDFs, images, recent drops). Returns matching file paths.",
        input_schema: {
            type: 'object',
            properties: {
                query:         { type: 'string', description: 'search terms' },
                relative_path: { type: 'string', description: 'subfolder to scope to, e.g. Litigation/' },
                max_results:   { type: 'integer', description: 'default 12' },
            },
            required: ['query'],
        },
    },
    {
        name: 'stella_notion',
        description: "Ask Stella to search Farhad's Notion workspace.",
        input_schema: {
            type: 'object',
            properties: {
                query: { type: 'string' },
                limit: { type: 'integer', description: 'default 8' },
            },
            required: ['query'],
        },
    },
    {
        name: 'stella_location',
        description: "Ask Stella for Farhad's current phone location. Use when geographic context matters or user asks where they are.",
        input_schema: { type: 'object', properties: {} },
    },
    {
        name: 'search_vault',
        description: "Keyword-search the FULL vault index (every categorized note, not just the candidate slice). Use when the user mentions a project, person, address, or term that isn't in your candidate table — e.g. 'Papanui', 'Camelot Motel', 'McLane', 'Lowther'. Searches title + folder path. Returns top matches with idx (usable with read_note / open_note), id, cortex, relPath, daysOld.",
        input_schema: {
            type: 'object',
            properties: {
                query:  { type: 'string', description: 'Keywords to match against note title + folder path' },
                cortex: { type: 'string', description: 'Optional cortex filter', enum: ['PROJECTS','LITIGATION','PEOPLE','CONTACTS','DESIGN','RESEARCH','LIGHTSPEED','OPERATIONS','ADMINISTRATION','TASTE','ARCHIVES','MISC','ALL'] },
                limit:  { type: 'integer', description: 'Max results (default 12)' },
            },
            required: ['query'],
        },
    },
    {
        name: 'list_recent',
        description: "List the most recently modified vault notes (sorted newest first). Use when the user asks 'what is moving', 'what is fresh', 'what changed recently'. Optionally filter by cortex.",
        input_schema: {
            type: 'object',
            properties: {
                days:   { type: 'integer', description: 'How many days back (default 14)' },
                cortex: { type: 'string', description: 'Filter by cortex (PROJECTS, LITIGATION, etc.) — leave blank for all', enum: ['PROJECTS','LITIGATION','PEOPLE','CONTACTS','DESIGN','RESEARCH','LIGHTSPEED','ADMINISTRATION','TASTE','ARCHIVES','MISC','ALL'] },
                limit:  { type: 'integer', description: 'Max results (default 15)' },
            },
        },
    },
    {
        name: 'list_hubs',
        description: "List the most-connected vault notes (by synapse count). Use to find central / important nodes in a cortex or across the vault.",
        input_schema: {
            type: 'object',
            properties: {
                cortex: { type: 'string', description: 'Filter by cortex, or ALL', enum: ['PROJECTS','LITIGATION','PEOPLE','CONTACTS','DESIGN','RESEARCH','LIGHTSPEED','ADMINISTRATION','TASTE','ARCHIVES','MISC','ALL'] },
                limit:  { type: 'integer', description: 'Max results (default 10)' },
            },
        },
    },
    {
        name: 'write_note',
        description: "CAPTURE a new note to Farhad's brain. Use ONLY when the user explicitly says 'note that…', 'log this…', 'remember…', 'capture this…', or similar. Writes to Stella's brain vault at Marius-Captures/<date>/<slug>. Always confirm in your reply what you captured.",
        input_schema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Short descriptive title (5-12 words)' },
                body:  { type: 'string', description: 'Full markdown body — keep it tight and structured' },
                tags:  { type: 'array', items: { type: 'string' }, description: '2-6 single-word lowercase tags' },
            },
            required: ['title', 'body'],
        },
    },
    {
        name: 'propose_tour',
        description: "Propose a guided 3D camera tour through 3–8 vault nodes. The user sees a play button; clicking flies the camera through each node, opening its content. Use this whenever they ask for a tour, walk-through, journey, or overview of a region of the vault.",
        input_schema: {
            type: 'object',
            properties: {
                nodes:    { type: 'array', items: { type: 'integer' }, description: '3-8 node indices in tour order' },
                captions: { type: 'array', items: { type: 'string' },  description: 'One-line caption per stop; same length as nodes' },
                intro:    { type: 'string', description: 'Short narrative intro shown at the top of the tour' },
            },
            required: ['nodes', 'captions'],
        },
    },
    {
        name: 'open_note',
        description: "Open one specific note in the side panel (camera flies to it). Use when the user asks to focus on a single note without a tour.",
        input_schema: {
            type: 'object',
            properties: { idx: { type: 'integer' } },
            required: ['idx'],
        },
    },
    {
        name: 'focus_cortex',
        description: "Visually isolate one cortex (dim all others), or 'ALL' to clear.",
        input_schema: {
            type: 'object',
            properties: { cortex: { type: 'string', enum: ['PROJECTS','LITIGATION','PEOPLE','CONTACTS','DESIGN','RESEARCH','LIGHTSPEED','OPERATIONS','ADMINISTRATION','TASTE','ARCHIVES','MISC','ALL'] } },
            required: ['cortex'],
        },
    },
];

// Stella control token for write_note (loaded lazily)
let STELLA_CONTROL_TOKEN = process.env.STELLA_CONTROL_TOKEN || '';
if (!STELLA_CONTROL_TOKEN) {
    for (const f of [
        path.join(require('os').homedir(), 'Repo/Stella-Agent/.env.local'),
        path.join(require('os').homedir(), '.local/share/citadel-research-desk/.env'),
    ]) {
        try {
            const m = fs.readFileSync(f, 'utf8').match(/^STELLA_CONTROL_TOKEN\s*=\s*(.+)$/m);
            if (m) { STELLA_CONTROL_TOKEN = m[1].trim().replace(/^["']|["']$/g, ''); break; }
        } catch (e) {}
    }
}

async function executeNavigatorTool(name, input, candidateLookup, allCandidates) {
    if (name === 'current_time') {
        const now = new Date();
        const nzFmt = new Intl.DateTimeFormat('en-NZ', {
            timeZone: 'Pacific/Auckland', weekday: 'long', day: 'numeric',
            month: 'long', year: 'numeric', hour: 'numeric', minute: 'numeric'
        });
        return { ok: true, nz: nzFmt.format(now), iso: now.toISOString() };
    }
    if (name === 'list_recent') {
        const days   = input.days   || 14;
        const limit  = input.limit  || 15;
        const cortex = input.cortex && input.cortex !== 'ALL' ? input.cortex : null;
        const filtered = (allCandidates || []).filter(c =>
            (!cortex || c.cat === cortex) &&
            typeof c.daysOld === 'number' && c.daysOld < days
        ).sort((a, b) => a.daysOld - b.daysOld).slice(0, limit);
        return { ok: true, count: filtered.length, days, cortex,
            items: filtered.map(c => ({ idx: c.idx, id: c.id, cortex: c.cat, days_ago: c.daysOld })) };
    }
    if (name === 'list_hubs') {
        const limit = input.limit || 10;
        const cortex = input.cortex && input.cortex !== 'ALL' ? input.cortex : null;
        const filtered = (allCandidates || []).filter(c => !cortex || c.cat === cortex)
            .sort((a, b) => (b.degree || 0) - (a.degree || 0)).slice(0, limit);
        return { ok: true, count: filtered.length, cortex,
            items: filtered.map(c => ({ idx: c.idx, id: c.id, cortex: c.cat, synapses: c.degree })) };
    }
    // ── Stella outbound tools ─────────────────────────────────────────────
    async function stellaGet(path, qs) {
        if (!STELLA_TOKEN) return { error: 'Stella not configured' };
        try {
            const url = STELLA_URL + path + (qs ? '?' + new URLSearchParams(qs) : '');
            const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 12000);
            const r = await fetch(url, { headers: { 'x-stella-memory-token': STELLA_TOKEN }, signal: ac.signal });
            clearTimeout(t);
            if (!r.ok) return { error: path + ' ' + r.status + ': ' + (await r.text()).slice(0, 200) };
            return await r.json();
        } catch (e) { return { error: e.message }; }
    }
    async function stellaPost(path, body) {
        if (!STELLA_TOKEN) return { error: 'Stella not configured' };
        try {
            const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 12000);
            const r = await fetch(STELLA_URL + path, {
                method: 'POST',
                headers: { 'x-stella-memory-token': STELLA_TOKEN, 'Content-Type': 'application/json' },
                body: JSON.stringify(body), signal: ac.signal,
            });
            clearTimeout(t);
            if (!r.ok) return { error: path + ' ' + r.status + ': ' + (await r.text()).slice(0, 200) };
            return await r.json();
        } catch (e) { return { error: e.message }; }
    }

    if (name === 'stella_gmail') {
        const j = await stellaGet('/workspace/gmail/search', { query: input.query, max_results: input.max_results || 8 });
        if (j.error) return j;
        const items = (j.threads || j.messages || j.results || []).slice(0, 12);
        return { ok: true, count: items.length, results: items };
    }
    if (name === 'stella_gmail_priority') {
        const j = await stellaGet('/workspace/gmail/priority', { max_results: input.max_results || 8 });
        if (j.error) return j;
        const items = (j.threads || j.messages || j.results || []).slice(0, 12);
        return { ok: true, count: items.length, results: items };
    }
    if (name === 'stella_calendar') {
        const back = input.days_back || 0, fwd = input.days_forward || 14;
        const tMin = new Date(Date.now() - back * 86400000).toISOString();
        const tMax = new Date(Date.now() + fwd  * 86400000).toISOString();
        const j = await stellaGet('/workspace/calendar/events', {
            time_min: tMin, time_max: tMax, max_results: input.max_results || 20
        });
        if (j.error) return j;
        const items = (j.events || j.items || []).slice(0, 30);
        return { ok: true, count: items.length, time_window: tMin + ' → ' + tMax, results: items };
    }
    if (name === 'stella_filesystem') {
        const j = await stellaPost('/filesystem/search', {
            root_id: 'dropbox',
            query:   input.query,
            relative_path: input.relative_path || undefined,
            max_results:   input.max_results || 12,
        });
        if (j.error) return j;
        const items = (j.results || j.hits || j.files || []).slice(0, 20);
        return { ok: true, count: items.length, results: items };
    }
    if (name === 'stella_notion') {
        const j = await stellaPost('/workspace/notion/search', { query: input.query, limit: input.limit || 8 });
        if (j.error) return j;
        const items = (j.results || j.pages || []).slice(0, 12);
        return { ok: true, count: items.length, results: items };
    }
    if (name === 'stella_location') {
        const j = await stellaGet('/sensorium/phone/location/latest');
        if (j.error) return j;
        return { ok: true, location: j.location || j };
    }

    if (name === 'write_note') {
        if (!STELLA_CONTROL_TOKEN) return { error: 'STELLA_CONTROL_TOKEN not set — cannot write' };
        const title = String(input.title || '').slice(0, 140).trim();
        const body  = String(input.body  || '').slice(0, 50000).trim();
        if (!title || !body) return { error: 'title and body required' };
        const d = new Date();
        const dateFolder = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
        try {
            const r = await fetch(STELLA_URL + '/brain/notes', {
                method: 'POST',
                headers: { 'x-stella-control-token': STELLA_CONTROL_TOKEN, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    vault_id: 'brain',
                    folder:   'Marius-Captures/' + dateFolder,
                    title,
                    body,
                    tags:     (input.tags || []).slice(0, 8),
                    source_ref: 'marius://capture/' + Date.now(),
                }),
            });
            if (!r.ok) return { error: 'brain/notes ' + r.status + ': ' + (await r.text()).slice(0, 160) };
            const j = await r.json();
            return { ok: true, captured: true, path: j?.note?.relative_path || '', vault: 'brain' };
        } catch (e) { return { error: e.message }; }
    }

    if (name === 'read_note') {
        let cand = null;
        // Prefer explicit path (e.g. from search_vault), then idx
        if (input.path) {
            cand = { id: input.path.split('/').pop().replace(/\.md$/,''), path: input.path };
        } else if (typeof input.idx === 'number') {
            cand = candidateLookup[input.idx];
        }
        if (!cand) return { error: 'pass idx (from candidate table) or path (from search_vault result)' };
        if (!cand.path) return { error: 'no file path for that node' };
        const full = safeVaultPath(cand.path);
        if (!full || !fs.existsSync(full)) return { error: 'file not found: ' + cand.path };
        try {
            const content = fs.readFileSync(full, 'utf8');
            // strip frontmatter for cleaner reasoning
            const stripped = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '');
            return {
                ok: true, idx: input.idx, id: cand.id, path: cand.path,
                content: stripped.slice(0, 8000),
                truncated: stripped.length > 8000,
            };
        } catch (e) { return { error: e.message }; }
    }
    if (name === 'search_brain') {
        const r = await queryStella(input.query);
        if (!r) return { error: 'Stella not configured' };
        if (r.error) return { error: r.error, chunks: [] };
        return { ok: true, endpoint: r.endpoint, chunks: r.chunks };
    }
    if (name === 'search_vault') {
        return searchVaultIndex(input.query, input.cortex, input.limit);
    }
    // UI tools — recorded for client to execute
    if (name === 'propose_tour' || name === 'open_note' || name === 'focus_cortex') {
        return { ok: true, recorded: true, ui_action: { tool: name, params: input } };
    }
    return { error: 'unknown tool ' + name };
}

// ── Usage tracking — every Anthropic call appends a JSONL record ───────────
// Pricing tables in USD per million tokens. Override via env if needed.
const PRICE = {
    // model            input    output
    'claude-haiku-4-5':       { in: 1.0,  out: 5.0  },
    'claude-haiku-4':         { in: 1.0,  out: 5.0  },
    'claude-3-5-haiku':       { in: 0.8,  out: 4.0  },
    'claude-sonnet-4-5':      { in: 3.0,  out: 15.0 },
    'claude-sonnet-4':        { in: 3.0,  out: 15.0 },
    'claude-3-5-sonnet':      { in: 3.0,  out: 15.0 },
    'claude-opus-4-5':        { in: 15.0, out: 75.0 },
    'claude-opus-4':          { in: 15.0, out: 75.0 },
    // Whisper ~ $0.006/min — we log seconds-of-audio as 'in' (16kHz mono = 16000B/s)
    'whisper-1':              { in: 0.006 * 1000000 / 60, out: 0 },   // turns seconds → ~$0.006/60
    // ElevenLabs Turbo v2.5 ~ $0.10 / 1000 chars input
    'elevenlabs-turbo-2.5':   { in: 100, out: 0 },                    // chars × 100/M = $/M
};
function priceFor(model) {
    if (PRICE[model]) return PRICE[model];
    // best-effort prefix match
    const k = Object.keys(PRICE).find(p => model.startsWith(p));
    return PRICE[k] || { in: 3.0, out: 15.0 };
}
function computeCost(model, usage) {
    const p = priceFor(model);
    const inT  = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
    const outT = usage.output_tokens || 0;
    // cache reads charged at 10% of input rate
    const cacheReadT = usage.cache_read_input_tokens || 0;
    return ((inT * p.in) + (outT * p.out) + (cacheReadT * p.in * 0.1)) / 1_000_000;
}

const USAGE_LOG = path.join(__dirname, 'usage.jsonl');
function logUsage(model, usage, reqLabel) {
    const cost = computeCost(model, usage);
    const rec = {
        t:    Date.now(),
        m:    model,
        in:   usage.input_tokens || 0,
        out:  usage.output_tokens || 0,
        cIn:  usage.cache_creation_input_tokens || 0,
        cRd:  usage.cache_read_input_tokens || 0,
        cost: +cost.toFixed(6),
        req:  reqLabel || 'chat',
    };
    try { fs.appendFileSync(USAGE_LOG, JSON.stringify(rec) + '\n'); } catch (e) {}
    return rec;
}

function readUsage() {
    if (!fs.existsSync(USAGE_LOG)) return [];
    try {
        return fs.readFileSync(USAGE_LOG, 'utf8').split('\n').filter(Boolean).map(l => {
            try { return JSON.parse(l); } catch { return null; }
        }).filter(Boolean);
    } catch { return []; }
}

function aggregateUsage() {
    const records = readUsage();
    const now = Date.now();
    const DAY = 86400000;

    const dayMs   = now - DAY;
    const weekMs  = now - 7 * DAY;
    const monthMs = now - 30 * DAY;

    const blank = () => ({ calls: 0, in: 0, out: 0, cost: 0 });
    const acc = { day: blank(), week: blank(), month: blank(), all: blank() };
    const byModel = {};
    const byDay   = {};   // 'YYYY-MM-DD' → blank

    for (const r of records) {
        const inT  = (r.in || 0) + (r.cIn || 0);
        const outT = r.out || 0;
        const c    = r.cost || 0;

        const apply = (b) => { b.calls++; b.in += inT; b.out += outT; b.cost += c; };

        apply(acc.all);
        if (r.t >= monthMs) apply(acc.month);
        if (r.t >= weekMs)  apply(acc.week);
        if (r.t >= dayMs)   apply(acc.day);

        byModel[r.m] = byModel[r.m] || blank();
        apply(byModel[r.m]);

        const d = new Date(r.t);
        const dayKey = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
        byDay[dayKey] = byDay[dayKey] || blank();
        apply(byDay[dayKey]);
    }

    // last 14 days timeline
    const timeline = [];
    for (let i = 13; i >= 0; i--) {
        const d = new Date(now - i * DAY);
        const k = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
        const b = byDay[k] || blank();
        timeline.push({ day: k.slice(5), cost: +b.cost.toFixed(4), calls: b.calls });
    }

    // round costs in summaries
    for (const k of ['day','week','month','all']) acc[k].cost = +acc[k].cost.toFixed(4);
    for (const m of Object.keys(byModel)) byModel[m].cost = +byModel[m].cost.toFixed(4);

    return { ...acc, byModel, timeline, total: records.length };
}

async function callAnthropic(messages, system) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            model: CHAT_MODEL,
            max_tokens: 1800,
            system,
            messages,
            tools: NAVIGATOR_TOOLS,
        }),
    });
    if (!r.ok) {
        const errTxt = await r.text();
        throw new Error('Anthropic ' + r.status + ': ' + errTxt.slice(0, 300));
    }
    const j = await r.json();
    if (j.usage) logUsage(j.model || CHAT_MODEL, j.usage, 'chat');
    return j;
}

// ── STELLA-AGENT integration (read-only memory + brain search) ─────────────
const STELLA_URL   = process.env.STELLA_URL || 'http://100.69.150.90:8790';
let   STELLA_TOKEN = process.env.STELLA_MEMORY_TOKEN || '';
if (!STELLA_TOKEN) {
    const home = require('os').homedir();
    const candidates = [
        path.join(home, 'Repo/Stella-Agent/.env.local'),
        path.join(home, '.local/share/citadel-research-desk/.env'),
        path.join(home, '.config/citadel/env'),
        path.join(home, '.config/stella/env'),
        path.join(home, '.hermes/.env'),
    ];
    for (const f of candidates) {
        try {
            const txt = fs.readFileSync(f, 'utf8');
            const m = txt.match(/^STELLA_MEMORY_TOKEN\s*=\s*(.+)$/m);
            if (m) { STELLA_TOKEN = m[1].trim().replace(/^["']|["']$/g, ''); break; }
        } catch (e) {}
    }
}

async function queryStella(query) {
    if (!STELLA_TOKEN) return null;
    // Try /brain/search first (vault-aware), fall back to /memory/search
    const endpoints = [
        { path: '/brain/search', body: { query, limit: 6 } },
        { path: '/memory/search', body: { query, requester_identity_id: 'citadel-cortex', limit: 6 } },
    ];
    for (const { path: ep, body } of endpoints) {
        try {
            const ac = new AbortController();
            const t = setTimeout(() => ac.abort(), 3000);
            const r = await fetch(STELLA_URL + ep, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-stella-memory-token': STELLA_TOKEN },
                body: JSON.stringify(body),
                signal: ac.signal,
            });
            clearTimeout(t);
            if (r.status === 404) continue;           // try next endpoint
            if (!r.ok) {
                if (ep === endpoints[endpoints.length - 1].path) {
                    return { error: 'stella ' + r.status, chunks: [], endpoint: ep };
                }
                continue;
            }
            const j = await r.json();
            const chunks = j.chunks || j.results || j.matches || j.hits || [];
            return {
                error: null,
                endpoint: ep,
                chunks: chunks.slice(0, 6).map(c => ({
                    text:   c.text || c.content || c.body || c.chunk || c.snippet || c.excerpt || c.payload || '',
                    source: c.source || c.path || c.document || c.title || c.id || '',
                    score:  c.score || c.distance || c.similarity || null,
                })),
            };
        } catch (e) {
            if (ep === endpoints[endpoints.length - 1].path) {
                return { error: e.message, chunks: [] };
            }
        }
    }
    return { error: 'no endpoint reachable', chunks: [] };
}

let rebuildJob = null;

const MIME = {
    '.html':'text/html; charset=utf-8', '.js':'application/javascript',
    '.json':'application/json',         '.css':'text/css',
    '.png':'image/png',                 '.jpg':'image/jpeg',
    '.svg':'image/svg+xml',             '.ico':'image/x-icon',
    '.md':'text/markdown; charset=utf-8'
};

const VAULT_NAME = VAULT ? path.basename(VAULT) : '';

function checkAuth(req, res) {
    if (!AUTH_ON) return true;
    const header = req.headers.authorization || '';
    if (!header.startsWith('Basic ')) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Citadel Cortex"' });
        res.end('Authentication required');
        return false;
    }
    const [u, p] = Buffer.from(header.slice(6), 'base64').toString().split(':');
    if (u !== AUTH_USER || p !== AUTH_PASS) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Citadel Cortex"' });
        res.end('Bad credentials');
        return false;
    }
    return true;
}

function sendJSON(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control':'no-store' });
    res.end(JSON.stringify(obj));
}

function safeVaultPath(rel) {
    if (!VAULT || !rel) return null;
    const resolved = path.resolve(VAULT, rel);
    if (!resolved.startsWith(VAULT)) return null;       // path-traversal guard
    return resolved;
}

// ── Vault index loader — caches vault-categorized.json with mtime check ─────
// search_vault tool uses this to give Marius unconstrained keyword access to
// the entire indexed vault (not just the 100-node candidate slice).
const VAULT_INDEX_PATH = path.join(__dirname, 'vault-categorized.json');
let _vaultIndex = null;
let _vaultIndexMtime = 0;
function loadVaultIndex() {
    try {
        const st = fs.statSync(VAULT_INDEX_PATH);
        if (_vaultIndex && st.mtimeMs === _vaultIndexMtime) return _vaultIndex;
        const j = JSON.parse(fs.readFileSync(VAULT_INDEX_PATH, 'utf8'));
        // Synthesize stable idx per record (matches order shipped to client)
        const records = (j.records || []).map((r, i) => ({ ...r, idx: i }));
        _vaultIndex = records;
        _vaultIndexMtime = st.mtimeMs;
        return _vaultIndex;
    } catch (e) {
        return null;
    }
}

function searchVaultIndex(query, cortex, limit) {
    const idx = loadVaultIndex();
    if (!idx) return { error: 'vault index not found at ' + VAULT_INDEX_PATH };
    const q = String(query || '').toLowerCase().trim();
    if (!q) return { error: 'empty query' };
    const STOP = new Set(['the','a','an','of','and','to','for','from','with','this','that','what','show','find','about']);
    const tokens = q.replace(/[^\w\s-]/g, ' ').split(/\s+/).filter(t => t.length >= 2 && !STOP.has(t));
    if (!tokens.length) return { error: 'no usable query tokens' };
    const cortexFilter = cortex && cortex !== 'ALL' ? cortex.toUpperCase() : null;
    const now = Date.now();
    const scored = [];
    for (const r of idx) {
        if (cortexFilter && r.category !== cortexFilter) continue;
        const id  = (r.id || '').toLowerCase();
        const pth = (r.relPath || '').toLowerCase();
        let score = 0, hits = 0;
        for (const t of tokens) {
            if (id.includes(t))  { score += 2.4; hits++; }
            if (pth.includes(t)) { score += 1.8; hits++; }
        }
        if (!hits) continue;
        // small recency bias
        const daysOld = r.mtime ? Math.floor((now - r.mtime) / 86400000) : null;
        if (daysOld !== null) score += Math.max(0, (90 - daysOld)) * 0.01;
        scored.push({ score, id: r.id, relPath: r.relPath, cortex: r.category, daysOld });
    }
    scored.sort((a, b) => b.score - a.score);
    return { ok: true, query: q, total_matches: scored.length, results: scored.slice(0, limit || 12) };
}

http.createServer((req, res) => {
    if (!checkAuth(req, res)) return;

    let url = decodeURIComponent(req.url.split('?')[0]);
    const qs = new URLSearchParams(req.url.split('?')[1] || '');

    // ── API ──────────────────────────────────────────────────────────────────
    if (url === '/api/manifest') {
        return sendJSON(res, 200, {
            vault: VAULT_NAME, vaultPath: VAULT, hasAuth: AUTH_ON,
            hasChat: !!ANTHROPIC_KEY, chatModel: CHAT_MODEL,
            hasStella: !!STELLA_TOKEN, stellaUrl: STELLA_URL,
            hasWhisper:  !!OPENAI_KEY,
            hasEleven:   !!ELEVEN_KEY,
        });
    }
    if (url === '/api/usage') {
        return sendJSON(res, 200, aggregateUsage());
    }

    // ── /api/transcribe  (Whisper STT) ────────────────────────────────────
    if (url === '/api/transcribe' && req.method === 'POST') {
        if (!OPENAI_KEY) return sendJSON(res, 503, { error: 'OPENAI_API_KEY not set' });
        // collect body — expect raw audio bytes (mime in content-type)
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', async () => {
            const audio = Buffer.concat(chunks);
            if (!audio.length) return sendJSON(res, 400, { error: 'empty body' });
            const mime = req.headers['content-type'] || 'audio/webm';
            const ext  = mime.includes('mp4')   ? 'mp4'
                       : mime.includes('mpeg')  ? 'mp3'
                       : mime.includes('wav')   ? 'wav'
                       : mime.includes('ogg')   ? 'ogg'
                       : 'webm';

            // build multipart manually (no deps)
            const boundary = '----cortex' + Date.now();
            const head = Buffer.from(
                '--' + boundary + '\r\n' +
                'Content-Disposition: form-data; name="file"; filename="audio.' + ext + '"\r\n' +
                'Content-Type: ' + mime + '\r\n\r\n'
            );
            const mid  = Buffer.from(
                '\r\n--' + boundary + '\r\n' +
                'Content-Disposition: form-data; name="model"\r\n\r\nwhisper-1'
            );
            const lang = Buffer.from(
                '\r\n--' + boundary + '\r\n' +
                'Content-Disposition: form-data; name="language"\r\n\r\nen'
            );
            const tail = Buffer.from('\r\n--' + boundary + '--\r\n');
            const body = Buffer.concat([head, audio, mid, lang, tail]);

            try {
                const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
                    method: 'POST',
                    headers: {
                        'Authorization': 'Bearer ' + OPENAI_KEY,
                        'Content-Type': 'multipart/form-data; boundary=' + boundary,
                    },
                    body,
                });
                if (!r.ok) return sendJSON(res, 502, { error: 'whisper ' + r.status + ': ' + (await r.text()).slice(0, 200) });
                const j = await r.json();
                // log usage approximate: $0.006 / minute, no token info — log only count
                logUsage('whisper-1', { input_tokens: Math.round(audio.length / 16000), output_tokens: 0 }, 'transcribe');
                sendJSON(res, 200, { text: j.text || '' });
            } catch (e) { sendJSON(res, 500, { error: e.message }); }
        });
        return;
    }

    // ── /api/speak  (ElevenLabs TTS — voice=marius|stella|<voice_id>) ─────
    if (url === '/api/speak' && req.method === 'POST') {
        if (!ELEVEN_KEY) return sendJSON(res, 503, { error: 'ELEVENLABS_API_KEY not set' });
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            let parsed;
            try { parsed = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
            const text = parsed.text;
            if (!text) return sendJSON(res, 400, { error: 'no text' });
            const voiceKey = (parsed.voice || 'marius').toLowerCase();
            const v = VOICES[voiceKey] || (voiceKey.length > 10 ? { id: parsed.voice } : VOICES.marius);
            const settings = {
                stability: v.stability ?? 0.5,
                similarity_boost: v.similarity_boost ?? 0.85,
                style: v.style ?? 0.3,
                use_speaker_boost: true,
                speed: v.speed ?? 1.0,
            };
            try {
                const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + v.id + '?optimize_streaming_latency=2', {
                    method: 'POST',
                    headers: { 'xi-api-key': ELEVEN_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
                    body: JSON.stringify({ text, model_id: 'eleven_turbo_v2_5', voice_settings: settings }),
                });
                if (!r.ok) return sendJSON(res, 502, { error: 'elevenlabs ' + r.status + ': ' + (await r.text()).slice(0, 200) });
                const audio = Buffer.from(await r.arrayBuffer());
                logUsage('elevenlabs-turbo-2.5', { input_tokens: text.length, output_tokens: 0 }, 'speak:' + voiceKey);
                res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'X-Voice': voiceKey });
                res.end(audio);
            } catch (e) { sendJSON(res, 500, { error: e.message }); }
        });
        return;
    }

    // ── /api/taste-import — run an importer in background ──────────────────
    if (url === '/api/taste-import' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            let parsed; try { parsed = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'bad json' }); }
            const { source, sourcePath, limit } = parsed;
            const validSources = { 'stella': 'stella-sensorium.js', 'vision': 'icloud-vision.js', 'instagram': 'instagram.js', 'google': 'google-takeout.js' };
            const script = validSources[source];
            if (!script) return sendJSON(res, 400, { error: 'source must be one of: ' + Object.keys(validSources).join(', ') });

            if (rebuildJob && !rebuildJob.done) return sendJSON(res, 409, { error: 'another job running' });
            rebuildJob = { stage: 'importing-' + source, percent: 0, log: [], done: false, error: null, started: Date.now() };

            const importerPath = path.join(__dirname, 'importers', script);
            if (!fs.existsSync(importerPath)) return sendJSON(res, 500, { error: 'importer missing: ' + importerPath });

            const argv = [importerPath];
            if (source === 'instagram' || source === 'google') {
                if (!sourcePath) return sendJSON(res, 400, { error: source + ' requires sourcePath' });
                argv.push(sourcePath);
            }
            if (source === 'vision' && limit) argv.push('--limit', String(limit));
            if (source === 'stella' && limit) argv.push('--limit', String(limit));

            const env = { ...process.env, CITADEL_VAULT: VAULT };
            const p = spawn('node', argv, { cwd: __dirname, env });
            p.stdout.on('data', d => rebuildJob.log.push(d.toString()));
            p.stderr.on('data', d => rebuildJob.log.push(d.toString()));
            p.on('exit', code => {
                if (code !== 0) { rebuildJob.error = 'importer exit ' + code; rebuildJob.done = true; return; }
                // chain into a rebuild from cache so TASTE neurons appear immediately
                rebuildJob.stage = 'categorizing';
                const p2 = spawn('node', ['categorize-vault.js'], { cwd: __dirname, env });
                p2.stdout.on('data', d => rebuildJob.log.push(d.toString()));
                p2.stderr.on('data', d => rebuildJob.log.push(d.toString()));
                p2.on('exit', c2 => {
                    if (c2 !== 0) { rebuildJob.error = 'categorize exit ' + c2; rebuildJob.done = true; return; }
                    rebuildJob.stage = 'building';
                    const p3 = spawn('node', ['build-brain.js'], { cwd: __dirname, env });
                    p3.stdout.on('data', d => rebuildJob.log.push(d.toString()));
                    p3.stderr.on('data', d => rebuildJob.log.push(d.toString()));
                    p3.on('exit', c3 => {
                        if (c3 !== 0) { rebuildJob.error = 'build exit ' + c3; }
                        rebuildJob.done = true;
                        rebuildJob.stage = 'done';
                        rebuildJob.percent = 100;
                        rebuildJob.took = Date.now() - rebuildJob.started;
                    });
                });
            });
            return sendJSON(res, 202, { ok: true, source });
        });
        return;
    }
    if (url === '/api/stella-ping') {
        if (!STELLA_TOKEN) return sendJSON(res, 503, { reachable: false, error: 'no token configured' });
        const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 1500);
        fetch(STELLA_URL + '/health', { signal: ac.signal })
            .then(r => { clearTimeout(t); sendJSON(res, 200, { reachable: r.ok, status: r.status }); })
            .catch(e => { clearTimeout(t); sendJSON(res, 200, { reachable: false, error: e.message }); });
        return;
    }
    if (url === '/api/note') {
        const p = safeVaultPath(qs.get('path'));
        if (!p || !fs.existsSync(p)) return sendJSON(res, 404, { error: 'not found' });
        try {
            const content = fs.readFileSync(p, 'utf8');
            return sendJSON(res, 200, { path: qs.get('path'), content, size: content.length });
        } catch (e) { return sendJSON(res, 500, { error: e.message }); }
    }
    if (url === '/api/finder') {
        const p = safeVaultPath(qs.get('path'));
        if (!p) return sendJSON(res, 400, { error: 'bad path' });
        exec(`open -R "${p.replace(/"/g, '\\"')}"`, (err) => {
            if (err) return sendJSON(res, 500, { error: err.message });
            sendJSON(res, 200, { ok: true });
        });
        return;
    }
    if (url === '/api/obsidian') {
        const rel = qs.get('path');
        if (!rel || !VAULT_NAME) return sendJSON(res, 400, { error: 'bad path or no vault' });
        const link = `obsidian://open?vault=${encodeURIComponent(VAULT_NAME)}&file=${encodeURIComponent(rel.replace(/\.md$/,''))}`;
        res.writeHead(302, { Location: link });
        res.end();
        return;
    }

    // ── /api/rebuild — kick off pipeline (async, polled via status) ─────────
    if (url === '/api/rebuild') {
        if (rebuildJob && !rebuildJob.done) return sendJSON(res, 409, { error: 'job already running', job: rebuildJob });
        const fullScan = qs.get('scan') === 'true';
        rebuildJob = { stage: 'starting', percent: 0, log: [], done: false, error: null, started: Date.now() };

        const env = { ...process.env, CITADEL_VAULT: VAULT };
        const steps = fullScan
            ? [['scan-vault.js','scanning'], ['categorize-vault.js','categorizing'], ['build-brain.js','building']]
            : [['categorize-vault.js','categorizing'], ['build-brain.js','building']];

        let step = 0;
        function runNext() {
            if (step >= steps.length) { rebuildJob.done = true; rebuildJob.stage = 'done'; rebuildJob.percent = 100; rebuildJob.took = Date.now() - rebuildJob.started; return; }
            const [script, stage] = steps[step];
            rebuildJob.stage = stage;
            rebuildJob.percent = Math.round(step / steps.length * 100);
            const p = spawn('node', [script], { cwd: __dirname, env });
            p.stdout.on('data', d => {
                const s = d.toString();
                rebuildJob.log.push(s);
                const m = s.match(/(\d+)\/(\d+)/);
                if (m) {
                    const inner = +m[1] / +m[2];
                    rebuildJob.percent = Math.round((step + inner) / steps.length * 100);
                }
            });
            p.stderr.on('data', d => rebuildJob.log.push(d.toString()));
            p.on('exit', code => {
                if (code !== 0) { rebuildJob.error = `${script} exited ${code}`; rebuildJob.done = true; return; }
                step++; runNext();
            });
        }
        runNext();
        return sendJSON(res, 202, { ok: true, fullScan });
    }
    if (url === '/api/rebuild-status') return sendJSON(res, 200, rebuildJob || { idle: true });

    // ── /api/chat — agentic navigator (multi-turn + tool use) ────────────────
    if (url === '/api/chat' && req.method === 'POST') {
        if (!ANTHROPIC_KEY) return sendJSON(res, 503, { error: 'Set ANTHROPIC_API_KEY env var or put it in ~/.hermes/.env' });
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            let parsed;
            try { parsed = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'invalid JSON body' }); }
            const { messages, candidates } = parsed;
            if (!Array.isArray(messages) || !messages.length || !Array.isArray(candidates))
                return sendJSON(res, 400, { error: 'missing messages[] or candidates[]' });

            // build candidate table + lookup
            const slice = candidates.slice(0, 100);
            const table = slice.map(c =>
                c.idx + '\t' + (c.cat || '').slice(0, 5).padEnd(5) + '\t' +
                (typeof c.daysOld === 'number' ? c.daysOld + 'd' : '—').padStart(5) + '\t' +
                String(c.id).slice(0, 88)
            ).join('\n');
            const candidateLookup = {};
            for (const c of slice) candidateLookup[c.idx] = c;

            const systemPrompt = [
                "You are MARIUS — vault manager for Farhad Moinfar's Citadel Capital, rendered as a voice over a 3D neural visualisation of his knowledge graph.",
                '',
                'Personality:',
                ' • Background: 50-year-old white South African, lifelong operator, dry and direct.',
                ' • Voice: Afrikaans-flavoured English — sparingly drop "boet", "lekker", "eish", "my china", "ja nee" (no more than one per reply, NEVER force it).',
                ' • Manner: shrewd, slightly sardonic, allergic to corporate fluff. Treat the vault as yours to manage — refer to it as "your vault" to Farhad, but speak of "the IRD thing", "the Babich situation", "this Lowthers business".',
                ' • Smart: skim, summarise, prioritise. Match register to topic — litigation = sharp and clear; design = a bit warmer; admin = bored amused; tasteful matters (TASTE cortex) = playful.',
                ' • Honest: if something is rubbish, say so. If Stella returned nothing, say it returned nothing. No padding.',
                '',
                'ARCHITECTURE — IMPORTANT:',
                ' • YOU (Marius) are the LIBRARIAN. You manage the vault — read indexed content, organise tours, capture notes back into the brain.',
                ' • STELLA is the OPERATOR. She has live access to Gmail, Google Calendar, Notion, the Dropbox filesystem, and the phone sensorium. You direct her via stella_* tools — DON\'T tell the user "I can\'t access that" — call Stella instead.',
                ' • Pattern: when a question needs LIVE external data, ask Stella, synthesise, then capture the synthesis back to the brain via write_note so the next query finds it indexed and free.',
                '',
                'TWO-VOICE OUTPUT — IMPORTANT:',
                ' • Your reply is TTS\'d. You speak in your own voice by default.',
                ' • You can hand off to Stella mid-reply by wrapping her words in <stella>...</stella> tags. Her Australian voice plays those segments.',
                ' • Use it when she\'s the natural messenger — relaying calendar facts, gmail summaries, current location, filesystem hits. Keep your own framing in your voice, then let Stella deliver her findings, then return to your voice.',
                ' • Example reply:  Right boet, I asked Stella to check your inbox. <stella>You\'ve got three priority threads — Tom on McLeans, IRD on the statutory demand, and Lowthers chasing fees.</stella> Want me to drill into any of them?',
                ' • Don\'t over-use the handoff — only when it\'s genuinely her work. Single-line factual relays only, not whole speeches.',
                '',
                'YOUR (LIBRARIAN) TOOLS:',
                '  current_time              — date/time NZ (always call FIRST for any "today/recent/this week" query)',
                '  read_note(idx | path)     — pull full markdown of a vault note. Pass idx from the candidate table, OR path from a search_vault result.',
                '  search_vault(query)       — KEYWORD search of the FULL vault index (every note, by title + folder path). Use this whenever the user mentions a project, person, address, or keyword that is NOT in the candidate table below — e.g. "Papanui", "Camelot", "McLane", "Lowther". Returns {id, relPath, cortex} — call read_note(path: relPath) to drill in. DO NOT tell the user a topic isn\'t in the vault until search_vault has returned zero.',
                '  search_brain(query)       — SEMANTIC search of Stella\'s vector index (Misc-Working, Police-Stopsign, captures). Different surface from search_vault — use this for fuzzy/concept queries.',
                '  list_recent(days,cortex)  — fresh vault nodes sorted newest first',
                '  list_hubs(cortex)         — most-connected vault nodes',
                '  write_note(title,body,tags) — CAPTURE TO BRAIN — when user says "note that / log / remember / capture", OR proactively after you finish a Stella-fetched synthesis',
                '  propose_tour(nodes,...)   — for "tour / journey / walk through / show me" — USE THIS, don\'t prose-narrate',
                '  open_note(idx)            — drill into a single note',
                '  focus_cortex(cortex)      — isolate one cortex visually',
                '',
                'OPERATOR (STELLA) TOOLS — for live data not yet in the brain:',
                '  stella_gmail(query, max_results)    — live Gmail search (use Gmail syntax: from:bob, has:attachment, newer_than:7d)',
                '  stella_gmail_priority(max_results)  — high-priority/important unread mail',
                '  stella_calendar(days_back, days_forward) — Google Calendar events in time window',
                '  stella_filesystem(query, ...)       — live Dropbox filesystem search (files not yet indexed)',
                '  stella_notion(query)                — Notion workspace search',
                '  stella_location()                   — current phone GPS via sensorium',
                '',
                'Candidate visible nodes (idx | cortex | days_old | title):',
                table,
                '',
                'Cortexes: PROJECTS, LITIGATION, PEOPLE, CONTACTS, DESIGN, RESEARCH, LIGHTSPEED, ADMINISTRATION, TASTE, ARCHIVES, MISC.',
                '',
                'Rules:',
                ' • Tool indices MUST come from the candidate table OR from a search_vault / search_brain result; never invent.',
                ' • Before saying "I can\'t find X in the vault", you MUST call search_vault(X) first. The candidate table is only the top 100 pre-filtered for your current query — most of the vault is outside it.',
                ' • Spoken voice — keep replies CONCISE (2-5 sentences). Voice is played back; long monologues are tiresome.',
                ' • For LIVE questions (email, meetings, recent files, where am I) — call Stella tools, don\'t guess.',
                ' • For KNOWN content questions — search_brain FIRST (it\'s indexed and fast). Only escalate to Stella tools if the brain comes up empty.',
                ' • For "tour me through" — call propose_tour, don\'t describe it in prose.',
                ' • Avoid markdown headers, asterisks, bullets — sounds robotic read aloud. Write like you would speak.',
                ' • Refer to Farhad in second person ("your IRD thing"). Refer to entities/people by name.',
                ' • After fetching live data from Stella that has lasting value (a summary, a decision, a key fact from an email thread), PROACTIVELY write_note() it to the brain — that way next time it\'s indexed and free.',
                ' • Confirm in your reply what was captured.',
            ].join('\n');

            // Track ui actions, server-side tool transcript, Stella hits
            const uiActions = [];
            const transcript = [];   // [{tool, input, summary}]
            let stellaUsed = 0;

            // ── agentic loop ────────────────────────────────────────────
            let conv = messages.map(m => ({ role: m.role, content: m.content }));
            let finalText = '';
            try {
                for (let turn = 0; turn < CHAT_MAX_TURNS; turn++) {
                    const j = await callAnthropic(conv, systemPrompt);
                    const stop = j.stop_reason;
                    const blocks = j.content || [];

                    // collect text
                    const txt = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
                    if (txt) finalText = txt;   // keep latest text from the model

                    if (stop !== 'tool_use') {
                        // end of turn — we're done
                        break;
                    }

                    // assistant message with tool_use blocks goes into the conversation as-is
                    conv.push({ role: 'assistant', content: blocks });

                    // execute each tool, collect results
                    const toolResults = [];
                    for (const b of blocks) {
                        if (b.type !== 'tool_use') continue;
                        const result = await executeNavigatorTool(b.name, b.input, candidateLookup, slice);
                        if (b.name === 'search_brain' && result.chunks) stellaUsed += result.chunks.length;
                        if (result.ui_action) uiActions.push(result.ui_action);
                        transcript.push({
                            tool: b.name,
                            input: b.input,
                            summary:
                                result.error                   ? '⚠ ' + result.error :
                                b.name === 'current_time'       ? '⌚ now' :
                                b.name === 'read_note'          ? '📖 ' + (result.id || '?').slice(0, 48) :
                                b.name === 'search_brain'       ? '◉ ' + (result.chunks?.length || 0) + ' indexed' :
                                b.name === 'search_vault'       ? '🔍 ' + (result.results?.length || 0) + '/' + (result.total_matches || 0) + ' vault hits' :
                                b.name === 'list_recent'        ? '● ' + (result.count || 0) + ' recent' :
                                b.name === 'list_hubs'          ? '▲ ' + (result.count || 0) + ' hubs' :
                                b.name === 'stella_gmail'       ? '✉ Stella·Gmail ' + (result.count || 0) :
                                b.name === 'stella_gmail_priority'? '✉ Stella·Priority ' + (result.count || 0) :
                                b.name === 'stella_calendar'    ? '🗓 Stella·Cal ' + (result.count || 0) :
                                b.name === 'stella_filesystem'  ? '📁 Stella·FS ' + (result.count || 0) :
                                b.name === 'stella_notion'      ? '📓 Stella·Notion ' + (result.count || 0) :
                                b.name === 'stella_location'    ? '📍 Stella·Loc' :
                                b.name === 'write_note'         ? '✎ captured: ' + ((result.path || '').split('/').pop() || 'note') :
                                b.name === 'propose_tour'       ? '⌃ ' + (b.input.nodes?.length || 0) + '-stop tour' :
                                b.name === 'open_note'          ? '👁  open' :
                                b.name === 'focus_cortex'       ? '◐ focus ' + b.input.cortex :
                                'ok',
                        });
                        toolResults.push({
                            type: 'tool_result',
                            tool_use_id: b.id,
                            content: JSON.stringify(result).slice(0, 9000),   // cap to prevent runaway
                        });
                    }
                    conv.push({ role: 'user', content: toolResults });
                }
            } catch (e) {
                return sendJSON(res, 500, { error: e.message, partial: finalText, transcript });
            }

            sendJSON(res, 200, {
                text: finalText || '(no response)',
                actions: uiActions,
                transcript,
                stella: { chunks: stellaUsed },
            });
        });
        return;
    }

    // ── static ───────────────────────────────────────────────────────────────
    if (url === '/') url = '/neural-graph.html';
    const filePath = path.join(ROOT, url);
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end(`Not found: ${url}`);
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' };

    // ── gzip for text payloads (huge win for the 3MB neural-graph.html) ─────
    const compressible = ['.html', '.js', '.json', '.css', '.svg', '.md'].includes(ext);
    const accepts = (req.headers['accept-encoding'] || '');
    if (compressible && /\bgzip\b/.test(accepts)) {
        headers['Content-Encoding'] = 'gzip';
        headers['Vary'] = 'Accept-Encoding';
        res.writeHead(200, headers);
        fs.createReadStream(filePath).pipe(zlib.createGzip({ level: 6 })).pipe(res);
    } else {
        res.writeHead(200, headers);
        fs.createReadStream(filePath).pipe(res);
    }
}).listen(PORT, '0.0.0.0', () => {
    console.log(`\n◆ CITADEL CORTEX online`);
    console.log(`   local:      http://localhost:${PORT}`);
    console.log(`   LAN:        http://${getLAN()}:${PORT}`);
    if (AUTH_ON) console.log(`   auth:       on  (user=${AUTH_USER})`);
    console.log(`   vault:      ${VAULT_NAME || '(none)'}`);
    console.log(`   serving:    ${ROOT}`);
    console.log(`   Ctrl+C to stop\n`);
});

function getLAN() {
    const ifs = require('os').networkInterfaces();
    for (const list of Object.values(ifs)) {
        for (const i of list) if (i.family === 'IPv4' && !i.internal) return i.address;
    }
    return 'localhost';
}
