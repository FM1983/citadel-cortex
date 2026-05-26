#!/usr/bin/env node
/**
 * Rewrites the vault's .obsidian/graph.json to:
 *   - apply 7 colour groups matching the Citadel cortex palette
 *   - filter out dev noise (FM ClaudeCode, copilot, memory-export, etc.)
 *   - tune forces for a more legible layout
 *
 * Backs up the existing file to graph.json.bak before writing.
 */

const fs   = require('fs');
const { GRAPH_JSON: GRAPH } = require('./config');

// ── colour palette (matches build-brain.js LOBES) ────────────────────────────
const C = (hex) => parseInt(hex, 16);
const COLORS = {
    PROJECTS:       C('00ff88'),
    LITIGATION:     C('ff0044'),
    DESIGN:         C('ffaa00'),
    ADMINISTRATION: C('00ccff'),
    CONTACTS:       C('ff00ff'),
    ARCHIVES:       C('888888'),
};

if (!fs.existsSync(GRAPH)) { console.error(`\n❌  ${GRAPH} not found\n`); process.exit(1); }

const existing = JSON.parse(fs.readFileSync(GRAPH, 'utf8'));
fs.writeFileSync(GRAPH + '.bak', JSON.stringify(existing, null, 2));
console.log('💾 backup → graph.json.bak');

// ── new configuration ────────────────────────────────────────────────────────
//   Color group precedence is top-down — first match wins.
//   Place Archives + Litigation BEFORE the broad Projects path so they dominate.
const newCfg = {
    ...existing,

    // Hide noise globally
    search:           '-path:"FM ClaudeCode" -path:copilot -path:"citadel-memory-export" -path:"nimbalyst-local" -path:templates -path:_templates',

    showOrphans:      false,
    showAttachments:  false,
    showTags:         false,
    hideUnresolved:   true,

    // DANCING forces — high repulsion vs moderate link spring → orbital motion
    // before settling.  Lower centerStrength lets the graph drift outward instead
    // of collapsing into a tight cluster.
    centerStrength:   0.18,
    repelStrength:    32,
    linkStrength:     0.42,
    linkDistance:     420,
    nodeSizeMultiplier: 1.4,
    lineSizeMultiplier: 1.8,
    textFadeMultiplier: 0.0,        // labels stay visible at low zoom

    'collapse-filter':       false,
    'collapse-color-groups': false,
    'collapse-display':      false,
    'collapse-forces':       false,

    colorGroups: [
        // ARCHIVES first — overrides any Projects path
        { query: 'path:"02 - Archived Projects"',                                                      color: { a: 1, rgb: COLORS.ARCHIVES       } },

        // LITIGATION — explicit folder + statutory demand pocket inside Admin
        { query: 'path:Litigation OR "IRD Enforcement" OR "Lowthers" OR "Statutory Demand" OR enforcement', color: { a: 1, rgb: COLORS.LITIGATION   } },

        // DESIGN — design library, marketing collateral, media assets
        { query: 'path:"Citadel-Design-Library" OR path:Marketing OR path:Media OR render OR masterplan OR architect',  color: { a: 1, rgb: COLORS.DESIGN } },

        // CONTACTS — people files, master contact register
        { query: '"Master Contact Register" OR path:people',                                            color: { a: 1, rgb: COLORS.CONTACTS       } },

        // ADMINISTRATION — Admin folder + AI infrastructure (but FM ClaudeCode is excluded globally)
        { query: 'path:Admin OR path:"Citadel-AI" OR path:"Citadel-Intel" OR path:"Citadel Group AI Assets" OR governance OR accounting', color: { a: 1, rgb: COLORS.ADMINISTRATION } },

        // PROJECTS — everything else under /Projects/
        { query: 'path:Projects OR path:Lightspeed OR Babich OR Featherston OR McLane OR Castra OR Carrack OR Hyperion OR Barbarossa OR Imperator', color: { a: 1, rgb: COLORS.PROJECTS } },
    ],
};

fs.writeFileSync(GRAPH, JSON.stringify(newCfg, null, 2));

console.log('\n✅ Obsidian graph rationalised:');
console.log('   ◇ 6 colour groups installed (PROJECTS / LITIGATION / DESIGN / CONTACTS / ADMIN / ARCHIVES)');
console.log('   ◇ noise filter:  -FM ClaudeCode  -copilot  -memory-export  -nimbalyst-local  -templates');
console.log('   ◇ forces re-tuned (looser repulsion, shorter links)');
console.log('   ◇ orphans/attachments/tags hidden\n');
console.log('Reopen Obsidian → ⌥⌘G (graph view) → ⌘R to refresh if needed.\n');
