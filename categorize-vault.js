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
const CATEGORIES = ['PROJECTS','LITIGATION','PEOPLE','CONTACTS','DESIGN','RESEARCH','OPERATIONS','LIGHTSPEED','ADMINISTRATION','TASTE','ARCHIVES','MISC'];

function categorize(rec) {
    const p = (rec.relPath || '').toLowerCase();
    const t = (rec.id || '').toLowerCase();

    // PEOPLE — individual person files (one-per-human biographical notes)
    // Checked first so /people/ wins over generic admin/research routing
    if (p.includes('/people/') || p.startsWith('people/')) return 'PEOPLE';

    // CONTACTS — registers, address books, formal contact lists
    if (p.includes('master contact') || p.includes('contact register') ||
        t.includes('contact register') || t.includes('master contact') ||
        p.includes('/contacts/') || p.startsWith('contacts/')) return 'CONTACTS';

    // TASTE — personal aesthetic: music, photos, places, likes, instagram saves
    if (p.startsWith('taste/')      || p.includes('/taste/')      ||
        p.startsWith('music/')      || p.includes('/music/')      ||
        p.startsWith('instagram/')  || p.includes('/instagram/')  ||
        p.startsWith('photos/')     || p.includes('/photos/')     ||
        p.startsWith('places/')     || p.includes('/places/')     ||
        p.startsWith('likes/')      || p.includes('/likes/')      ||
        p.startsWith('saved/')      || p.includes('/saved/')      ||
        p.includes('/visited/')     || p.includes('/listened/')   ||
        p.includes('/aesthetic/')   ||
        t.startsWith('song:')       || t.startsWith('track:')     ||
        t.startsWith('album:')      || t.startsWith('artist:')    ||
        t.startsWith('photo:')      || t.startsWith('place:')     ||
        t.startsWith('visited:')    || t.startsWith('liked:')     ||
        t.startsWith('saved:')) return 'TASTE';

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

    // OPERATIONS — Stella's command-and-control cortex.
    // ALL live-stream + ingested data lands here: Stella's brain, captures, sensorium,
    // transcripts, voice notes, reminders, tasks, action items, day notes.
    // Captured BEFORE LIGHTSPEED so Stella-Brain wins over the broader Citadel-AI rule.
    if (p.includes('stella-brain')          || p.startsWith('stella-brain/')      ||
        p.includes('/source mirrors/')      || p.startsWith('source mirrors/')    ||
        p.includes('marius-captures')       || p.startsWith('marius-captures/')   ||
        p.includes('/transcripts/')         || p.startsWith('transcripts/')       ||
        p.includes('/recordings/')          || p.startsWith('recordings/')        ||
        p.includes('/voice-notes/')         || p.startsWith('voice-notes/')       ||
        p.includes('/day-notes/')           || p.startsWith('day-notes/')         ||
        p.includes('/musings/')             || p.startsWith('musings/')           ||
        p.includes('/reminders/')           || p.startsWith('reminders/')         ||
        p.includes('/tasks/')               || p.startsWith('tasks/')             ||
        p.includes('/actions/')             || p.startsWith('actions/')           ||
        p.includes('/interactions/')        || p.startsWith('interactions/')      ||
        p.includes('/ops/')                 || p.startsWith('ops/')               ||
        t.startsWith('voice:')              || t.startsWith('day:')               ||
        t.startsWith('op:')                 || t.startsWith('action:')            ||
        t.startsWith('reminder:')           || t.startsWith('capture:')           ||
        t.startsWith('musing:')             || t.startsWith('interaction:')      ) return 'OPERATIONS';

    // LIGHTSPEED — Citadel AI infrastructure: agents, automations, skills, prompts
    // Captured BEFORE PROJECTS so Lightspeed/ doesn't fall into property-projects bucket,
    // and BEFORE ADMINISTRATION so Citadel-AI / AI Assets win over generic admin.
    if (p.startsWith('lightspeed/')        || p.includes('/lightspeed/')         ||
        p.startsWith('citadel-ai/')        || p.includes('/citadel-ai/')         ||
        p.includes('citadel group ai assets') ||
        p.startsWith('stella-agent/')      || p.includes('/stella-agent/')       ||
        p.includes('nimbalyst')            || p.includes('/cortex/')             ||
        p.includes('/agents/')             || p.includes('/agent/')              ||
        p.includes('/automations/')        || p.includes('/automation/')         ||
        p.includes('/skills/')             || p.includes('/prompts/')            ||
        p.includes('citadel-intel-notionbuild') ||
        p.includes('/copilot/')            ||
        t.startsWith('agent:')             || t.startsWith('skill:')             ||
        t.startsWith('prompt:')            || t.startsWith('automation:')) return 'LIGHTSPEED';

    // PROJECTS — live projects, acquisitions, named property deals
    if (p.startsWith('projects/01') || p.includes('/projects/01') ||
        p.includes('business acquisitions') || p.includes('acquisitions') ||
        p.includes('babich') || p.includes('featherston') || p.includes('mclane') ||
        p.includes('bealey') || p.includes('castra') ||
        p.includes('carrack') || p.includes('hyperion') || p.includes('barbarossa') ||
        p.startsWith('projects/')) return 'PROJECTS';

    // RESEARCH — intelligence work, briefings, analysis, theses (must come before ADMIN)
    if ((p.startsWith('citadel-intel/') || p.includes('/citadel-intel/')) && !p.includes('notionbuild')) return 'RESEARCH';
    if (p.includes('/briefings/') || p.includes('/briefing/') || p.includes('/research/') ||
        p.includes('/intel/') || p.includes('/analyses/') || p.includes('/theses/') ||
        p.includes('perplexity')) return 'RESEARCH';
    if (t.includes('briefing') || t.includes('thesis') || t.includes('analysis') ||
        t.includes('research note') || t.includes('intel ') || t.startsWith('intel ') ||
        t.includes('memo:') || t.includes('investigation')) return 'RESEARCH';

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
    // ── TASTE + OPERATIONS notes are short by design — keep regardless of size ──
    const isShortByDesign =
        p.startsWith('taste/') || p.includes('/taste/') ||
        p.includes('stella-brain') || p.includes('marius-captures') ||
        p.includes('source mirrors') || p.includes('/voice-notes/') ||
        p.includes('/reminders/') || p.includes('/tasks/') || p.includes('/day-notes/');
    if (!isShortByDesign && (rec.wordCount || 0) < 40) return false;
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
