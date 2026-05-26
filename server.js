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
const AUTH_ON   = AUTH_USER && AUTH_PASS;

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
const CHAT_MODEL = process.env.CHAT_MODEL || 'claude-haiku-4-5';

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
        return sendJSON(res, 200, { vault: VAULT_NAME, vaultPath: VAULT, hasAuth: AUTH_ON, hasChat: !!ANTHROPIC_KEY, chatModel: CHAT_MODEL });
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

    // ── /api/chat — Claude-backed navigator ─────────────────────────────────
    if (url === '/api/chat' && req.method === 'POST') {
        if (!ANTHROPIC_KEY) return sendJSON(res, 503, { error: 'Set ANTHROPIC_API_KEY env var or put it in ~/.hermes/.env' });
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            let parsed;
            try { parsed = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'invalid JSON body' }); }
            const { message, candidates } = parsed;
            if (!message || !Array.isArray(candidates)) return sendJSON(res, 400, { error: 'missing message or candidates' });

            // build the table the LLM sees — strict, terse, deterministic
            const table = candidates.slice(0, 100).map(c =>
                c.idx + '\t' + (c.cat || '').slice(0, 5).padEnd(5) + '\t' +
                (typeof c.daysOld === 'number' ? c.daysOld + 'd' : '—').padStart(5) + '\t' +
                String(c.id).slice(0, 88)
            ).join('\n');

            const systemPrompt = [
                'You are the navigator for a 3D knowledge-graph visualisation of an Obsidian vault.',
                'A user asks a plain-English question; you choose a coherent set of nodes to visit and write a tour.',
                '',
                'Candidate nodes  (idx | cortex | days_old | title):',
                table,
                '',
                'Cortexes are: PROJECTS, LITIG (litigation), DESIG (design), ADMIN (administration), RESEA (research), CONTA (contacts), ARCHI (archives), MISC.',
                '',
                'Return ONLY a single JSON object with this exact shape, no prose, no markdown fence:',
                '{',
                '  "summary":   "2-4 sentence narrative overview of what we will see and why",',
                '  "tour":      [ { "idx": <int from the table>, "note": "one-sentence reason this node is on the tour" }, ... ],',
                '  "follow_up": ["short related question 1", "short related question 2"]',
                '}',
                '',
                'Rules:',
                ' - Pick 4–8 nodes unless the user explicitly asks for more or fewer',
                ' - Order them as a coherent narrative — chronological, hub-first, or grouped by sub-theme',
                ' - Only use idx values from the candidate table. Never invent IDs.',
                ' - If no candidate fits, return {"summary": "explanation", "tour": [], "follow_up": ["..."]}',
                ' - Be terse. Notes 1 line max. Summary 2-4 sentences max.',
            ].join('\n');

            try {
                const r = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                        'x-api-key': ANTHROPIC_KEY,
                        'anthropic-version': '2023-06-01',
                        'content-type': 'application/json',
                    },
                    body: JSON.stringify({
                        model: CHAT_MODEL,
                        max_tokens: 900,
                        system: systemPrompt,
                        messages: [{ role: 'user', content: message }],
                    }),
                });
                if (!r.ok) {
                    const errTxt = await r.text();
                    return sendJSON(res, 502, { error: 'Anthropic ' + r.status + ': ' + errTxt.slice(0, 240) });
                }
                const j = await r.json();
                const txt = j.content?.[0]?.text || '';
                // extract leading JSON object
                const m = txt.match(/\{[\s\S]*\}/);
                if (!m) return sendJSON(res, 200, { summary: txt, tour: [], follow_up: [], raw: true });
                let plan;
                try { plan = JSON.parse(m[0]); } catch (e) {
                    return sendJSON(res, 200, { summary: txt, tour: [], follow_up: [], raw: true, parseError: e.message });
                }
                sendJSON(res, 200, plan);
            } catch (e) {
                sendJSON(res, 500, { error: e.message });
            }
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
