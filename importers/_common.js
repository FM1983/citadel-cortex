/**
 * Shared helpers for all TASTE importers.
 */
const fs   = require('fs');
const path = require('path');

let VAULT;
try { ({ VAULT } = require('../config')); } catch (e) {
    VAULT = process.env.CITADEL_VAULT || '';
}
if (!VAULT) throw new Error('CITADEL_VAULT not set');

const TASTE_ROOT = path.join(VAULT, 'TASTE');
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
ensureDir(TASTE_ROOT);

function slug(s, maxLen = 60) {
    return String(s || 'untitled')
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
        .replace(/[^\w\s.-]/g, '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, maxLen) || 'untitled';
}

function yamlFm(obj) {
    const lines = ['---'];
    for (const [k, v] of Object.entries(obj)) {
        if (v == null) lines.push(k + ': null');
        else if (Array.isArray(v))  lines.push(k + ': [' + v.map(x => JSON.stringify(x)).join(', ') + ']');
        else if (typeof v === 'object') lines.push(k + ': ' + JSON.stringify(v));
        else if (typeof v === 'string' && v.includes('\n')) {
            lines.push(k + ': |');
            for (const ln of v.split('\n')) lines.push('  ' + ln);
        } else lines.push(k + ': ' + (typeof v === 'string' ? JSON.stringify(v) : v));
    }
    lines.push('---', '');
    return lines.join('\n');
}

/**
 * Write a note idempotently. Returns true if created, false if already existed.
 *   subfolder: e.g. 'Photos' or 'Instagram'
 *   titleSlug: filename stem (no .md)
 *   frontmatter: object
 *   body: markdown string (already includes title heading)
 */
function writeTasteNote(subfolder, titleSlug, frontmatter, body) {
    const dir = path.join(TASTE_ROOT, subfolder);
    ensureDir(dir);
    const file = path.join(dir, slug(titleSlug) + '.md');
    if (fs.existsSync(file)) return false;
    fs.writeFileSync(file, yamlFm(frontmatter) + body);
    return true;
}

function isoToHumanDate(iso) {
    try {
        const d = new Date(iso);
        return d.getUTCFullYear() + '-' + String(d.getUTCMonth()+1).padStart(2,'0') + '-' +
               String(d.getUTCDate()).padStart(2,'0') + ' ' +
               String(d.getUTCHours()).padStart(2,'0') + ':' + String(d.getUTCMinutes()).padStart(2,'0');
    } catch { return iso; }
}

module.exports = { VAULT, TASTE_ROOT, ensureDir, slug, yamlFm, writeTasteNote, isoToHumanDate };
