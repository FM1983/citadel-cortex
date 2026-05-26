#!/usr/bin/env node
/**
 * Stella brain ingester
 * ─────────────────────
 * Mirrors a vault folder into Stella's writable `brain` vault under
 * `Source Mirrors/<label>/`, so Stella's vector index picks it up and her
 * /brain/search returns the content.
 *
 *   # default — ingest the Misc-Working folder
 *   node importers/stella-ingest.js
 *
 *   # ingest any folder, custom label
 *   node importers/stella-ingest.js /abs/path/to/folder my-label
 *
 *   # control concurrency / file cap
 *   CONCURRENCY=6 MAX=200 node importers/stella-ingest.js
 *
 * Auth: requires STELLA_CONTROL_TOKEN (for writing) + STELLA_MEMORY_TOKEN
 *       (for verification search).  Both auto-loaded from
 *       ~/Repo/Stella-Agent/.env.local.
 */
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const STELLA_URL = process.env.STELLA_URL || 'http://100.69.150.90:8790';

function loadKey(re) {
    for (const f of [
        path.join(os.homedir(), 'Repo/Stella-Agent/.env.local'),
        path.join(os.homedir(), '.local/share/citadel-research-desk/.env'),
        path.join(os.homedir(), '.hermes/.env'),
    ]) {
        try {
            const m = fs.readFileSync(f, 'utf8').match(re);
            if (m) return m[1].trim().replace(/^["']|["']$/g, '');
        } catch (e) {}
    }
    return '';
}
const CONTROL = process.env.STELLA_CONTROL_TOKEN || loadKey(/^STELLA_CONTROL_TOKEN\s*=\s*(.+)$/m);
const MEMORY  = process.env.STELLA_MEMORY_TOKEN  || loadKey(/^STELLA_MEMORY_TOKEN\s*=\s*(.+)$/m);
if (!CONTROL) { console.error('❌ STELLA_CONTROL_TOKEN missing'); process.exit(1); }

// ── arguments ────────────────────────────────────────────────
const DEFAULT_SRC = '/Users/fm-sarsfield/Library/CloudStorage/Dropbox-CitadelCapital/Citadel Capital - Team Folder/Citadel-Main/Misc-Working';
const SRC   = path.resolve(process.argv[2] || DEFAULT_SRC);
const LABEL = process.argv[3] || path.basename(SRC);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '4', 10);
const MAX         = parseInt(process.env.MAX || '0', 10);   // 0 = unlimited

if (!fs.existsSync(SRC)) { console.error('❌ source not found: ' + SRC); process.exit(1); }

console.log('\n📡 Stella brain ingester');
console.log('   source: ' + SRC);
console.log('   label : ' + LABEL);
console.log('   target: brain/Source Mirrors/' + LABEL + '/');
console.log('   concurrency: ' + CONCURRENCY + (MAX ? ' · max: ' + MAX : '') + '\n');

// ── walk ─────────────────────────────────────────────────────
function walkMd(dir, out = []) {
    let entries; try { entries = fs.readdirSync(dir); } catch { return out; }
    for (const e of entries) {
        if (e.startsWith('.') || e === 'node_modules') continue;
        const full = path.join(dir, e);
        let stat; try { stat = fs.statSync(full); } catch { continue; }
        if (stat.isDirectory()) walkMd(full, out);
        else if (e.endsWith('.md')) out.push(full);
    }
    return out;
}

const files = walkMd(SRC);
const total = MAX ? Math.min(MAX, files.length) : files.length;
console.log('   found ' + files.length + ' markdown files' + (MAX && files.length > MAX ? ' (capped to ' + MAX + ')' : '') + '\n');

// ── helpers ──────────────────────────────────────────────────
function parseFm(content) {
    const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/); if (!m) return {};
    const y = {};
    for (const l of m[1].split('\n')) { const kv = l.match(/^(\w[\w-]*):\s*(.+)/); if (kv) y[kv[1]] = kv[2].replace(/^["']|["']$/g,'').trim(); }
    return y;
}
function extractTitle(content, fp) {
    const fm = parseFm(content);
    if (fm.title) return fm.title;
    const h1 = content.match(/^#\s+([^\n]+)/m);
    if (h1) return h1[1].trim();
    return path.basename(fp, '.md');
}
function extractTags(content) {
    const re = /(?:^|\s)#([a-z][\w-]{1,40})/gi;
    const out = new Set(); let m;
    while ((m = re.exec(content)) !== null) out.add(m[1].toLowerCase());
    return [...out].slice(0, 12);
}
function safe(s) { return String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim() || 'untitled'; }

async function ingestOne(fp) {
    let content = '';
    try { content = fs.readFileSync(fp, 'utf8'); } catch (e) { return { fp, error: 'read: ' + e.message }; }
    if (!content.trim() || content.length < 20) return { fp, skipped: 'empty' };

    const title  = safe(extractTitle(content, fp));
    const rel    = path.relative(SRC, fp).replace(/\.md$/i, '');
    const folder = 'Source Mirrors/' + LABEL + '/' + path.dirname(rel).replace(/\\/g, '/');
    const tags   = extractTags(content);
    const body   = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');   // strip frontmatter

    try {
        const r = await fetch(STELLA_URL + '/brain/notes', {
            method: 'POST',
            headers: { 'x-stella-control-token': CONTROL, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                vault_id:   'brain',
                folder:     folder === 'Source Mirrors/' + LABEL + '/.' ? 'Source Mirrors/' + LABEL : folder,
                title,
                body:       body.slice(0, 100000),       // safety cap
                tags,
                source_ref: 'citadel_main://' + path.relative(path.join(os.homedir(), 'Library/CloudStorage/Dropbox-CitadelCapital/Citadel Capital - Team Folder'), fp),
            }),
        });
        if (!r.ok) return { fp, error: 'http ' + r.status + ': ' + (await r.text()).slice(0, 160) };
        return { fp, ok: true, title };
    } catch (e) { return { fp, error: e.message }; }
}

// ── parallel queue ───────────────────────────────────────────
(async () => {
    let done = 0, ok = 0, fail = 0, skipped = 0;
    const queue = files.slice(0, total);
    const errs = [];
    const start = Date.now();

    async function worker() {
        while (queue.length) {
            const fp = queue.shift();
            const r = await ingestOne(fp);
            done++;
            if (r.ok)        ok++;
            else if (r.error){ fail++; if (errs.length < 8) errs.push(path.basename(fp) + ' :: ' + r.error); }
            else if (r.skipped) skipped++;
            if (done % 10 === 0 || done === total) {
                const pct = Math.round(done / total * 100);
                const elapsed = ((Date.now() - start) / 1000).toFixed(1);
                process.stdout.write('\r   ' + done + '/' + total + '  (' + pct + '%)  ok ' + ok + '  fail ' + fail + '  skip ' + skipped + '  ' + elapsed + 's   ');
            }
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log('\n\n✅ done — ' + ok + ' written, ' + fail + ' failed, ' + skipped + ' skipped, in ' + elapsed + 's');
    if (errs.length) { console.log('\nfirst errors:'); for (const e of errs) console.log('   ✗ ' + e); }

    // ── verify with a search ──
    if (MEMORY && ok > 0) {
        console.log('\n🔎 verifying — searching for a Misc-Working title…');
        // pick a random successful one
        const sample = path.basename(files[Math.floor(Math.random() * Math.min(total, files.length))], '.md');
        try {
            const r = await fetch(STELLA_URL + '/brain/search', {
                method: 'POST',
                headers: { 'x-stella-memory-token': MEMORY, 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: sample, limit: 3 }),
            });
            const j = await r.json();
            const hits = (j.results || []).filter(x => x.relative_path && x.relative_path.includes('Misc-Working'));
            console.log('   query: "' + sample + '"  →  ' + (j.results || []).length + ' hits ' + (hits.length ? '(✓ Misc-Working in results)' : '(no Misc-Working match — index may be syncing)'));
        } catch (e) { console.log('   ⚠ verify failed: ' + e.message); }
    }
})();
