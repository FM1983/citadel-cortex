/**
 * Shared configuration. Override via environment variable or edit here.
 *   CITADEL_VAULT=/path/to/Vault  node scan-vault.js
 */
const path = require('path');

const VAULT =
    process.env.CITADEL_VAULT ||
    '/Users/fm-sarsfield/Library/CloudStorage/Dropbox-CitadelCapital/Citadel Capital - Team Folder/Citadel-Main';

const WORK = process.env.CITADEL_WORK || __dirname;

// Additional roots to ingest into the same vault graph (siblings of main vault).
// Each gets prefixed in relPath so the categorizer can route them.
const EXTRA_ROOTS = [
    { id: 'stella-brain', path: '/Users/fm-sarsfield/Library/CloudStorage/Dropbox-CitadelCapital/Citadel Capital - Team Folder/Citadel-AI/Stella-Brain' },
];

module.exports = {
    VAULT, WORK, EXTRA_ROOTS,
    CACHE:        path.join(WORK, 'vault-cache.json'),
    CATEGORIZED:  path.join(WORK, 'vault-categorized.json'),
    HTML_OUT:     path.join(WORK, 'neural-graph.html'),
    GRAPH_JSON:   path.join(VAULT, '.obsidian', 'graph.json'),
};
