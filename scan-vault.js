#!/usr/bin/env node
/**
 * Vault scanner — extracts nodes + wiki-links, caches to vault-cache.json.
 * Run once, reuse forever (until vault changes significantly).
 */

const fs   = require('fs');
const path = require('path');
const { VAULT, CACHE } = require('./config');

const FOLDER_GROUPS = {
    'people':1,'projects':2,'finance':3,'ai':4,'repos':5,
    'daily':6,'areas':7,'glossary':8,'meetings':9,'intel':10,
};

function walkMd(dir, out=[]) {
    let entries; try { entries = fs.readdirSync(dir); } catch { return out; }
    for (const e of entries) {
        const full = path.join(dir, e);
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

console.log(`\n🔵 Scanning ${VAULT}…`);
const t0 = Date.now();
const files = walkMd(VAULT);
console.log(`   ${files.length} files`);

const records = []; // { id, group, wordCount, links: [], aliases: [] }
let processed = 0;
const reportEvery = Math.max(100, Math.floor(files.length / 20));

for (const fp of files) {
    let content=''; try { content = fs.readFileSync(fp,'utf8'); } catch { continue; }
    const rel   = path.relative(VAULT, fp);
    const title = extractTitle(content, fp);
    const fm    = parseFm(content);
    const group = groupFor(rel);
    const words = content.split(/\s+/).length;
    const aliases = [
        path.basename(fp,'.md'),
        rel.replace(/\.md$/,'').split(path.sep).pop(),
    ];
    if (fm.aliases) fm.aliases.replace(/[\[\]"']/g,'').split(',').forEach(a=>aliases.push(a.trim()));
    records.push({ id: title, group, wordCount: words, links: extractLinks(content), aliases, relPath: rel });
    processed++;
    if (processed % reportEvery === 0) console.log(`   ${processed}/${files.length} (${Math.round(processed/files.length*100)}%)`);
}

fs.writeFileSync(CACHE, JSON.stringify({ generated: new Date().toISOString(), vault: VAULT, records }));
console.log(`\n✅  ${records.length} records → ${CACHE}`);
console.log(`   Took ${((Date.now()-t0)/1000).toFixed(1)}s\n`);
