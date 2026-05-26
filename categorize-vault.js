#!/usr/bin/env node
/**
 * Reads vault-cache.json → applies 7-bucket categorization, filters noise,
 * writes vault-categorized.json.
 *
 * Buckets:  PROJECTS, LITIGATION, CONTACTS, DESIGN, ADMINISTRATION, ARCHIVES, MISC
 */

const fs   = require('fs');
const { CACHE: IN, CATEGORIZED: OUT } = require('./config');

if (!fs.existsSync(IN)) { console.error(`\n❌ ${IN} missing — run scan-vault.js first.\n`); process.exit(1); }
const { records } = JSON.parse(fs.readFileSync(IN, 'utf8'));
console.log(`\n🧬 Categorizing ${records.length} records…`);

// ─── Deterministic categorization ────────────────────────────────────────────
const CATEGORIES = ['PROJECTS','LITIGATION','CONTACTS','DESIGN','ADMINISTRATION','ARCHIVES','MISC'];

function categorize(rec) {
    const p = (rec.relPath || '').toLowerCase();
    const t = (rec.id || '').toLowerCase();

    // CONTACTS — checked first so /people/ wins over /citadel-ai/.../people/
    if (p.includes('/people/') || p.includes('/contacts/') ||
        p.includes('contact register') || t.includes('contact register') ||
        p.includes('master contact')) return 'CONTACTS';

    // ARCHIVES — explicit archived/inactive
    if (p.includes('02 - archived projects') || p.includes('/archive/') || p.includes('/archived/') ||
        p.includes('/old/') || p.includes('deprecated') || p.includes('/inactive/')) return 'ARCHIVES';

    // LITIGATION — explicit /Litigation/ folder + IRD/court keywords
    if (p.startsWith('litigation/') || p.includes('/litigation/') ||
        p.includes('ird ') || p.includes('/ird-') || p.includes('enforcement') ||
        p.includes('dispute') || p.includes('mcbride') || p.includes('paul duncan') ||
        p.includes('richard janett') || p.includes('lowther') || p.includes('court') ||
        t.includes('litigation') || t.includes('ird ') || t.includes('enforcement')) return 'LITIGATION';

    // DESIGN — design library, marketing, media, renders, plans
    if (p.includes('citadel-design-library') || p.startsWith('marketing/') || p.includes('/marketing/') ||
        p.startsWith('media/') || p.includes('/media/') || p.includes('render') ||
        p.includes('masterplan') || p.includes('architect') || p.includes('drawing') ||
        p.includes('/plans/') || p.includes('blueprint') || p.includes('scheme')) return 'DESIGN';

    // PROJECTS — live projects, acquisitions, named property deals
    if (p.startsWith('projects/01') || p.includes('/projects/01') ||
        p.includes('business acquisitions') || p.includes('acquisitions') ||
        p.includes('babich') || p.includes('featherston') || p.includes('mclane') ||
        p.includes('bealey') || p.includes('lightspeed') || p.includes('castra') ||
        p.includes('carrack') || p.includes('hyperion') || p.includes('barbarossa') ||
        p.startsWith('projects/')) return 'PROJECTS';

    // ADMINISTRATION — Admin folder, AI infra (excluding ClaudeCode which we filter out)
    if (p.startsWith('admin/') || p.includes('/admin/') ||
        p.includes('citadel-ai') || p.includes('citadel-intel') ||
        p.includes('citadel group ai assets') ||
        p.includes('nimbalyst') || p.includes('notionbuild') ||
        p.includes('governance') || p.includes('/finance/') ||
        p.includes('accounting') || p.includes('/tax/') || p.includes('office lease') ||
        p.includes('strategy') || p.includes('operations') || p.includes('retainer')) return 'ADMINISTRATION';

    return 'MISC';
}

// ─── Filter rules ────────────────────────────────────────────────────────────
function keep(rec) {
    const t = (rec.id || '').trim();
    const p = (rec.relPath || '').toLowerCase();
    // drop entire dev/scratch trees (high-volume noise)
    if (p.startsWith('fm claudecode/') || p.startsWith('copilot/') ||
        p.startsWith('citadel-memory-export/') || p.startsWith('nimbalyst-local/')) return false;
    // drop date-only titles  e.g.  2024-05-12
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(t)) return false;
    // drop daily-note folders
    if (p.includes('/daily/') || p.includes('daily notes')) return false;
    // drop templates
    if (p.includes('/templates/') || p.includes('/_templates/')) return false;
    // drop hidden / node_modules / __pycache__
    if (p.includes('/node_modules/') || p.includes('/__pycache__/') || p.includes('/.git/')) return false;
    // drop tiny scraps
    if ((rec.wordCount || 0) < 40) return false;
    // drop OS dotfiles
    if (t.startsWith('.')) return false;
    // skip CLAUDE.md / README.md scattered everywhere unless substantial
    if ((t === 'CLAUDE' || t === 'README' || t === 'STATUS') && (rec.wordCount || 0) < 200) return false;
    return true;
}

// ─── Apply ───────────────────────────────────────────────────────────────────
const tally = Object.fromEntries(CATEGORIES.map(c => [c, 0]));
let filtered = 0, kept = 0;

const output = records.filter(r => {
    if (!keep(r)) { filtered++; return false; }
    r.category = categorize(r);
    tally[r.category]++;
    kept++;
    return true;
});

// Re-attach 'group' as the category index for the brain builder
output.forEach(r => { r.group = CATEGORIES.indexOf(r.category); });

fs.writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString(), categories: CATEGORIES, records: output }));

console.log('\n📊 Distribution:');
CATEGORIES.forEach(c => console.log(`   ${c.padEnd(15)} ${String(tally[c]).padStart(5)} (${(tally[c]/kept*100).toFixed(1)}%)`));
console.log(`\n   filtered ${filtered}  kept ${kept}  total ${records.length}`);
console.log(`\n✅  ${OUT}\n`);
