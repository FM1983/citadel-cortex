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
const CHAT_MODEL = process.env.CHAT_MODEL || 'claude-sonnet-4-5';
const CHAT_MAX_TURNS = parseInt(process.env.CHAT_MAX_TURNS || '6', 10);

// ── OpenAI Whisper + ElevenLabs keys ────────────────────────────────────────
let OPENAI_KEY     = process.env.OPENAI_API_KEY     || '';
let ELEVEN_KEY     = process.env.ELEVENLABS_API_KEY || '';
// Charlotte — British female, classy, narrative-trained.  Override with ELEVENLABS_VOICE_ID.
const ELEVEN_VOICE = process.env.ELEVENLABS_VOICE_ID || 'rhS7yjXTU4uIlRxXhNW7';
const ELEVEN_SPEED = parseFloat(process.env.ELEVENLABS_SPEED || '0.97');
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

// ── Tool definitions for the agentic navigator loop ────────────────────────
const NAVIGATOR_TOOLS = [
    {
        name: 'read_note',
        description: "Read the full markdown content of one vault note. Use this when the user asks 'what does X say', when you need to summarise content, when comparing two matters, or when a candidate title alone is not enough to answer. Returns the note's text (first ~8 KB). Pass the integer idx from the candidate table.",
        input_schema: {
            type: 'object',
            properties: { idx: { type: 'integer', description: 'Node index from the candidate table' } },
            required: ['idx'],
        },
    },
    {
        name: 'search_brain',
        description: "Search Stella's second-brain (Citadel's institutional memory) for additional context not captured in the candidate node list. Returns up to 6 relevant snippets with source labels. Use when the user asks something the visible vault may not fully answer.",
        input_schema: {
            type: 'object',
            properties: { query: { type: 'string', description: 'Natural-language search query' } },
            required: ['query'],
        },
    },
    {
        name: 'propose_tour',
        description: "Propose a guided 3D camera tour through a sequence of 3–8 vault nodes. The user will see a play button; when they click it, the camera flies through each node and opens the side panel. Use this whenever the user asks for a tour, walk-through, journey, or overview.",
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
            properties: { cortex: { type: 'string', enum: ['PROJECTS','LITIGATION','PEOPLE','CONTACTS','DESIGN','RESEARCH','ADMINISTRATION','TASTE','ARCHIVES','MISC','ALL'] } },
            required: ['cortex'],
        },
    },
];

async function executeNavigatorTool(name, input, candidateLookup) {
    if (name === 'read_note') {
        const cand = candidateLookup[input.idx];
        if (!cand) return { error: 'idx ' + input.idx + ' not in candidates' };
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

    // ── /api/speak  (ElevenLabs TTS — returns audio/mpeg) ─────────────────
    if (url === '/api/speak' && req.method === 'POST') {
        if (!ELEVEN_KEY) return sendJSON(res, 503, { error: 'ELEVENLABS_API_KEY not set' });
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            let text;
            try { text = JSON.parse(body).text; } catch { return sendJSON(res, 400, { error: 'bad json' }); }
            if (!text) return sendJSON(res, 400, { error: 'no text' });
            const voiceId = ELEVEN_VOICE;
            try {
                const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + voiceId + '?optimize_streaming_latency=2', {
                    method: 'POST',
                    headers: {
                        'xi-api-key': ELEVEN_KEY,
                        'Content-Type': 'application/json',
                        'Accept': 'audio/mpeg',
                    },
                    body: JSON.stringify({
                        text,
                        model_id: 'eleven_turbo_v2_5',
                        voice_settings: { stability: 0.70, similarity_boost: 0.90, style: 0.12, use_speaker_boost: true, speed: ELEVEN_SPEED },
                    }),
                });
                if (!r.ok) return sendJSON(res, 502, { error: 'elevenlabs ' + r.status + ': ' + (await r.text()).slice(0, 200) });
                const audio = Buffer.from(await r.arrayBuffer());
                logUsage('elevenlabs-turbo-2.5', { input_tokens: text.length, output_tokens: 0 }, 'speak');
                res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
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
                'You are CITADEL NAVIGATOR — an agentic guide for Farhad Moinfar through his Citadel Capital knowledge vault, rendered as a 3D neural visualisation.',
                '',
                'You have TOOLS available — use them aggressively:',
                ' • read_note(idx)      — pull the full text of a note when you need to actually understand or summarise it',
                ' • search_brain(query) — query Stella, the second-brain agent, for institutional memory beyond what is visible',
                ' • propose_tour(nodes, captions, intro) — when the user wants a journey/walk-through/overview, USE THIS — do not just describe the tour in prose',
                ' • open_note(idx)      — when the user wants to focus on one specific note',
                ' • focus_cortex(cat)   — when the user wants to isolate one category visually',
                '',
                'Candidate visible nodes (idx | cortex | days_old | title):',
                table,
                '',
                'Cortexes: PROJECTS, LITIGATION, DESIGN, ADMINISTRATION, RESEARCH, CONTACTS, ARCHIVES, MISC.',
                '',
                'Rules:',
                ' • Tool indices must come from the candidate table; never invent.',
                ' • For "tour me through X" / "show me Y" — call propose_tour with 4–8 nodes and a brief intro.',
                ' • For "what does X say" / "summarise" / "compare" — call read_note first, then answer from the actual content.',
                ' • For broad "what do we know about X" — try search_brain too, then synthesise.',
                ' • Keep the final assistant message concise (2–6 sentences). Tools do the heavy lifting.',
                ' • Be honest if Stella is offline or returns nothing — the user wants the truth, not padding.',
                ' • Refer to Farhad in second person ("you"); refer to people / entities by their names.',
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
                        const result = await executeNavigatorTool(b.name, b.input, candidateLookup);
                        if (b.name === 'search_brain' && result.chunks) stellaUsed += result.chunks.length;
                        if (result.ui_action) uiActions.push(result.ui_action);
                        transcript.push({
                            tool: b.name,
                            input: b.input,
                            summary:
                                result.error                   ? '⚠ ' + result.error :
                                b.name === 'read_note'          ? '📖 ' + (result.id || '?').slice(0, 48) :
                                b.name === 'search_brain'       ? '◉ ' + (result.chunks?.length || 0) + ' chunks' :
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
