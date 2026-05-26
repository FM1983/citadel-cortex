#!/usr/bin/env node
/**
 * Vault scanner — extracts nodes + wiki-links, caches to vault-cache.json.
 * Run once, reuse forever (until vault changes significantly).
 */

const fs   = require('fs');
const path = require('path');
let EXTRA_ROOTS = [];
try { ({ EXTRA_ROOTS = [] } = require('./config')); } catch (e) {}

const { VAULT, CACHE } = require('./config');

const FOLDER_GROUPS = {
    'people':1,'projects':2,'finance':3,'ai':4,'repos':5,
    'daily':6,'areas':7,'glossary':8,'meetings':9,'intel':10,
};

// Folders to skip during scan (heavy duplicates / noise that pollute the graph)
const SKIP_FOLDERS = new Set([
    'source mirrors',  // Stella's auto-mirror of content already in vault
    '.git', '.obsidian', '.smart-env', '.claude', '.claudian',
    'node_modules', '__pycache__', '.venv',
]);
function walkMd(dir, out=[]) {
    let entries; try { entries = fs.readdirSync(dir); } catch { return out; }
    for (const e of entries) {
        const full = path.join(dir, e);
        if (SKIP_FOLDERS.has(e.toLowerCase())) continue;
        let stat; try { stat = fs.statSync(full); } catch { continue; }
        if (stat.isDirectory()) walkMd(full, out);
        else if (e.endsWith('.md')) out.push(full);
    }
    return out;
}
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
function extractLinks(content) {
    const re = /\[\[([^\]]+)\]\]/g, out = new Set(); let m;
    while ((m = re.exec(content)) !== null) { let t = m[1].split('|')[0].split('#')[0].trim(); if (t) out.add(t); }
    return [...out];
}
function groupFor(rel) {
    const lp = rel.toLowerCase();
    for (const [kw,g] of Object.entries(FOLDER_GROUPS)) if (lp.includes(kw)) return g;
    return 0;
}

const t0 = Date.now();
const records = [];

function scanRoot(rootPath, rootId) {
    if (!fs.existsSync(rootPath)) { console.warn(`   ⚠ root missing: ${rootPath}`); return; }
    console.log(`\n🔵 Scanning ${rootId ? '[' + rootId + ']' : 'main vault'}  ${rootPath}…`);
    const files = walkMd(rootPath);
    console.log(`   ${files.length} files`);

    let processed = 0;
    const reportEvery = Math.max(100, Math.floor(files.length / 20));

    for (const fp of files) {
        let content='', stat; try { content = fs.readFileSync(fp,'utf8'); stat = fs.statSync(fp); } catch { continue; }
        let rel = path.relative(rootPath, fp);
        if (rootId) rel = rootId + '/' + rel.replace(/\\/g, '/');
        const title = extractTitle(content, fp);
        const fm    = parseFm(content);
        const group = groupFor(rel);
        const words = content.split(/\s+/).length;
        const aliases = [
            path.basename(fp,'.md'),
            rel.replace(/\.md$/,'').split('/').pop(),
        ];
        if (fm.aliases) fm.aliases.replace(/[\[\]"']/g,'').split(',').forEach(a=>aliases.push(a.trim()));
        records.push({
            id: title, group, wordCount: words,
            mtime: stat ? stat.mtimeMs : 0,
            links: extractLinks(content), aliases, relPath: rel,
            rootId: rootId || 'main',
            absPath: fp,
        });
        processed++;
        if (processed % reportEvery === 0) console.log(`   ${processed}/${files.length} (${Math.round(processed/files.length*100)}%)`);
    }
}

scanRoot(VAULT, '');
for (const extra of EXTRA_ROOTS) scanRoot(extra.path, extra.id);

fs.writeFileSync(CACHE, JSON.stringify({ generated: new Date().toISOString(), vault: VAULT, extraRoots: EXTRA_ROOTS, records }));
console.log(`\n✅  ${records.length} records → ${CACHE}`);
console.log(`   Took ${((Date.now()-t0)/1000).toFixed(1)}s\n`);
