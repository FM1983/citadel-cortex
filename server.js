#!/usr/bin/env node
/**
 * Citadel Cortex local server.
 * Serves the neural-graph HTML from this directory on port 8080.
 *
 *   node server.js               → http://localhost:8080
 *   node server.js 9090          → custom port
 *
 * Refresh the browser after rerunning build-brain.js to see updates.
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[2] || '8080', 10);
const ROOT = __dirname;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript',
    '.json': 'application/json',
    '.css':  'text/css',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
};

http.createServer((req, res) => {
    let url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/') url = '/neural-graph.html';
    const filePath = path.join(ROOT, url);

    // basic path-traversal guard
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`Not found: ${url}`);
        console.log(`  404  ${url}`);
        return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    fs.createReadStream(filePath).pipe(res);
    console.log(`  200  ${url}`);
}).listen(PORT, '127.0.0.1', () => {
    console.log(`\n◆ CITADEL CORTEX online`);
    console.log(`   http://localhost:${PORT}`);
    console.log(`   serving from: ${ROOT}`);
    console.log(`   Ctrl+C to stop\n`);
});
