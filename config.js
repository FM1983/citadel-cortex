/**
 * Citadel Cortex — shared configuration.
 *
 * Override via environment variable or by editing this file.
 *
 *   CITADEL_VAULT=/path/to/Vault  node scan-vault.js
 */

const path = require('path');

// 1. Vault location — point this at your Obsidian vault root.
const VAULT =
    process.env.CITADEL_VAULT ||
    '/Users/fm-sarsfield/Library/CloudStorage/Dropbox-CitadelCapital/Citadel Capital - Team Folder/Citadel-Main';

// 2. Where the pipeline writes its caches + outputs (defaults to this repo dir)
const WORK = process.env.CITADEL_WORK || __dirname;

module.exports = {
    VAULT,
    WORK,
    CACHE:        path.join(WORK, 'vault-cache.json'),
    CATEGORIZED:  path.join(WORK, 'vault-categorized.json'),
    HTML_OUT:     path.join(WORK, 'neural-graph.html'),
    GRAPH_JSON:   path.join(VAULT, '.obsidian', 'graph.json'),
};
