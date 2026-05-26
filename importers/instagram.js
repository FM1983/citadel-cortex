#!/usr/bin/env node
/**
 * Instagram saved-posts importer.
 * Parses a Meta data download (extracted folder or zip) and writes one
 * markdown note per saved post into TASTE/Instagram/.
 *
 *   node importers/instagram.js /path/to/extracted-instagram-export
 *   node importers/instagram.js /path/to/instagram-username-2026-xx-xx.zip
 *
 * Expects the export to contain "saved_posts.json" / "saved_collections.json"
 * somewhere under  your_instagram_activity/saved/ .
 *
 * To download yours:
 *   Instagram → Settings → Accounts Center → Your information & permissions →
 *   Download your information → choose Saved → format: JSON
 */
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os   = require('os');
const { writeTasteNote, isoToHumanDate } = require('./_common');

const arg = process.argv[2];
if (!arg) {
    console.error('Usage: node importers/instagram.js <path-to-meta-export>');
    process.exit(1);
}

let root = arg;
if (arg.endsWith('.zip')) {
    const tmp = path.join(os.tmpdir(), 'ig-export-' + Date.now());
    fs.mkdirSync(tmp, { recursive: true });
    console.log('· unzipping → ' + tmp);
    execSync(`unzip -q -o "${arg}" -d "${tmp}"`);
    root = tmp;
}

// find saved_posts.json
function findFile(start, name) {
    let found = null;
    (function walk(d) {
        if (found) return;
        let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name === name) { found = p; return; }
        }
    })(start);
    return found;
}

const savedPostsFile = findFile(root, 'saved_posts.json');
const savedCollFile  = findFile(root, 'saved_collections.json');

if (!savedPostsFile && !savedCollFile) {
    console.error('❌ Could not find saved_posts.json or saved_collections.json in: ' + root);
    process.exit(1);
}

let created = 0, skipped = 0;

function ingest(items, collection) {
    for (const item of items) {
        const map = item.string_map_data || {};
        const savedOn = map['Saved on'] || map['Saved'] || {};
        const url = savedOn.href || '';
        const ts  = savedOn.timestamp ? new Date(savedOn.timestamp * 1000).toISOString() : null;
        if (!url) continue;
        const author = item.title || (url.match(/\/p\/([^/]+)/) || ['', ''])[1] || 'unknown';
        const postId = (url.match(/\/(p|reel|tv)\/([^/?]+)/) || ['','',''])[2] || url.slice(-12);
        const human = ts ? isoToHumanDate(ts) : 'unknown';
        const titleStem = `Saved- ${author} ${postId}`;

        const body =
            `# Saved: @${author}\n\n` +
            (collection ? `_Collection: ${collection}_\n\n` : '') +
            `Saved ${human}\n\n` +
            `[View on Instagram](${url})\n`;

        const ok = writeTasteNote('Instagram', titleStem, {
            type: 'taste-instagram',
            source: 'instagram-export',
            source_ref: url,
            saved_at: ts || '',
            author,
            post_id: postId,
            collection: collection || '',
        }, body);
        ok ? created++ : skipped++;
    }
}

console.log('\n📱 Instagram saved → TASTE');

if (savedPostsFile) {
    console.log('· ' + path.relative(root, savedPostsFile));
    const d = JSON.parse(fs.readFileSync(savedPostsFile, 'utf8'));
    const items = d.saved_saved_media || d.saved_media || [];
    console.log('   ' + items.length + ' saved posts');
    ingest(items, '');
}

if (savedCollFile) {
    console.log('· ' + path.relative(root, savedCollFile));
    const d = JSON.parse(fs.readFileSync(savedCollFile, 'utf8'));
    const cols = d.saved_saved_collections || d.saved_collections || [];
    for (const c of cols) {
        const name = c.title || 'collection';
        const items = c.string_list_data ? c.string_list_data.map(s => ({ string_map_data: { 'Saved on': { href: s.href, timestamp: s.timestamp } } })) : [];
        ingest(items, name);
    }
}

console.log(`\n✅ created ${created} · skipped ${skipped}\n`);
