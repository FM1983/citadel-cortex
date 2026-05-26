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
        return sendJSON(res, 200, { vault: VAULT_NAME, vaultPath: VAULT, hasAuth: AUTH_ON });
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

    // ── static ───────────────────────────────────────────────────────────────
    if (url === '/') url = '/neural-graph.html';
    const filePath = path.join(ROOT, url);
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end(`Not found: ${url}`);
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(filePath).pipe(res);
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
