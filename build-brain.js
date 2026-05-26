#!/usr/bin/env node
/**
 * Reads vault-categorized.json → builds 7-cortex brain → writes neural-graph.html
 * Pure rendering (fast). Edit and re-run to iterate visuals.
 */

const fs   = require('fs');
const { CATEGORIZED: IN, HTML_OUT: OUT } = require('./config');

if (!fs.existsSync(IN)) { console.error(`\n❌ ${IN} missing — run categorize-vault.js first.\n`); process.exit(1); }
console.log('\n🧠 Loading categorized vault…');
const { records, categories: CATEGORIES } = JSON.parse(fs.readFileSync(IN, 'utf8'));
console.log(`   ${records.length} records · ${CATEGORIES.length} cortexes`);

// ═══════════════════════════════════════════════════════════════════════════════
// 1. NODES + ALIAS MAP
// ═══════════════════════════════════════════════════════════════════════════════
const nodes    = new Map();
const aliasMap = new Map();
const reg = (a, id) => { if (!a) return; const k = a.toLowerCase().trim(); if (!aliasMap.has(k)) aliasMap.set(k, id); };

for (const r of records) {
    if (!nodes.has(r.id)) {
        nodes.set(r.id, {
            id: r.id, group: r.group, category: r.category, wordCount: r.wordCount,
            mtime: r.mtime || 0, _links: r.links, relPath: r.relPath,
        });
        reg(r.id, r.id);
        for (const a of (r.aliases || [])) reg(a, r.id);
    }
}
console.log(`   ${nodes.size} unique nodes`);

// ═══════════════════════════════════════════════════════════════════════════════
// 2. RESOLVE WIKI-LINKS (semantic backbone)
// ═══════════════════════════════════════════════════════════════════════════════
const linkSet = new Set();
const addLink = (a, b) => { if (a !== b) linkSet.add([a,b].sort().join('\x00')); };

for (const [id, node] of nodes) {
    for (const raw of node._links) {
        const stem = raw.split('/').pop().replace(/\.md$/i,'');
        for (const t of [raw, stem, raw.toLowerCase(), stem.toLowerCase()]) {
            const k = t.trim().toLowerCase();
            if (aliasMap.has(k)) { const tgt = aliasMap.get(k); if (tgt !== id && nodes.has(tgt)) { addLink(id, tgt); break; } }
        }
    }
}
console.log(`   ${linkSet.size} semantic edges (wiki-links)`);

// ═══════════════════════════════════════════════════════════════════════════════
// 3. CORTEX LAYOUT — 7 anatomically-spaced lobes
// ═══════════════════════════════════════════════════════════════════════════════
//   Layout intent:
//      PROJECTS    front-centre   (executive function)
//      LITIGATION  right-lateral  (defensive cortex)
//      DESIGN      back-left      (visual cortex)
//      ADMIN       top-centre     (control)
//      CONTACTS    left-lateral
//      ARCHIVES    bottom-back    (long-term memory)
//      MISC        bottom-centre  (cerebellum)
const LOBES = {
    PROJECTS:       { center: [   0,    0,  340 ], radius: 230, color: '#7affc4', hex: 0x7affc4 },  // soft mint
    LITIGATION:     { center: [ 420,  130,    0 ], radius: 180, color: '#ff7a99', hex: 0xff7a99 },  // soft rose
    DESIGN:         { center: [-180,  -90, -350 ], radius: 260, color: '#ffd28a', hex: 0xffd28a },  // soft amber
    ADMINISTRATION: { center: [ 130,  370,  -20 ], radius: 230, color: '#8ee0ff', hex: 0x8ee0ff },  // soft sky
    RESEARCH:       { center: [ 280,  -90,  180 ], radius: 170, color: '#5af0e8', hex: 0x5af0e8 },  // turquoise
    CONTACTS:       { center: [-420,   65,   60 ], radius: 130, color: '#ee9ce6', hex: 0xee9ce6 },  // soft pink
    ARCHIVES:       { center: [   0, -310, -270 ], radius:  90, color: '#a8b0bd', hex: 0xa8b0bd },  // mist grey
    MISC:           { center: [   0, -380,  160 ], radius: 210, color: '#c9a8ff', hex: 0xc9a8ff },  // soft lavender
};

// initial degree from semantic edges (hub-bias for layout)
const degree = new Map();
for (const k of linkSet) { const [a,b] = k.split('\x00'); degree.set(a,(degree.get(a)||0)+1); degree.set(b,(degree.get(b)||0)+1); }
const maxDeg = Math.max(...[...degree.values(), 1]);

// Nebula-like distribution: hubs near centre, dim nodes drift far out (power-law tail)
for (const [id, node] of nodes) {
    const lobe = LOBES[node.category] || LOBES.MISC;
    const deg  = degree.get(id) || 0;
    const hubPull = 1 - deg/maxDeg;             // 0 = hub  → centre
    const r    = lobe.radius * (0.06 + hubPull * 0.94) * Math.pow(Math.random(), 0.38); // power-law: more periphery
    const phi  = Math.random() * Math.PI * 2;
    const the  = Math.acos(2 * Math.random() - 1);
    // mildly flatten Y for galactic-disk feel on big lobes
    const flatten = lobe.radius > 180 ? 0.62 : 0.9;
    node.x = lobe.center[0] + r * Math.sin(the) * Math.cos(phi);
    node.y = lobe.center[1] + r * Math.sin(the) * Math.sin(phi) * flatten;
    node.z = lobe.center[2] + r * Math.cos(the);
    // wispy jitter
    node.x += (Math.random() - 0.5) * 18;
    node.y += (Math.random() - 0.5) * 18;
    node.z += (Math.random() - 0.5) * 18;
}

const nodeArr = [...nodes.values()];

// ═══════════════════════════════════════════════════════════════════════════════
// 4. SAME-FOLDER EDGES — notes a curator put in the same directory are related
// ═══════════════════════════════════════════════════════════════════════════════
console.log('📁  Same-folder edges…');
const byFolder = new Map();
for (const n of nodeArr) {
    const folder = (n.relPath || '').split('/').slice(0, -1).join('/');
    if (!folder) continue;
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder).push(n.id);
}
let fEdges = 0;
for (const [folder, members] of byFolder) {
    if (members.length < 2 || members.length > 40) continue;     // skip giant index-style folders
    // pick a folder anchor (most-linked member, else first)
    let anchor = members[0];
    let anchorDeg = degree.get(anchor) || 0;
    for (const m of members) { const d = degree.get(m) || 0; if (d > anchorDeg) { anchor = m; anchorDeg = d; } }
    // connect every member to anchor (star within folder) + each pair-up if folder is small
    for (const m of members) {
        if (m !== anchor) { const before = linkSet.size; addLink(m, anchor); if (linkSet.size > before) fEdges++; }
    }
    if (members.length <= 6) {
        // also connect non-anchor members to one more sibling (tight cluster)
        for (let i = 0; i < members.length; i++) {
            const a = members[i], b = members[(i+1) % members.length];
            if (a !== b) { const before = linkSet.size; addLink(a, b); if (linkSet.size > before) fEdges++; }
        }
    }
}
console.log(`   ${fEdges} folder edges  (${linkSet.size} total)`);

// ═══════════════════════════════════════════════════════════════════════════════
// 5. TITLE-KEYWORD EDGES — notes whose titles share ≥2 significant tokens
// ═══════════════════════════════════════════════════════════════════════════════
console.log('🔤  Title-keyword overlap…');
const STOP = new Set([
    'the','a','an','of','and','to','for','in','on','at','with','by','from','as','is','it','this','that',
    'project','overview','register','note','draft','update','log','status','main','citadel','file',
    'limited','capital','company','ltd','inc','co','-','&','|','—','rev','v1','v2','v3','part','one','two',
]);
const kw = new Map();
for (const n of nodeArr) {
    const tokens = n.id.toLowerCase()
        .replace(/[^\w\s-]/g, ' ')
        .split(/[\s\-_/]+/)
        .filter(w => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w));
    kw.set(n.id, new Set(tokens));
}
let kEdges = 0;
const arr = [...nodeArr];
for (let i = 0; i < arr.length; i++) {
    const ka = kw.get(arr[i].id);
    if (ka.size === 0) continue;
    let added = 0;
    for (let j = i + 1; j < arr.length && added < 6; j++) {     // cap edges per node
        const kb = kw.get(arr[j].id);
        let shared = 0;
        for (const w of ka) if (kb.has(w)) shared++;
        if (shared >= 2) {
            const before = linkSet.size;
            addLink(arr[i].id, arr[j].id);
            if (linkSet.size > before) { kEdges++; added++; }
        }
    }
}
console.log(`   ${kEdges} keyword edges  (${linkSet.size} total)`);

// ═══════════════════════════════════════════════════════════════════════════════
// 6. CATEGORY-HUB EDGES — every isolated node hooks to its cortex's biggest hub
// ═══════════════════════════════════════════════════════════════════════════════
console.log('🎯  Category hub-spoke…');
degree.clear();
for (const k of linkSet) { const [a,b] = k.split('\x00'); degree.set(a,(degree.get(a)||0)+1); degree.set(b,(degree.get(b)||0)+1); }
const catHubs = {};
for (const cat of CATEGORIES) {
    const members = nodeArr.filter(n => n.category === cat);
    if (members.length < 2) continue;
    members.sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0));
    catHubs[cat] = members.slice(0, 3).map(n => n.id);   // top 3 hubs
}
let hEdges = 0;
for (const n of nodeArr) {
    const hubs = catHubs[n.category] || [];
    const d = degree.get(n.id) || 0;
    if (d >= 2) continue;                                  // already connected enough
    for (const h of hubs.slice(0, d === 0 ? 2 : 1)) {       // orphans get 2 anchors, weak nodes get 1
        if (h !== n.id) { const before = linkSet.size; addLink(n.id, h); if (linkSet.size > before) hEdges++; }
    }
}
console.log(`   ${hEdges} hub edges  (${linkSet.size} total)`);

// ═══════════════════════════════════════════════════════════════════════════════
// 6. CONNECT ANY REMAINING ORPHANS
// ═══════════════════════════════════════════════════════════════════════════════
degree.clear();
for (const k of linkSet) { const [a,b] = k.split('\x00'); degree.set(a,(degree.get(a)||0)+1); degree.set(b,(degree.get(b)||0)+1); }
const orphans = nodeArr.filter(n => !degree.get(n.id));
console.log(`🪐 ${orphans.length} orphans → nearest hub`);
for (const o of orphans) {
    let nearest = null, d = Infinity;
    for (const m of nodeArr) {
        if (m.id === o.id) continue;
        const dd = Math.hypot(m.x-o.x, m.y-o.y, m.z-o.z);
        if (dd < d) { d = dd; nearest = m; }
    }
    if (nearest) addLink(o.id, nearest.id);
}

// final degree + sizes
degree.clear();
for (const k of linkSet) { const [a,b] = k.split('\x00'); degree.set(a,(degree.get(a)||0)+1); degree.set(b,(degree.get(b)||0)+1); }
for (const [id, node] of nodes) {
    const d = degree.get(id) || 0;
    node.size = Math.min(Math.max(4 + Math.sqrt(d) * 1.6 + Math.log2((node.wordCount||1)+1) * 0.4, 4), 28);
    delete node._links;
}

const links = [...linkSet].map(k => { const [s,t]=k.split('\x00'); return { source: s, target: t }; });
console.log(`\n✓ Brain ready: ${nodes.size} neurons · ${links.length} synapses\n`);

// ═══════════════════════════════════════════════════════════════════════════════
// 7. ADJACENCY + DIRECTED BACKLINKS (only from real wiki-links)
// ═══════════════════════════════════════════════════════════════════════════════
const nodeIndex = new Map(); nodeArr.forEach((n,i) => nodeIndex.set(n.id, i));
const adjacency = nodeArr.map(() => []);
for (const lk of links) {
    const s = nodeIndex.get(lk.source), t = nodeIndex.get(lk.target);
    if (s !== undefined && t !== undefined) { adjacency[s].push(t); adjacency[t].push(s); }
}

// Directed backlinks: who explicitly wrote [[me]] in their note (semantic only)
const wikiOut = nodeArr.map(() => []);    // out-edges (this node links to ...)
const wikiIn  = nodeArr.map(() => []);    // in-edges  (... links to this node)
for (const r of records) {
    const srcIdx = nodeIndex.get(r.id);
    if (srcIdx === undefined) continue;
    for (const raw of (r.links || [])) {
        const stem = raw.split('/').pop().replace(/\.md$/i, '');
        let tgt = null;
        for (const t of [raw, stem, raw.toLowerCase(), stem.toLowerCase()]) {
            if (aliasMap.has(t.trim().toLowerCase())) { tgt = aliasMap.get(t.trim().toLowerCase()); break; }
        }
        if (!tgt || tgt === r.id) continue;
        const tgtIdx = nodeIndex.get(tgt);
        if (tgtIdx === undefined) continue;
        if (!wikiOut[srcIdx].includes(tgtIdx)) wikiOut[srcIdx].push(tgtIdx);
        if (!wikiIn[tgtIdx].includes(srcIdx))  wikiIn[tgtIdx].push(srcIdx);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 8. PRE-COMPUTE JAGGED-LIGHTNING LINK GEOMETRY (5 segments per link)
// ═══════════════════════════════════════════════════════════════════════════════
//   For each link we make 5 sub-segments with small perpendicular zigzag.
//   Stored flat as LineSegments-compatible buffer (10 vertices per link).
console.log('⚡ Pre-tessellating jagged synapses…');
const SEG = 3;                          // sub-segments per link (down from 5 — same look, 40% smaller payload)
const VERTS_PER_LINK = SEG * 2;         // line-segment pairs
const linkPosArr  = new Float32Array(links.length * VERTS_PER_LINK * 3);
const linkLPArr   = new Float32Array(links.length * VERTS_PER_LINK);
const linkSeedArr = new Float32Array(links.length * VERTS_PER_LINK);

function rand() { return (Math.random() - 0.5) * 2; }

for (let i = 0; i < links.length; i++) {
    const [a, b] = links[i].source ? [nodeIndex.get(links[i].source), nodeIndex.get(links[i].target)] : [0,0];
    if (a === undefined || b === undefined) continue;
    const A = [nodeArr[a].x, nodeArr[a].y, nodeArr[a].z];
    const B = [nodeArr[b].x, nodeArr[b].y, nodeArr[b].z];
    const len = Math.hypot(B[0]-A[0], B[1]-A[1], B[2]-A[2]);
    const jitter = Math.min(len * 0.05, 4.5);

    // build SEG+1 points with random offset on interior points
    const pts = [];
    for (let k = 0; k <= SEG; k++) {
        const t = k / SEG;
        let px = A[0] + (B[0]-A[0]) * t;
        let py = A[1] + (B[1]-A[1]) * t;
        let pz = A[2] + (B[2]-A[2]) * t;
        if (k !== 0 && k !== SEG) {
            px += rand() * jitter;
            py += rand() * jitter;
            pz += rand() * jitter;
        }
        pts.push([px,py,pz]);
    }

    const seed = (i * 0.137) % 1;
    for (let k = 0; k < SEG; k++) {
        const o = (i * VERTS_PER_LINK + k * 2) * 3;
        linkPosArr[o + 0] = pts[k][0];     linkPosArr[o + 1] = pts[k][1];     linkPosArr[o + 2] = pts[k][2];
        linkPosArr[o + 3] = pts[k+1][0];   linkPosArr[o + 4] = pts[k+1][1];   linkPosArr[o + 5] = pts[k+1][2];
        const ol = i * VERTS_PER_LINK + k * 2;
        linkLPArr[ol + 0]  = k / SEG;
        linkLPArr[ol + 1]  = (k+1) / SEG;
        linkSeedArr[ol + 0] = seed;
        linkSeedArr[ol + 1] = seed;
    }
}
console.log(`   ${links.length * SEG} sub-segments\n`);

// top hubs
const topHubs = nodeArr.map((n, i) => ({ id: n.id, deg: degree.get(n.id) || 0, cat: n.category }))
    .sort((a,b)=>b.deg-a.deg).slice(0,12);
console.log('🌟 Top hubs:');
topHubs.forEach((h,i)=>console.log(`   ${i+1}. ${h.id} (${h.deg} synapses · ${h.cat})`));

// ═══════════════════════════════════════════════════════════════════════════════
// 9. PACK DATA
// ═══════════════════════════════════════════════════════════════════════════════
const NOW_MS = Date.now();
const packed = {
    ids:        nodeArr.map(n => n.id),
    paths:      nodeArr.map(n => n.relPath || ''),
    cats:       nodeArr.map(n => n.category),
    groups:     nodeArr.map(n => n.group),
    sizes:      nodeArr.map(n => n.size),
    words:      nodeArr.map(n => n.wordCount || 0),
    // days-ago (rounded) — cheap & compact
    daysOld:    nodeArr.map(n => n.mtime ? Math.round((NOW_MS - n.mtime) / 86400000) : 9999),
    xs:         nodeArr.map(n => n.x),
    ys:         nodeArr.map(n => n.y),
    zs:         nodeArr.map(n => n.z),
    adj:        adjacency,
    wikiOut, wikiIn,
    categories: CATEGORIES,
    lobes:      LOBES,
    linkPos:    Array.from(linkPosArr),
    linkLP:     Array.from(linkLPArr),
    linkSeed:   Array.from(linkSeedArr),
    nLinks:     links.length,
    segPerLink: SEG,
    generated:  NOW_MS,
};
const DATA = JSON.stringify(packed);

// ═══════════════════════════════════════════════════════════════════════════════
// 10. HTML
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n⚡ Writing neural-graph.html…');

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>◆ CITADEL NEURAL CORTEX</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;background:radial-gradient(ellipse at 50% 55%,#06101f 0%,#020610 55%,#000005 100%);overflow:hidden;font-family:'Courier New',monospace;color:#9dd}
canvas{display:block;width:100%!important;height:100%!important}
#hud{position:fixed;inset:0;pointer-events:none;z-index:20}
.panel{position:absolute;border:1px solid rgba(140,210,255,.12);background:rgba(5,12,22,.55);padding:11px 15px;backdrop-filter:blur(10px);border-radius:3px}
.pt{font-size:9px;letter-spacing:4px;color:rgba(180,230,255,.85);text-shadow:0 0 8px rgba(120,180,220,.45);margin-bottom:8px}
.st{font-size:10px;line-height:2.2;color:rgba(140,220,180,.85)}
#tl{top:18px;left:18px;min-width:200px}
#tr{top:18px;right:140px;text-align:left;min-width:200px;font-size:10px;line-height:2;letter-spacing:1px}
.legend-row{display:flex;align-items:center;gap:7px;color:#aaa}
.legend-row span{font-size:14px;line-height:1}
#bl{bottom:18px;left:18px;font-size:9px;line-height:2.2;color:rgba(0,255,255,.5)}
#ni{bottom:18px;right:18px;min-width:260px;max-width:340px;display:none;pointer-events:auto}
#ni .nit{font-size:14px;font-weight:bold;color:#fff;text-shadow:0 0 14px #0ff;margin-bottom:8px;word-break:break-word;padding-right:20px}
#ni .nim{font-size:9px;line-height:2;color:#0f9}
#ni .close{position:absolute;top:10px;right:12px;cursor:pointer;color:#f0f;font-size:16px;pointer-events:auto}
#sw{position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:30;pointer-events:auto}
#si{background:rgba(0,5,20,.85);border:1px solid rgba(0,255,255,.3);color:#0ff;font-family:'Courier New',monospace;font-size:11px;letter-spacing:2px;padding:7px 14px;width:290px;outline:none;text-transform:uppercase}
#si::placeholder{color:rgba(0,200,255,.3)}
#si:focus{border-color:#0ff;box-shadow:0 0 16px rgba(0,255,255,.25)}
#scan{position:fixed;inset:0;background:repeating-linear-gradient(0deg,rgba(120,180,220,.006) 0,rgba(120,180,220,.006) 1px,transparent 1px,transparent 3px);pointer-events:none;z-index:15}
#vig{position:fixed;inset:0;background:radial-gradient(ellipse at center,transparent 38%,rgba(0,0,16,.85) 100%);pointer-events:none;z-index:14}
#loading{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);color:#0ff;font-size:15px;letter-spacing:5px;text-shadow:0 0 20px #0ff;z-index:100;text-align:center}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.2}}.blink{animation:blink 1.2s infinite}
/* ── NOTE SIDE PANEL ──────────────────────────────────────── */
#note-panel{position:fixed;top:0;left:0;width:420px;max-width:90vw;height:100%;background:rgba(5,10,20,.92);
  border-right:1px solid rgba(140,200,230,.18);backdrop-filter:blur(14px);
  transform:translateX(-110%);transition:transform .35s cubic-bezier(.2,.7,.2,1);z-index:60;
  display:flex;flex-direction:column;pointer-events:auto;color:#cdf;font-family:'Courier New',monospace}
#note-panel.open{transform:translateX(0)}
#note-panel header{padding:18px 20px 14px;border-bottom:1px solid rgba(140,200,230,.14);position:relative}
#note-panel h2{font-size:14px;font-weight:bold;color:#fff;text-shadow:0 0 14px rgba(140,200,230,.5);
  word-break:break-word;padding-right:28px;letter-spacing:.5px;margin-bottom:10px;line-height:1.4}
#note-panel .np-meta{font-size:9px;letter-spacing:2px;color:rgba(160,220,200,.7);line-height:1.9}
#note-panel .np-cat{display:inline-block;padding:2px 8px;border-radius:2px;font-weight:bold;letter-spacing:1.5px}
#note-panel .np-actions{display:flex;gap:8px;margin-top:14px}
#note-panel .np-actions button{flex:1;background:rgba(140,200,230,.08);border:1px solid rgba(140,200,230,.3);
  color:#cdf;font-family:'Courier New',monospace;font-size:10px;letter-spacing:1.5px;padding:7px 8px;cursor:pointer;
  border-radius:2px;transition:all .15s}
#note-panel .np-actions button:hover{background:rgba(140,200,230,.22);border-color:rgba(140,200,230,.6)}
#note-panel .np-actions button.primary{background:rgba(122,255,196,.12);border-color:rgba(122,255,196,.5);color:#7affc4}
#note-panel .np-actions button.primary:hover{background:rgba(122,255,196,.25)}
#np-close{position:absolute;top:14px;right:16px;background:none;border:none;color:#ee9ce6;font-size:18px;cursor:pointer;
  padding:4px 8px;line-height:1}
#np-close:hover{color:#fff;text-shadow:0 0 10px #ee9ce6}
#np-content{flex:1;overflow-y:auto;padding:18px 24px 24px;font-size:12px;line-height:1.65;color:rgba(220,235,250,.9)}
#np-content h1,#np-content h2,#np-content h3{color:#7affc4;margin:18px 0 10px;letter-spacing:.5px}
#np-content h1{font-size:16px} #np-content h2{font-size:14px} #np-content h3{font-size:13px}
#np-content code{background:rgba(140,200,230,.1);padding:2px 5px;border-radius:2px;font-size:11px;color:#ffd28a}
#np-content pre{background:rgba(0,0,0,.4);padding:10px;border-radius:3px;overflow-x:auto;font-size:10px;border-left:2px solid #7affc4}
#np-content a{color:#8ee0ff;text-decoration:none;border-bottom:1px dotted rgba(140,200,230,.5)}
#np-content a:hover{color:#fff}
#np-content blockquote{border-left:2px solid rgba(238,156,230,.5);padding-left:12px;margin:10px 0;color:rgba(238,200,230,.85);font-style:italic}
#np-content table{width:100%;border-collapse:collapse;margin:10px 0;font-size:11px}
#np-content td,#np-content th{padding:5px 8px;border:1px solid rgba(140,200,230,.15);text-align:left}
#np-content th{background:rgba(140,200,230,.08);color:#7affc4}
#np-content ul,#np-content ol{padding-left:20px;margin:8px 0}
#np-content li{margin:3px 0}
#np-content::-webkit-scrollbar{width:6px}
#np-content::-webkit-scrollbar-track{background:rgba(0,0,0,.2)}
#np-content::-webkit-scrollbar-thumb{background:rgba(140,200,230,.3);border-radius:3px}
#np-content .np-sep{border:none;border-top:1px solid rgba(140,200,230,.12);margin:22px 0 12px}
#np-content .np-section-title{font-size:9px;letter-spacing:2.5px;color:#7affc4;margin-bottom:8px;font-weight:bold}
#np-content .np-link-list{font-size:10.5px;line-height:1.85;color:rgba(180,220,250,.85);word-break:break-word}
#np-content .np-link-list a{color:#8ee0ff;border-bottom:none;padding:2px 4px;border-radius:2px;transition:background .12s}
#np-content .np-link-list a:hover{background:rgba(140,200,230,.15);color:#fff}

/* ── SEARCH DROPDOWN ──────────────────────────────────────── */
#search-results{position:fixed;top:50px;left:50%;transform:translateX(-50%);width:290px;
  background:rgba(5,12,22,.95);border:1px solid rgba(140,200,230,.3);border-top:none;backdrop-filter:blur(12px);
  max-height:330px;overflow-y:auto;z-index:31;pointer-events:auto;display:none;border-radius:0 0 3px 3px}
#search-results .sr-item{padding:7px 12px;cursor:pointer;font-size:10px;letter-spacing:.5px;
  border-bottom:1px solid rgba(140,200,230,.08);color:#cdf;display:flex;justify-content:space-between;gap:8px}
#search-results .sr-item:last-child{border-bottom:none}
#search-results .sr-item:hover,#search-results .sr-item.active{background:rgba(140,200,230,.15)}
#search-results .sr-cat{font-size:8px;letter-spacing:1.5px;opacity:.75;flex-shrink:0}

/* ── DASHBOARD ─────────────────────────────────────────────── */
#dash{position:fixed;top:0;left:50%;transform:translateX(-50%) translateY(-110%);width:min(880px,94vw);max-height:84vh;
  background:rgba(5,10,20,.94);border:1px solid rgba(140,200,230,.22);border-top:none;backdrop-filter:blur(14px);
  z-index:70;display:flex;flex-direction:column;transition:transform .3s cubic-bezier(.2,.7,.2,1);border-radius:0 0 4px 4px;
  font-family:'Courier New',monospace;color:#cdf;pointer-events:auto}
#dash.open{transform:translateX(-50%) translateY(0)}
#dash header{padding:14px 24px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(140,200,230,.14)}
#dash header .dt{font-size:13px;letter-spacing:5px;color:#7affc4;font-weight:bold;text-shadow:0 0 12px rgba(122,255,196,.4)}
#dash header .dc{cursor:pointer;color:#ee9ce6;font-size:18px;background:none;border:none;padding:6px 10px}
#dash header .dc:hover{color:#fff;text-shadow:0 0 8px #ee9ce6}
#dash .dgrid{padding:18px 24px;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px 20px;overflow-y:auto}
#dash section h3{font-size:9px;letter-spacing:3px;color:#8ee0ff;margin-bottom:8px;text-transform:uppercase}
#dash section ol{list-style:none;padding:0;font-size:11px}
#dash section li{padding:5px 8px;border-bottom:1px solid rgba(140,200,230,.06);cursor:pointer;display:flex;justify-content:space-between;gap:8px;line-height:1.45;border-radius:2px}
#dash section li:hover{background:rgba(140,200,230,.12)}
#dash .dn{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#dash .dx{font-size:9px;color:#7affc4;flex-shrink:0;opacity:.85;letter-spacing:1px}

#fire-btn{position:fixed;bottom:80px;right:18px;background:rgba(238,156,230,.15);border:1px solid rgba(238,156,230,.6);color:#ee9ce6;font-family:'Courier New',monospace;font-size:10px;letter-spacing:3px;padding:8px 16px;cursor:pointer;z-index:30;pointer-events:auto;text-shadow:0 0 8px rgba(238,156,230,.7);transition:all .15s;border-radius:2px}
#dash-btn{position:fixed;bottom:80px;right:155px;background:rgba(122,255,196,.13);border:1px solid rgba(122,255,196,.5);color:#7affc4;font-family:'Courier New',monospace;font-size:10px;letter-spacing:3px;padding:8px 16px;cursor:pointer;z-index:30;pointer-events:auto;text-shadow:0 0 8px rgba(122,255,196,.6);transition:all .15s;border-radius:2px}
#dash-btn:hover{background:rgba(122,255,196,.28);box-shadow:0 0 20px rgba(122,255,196,.35)}

/* ── NAVIGATOR CHAT ─────────────────────────────────────────── */
#chat{position:fixed;left:18px;bottom:120px;width:380px;max-width:92vw;background:rgba(5,12,22,.94);
  border:1px solid rgba(122,255,196,.25);backdrop-filter:blur(14px);border-radius:4px;
  z-index:65;display:none;flex-direction:column;color:#cdf;font-family:'Courier New',monospace;
  box-shadow:0 8px 40px rgba(0,0,0,.5),0 0 30px rgba(122,255,196,.06);max-height:74vh;pointer-events:auto}
#chat.open{display:flex}
#chat header{padding:11px 15px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(122,255,196,.16)}
#chat header .ct{font-size:10px;letter-spacing:4px;color:#7affc4;font-weight:bold;text-shadow:0 0 8px rgba(122,255,196,.4)}
#chat header .cc{background:none;border:none;color:#ee9ce6;font-size:16px;cursor:pointer;padding:2px 8px}
#chat-log{flex:1;overflow-y:auto;padding:14px 16px;font-size:11px;line-height:1.55;min-height:80px;max-height:48vh}
#chat-log::-webkit-scrollbar{width:5px} #chat-log::-webkit-scrollbar-thumb{background:rgba(122,255,196,.25);border-radius:3px}
.cm-user{color:#8ee0ff;margin-bottom:6px;font-weight:bold}
.cm-user::before{content:"▷ "; opacity:.7}
.cm-bot{color:rgba(220,235,250,.92);margin-bottom:14px;background:rgba(122,255,196,.07);padding:10px 12px;border-left:2px solid rgba(122,255,196,.4);border-radius:0 3px 3px 0}
.cm-loading{color:rgba(122,255,196,.6);font-style:italic;animation:blink 1.2s infinite}
.cm-error{color:#ff7a99;font-style:italic}
.cm-tour{margin-top:10px;display:flex;flex-direction:column;gap:5px;padding-top:8px;border-top:1px dashed rgba(122,255,196,.18)}
.cm-stop{display:flex;gap:6px;margin-top:6px;font-size:9px;letter-spacing:1px}
.cm-tour-step{display:flex;gap:8px;cursor:pointer;padding:5px 7px;border-radius:2px;background:rgba(140,200,230,.04);transition:background .12s}
.cm-tour-step:hover{background:rgba(140,200,230,.14)}
.cm-tour-num{color:#7affc4;font-weight:bold;flex-shrink:0;width:14px}
.cm-tour-id{flex:1;color:#fff;font-weight:bold;font-size:10.5px}
.cm-tour-note{display:block;color:rgba(180,220,250,.7);font-size:9.5px;margin-top:2px}
.cm-followup{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
.cm-followup button{background:rgba(140,200,230,.08);border:1px solid rgba(140,200,230,.25);color:#aaccdd;
  font-family:'Courier New',monospace;font-size:9px;letter-spacing:1px;padding:4px 8px;cursor:pointer;border-radius:2px}
.cm-followup button:hover{background:rgba(140,200,230,.2);color:#fff}
.cm-tour-actions{display:flex;gap:6px;margin-top:8px}
.cm-tour-actions button{flex:1;background:rgba(122,255,196,.14);border:1px solid rgba(122,255,196,.5);color:#7affc4;
  font-family:'Courier New',monospace;font-size:9px;letter-spacing:2px;padding:6px 10px;cursor:pointer;border-radius:2px}
.cm-tour-actions button:hover{background:rgba(122,255,196,.28)}
#chat-form{display:flex;border-top:1px solid rgba(122,255,196,.16);padding:10px 12px;gap:8px}
#chat-input{flex:1;background:rgba(0,0,0,.35);border:1px solid rgba(140,200,230,.2);color:#cdf;
  font-family:'Courier New',monospace;font-size:11px;padding:8px 11px;outline:none;border-radius:2px}
#chat-input:focus{border-color:rgba(122,255,196,.6);box-shadow:0 0 10px rgba(122,255,196,.2)}
#chat-input::placeholder{color:rgba(140,200,230,.4)}
#chat-form button{background:rgba(122,255,196,.14);border:1px solid rgba(122,255,196,.5);color:#7affc4;
  font-family:'Courier New',monospace;font-size:11px;padding:8px 13px;cursor:pointer;border-radius:2px}
#chat-form button:hover{background:rgba(122,255,196,.28)}
#chat-btn{position:fixed;bottom:80px;left:18px;background:rgba(122,255,196,.13);border:1px solid rgba(122,255,196,.5);color:#7affc4;
  font-family:'Courier New',monospace;font-size:10px;letter-spacing:3px;padding:8px 16px;cursor:pointer;z-index:30;pointer-events:auto;
  text-shadow:0 0 8px rgba(122,255,196,.6);transition:all .15s;border-radius:2px}
#chat-btn:hover{background:rgba(122,255,196,.28);box-shadow:0 0 20px rgba(122,255,196,.35)}

/* ── TOUR HUD overlay (when a tour is playing) ──────────────── */
#tour-hud{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(140%);
  background:rgba(5,12,22,.93);border:1px solid rgba(122,255,196,.4);backdrop-filter:blur(10px);
  padding:14px 22px;z-index:55;pointer-events:auto;border-radius:4px;min-width:380px;max-width:90vw;
  transition:transform .3s cubic-bezier(.2,.7,.2,1);box-shadow:0 0 30px rgba(122,255,196,.18)}
#tour-hud.open{transform:translateX(-50%) translateY(0)}
#tour-hud .tt{font-size:8px;letter-spacing:3px;color:#7affc4;margin-bottom:6px;display:flex;justify-content:space-between}
#tour-hud .th-title{font-size:13px;font-weight:bold;color:#fff;text-shadow:0 0 10px rgba(140,200,230,.5);margin-bottom:5px;line-height:1.4}
#tour-hud .th-note{font-size:10.5px;color:rgba(180,220,250,.8);line-height:1.5}
#tour-hud .th-bar{height:2px;background:rgba(140,200,230,.15);margin:10px 0 8px;border-radius:1px;overflow:hidden}
#tour-hud .th-fill{height:100%;background:linear-gradient(90deg,#7affc4,#8ee0ff);width:0%;transition:width .3s linear}
#tour-hud .th-ctrl{display:flex;gap:8px;font-size:9px;letter-spacing:2px}
#tour-hud .th-ctrl button{background:rgba(140,200,230,.1);border:1px solid rgba(140,200,230,.3);color:#cdf;
  font-family:'Courier New',monospace;font-size:9px;letter-spacing:2px;padding:5px 12px;cursor:pointer;border-radius:2px}
#tour-hud .th-ctrl button:hover{background:rgba(140,200,230,.22)}
#tour-hud .th-ctrl button.stop{color:#ff7a99;border-color:rgba(255,122,153,.4)}

/* ── MOBILE / NARROW ─────────────────────────────────────── */
@media (max-width: 720px) {
    #tr{display:none}
    #tl{font-size:9px;padding:8px 11px;min-width:0;width:auto}
    .pt{font-size:8px;letter-spacing:3px}
    #bl{display:none}
    #note-panel{width:100vw;max-width:100vw;border-right:none}
    #si{width:75vw;font-size:12px;padding:9px 14px}
    #search-results{width:75vw}
    #fire-btn,#gui-toggle,#dash-btn,#chat-btn{font-size:9px;padding:7px 11px;letter-spacing:2px}
    #fire-btn{bottom:18px;right:18px}
    #chat-btn{bottom:60px;left:18px}
    #gui-toggle{top:auto;bottom:18px;right:auto;left:18px}
    #dash-btn{bottom:18px;right:140px}
    .lil-gui.root{width:88vw;max-width:88vw;top:auto;bottom:104px;right:6vw}
    #dash{width:96vw;max-height:78vh}
    #dash .dgrid{grid-template-columns:1fr;padding:14px 16px;gap:14px}
    #chat{left:2vw;right:2vw;bottom:108px;width:96vw;max-width:96vw}
    #tour-hud{min-width:0;width:94vw;left:50%}
}
#fire-btn:hover{background:rgba(238,156,230,.3);box-shadow:0 0 20px rgba(238,156,230,.4)}

/* ── lil-gui themed ────────────────────────────────────────── */
.lil-gui{--background-color:rgba(5,12,22,.78);--text-color:#aaccdd;--title-background-color:rgba(8,20,32,.85);--title-text-color:#7af0c4;--widget-color:rgba(140,200,230,.08);--hover-color:rgba(140,200,230,.16);--focus-color:rgba(122,240,196,.20);--number-color:#7affc4;--string-color:#ee9ce6;--font-family:'Courier New',monospace;--font-size:11px;--input-font-size:11px;--folder-indent:8px;--padding:6px;--spacing:3px;--input-color:rgba(0,0,0,.35);--name-width:42%;backdrop-filter:blur(10px);border:1px solid rgba(140,200,230,.18);border-radius:3px}
.lil-gui.root{position:fixed;top:18px;right:18px;z-index:40;max-height:calc(100vh - 36px);overflow-y:auto;width:280px;display:none}
.lil-gui.root.open{display:block}
.lil-gui .title{letter-spacing:2.5px;text-transform:uppercase;font-weight:bold}
#gui-toggle{position:fixed;top:18px;right:18px;background:rgba(5,12,22,.7);border:1px solid rgba(140,200,230,.25);color:#aaccdd;font-family:'Courier New',monospace;font-size:10px;letter-spacing:3px;padding:7px 12px;cursor:pointer;z-index:42;pointer-events:auto;backdrop-filter:blur(8px);border-radius:2px;transition:all .15s}
#gui-toggle:hover{background:rgba(140,200,230,.15);border-color:rgba(140,200,230,.5)}
.lil-gui.root.open ~ #gui-toggle{display:none}
</style>
</head>
<body>
<div id="loading"><div>◆ INITIALIZING CITADEL CORTEX ◆</div><div class="blink" style="font-size:11px;margin-top:14px;color:#0f9">FIRING SYNAPSES…</div></div>
<div id="scan"></div>
<div id="vig"></div>

<div id="hud">
  <div class="panel" id="tl">
    <div class="pt">◆ CITADEL CORTEX</div>
    <div class="st">NEURONS  <span id="sn" style="color:#0ff">—</span></div>
    <div class="st">SYNAPSES <span id="sl" style="color:#0ff">—</span></div>
    <div class="st">FIRING   <span id="sfire" style="color:#ff0">—</span></div>
    <div class="st">FOCUS    <span id="sf" style="color:#f0f">—</span></div>
    <div class="st">FPS      <span id="fp" style="color:#0f9">—</span></div>
    <div class="st">STELLA   <span id="stella-status" style="color:#888">…</span></div>
  </div>
  <div id="sw"><input id="si" type="text" placeholder="SEARCH NEURON…" autocomplete="off"></div>
  <div class="panel" id="tr">
    <div class="pt">CORTEX MAP</div>
    <div class="legend-row" data-cat="PROJECTS"><span style="color:#7affc4">●</span> PROJECTS</div>
    <div class="legend-row" data-cat="LITIGATION"><span style="color:#ff7a99">●</span> LITIGATION</div>
    <div class="legend-row" data-cat="DESIGN"><span style="color:#ffd28a">●</span> DESIGN</div>
    <div class="legend-row" data-cat="ADMINISTRATION"><span style="color:#8ee0ff">●</span> ADMINISTRATION</div>
    <div class="legend-row" data-cat="RESEARCH"><span style="color:#5af0e8">●</span> RESEARCH</div>
    <div class="legend-row" data-cat="CONTACTS"><span style="color:#ee9ce6">●</span> CONTACTS</div>
    <div class="legend-row" data-cat="ARCHIVES"><span style="color:#a8b0bd">●</span> ARCHIVES</div>
    <div class="legend-row" data-cat="MISC"><span style="color:#c9a8ff">●</span> MISC</div>
  </div>
  <div class="panel" id="bl">
    DRAG — rotate &nbsp; SCROLL — zoom<br>
    CLICK neuron — focus &amp; fire<br>
    CLICK legend row — isolate cortex<br>
    F — fire storm &nbsp; SPACE — reset<br>
    ESC — clear isolation
  </div>
</div>

<aside id="note-panel">
  <header>
    <button id="np-close">✕</button>
    <h2 id="np-title">—</h2>
    <div class="np-meta">
      <span class="np-cat" id="np-cat">—</span>
      <span id="np-stats" style="margin-left:8px"></span>
    </div>
    <div class="np-actions">
      <button id="np-obsidian" class="primary">⌥ Open in Obsidian</button>
      <button id="np-finder">⌘ Reveal in Finder</button>
    </div>
  </header>
  <div id="np-content">Click a neuron to load.</div>
</aside>

<div id="search-results"></div>

<div id="dash">
  <header>
    <div class="dt">◆ DASHBOARD</div>
    <button class="dc" id="dash-close">✕</button>
  </header>
  <div class="dgrid" id="dash-grid"></div>
</div>

<div id="chat">
  <header>
    <span class="ct">⌃ CITADEL NAVIGATOR</span>
    <button class="cc" id="chat-close">✕</button>
  </header>
  <div id="chat-log"></div>
  <form id="chat-form">
    <input id="chat-input" type="text" placeholder='ask anything · e.g. "tour recent litigation"' autocomplete="off" />
    <button type="submit">↗</button>
  </form>
</div>

<div id="tour-hud">
  <div class="tt"><span id="th-step">step 1 / 6</span><span id="th-cat" style="color:#7affc4"></span></div>
  <div class="th-title" id="th-title">—</div>
  <div class="th-note" id="th-note">—</div>
  <div class="th-bar"><div class="th-fill" id="th-fill"></div></div>
  <div class="th-ctrl">
    <button id="th-prev">◀ prev</button>
    <button id="th-pause">⏸ pause</button>
    <button id="th-next">next ▶</button>
    <button id="th-stop" class="stop">✕ stop</button>
  </div>
</div>

<button id="chat-btn">⌃ NAVIGATOR</button>
<button id="dash-btn">▤ DASHBOARD</button>
<button id="fire-btn">⚡ FIRE STORM</button>
<button id="gui-toggle">⚙ CONTROLS</button>

<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<script src="https://cdn.jsdelivr.net/gh/mrdoob/three.js@r128/examples/js/controls/OrbitControls.js"></script>
<script src="https://cdn.jsdelivr.net/gh/mrdoob/three.js@r128/examples/js/postprocessing/EffectComposer.js"></script>
<script src="https://cdn.jsdelivr.net/gh/mrdoob/three.js@r128/examples/js/postprocessing/RenderPass.js"></script>
<script src="https://cdn.jsdelivr.net/gh/mrdoob/three.js@r128/examples/js/postprocessing/ShaderPass.js"></script>
<script src="https://cdn.jsdelivr.net/gh/mrdoob/three.js@r128/examples/js/shaders/LuminosityHighPassShader.js"></script>
<script src="https://cdn.jsdelivr.net/gh/mrdoob/three.js@r128/examples/js/shaders/CopyShader.js"></script>
<script src="https://cdn.jsdelivr.net/gh/mrdoob/three.js@r128/examples/js/postprocessing/UnrealBloomPass.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three-spritetext@1.9.0/dist/three-spritetext.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/lil-gui@0.19/dist/lil-gui.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/marked@12.0.1/marked.min.js"></script>

<script>
const DATA = ${DATA};
const N    = DATA.ids.length;
const NL   = DATA.nLinks;
const SEG  = DATA.segPerLink;

const COLOR = {};
for (const k of Object.keys(DATA.lobes)) COLOR[k] = new THREE.Color(DATA.lobes[k].color);

// ════════════════════════════════════════════════════════════════════════════
// SCENE / RENDERER / BLOOM
// ════════════════════════════════════════════════════════════════════════════
const W = window.innerWidth, H = window.innerHeight;
const IS_MOBILE = matchMedia('(max-width: 720px), (pointer: coarse)').matches;

const renderer = new THREE.WebGLRenderer({ antialias: !IS_MOBILE });
renderer.setPixelRatio(IS_MOBILE ? 1 : Math.min(devicePixelRatio, 2));
renderer.setSize(W, H);
renderer.toneMapping = THREE.ACESFilmicToneMapping;   // softer roll-off
renderer.toneMappingExposure = 0.62;
document.body.appendChild(renderer.domElement);

const scene  = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, W/H, 0.5, 10000);
camera.position.set(0, 80, 1250);

const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enableDamping   = true;
controls.dampingFactor   = 0.06;
controls.autoRotate      = true;
controls.autoRotateSpeed = 0.15;

let composer, bloomPass;
try {
    composer  = new THREE.EffectComposer(renderer);
    composer.addPass(new THREE.RenderPass(scene, camera));
    bloomPass = new THREE.UnrealBloomPass(new THREE.Vector2(W, H), IS_MOBILE ? 0.30 : 0.45, IS_MOBILE ? 0.6 : 0.85, IS_MOBILE ? 0.35 : 0.30);
    composer.addPass(bloomPass);
} catch(e) { console.warn('Bloom:', e.message); composer = null; }

// shared live uniforms — driven by control surface
const timeU      = { value: 0.0 };
const driftU     = { value: 3.5 };
const pulseU     = { value: 0.10 };
const sizeScaleU = { value: 1.0 };
const haloScaleU = { value: 1.0 };
const linkBrightU= { value: 1.0 };
const recencyU   = { value: 0.0 };       // 0 = off
const recencyWinU= { value: 30.0 };      // days

function makeGlowTex(softness = 1.0, sz = 256) {
    // softness:  0.5 = sharp,  1.0 = soft (default),  1.5+ = wisp
    const c = document.createElement('canvas'); c.width = c.height = sz;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(sz/2, sz/2, 0, sz/2, sz/2, sz/2);
    // gentler falloff — no harsh hot core
    const steps = 24;
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const alpha = Math.pow(1 - t, 2.4 / softness);
        g.addColorStop(t, 'rgba(255,255,255,' + alpha.toFixed(3) + ')');
    }
    ctx.fillStyle = g; ctx.fillRect(0, 0, sz, sz);
    return new THREE.CanvasTexture(c);
}

// ════════════════════════════════════════════════════════════════════════════
// NEURONS
// ════════════════════════════════════════════════════════════════════════════
const pos    = new Float32Array(N * 3);
const cols   = new Float32Array(N * 3);
const sizes  = new Float32Array(N);
const phases = new Float32Array(N);
const act    = new Float32Array(N);
const dimmed = new Float32Array(N);
const recent = new Float32Array(N);
const baseSizes = new Float32Array(N);

let MAX_DAYS = 60;
for (let i = 0; i < N; i++) if (DATA.daysOld[i] < 9000) MAX_DAYS = Math.max(MAX_DAYS, DATA.daysOld[i]);

for (let i = 0; i < N; i++) {
    pos[i*3]   = DATA.xs[i];
    pos[i*3+1] = DATA.ys[i];
    pos[i*3+2] = DATA.zs[i];
    const c = COLOR[DATA.cats[i]];
    cols[i*3] = c.r; cols[i*3+1] = c.g; cols[i*3+2] = c.b;
    baseSizes[i] = DATA.sizes[i] * 1.85;
    sizes[i]     = baseSizes[i];
    phases[i]    = Math.random() * Math.PI * 2;
    dimmed[i]    = 1.0;
    recent[i]    = DATA.daysOld[i] >= 9000 ? 0 : Math.max(0, 1 - DATA.daysOld[i] / MAX_DAYS);
}

const NODE_VERT = \`
  attribute float aSize;
  attribute vec3  aColor;
  attribute float aPhase;
  attribute float aAct;
  attribute float aDimmed;       // 1.0 = in current focus / 0.05 = dimmed
  attribute float aRecent;       // 0..1 — newer = closer to 1
  uniform   float uTime;
  uniform   float uDrift;
  uniform   float uPulse;
  uniform   float uSizeScale;
  uniform   float uRecency;      // 0 = off, 1 = full effect
  varying   vec3  vColor;
  varying   float vAct;
  varying   float vDim;
  void main(){
    vec3 drift = vec3(
      sin(uTime * 0.14 + aPhase * 2.1),
      cos(uTime * 0.11 + aPhase * 1.7),
      sin(uTime * 0.17 + aPhase * 1.3)
    ) * uDrift;
    vec3 p = position + drift;

    float pulse = 1.0 + uPulse * sin(uTime * 1.3 + aPhase) + aAct * 1.6;
    float recent = mix(1.0, 0.85 + aRecent * 0.9, uRecency);

    vColor = aColor + vec3(1.0,1.0,1.0) * aAct * 0.7;
    vAct   = aAct;
    vDim   = aDimmed;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = aSize * pulse * uSizeScale * recent * aDimmed * (380.0 / -mv.z);
    gl_Position  = projectionMatrix * mv;
  }
\`;
const NODE_FRAG = \`
  uniform sampler2D uTex;
  varying vec3  vColor;
  varying float vAct;
  varying float vDim;
  void main(){
    vec4 t = texture2D(uTex, gl_PointCoord);
    if(t.a < 0.01) discard;
    vec3 c = vColor * (0.9 + t.r * 0.7) * (1.0 + vAct * 1.6);
    gl_FragColor = vec4(c * vDim, t.a * mix(0.15, 1.0, vDim));
  }
\`;

const nodeMat = new THREE.ShaderMaterial({
    uniforms:       { uTime: timeU, uTex: { value: makeGlowTex(1.1) }, uDrift: driftU, uPulse: pulseU, uSizeScale: sizeScaleU, uRecency: recencyU },
    vertexShader:   NODE_VERT, fragmentShader: NODE_FRAG,
    transparent:    true, blending: THREE.AdditiveBlending, depthWrite: false,
});

const nodeGeo = new THREE.BufferGeometry();
nodeGeo.setAttribute('position', new THREE.BufferAttribute(pos,3));
nodeGeo.setAttribute('aColor',   new THREE.BufferAttribute(cols,3));
const sizeAttr = new THREE.BufferAttribute(sizes,1); sizeAttr.setUsage(THREE.DynamicDrawUsage);
nodeGeo.setAttribute('aSize',    sizeAttr);
nodeGeo.setAttribute('aPhase',   new THREE.BufferAttribute(phases,1));
const actAttr = new THREE.BufferAttribute(act,1); actAttr.setUsage(THREE.DynamicDrawUsage);
nodeGeo.setAttribute('aAct',     actAttr);
const dimAttr = new THREE.BufferAttribute(dimmed,1); dimAttr.setUsage(THREE.DynamicDrawUsage);
nodeGeo.setAttribute('aDimmed',  dimAttr);
nodeGeo.setAttribute('aRecent',  new THREE.BufferAttribute(recent,1));
const nodeCloud = new THREE.Points(nodeGeo, nodeMat);
scene.add(nodeCloud);

// soft halo layer (heavily dimmed for nebula calm)
const haloSizes = new Float32Array(N);
for (let i=0;i<N;i++) haloSizes[i] = sizes[i] * 2.4;
const haloCols = new Float32Array(N*3);
for (let i=0;i<N*3;i++) haloCols[i] = cols[i] * 0.18;
const haloMat = new THREE.ShaderMaterial({
    uniforms:       { uTime: timeU, uTex: { value: makeGlowTex(1.7, 512) }, uDrift: driftU, uPulse: pulseU, uSizeScale: haloScaleU, uRecency: recencyU },
    vertexShader:   NODE_VERT, fragmentShader: NODE_FRAG,
    transparent:    true, blending: THREE.AdditiveBlending, depthWrite: false,
});
const haloGeo = new THREE.BufferGeometry();
haloGeo.setAttribute('position', new THREE.BufferAttribute(pos,3));
haloGeo.setAttribute('aColor',   new THREE.BufferAttribute(haloCols,3));
haloGeo.setAttribute('aSize',    new THREE.BufferAttribute(haloSizes,1));
haloGeo.setAttribute('aPhase',   new THREE.BufferAttribute(phases.map(p=>p+1.7),1));
haloGeo.setAttribute('aAct',     actAttr);
haloGeo.setAttribute('aDimmed',  dimAttr);
haloGeo.setAttribute('aRecent',  new THREE.BufferAttribute(recent,1));
scene.add(new THREE.Points(haloGeo, haloMat));

// ════════════════════════════════════════════════════════════════════════════
// SYNAPSES — pre-tessellated jagged lines (LineSegments, one draw call)
// ════════════════════════════════════════════════════════════════════════════
const LINK_VERT = \`
  attribute float aLP;
  attribute float aSeed;
  uniform   float uTime;
  varying   float vLP;
  varying   float vSeed;
  void main(){
    vLP = aLP; vSeed = aSeed;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
  }
\`;
const LINK_FRAG = \`
  uniform float uTime;
  uniform float uLinkBright;
  varying float vLP;
  varying float vSeed;
  void main(){
    float flow  = fract(vLP - uTime * 0.4 + vSeed * 7.0);
    float head  = smoothstep(0.0, 0.05, flow) * (1.0 - smoothstep(0.28, 1.0, flow));
    float crackle = 0.7 + 0.3 * sin(uTime * 15.0 + vSeed * 33.0 + vLP * 4.0);
    float base  = 0.025 * crackle;
    vec3  cyan  = vec3(0.0, 0.7, 1.0);
    vec3  white = vec3(1.0, 1.0, 1.0);
    vec3  col   = mix(cyan, white, head * 0.7);
    float alpha = (base + head * 0.55) * crackle * uLinkBright;
    gl_FragColor = vec4(col, alpha);
  }
\`;

const linkMat = new THREE.ShaderMaterial({
    uniforms: { uTime: timeU, uLinkBright: linkBrightU },
    vertexShader: LINK_VERT, fragmentShader: LINK_FRAG,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
});
const linkGeo = new THREE.BufferGeometry();
linkGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(DATA.linkPos),3));
linkGeo.setAttribute('aLP',      new THREE.BufferAttribute(new Float32Array(DATA.linkLP),1));
linkGeo.setAttribute('aSeed',    new THREE.BufferAttribute(new Float32Array(DATA.linkSeed),1));
const linkSegs = new THREE.LineSegments(linkGeo, linkMat);
scene.add(linkSegs);

// ════════════════════════════════════════════════════════════════════════════
// 3D CORTEX LABELS — floating SpriteText above each lobe
// ════════════════════════════════════════════════════════════════════════════
const labelGroup = new THREE.Group();
scene.add(labelGroup);
for (const [name, lobe] of Object.entries(DATA.lobes)) {
    const spr = new SpriteText(name);
    spr.textHeight = 20;
    spr.color = lobe.color;
    spr.fontFace = 'Courier New';
    spr.fontWeight = 'bold';
    spr.strokeColor = 'rgba(0,0,0,0.6)';
    spr.strokeWidth = 0.4;
    spr.backgroundColor = 'rgba(0,5,15,0.55)';
    spr.padding = [8, 4];
    spr.borderColor = lobe.color;
    spr.borderWidth = 0.5;
    spr.borderRadius = 3;
    spr.position.set(
        lobe.center[0],
        lobe.center[1] + lobe.radius + 55,
        lobe.center[2]
    );
    spr.material.depthWrite = false;
    spr.material.depthTest = false;
    spr.renderOrder = 10;
    spr.userData.lobeName = name;
    labelGroup.add(spr);
}

// ════════════════════════════════════════════════════════════════════════════
// SYNAPTIC FIRING + LIGHTNING ARCS
// ════════════════════════════════════════════════════════════════════════════
const firingQueue = [];
let activeFirings = 0;

function fireNeuron(idx, depth = 0, t = 0) {
    if (idx < 0 || idx >= N) return;
    act[idx] = Math.min(act[idx] + 0.7, 1.0);

    const nbrs = DATA.adj[idx];
    const chance = (typeof params !== 'undefined') ? params.cascadeChance : 0.22;
    for (const nb of nbrs) {
        if (Math.random() < chance * 0.85) spawnArc(idx, nb);
        if (depth < 2 && Math.random() < (chance - depth*0.10)) {
            firingQueue.push({ idx: nb, fireAt: t + 0.12 + Math.random() * 0.08, depth: depth + 1 });
        }
    }
}

function fireStorm(t) {
    let pick = Math.floor(Math.random() * N);
    for (let tries = 0; tries < 5; tries++) {
        const c = Math.floor(Math.random() * N);
        if (DATA.adj[c].length > DATA.adj[pick].length) pick = c;
    }
    fireNeuron(pick, 0, t);
}

function updateFirings(t, dt) {
    for (let i = 0; i < N; i++) {
        if (act[i] > 0) {
            act[i] *= Math.pow(0.04, dt);
            if (act[i] < 0.01) act[i] = 0;
        }
    }
    actAttr.needsUpdate = true;

    for (let i = firingQueue.length - 1; i >= 0; i--) {
        if (firingQueue[i].fireAt <= t) {
            const f = firingQueue[i]; firingQueue.splice(i, 1);
            fireNeuron(f.idx, f.depth, t);
        }
    }
    // ambient breathing — controlled by params.ambientFire (live slider)
    const rate = (typeof params !== 'undefined') ? params.ambientFire : 0.018;
    if (Math.random() < rate * dt * 60) fireNeuron(Math.floor(Math.random() * N), 0, t);

    activeFirings = 0;
    for (let i = 0; i < N; i++) if (act[i] > 0.15) activeFirings++;
}

const arcPool = [], MAX_ARCS = 25;
function lightning(a, b, rough = 0.45, depth = 4) {
    if (depth === 0) return [a, b];
    const mid = a.clone().lerp(b, 0.5);
    const len = a.distanceTo(b);
    mid.x += (Math.random() - .5) * len * rough;
    mid.y += (Math.random() - .5) * len * rough;
    mid.z += (Math.random() - .5) * len * rough;
    return [...lightning(a, mid, rough * .6, depth - 1), ...lightning(mid, b, rough * .6, depth - 1)];
}
function spawnArc(s, t) {
    if (arcPool.length >= MAX_ARCS) return;
    const a = new THREE.Vector3(DATA.xs[s], DATA.ys[s], DATA.zs[s]);
    const b = new THREE.Vector3(DATA.xs[t], DATA.ys[t], DATA.zs[t]);
    const pts = lightning(a, b);
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 1.0,
        blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const line = new THREE.Line(geo, mat);
    scene.add(line);
    arcPool.push({ line, mat, life: 1.0 });
}
function updateArcs(dt) {
    const opAmp = (typeof params !== 'undefined') ? params.arcOpacity : 0.28;
    for (let i = arcPool.length - 1; i >= 0; i--) {
        const arc = arcPool[i];
        arc.life -= dt * 5.0;
        arc.mat.opacity = Math.max(arc.life, 0) * opAmp;
        arc.mat.color.setRGB(arc.life * 0.2 + 0.5, arc.life * 0.5 + 0.5, 0.92);
        if (arc.life <= 0) { scene.remove(arc.line); arc.line.geometry.dispose(); arc.mat.dispose(); arcPool.splice(i, 1); }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// STAR FIELD + AMBIENT DUST
// ════════════════════════════════════════════════════════════════════════════
// ── HUBBLE SKYBOX — animated FBM-noise nebula + procedural stars ────────────
const nebulaIntensityU = { value: 1.0 };
const nebulaHueU       = { value: 0.0 };
const starDensityU     = { value: 1.0 };
const nebulaPulseU     = { value: 1.0 };

const SKY_VERT = \`
  varying vec3 vDir;
  void main(){
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
\`;

const SKY_FRAG = \`
  uniform float uTime;
  uniform float uIntensity;
  uniform float uHue;
  uniform float uStars;
  uniform float uPulse;
  varying vec3 vDir;

  float hash3(vec3 p){
    p = fract(p * vec3(443.897, 441.423, 437.195));
    p += dot(p, p.yzx + 19.19);
    return fract((p.x + p.y) * p.z);
  }
  float noise(vec3 p){
    vec3 i = floor(p), f = fract(p);
    f = f*f*(3.0 - 2.0*f);
    float c000 = hash3(i + vec3(0.0,0.0,0.0));
    float c100 = hash3(i + vec3(1.0,0.0,0.0));
    float c010 = hash3(i + vec3(0.0,1.0,0.0));
    float c110 = hash3(i + vec3(1.0,1.0,0.0));
    float c001 = hash3(i + vec3(0.0,0.0,1.0));
    float c101 = hash3(i + vec3(1.0,0.0,1.0));
    float c011 = hash3(i + vec3(0.0,1.0,1.0));
    float c111 = hash3(i + vec3(1.0,1.0,1.0));
    return mix(mix(mix(c000, c100, f.x), mix(c010, c110, f.x), f.y),
               mix(mix(c001, c101, f.x), mix(c011, c111, f.x), f.y), f.z);
  }
  float fbm(vec3 p){
    float v = 0.0, a = 0.5;
    v += a * noise(p); p *= 2.05; a *= 0.5;
    v += a * noise(p); p *= 2.05; a *= 0.5;
    v += a * noise(p); p *= 2.05; a *= 0.5;
    v += a * noise(p);
    return v;
  }

  vec3 starColor(float h){
    vec3 cBlue  = vec3(0.65, 0.78, 1.05);
    vec3 cWhite = vec3(1.0,  1.0,  1.0);
    vec3 cYel   = vec3(1.0,  0.92, 0.74);
    vec3 cRed   = vec3(1.0,  0.55, 0.32);
    vec3 c = mix(cBlue, cWhite, smoothstep(0.0, 0.35, h));
    c      = mix(c,    cYel,   smoothstep(0.35, 0.65, h));
    c      = mix(c,    cRed,   smoothstep(0.65, 1.0,  h));
    return c;
  }

  vec3 hueShift(vec3 c, float h){
    const mat3 toYIQ = mat3(0.299, 0.587, 0.114, 0.596,-0.275,-0.321, 0.212,-0.523, 0.311);
    const mat3 toRGB = mat3(1.0, 0.956, 0.621, 1.0,-0.272,-0.647, 1.0,-1.107, 1.704);
    vec3 y = toYIQ * c;
    float hue = atan(y.z, y.y) + h;
    float ch  = length(y.yz);
    return toRGB * vec3(y.x, ch*cos(hue), ch*sin(hue));
  }

  vec3 starLayer(vec3 d, float scale, float thresh, float coreR, float haloR, float twAmp){
    vec3 p  = d * scale;
    vec3 ip = floor(p);
    vec3 fp = fract(p);
    float h = hash3(ip);
    float dim = max(h - thresh, 0.0) / max(1.0 - thresh, 0.001);
    vec3 sp  = vec3(hash3(ip + vec3(1.7)), hash3(ip + vec3(5.3)), hash3(ip + vec3(9.1)));
    float dist = length(fp - sp);
    float core = smoothstep(coreR, 0.0, dist);
    float halo = smoothstep(haloR, 0.0, dist) * 0.35;
    float tw = 0.7 + twAmp * sin(uTime * (1.5 + h * 3.0) + h * 47.0);
    vec3 col = starColor(hash3(ip + vec3(3.3)));
    return col * (core * 1.4 + halo) * dim * tw;
  }

  void main(){
    vec3 d = normalize(vDir);

    float t = uTime * 0.010;
    vec3 q = d * 1.7 + vec3(t, -t*0.55, t*0.40);
    float n1 = fbm(q);
    float n2 = fbm(q * 2.5 + 4.2);
    float mask = smoothstep(0.40, 0.92, n1 * 0.65 + n2 * 0.40);
    float pulse = 0.85 + 0.15 * sin(uTime * 0.22);

    vec3 violet = vec3(0.32, 0.10, 0.50);
    vec3 teal   = vec3(0.05, 0.30, 0.45);
    vec3 amber  = vec3(0.45, 0.20, 0.08);
    vec3 cloudC = mix(mix(violet, teal, n2), amber, n1 * 0.55);
    cloudC = hueShift(cloudC, uHue);
    vec3 cloud = cloudC * mask * 0.30 * uIntensity * mix(1.0, pulse, uPulse);

    vec3 starsBg  = starLayer(d, 340.0, 1.0 - 0.011 * uStars, 0.04, 0.13, 0.30);
    vec3 starsMid = starLayer(d, 110.0, 1.0 - 0.005 * uStars, 0.05, 0.18, 0.45);
    vec3 starsBig = starLayer(d,  32.0, 1.0 - 0.002 * uStars, 0.07, 0.30, 0.55);

    vec3 col = cloud + starsBg + starsMid * 1.05 + starsBig * 1.2;
    col *= 1.0 - mask * 0.08;
    gl_FragColor = vec4(col, 1.0);
  }
\`;

const skyMat = new THREE.ShaderMaterial({
    uniforms: { uTime: timeU, uIntensity: nebulaIntensityU, uHue: nebulaHueU, uStars: starDensityU, uPulse: nebulaPulseU },
    vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
    side: THREE.BackSide, depthWrite: false, depthTest: false,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(4800, 48, 32), skyMat);
sky.renderOrder = -1;
scene.add(sky);
const stars = sky;   // alias for layer-toggle hook

// ── DISTANT GALAXIES — procedural sprites on a parallax shell ───────────
function makeGalaxyTex(seed) {
    const sz = 192;
    const c = document.createElement('canvas'); c.width = c.height = sz;
    const ctx = c.getContext('2d');

    // pick a galaxy style
    const r = (s) => { const x = Math.sin(s) * 43758.5453; return x - Math.floor(x); };
    const style = Math.floor(r(seed * 7.1) * 3); // 0 spiral, 1 elliptical, 2 irregular
    // core colour roll
    const tint = r(seed * 1.7);
    const cr = tint < 0.33 ? [240,230,255] : tint < 0.66 ? [255,235,200] : [255,195,170];

    ctx.save(); ctx.translate(sz/2, sz/2);
    ctx.rotate(r(seed) * Math.PI * 2);
    const ar = style === 0 ? 0.35 : (0.6 + r(seed*2) * 0.4);
    ctx.scale(1.0, ar);

    // outer haze
    let g = ctx.createRadialGradient(0,0,0, 0,0,sz/2);
    g.addColorStop(0,    'rgba(' + cr[0] + ',' + cr[1] + ',' + cr[2] + ',1)');
    g.addColorStop(0.15, 'rgba(' + cr[0] + ',' + cr[1] + ',' + cr[2] + ',.6)');
    g.addColorStop(0.4,  'rgba(' + cr[0] + ',' + cr[1] + ',' + cr[2] + ',.15)');
    g.addColorStop(1,    'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0,0, sz/2, 0, Math.PI*2); ctx.fill();

    // brighter core
    g = ctx.createRadialGradient(0,0,0, 0,0,sz/6);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(' + cr[0] + ',' + cr[1] + ',' + cr[2] + ',.85)');
    g.addColorStop(1, 'rgba(' + cr[0] + ',' + cr[1] + ',' + cr[2] + ',0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0,0, sz/6, 0, Math.PI*2); ctx.fill();

    // spiral arms — faint ring noise
    if (style === 0) {
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < 4; i++) {
            const off = r(seed * 17 + i) * Math.PI * 2;
            const rad = sz * (0.20 + r(seed * 23 + i) * 0.15);
            ctx.strokeStyle = 'rgba(' + cr[0] + ',' + cr[1] + ',' + cr[2] + ',.18)';
            ctx.lineWidth = 2 + r(seed * 31 + i) * 4;
            ctx.beginPath();
            ctx.arc(0, 0, rad, off, off + Math.PI * (1.2 + r(seed*5+i) * 0.6));
            ctx.stroke();
        }
    }
    ctx.restore();

    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    return tex;
}

const GALAXY_TEXES = [];
const GALAXY_VARIANTS = 6;
for (let i = 0; i < GALAXY_VARIANTS; i++) GALAXY_TEXES.push(makeGalaxyTex((i + 1) * 13.7));

const galaxyGroup = new THREE.Group();
scene.add(galaxyGroup);
const GAL_COUNT = IS_MOBILE ? 35 : 90;
for (let i = 0; i < GAL_COUNT; i++) {
    const tex = GALAXY_TEXES[i % GALAXY_VARIANTS];
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.45 + Math.random() * 0.4,
        blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false });
    const spr = new THREE.Sprite(mat);
    // position on a far sphere (closer than sky for parallax)
    const phi = Math.random() * Math.PI * 2;
    const the = Math.acos(2 * Math.random() - 1);
    const R   = 2200 + Math.random() * 1400;
    spr.position.set(
        R * Math.sin(the) * Math.cos(phi),
        R * Math.sin(the) * Math.sin(phi),
        R * Math.cos(the)
    );
    const s = 35 + Math.random() * 110;
    spr.scale.set(s, s * (0.5 + Math.random() * 0.6), 1);
    spr.material.rotation = Math.random() * Math.PI * 2;
    spr.renderOrder = -1;
    galaxyGroup.add(spr);
}

// ── COLOURED NEBULA DUST per cortex (gives the galaxy look) ─────────────────
const DUST_PER_LOBE = IS_MOBILE ? 200 : 600;
const dustGroups = [];
for (const [name, lobe] of Object.entries(DATA.lobes)) {
    const dp = new Float32Array(DUST_PER_LOBE * 3);
    const dv = new Float32Array(DUST_PER_LOBE * 3);
    for (let i = 0; i < DUST_PER_LOBE; i++) {
        // wider spread than the actual nodes — soft halo cloud
        const r = lobe.radius * (1.0 + Math.random() * 1.4) * Math.pow(Math.random(), 0.55);
        const phi = Math.random() * Math.PI * 2;
        const the = Math.acos(2 * Math.random() - 1);
        const flatten = lobe.radius > 180 ? 0.55 : 0.85;
        dp[i*3]   = lobe.center[0] + r * Math.sin(the) * Math.cos(phi);
        dp[i*3+1] = lobe.center[1] + r * Math.sin(the) * Math.sin(phi) * flatten;
        dp[i*3+2] = lobe.center[2] + r * Math.cos(the);
        dv[i*3]   = (Math.random()-.5) * 0.04;
        dv[i*3+1] = (Math.random()-.5) * 0.04;
        dv[i*3+2] = (Math.random()-.5) * 0.04;
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(dp,3));
    const dm = new THREE.PointsMaterial({
        size: 1.7,
        color: new THREE.Color(lobe.color).multiplyScalar(0.55),
        transparent: true, opacity: 0.32,
        blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    scene.add(new THREE.Points(dg, dm));
    dustGroups.push({ geo: dg, pos: dp, vel: dv });
}
// generic ambient void dust
const AP = IS_MOBILE ? 500 : 1800, avel = new Float32Array(AP*3);
const ambPos = new Float32Array(AP*3);
for (let i = 0; i < AP; i++) {
    ambPos[i*3]   = (Math.random()-.5)*1500;
    ambPos[i*3+1] = (Math.random()-.5)*1500;
    ambPos[i*3+2] = (Math.random()-.5)*1500;
    avel[i*3]   = (Math.random()-.5)*.05;
    avel[i*3+1] = (Math.random()-.5)*.05;
    avel[i*3+2] = (Math.random()-.5)*.05;
}
const ambGeo = new THREE.BufferGeometry();
ambGeo.setAttribute('position', new THREE.BufferAttribute(ambPos,3));
const ambMat = new THREE.PointsMaterial({ size: 0.9, color: 0x002233, transparent: true, opacity: .42, blending: THREE.AdditiveBlending, depthWrite: false });
const ambient = new THREE.Points(ambGeo, ambMat);
scene.add(ambient);
function updateAmbient() {
    for (let i = 0; i < AP; i++) {
        ambPos[i*3]   += avel[i*3];
        ambPos[i*3+1] += avel[i*3+1];
        ambPos[i*3+2] += avel[i*3+2];
        if (Math.abs(ambPos[i*3])   > 750) avel[i*3]   *= -1;
        if (Math.abs(ambPos[i*3+1]) > 750) avel[i*3+1] *= -1;
        if (Math.abs(ambPos[i*3+2]) > 750) avel[i*3+2] *= -1;
    }
    ambGeo.attributes.position.needsUpdate = true;
    // slowly rotate dust clouds for organic drift
    for (const dg of dustGroups) {
        const p = dg.pos, v = dg.vel;
        for (let i = 0; i < p.length; i += 3) {
            p[i]   += v[i];
            p[i+1] += v[i+1];
            p[i+2] += v[i+2];
        }
        dg.geo.attributes.position.needsUpdate = true;
    }
}

// ════════════════════════════════════════════════════════════════════════════
// INTERACTION
// ════════════════════════════════════════════════════════════════════════════
const raycaster = new THREE.Raycaster();
raycaster.params.Points.threshold = 8;
const mouse = new THREE.Vector2();
let isolated = null;

let manifest = { vault: '', vaultPath: '', hasStella: false };
fetch('/api/manifest').then(r => r.json()).then(m => {
    manifest = m;
    const el = document.getElementById('stella-status');
    if (!el) return;
    if (!m.hasStella) { el.textContent = 'off'; el.style.color = '#666'; return; }
    el.textContent = 'pinging…'; el.style.color = '#8ee0ff';
    fetch('/api/stella-ping').then(r => r.json()).then(p => {
        if (p.reachable) { el.textContent = '◉ online'; el.style.color = '#7affc4'; }
        else { el.textContent = 'unreachable'; el.style.color = '#ff7a99'; el.title = p.error || ''; }
    }).catch(() => { el.textContent = 'err'; el.style.color = '#ff7a99'; });
}).catch(()=>{});

const npLobeColors = {};   // for category accent on panel
for (const k of Object.keys(DATA.lobes)) npLobeColors[k] = DATA.lobes[k].color;

// ── 2-hop neighbourhood highlight ─────────────────────────────────────
function applyNeighbourhood(idx) {
    if (idx == null) {
        for (let i = 0; i < N; i++) dimmed[i] = 1.0;
    } else {
        for (let i = 0; i < N; i++) dimmed[i] = 0.12;
        dimmed[idx] = 1.0;
        const oneHop = DATA.adj[idx] || [];
        for (const a of oneHop) {
            dimmed[a] = 1.0;
            for (const b of (DATA.adj[a] || [])) if (b !== idx) dimmed[b] = Math.max(dimmed[b], 0.55);
        }
    }
    dimAttr.needsUpdate = true;
}

function humanAge(days) {
    if (days >= 9000) return 'unknown';
    if (days < 1)    return 'today';
    if (days < 2)    return 'yesterday';
    if (days < 30)   return days + 'd ago';
    if (days < 365)  return Math.round(days / 30) + 'mo ago';
    return Math.round(days / 365) + 'y ago';
}

async function showNodeInfo(idx) {
    const id = DATA.ids[idx];
    const relPath = DATA.paths[idx];
    const cat = DATA.cats[idx];

    document.getElementById('sf').textContent = id.slice(0,18) + (id.length>18?'…':'');
    document.getElementById('np-title').textContent = id;

    const catEl = document.getElementById('np-cat');
    catEl.textContent = cat;
    catEl.style.color = npLobeColors[cat] || '#aaccdd';
    const cR = parseInt(npLobeColors[cat].slice(1,3),16),
          cG = parseInt(npLobeColors[cat].slice(3,5),16),
          cB = parseInt(npLobeColors[cat].slice(5,7),16);
    catEl.style.background = 'rgba(' + cR + ',' + cG + ',' + cB + ',.18)';

    const inLinks = (DATA.wikiIn[idx] || []).length;
    const outLinks = (DATA.wikiOut[idx] || []).length;
    document.getElementById('np-stats').innerHTML =
        DATA.adj[idx].length + ' synapses · ' +
        DATA.words[idx].toLocaleString() + ' words · ' +
        humanAge(DATA.daysOld[idx]);

    const np = document.getElementById('note-panel');
    np.classList.add('open');
    np.dataset.path = relPath;

    const content = document.getElementById('np-content');
    if (!relPath) { content.innerHTML = '<em>(synthetic node — no file)</em>'; return; }

    content.innerHTML = '<em style="opacity:.5">loading ' + relPath + '…</em>';
    try {
        const r = await fetch('/api/note?path=' + encodeURIComponent(relPath));
        if (!r.ok) throw new Error(r.statusText);
        const j = await r.json();
        let md = j.content.replace(/^---\\s*\\n[\\s\\S]*?\\n---\\s*\\n/, '');
        md = md.replace(/\\[\\[([^\\]|]+)(?:\\|([^\\]]+))?\\]\\]/g, (_, l, a) => '**' + (a || l) + '**');
        content.innerHTML = marked.parse(md);

        // ── BACKLINKS: who links TO this note (semantic only) ──────────
        const back = DATA.wikiIn[idx] || [];
        if (back.length) {
            const list = back.slice(0, 30).map(n => '<a href="#" data-idx="' + n + '">↶ ' + DATA.ids[n] + '</a>').join(' · ');
            content.insertAdjacentHTML('beforeend',
                '<hr class="np-sep"/>' +
                '<div class="np-section-title">◀ BACKLINKED FROM ' + back.length + '</div>' +
                '<div class="np-link-list">' + list + '</div>');
        }
        // ── OUTGOING wiki-links ────────────────────────────────────────
        const out = DATA.wikiOut[idx] || [];
        if (out.length) {
            const list = out.slice(0, 30).map(n => '<a href="#" data-idx="' + n + '">↷ ' + DATA.ids[n] + '</a>').join(' · ');
            content.insertAdjacentHTML('beforeend',
                '<hr class="np-sep"/>' +
                '<div class="np-section-title">▶ LINKS TO ' + out.length + '</div>' +
                '<div class="np-link-list">' + list + '</div>');
        }
        // ── SIBLING connections (folder / keyword / hub edges) ──────────
        const allConn = new Set(DATA.adj[idx]);
        out.forEach(n => allConn.delete(n));
        back.forEach(n => allConn.delete(n));
        const siblings = [...allConn].slice(0, 24);
        if (siblings.length) {
            const list = siblings.map(n => '<a href="#" data-idx="' + n + '">' + DATA.ids[n] + '</a>').join(' · ');
            content.insertAdjacentHTML('beforeend',
                '<hr class="np-sep"/>' +
                '<div class="np-section-title">◇ RELATED ' + allConn.size + '</div>' +
                '<div class="np-link-list">' + list + '</div>');
        }

        content.querySelectorAll('a[data-idx]').forEach(a => {
            a.addEventListener('click', e => { e.preventDefault(); selectByIndex(+a.getAttribute('data-idx')); });
        });
    } catch (e) {
        content.innerHTML = '<em style="color:#ff7a99">could not load: ' + e.message + '</em>';
    }
}

function selectByIndex(idx) {
    showNodeInfo(idx);
    applyNeighbourhood(idx);
    fireNeuron(idx, 0, clock.getElapsedTime());
    const tgt = new THREE.Vector3(DATA.xs[idx], DATA.ys[idx], DATA.zs[idx]);
    const dir = camera.position.clone().sub(tgt).normalize().multiplyScalar(220);
    flyTo(tgt.clone().add(dir), tgt);
}

function clearSelection() {
    document.getElementById('note-panel').classList.remove('open');
    document.getElementById('sf').textContent = '—';
    applyNeighbourhood(null);
}

// ── panel buttons ─────────────────────────────────────────────────────
// ── DASHBOARD ─────────────────────────────────────────────────────────
function openDashboard() {
    const grid = document.getElementById('dash-grid');
    const rows = (title, items, badge) =>
        '<section><h3>' + title + '</h3><ol>' +
        items.map(([idx, label, sub]) =>
            '<li data-idx="' + idx + '"><span class="dn">' + label + '</span><span class="dx">' + (sub || '') + '</span></li>'
        ).join('') + '</ol></section>';

    // Top hubs (by total degree)
    const allIdx = DATA.ids.map((_, i) => i);
    const topHubs = allIdx.slice().sort((a, b) => DATA.adj[b].length - DATA.adj[a].length).slice(0, 12)
        .map(i => [i, DATA.ids[i], DATA.adj[i].length + ' syn']);

    // Recently modified (last 14 days, top by mtime)
    const recentList = allIdx.filter(i => DATA.daysOld[i] < 14)
        .sort((a, b) => DATA.daysOld[a] - DATA.daysOld[b]).slice(0, 12)
        .map(i => [i, DATA.ids[i], humanAge(DATA.daysOld[i])]);

    // Orphan-ish (low degree, real notes with paths)
    const weakly = allIdx.filter(i => DATA.adj[i].length <= 1 && DATA.paths[i])
        .sort((a, b) => DATA.words[b] - DATA.words[a]).slice(0, 12)
        .map(i => [i, DATA.ids[i], DATA.words[i] + 'w']);

    // Per-cortex counts + click to isolate
    const catCounts = {};
    for (const c of DATA.categories) catCounts[c] = 0;
    for (const c of DATA.cats) catCounts[c] = (catCounts[c] || 0) + 1;

    grid.innerHTML =
        rows('▲  Top Hubs', topHubs) +
        rows('●  Recently Modified', recentList) +
        rows('○  Lowly Connected', weakly) +
        '<section><h3>◇  Cortexes</h3><ol>' +
            DATA.categories.map(c =>
                '<li data-cat="' + c + '"><span class="dn" style="color:' + (DATA.lobes[c]?.color || '#cdf') + '">' + c + '</span><span class="dx">' + (catCounts[c] || 0) + '</span></li>'
            ).join('') + '</ol></section>';

    grid.querySelectorAll('li[data-idx]').forEach(li => {
        li.addEventListener('click', () => {
            selectByIndex(+li.getAttribute('data-idx'));
            closeDashboard();
        });
    });
    grid.querySelectorAll('li[data-cat]').forEach(li => {
        li.addEventListener('click', () => {
            const cat = li.getAttribute('data-cat');
            for (const c of DATA.categories) params['c' + c] = (c === cat);
            gui.controllersRecursive().forEach(ct => ct.updateDisplay());
            applyAll();
            closeDashboard();
        });
    });

    document.getElementById('dash').classList.add('open');
}
function closeDashboard() { document.getElementById('dash').classList.remove('open'); }
document.getElementById('dash-btn').addEventListener('click', openDashboard);
document.getElementById('dash-close').addEventListener('click', closeDashboard);

document.getElementById('np-close').addEventListener('click', clearSelection);
document.getElementById('np-obsidian').addEventListener('click', () => {
    const rel = document.getElementById('note-panel').dataset.path;
    if (!rel || !manifest.vault) return;
    const link = 'obsidian://open?vault=' + encodeURIComponent(manifest.vault) +
                 '&file=' + encodeURIComponent(rel.replace(/\\.md$/, ''));
    window.open(link, '_self');
});
document.getElementById('np-finder').addEventListener('click', () => {
    const rel = document.getElementById('note-panel').dataset.path;
    if (!rel) return;
    fetch('/api/finder?path=' + encodeURIComponent(rel));
});

function applyIsolation() {
    const c = nodeGeo.attributes.aColor;
    const s = nodeGeo.attributes.aSize;
    for (let i = 0; i < N; i++) {
        const col = COLOR[DATA.cats[i]];
        if (!isolated || DATA.cats[i] === isolated) {
            c.setXYZ(i, col.r, col.g, col.b);
            sizes[i] = baseSizes[i];
        } else {
            c.setXYZ(i, col.r * 0.05, col.g * 0.05, col.b * 0.05);
            sizes[i] = baseSizes[i] * 0.5;
        }
    }
    c.needsUpdate = true; s.needsUpdate = true;
}

document.querySelectorAll('.legend-row').forEach(row => {
    row.style.cursor = 'pointer';
    row.style.pointerEvents = 'auto';
    row.addEventListener('click', () => {
        const cat = row.getAttribute('data-cat');
        isolated = (isolated === cat) ? null : cat;
        document.querySelectorAll('.legend-row').forEach(r => r.style.opacity = (!isolated || r.getAttribute('data-cat') === isolated) ? '1' : '.3');
        applyIsolation();
    });
});

renderer.domElement.addEventListener('click', e => {
    if (e.target !== renderer.domElement) return;
    mouse.x = (e.clientX/W)*2 - 1; mouse.y = -(e.clientY/H)*2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObject(nodeCloud);
    if (hits.length) {
        selectByIndex(hits[0].index);
    } else {
        clearSelection();
    }
});

function flyTo(p, tgt, dur=1100) {
    const s = camera.position.clone();
    const t0 = performance.now();
    function step() {
        const r = Math.min((performance.now()-t0)/dur, 1);
        const e = 1 - Math.pow(1-r, 4);
        camera.position.lerpVectors(s, p, e);
        controls.target.lerp(tgt, e);
        if (r < 1) requestAnimationFrame(step);
    } step();
}

// ── SEARCH with dropdown of matching neurons ─────────────────────────
const searchEl  = document.getElementById('si');
const resultsEl = document.getElementById('search-results');
let searchActiveIdx = -1;

function runSearch(q) {
    const c = nodeGeo.attributes.aColor;
    const Q = q.toLowerCase().trim();

    // dim/highlight everything
    for (let i = 0; i < N; i++) {
        const match = !Q || DATA.ids[i].toLowerCase().includes(Q);
        const col = COLOR[DATA.cats[i]];
        if (match) c.setXYZ(i, col.r, col.g, col.b);
        else       c.setXYZ(i, col.r*0.04, col.g*0.04, col.b*0.04);
    }
    c.needsUpdate = true;

    // build dropdown
    if (!Q) { resultsEl.style.display = 'none'; return; }
    const hits = [];
    for (let i = 0; i < N; i++) {
        if (DATA.ids[i].toLowerCase().includes(Q)) hits.push(i);
        if (hits.length >= 80) break;
    }
    // rank by degree
    hits.sort((a, b) => DATA.adj[b].length - DATA.adj[a].length);
    const top = hits.slice(0, 30);

    resultsEl.innerHTML = top.map((idx, k) =>
        '<div class="sr-item' + (k === 0 ? ' active' : '') + '" data-idx="' + idx + '">' +
        '<span>' + DATA.ids[idx].slice(0, 38) + (DATA.ids[idx].length > 38 ? '…' : '') + '</span>' +
        '<span class="sr-cat" style="color:' + npLobeColors[DATA.cats[idx]] + '">' + DATA.cats[idx].slice(0,4) + '</span>' +
        '</div>'
    ).join('');
    resultsEl.style.display = top.length ? 'block' : 'none';
    searchActiveIdx = 0;

    resultsEl.querySelectorAll('.sr-item').forEach(el => {
        el.addEventListener('click', () => {
            selectByIndex(+el.getAttribute('data-idx'));
            resultsEl.style.display = 'none';
        });
    });
}

searchEl.addEventListener('input', e => runSearch(e.target.value));
searchEl.addEventListener('focus', () => searchEl.value && runSearch(searchEl.value));
searchEl.addEventListener('keydown', e => {
    const items = [...resultsEl.querySelectorAll('.sr-item')];
    if (!items.length) return;
    if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
        e.preventDefault();
        items[searchActiveIdx]?.classList.remove('active');
        searchActiveIdx = (searchActiveIdx + (e.code === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[searchActiveIdx].classList.add('active');
        items[searchActiveIdx].scrollIntoView({ block: 'nearest' });
    } else if (e.code === 'Enter') {
        e.preventDefault();
        const idx = +items[searchActiveIdx].getAttribute('data-idx');
        selectByIndex(idx);
        resultsEl.style.display = 'none';
        searchEl.blur();
    } else if (e.code === 'Escape') {
        resultsEl.style.display = 'none';
        searchEl.blur();
    }
});
document.addEventListener('click', e => {
    if (!e.target.closest('#search-results') && e.target !== searchEl) resultsEl.style.display = 'none';
});

// (old close handler replaced by #np-close)
document.getElementById('fire-btn').addEventListener('click', () => fireStorm(clock.getElapsedTime()));

document.getElementById('sn').textContent = N;
document.getElementById('sl').textContent = NL;

// ════════════════════════════════════════════════════════════════════════════
// NAVIGATOR CHAT (Claude-backed)
// ════════════════════════════════════════════════════════════════════════════
const CAT_HINTS = {
    'litigation': 'LITIGATION', 'legal': 'LITIGATION', 'ird': 'LITIGATION', 'court': 'LITIGATION',
    'dispute': 'LITIGATION', 'enforcement': 'LITIGATION', 'lawsuit': 'LITIGATION',
    'research': 'RESEARCH', 'intel': 'RESEARCH', 'briefing': 'RESEARCH', 'thesis': 'RESEARCH', 'analysis': 'RESEARCH',
    'project': 'PROJECTS', 'projects': 'PROJECTS', 'deal': 'PROJECTS', 'property': 'PROJECTS',
    'acquisition': 'PROJECTS', 'babich': 'PROJECTS', 'featherston': 'PROJECTS', 'mclane': 'PROJECTS',
    'design': 'DESIGN', 'render': 'DESIGN', 'masterplan': 'DESIGN', 'marketing': 'DESIGN', 'media': 'DESIGN',
    'admin': 'ADMINISTRATION', 'finance': 'ADMINISTRATION', 'accounting': 'ADMINISTRATION',
    'governance': 'ADMINISTRATION', 'entity': 'ADMINISTRATION', 'tax': 'ADMINISTRATION',
    'people': 'CONTACTS', 'contact': 'CONTACTS', 'team': 'CONTACTS',
};
const RECENT_RE = /\b(recent|recently|fresh|new(est)?|latest|this week|last week|today|yesterday|lately|past few)\b/i;
const COUNT_RE  = /\b(top|first|last|\d+)\b/i;

function preFilter(message) {
    const m = message.toLowerCase();
    let pool = [];
    for (let i = 0; i < N; i++) pool.push(i);

    // category hint
    let catFilter = null;
    for (const [kw, cat] of Object.entries(CAT_HINTS)) {
        if (m.includes(kw)) { catFilter = cat; break; }
    }
    if (catFilter) pool = pool.filter(i => DATA.cats[i] === catFilter);

    // recency hint
    if (RECENT_RE.test(message)) pool = pool.filter(i => DATA.daysOld[i] < 60);

    // keyword salience: tokens > 3 chars not in stopwords
    const STOP = new Set(['the','a','an','of','and','to','for','from','with','this','that','what','show','take','find','about','through','journey','tour','give','want','need','look']);
    const tokens = m.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(t => t.length >= 4 && !STOP.has(t));
    const scored = pool.map(i => {
        const id = DATA.ids[i].toLowerCase();
        let score = 0;
        for (const t of tokens) if (id.includes(t)) score += 2;
        score += DATA.adj[i].length * 0.04;     // degree bias
        score += Math.max(0, (60 - DATA.daysOld[i])) * 0.03;  // recency bias
        return [i, score];
    });
    scored.sort((a, b) => b[1] - a[1]);

    // if nothing scored, just keep recency / category order
    return scored.slice(0, 100).map(x => x[0]);
}

let chatHistory = [];
function chatRender() {
    const log = document.getElementById('chat-log');
    log.innerHTML = chatHistory.map(msg => {
        if (msg.kind === 'user')    return '<div class="cm-user">' + esc(msg.text) + '</div>';
        if (msg.kind === 'loading') return '<div class="cm-bot cm-loading">thinking…</div>';
        if (msg.kind === 'error')   return '<div class="cm-bot cm-error">' + esc(msg.text) + '</div>';
        // bot reply with optional tour
        let html = '<div class="cm-bot">';
        if (msg.stella && msg.stella.chunks > 0) {
            html += '<div style="font-size:8.5px;letter-spacing:2px;color:#7affc4;margin-bottom:6px">◉ STELLA · ' + msg.stella.chunks + ' chunks</div>';
        }
        html += esc(msg.text);
        if (msg.tour && msg.tour.length) {
            html += '<div class="cm-tour">' + msg.tour.map((t, k) =>
                '<div class="cm-tour-step" data-idx="' + t.idx + '">' +
                  '<span class="cm-tour-num">' + (k+1) + '</span>' +
                  '<div><span class="cm-tour-id">' + esc((DATA.ids[t.idx] || '?').slice(0,46)) + '</span>' +
                  '<span class="cm-tour-note">' + esc(t.note || '') + '</span></div>' +
                '</div>'
            ).join('') + '</div>' +
            '<div class="cm-tour-actions"><button data-act="play" data-mid="' + msg.id + '">▶ play tour</button></div>';
        }
        if (msg.follow_up && msg.follow_up.length) {
            html += '<div class="cm-followup">' + msg.follow_up.map(q =>
                '<button data-followup="' + esc(q) + '">' + esc(q) + '</button>'
            ).join('') + '</div>';
        }
        html += '</div>';
        return html;
    }).join('');
    log.scrollTop = log.scrollHeight;

    // wire up handlers
    log.querySelectorAll('.cm-tour-step').forEach(el =>
        el.addEventListener('click', () => { const idx = +el.getAttribute('data-idx'); selectByIndex(idx); }));
    log.querySelectorAll('[data-followup]').forEach(b =>
        b.addEventListener('click', () => { document.getElementById('chat-input').value = b.getAttribute('data-followup'); chatSubmit(); }));
    log.querySelectorAll('[data-act="play"]').forEach(b =>
        b.addEventListener('click', () => {
            const mid = +b.getAttribute('data-mid');
            const msg = chatHistory.find(m => m.id === mid);
            if (msg && msg.tour) playTour(msg.tour);
        }));
}
function esc(s){ return String(s).replace(/[<>&"]/g, c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])); }

async function chatSubmit() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    chatHistory.push({ kind: 'user', text });
    chatHistory.push({ kind: 'loading' });
    chatRender();
    try {
        const candidates = preFilter(text).map(i => ({
            idx: i, id: DATA.ids[i], cat: DATA.cats[i],
            daysOld: DATA.daysOld[i], degree: DATA.adj[i].length,
        }));
        const r = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text, candidates }),
        });
        const j = await r.json();
        chatHistory.pop();   // remove loading
        if (j.error) {
            chatHistory.push({ kind: 'error', text: j.error });
        } else {
            chatHistory.push({
                kind: 'bot',
                id: Date.now(),
                text: j.summary || '(no summary)',
                tour: (j.tour || []).filter(t => Number.isInteger(t.idx) && t.idx >= 0 && t.idx < N),
                follow_up: j.follow_up || [],
                stella: j.stella || null,
            });
        }
    } catch (e) {
        chatHistory.pop();
        chatHistory.push({ kind: 'error', text: e.message });
    }
    chatRender();
}

// ── Tour player ───────────────────────────────────────────────────────
let tourState = null;
function playTour(tour) {
    if (!tour.length) return;
    closeChat();
    tourState = { tour, idx: 0, paused: false, timer: null, dwellMs: 6500 };
    showTourStep();
    document.getElementById('tour-hud').classList.add('open');
}
function showTourStep() {
    if (!tourState || tourState.idx >= tourState.tour.length) { stopTour(); return; }
    const step = tourState.tour[tourState.idx];
    const idx  = step.idx;
    selectByIndex(idx);
    document.getElementById('th-step').textContent = 'step ' + (tourState.idx + 1) + ' / ' + tourState.tour.length;
    document.getElementById('th-cat').textContent  = DATA.cats[idx] || '';
    document.getElementById('th-title').textContent = DATA.ids[idx] || '';
    document.getElementById('th-note').textContent  = step.note || '';
    document.getElementById('th-fill').style.width  = '0%';
    if (!tourState.paused) scheduleNext();
}
function scheduleNext() {
    if (tourState.timer) clearTimeout(tourState.timer);
    const start = performance.now();
    const tick = () => {
        if (!tourState || tourState.paused) return;
        const elapsed = performance.now() - start;
        const pct = Math.min(elapsed / tourState.dwellMs, 1);
        document.getElementById('th-fill').style.width = (pct * 100) + '%';
        if (pct >= 1) { tourState.idx++; showTourStep(); }
        else tourState.timer = requestAnimationFrame(tick);
    };
    tourState.timer = requestAnimationFrame(tick);
}
function stopTour() {
    if (tourState && tourState.timer) cancelAnimationFrame(tourState.timer);
    tourState = null;
    document.getElementById('tour-hud').classList.remove('open');
}
document.getElementById('th-next').addEventListener('click', () => { if (!tourState) return; tourState.idx++; showTourStep(); });
document.getElementById('th-prev').addEventListener('click', () => { if (!tourState) return; tourState.idx = Math.max(0, tourState.idx - 1); showTourStep(); });
document.getElementById('th-pause').addEventListener('click', (e) => {
    if (!tourState) return;
    tourState.paused = !tourState.paused;
    e.target.textContent = tourState.paused ? '▶ resume' : '⏸ pause';
    if (!tourState.paused) scheduleNext();
});
document.getElementById('th-stop').addEventListener('click', stopTour);

// ── chat panel open/close ─────────────────────────────────────────────
function openChat() {
    document.getElementById('chat').classList.add('open');
    setTimeout(() => document.getElementById('chat-input').focus(), 50);
}
function closeChat() { document.getElementById('chat').classList.remove('open'); }
document.getElementById('chat-btn').addEventListener('click', openChat);
document.getElementById('chat-close').addEventListener('click', closeChat);
document.getElementById('chat-form').addEventListener('submit', e => { e.preventDefault(); chatSubmit(); });

document.addEventListener('keydown', e => {
    if (e.target.matches && e.target.matches('input,textarea')) return;
    if (e.code === 'Space')  { e.preventDefault(); flyTo(new THREE.Vector3(0,80,1250), new THREE.Vector3(0,0,0)); }
    if (e.code === 'KeyF')   { fireStorm(clock.getElapsedTime()); }
    if (e.code === 'KeyD')   { document.getElementById('dash').classList.contains('open') ? closeDashboard() : openDashboard(); }
    if (e.code === 'KeyR')   { params.recencyOn = !params.recencyOn; gui.controllersRecursive().forEach(ct => ct.updateDisplay()); applyAll(); }
    if (e.code === 'KeyK')   { document.getElementById('chat').classList.contains('open') ? closeChat() : openChat(); }
    if (e.code === 'Slash')  { e.preventDefault(); document.getElementById('si').focus(); }
    if (e.code === 'Escape') {
        stopTour();
        clearSelection();
        closeDashboard();
        closeChat();
        document.getElementById('si').value='';
        document.getElementById('si').dispatchEvent(new Event('input'));
        isolated = null; applyIsolation();
        document.querySelectorAll('.legend-row').forEach(r => r.style.opacity = '1');
    }
});

window.addEventListener('resize', () => {
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w/h; camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    if (composer) composer.setSize(w, h);
});

let lastT = performance.now(), fcount = 0;
function updateFPS() {
    fcount++;
    const now = performance.now();
    if (now - lastT > 800) {
        document.getElementById('fp').textContent = Math.round(fcount * 1000 / (now-lastT));
        document.getElementById('sfire').textContent = activeFirings;
        fcount = 0; lastT = now;
    }
}

// ════════════════════════════════════════════════════════════════════════════
// CONTROL SURFACE (lil-gui)
// ════════════════════════════════════════════════════════════════════════════
const STORAGE_KEY = 'citadel-cortex-settings-v1';
const defaults = {
    // visual
    bloomStrength:   0.45,
    bloomRadius:     0.85,
    bloomThreshold:  0.30,
    exposure:        0.62,
    // background
    nebulaIntensity: 1.0,
    nebulaHue:       0.0,
    nebulaPulse:     1.0,
    starDensity:     1.0,
    // recency
    recencyOn:       false,
    recencyStrength: 1.0,
    // motion
    autoRotate:      true,
    rotateSpeed:     0.15,
    drift:           3.5,
    pulse:           0.10,
    // nodes
    nodeSize:        1.0,
    haloSize:        1.0,
    // synapses
    linkBright:      1.0,
    showLinks:       true,
    // firing
    ambientFire:     0.018,
    cascadeChance:   0.22,
    arcOpacity:      0.28,
    // layers
    showLabels:      true,
    showDust:        true,
    showStars:       true,
    showAmbient:     true,
    // cortexes (per-bucket visibility)
    cPROJECTS:       true,
    cLITIGATION:     true,
    cDESIGN:         true,
    cADMINISTRATION: true,
    cCONTACTS:       true,
    cARCHIVES:       true,
    cMISC:           true,
};

let params = Object.assign({}, defaults);
try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved) Object.assign(params, saved);
} catch(e) {}

function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(params)); } catch(e) {}
}

const gui = new lil.GUI({ title: '◆ CITADEL CONTROL', autoPlace: false });
document.body.appendChild(gui.domElement);
gui.domElement.classList.add('root');

// ── helpers ──────────────────────────────────────────────────
function applyAll() {
    // visual
    if (bloomPass) { bloomPass.strength = params.bloomStrength; bloomPass.radius = params.bloomRadius; bloomPass.threshold = params.bloomThreshold; }
    renderer.toneMappingExposure = params.exposure;
    // background
    nebulaIntensityU.value = params.nebulaIntensity;
    nebulaHueU.value       = params.nebulaHue;
    nebulaPulseU.value     = params.nebulaPulse;
    starDensityU.value     = params.starDensity;
    // recency
    recencyU.value         = params.recencyOn ? params.recencyStrength : 0.0;
    // motion
    controls.autoRotate = params.autoRotate;
    controls.autoRotateSpeed = params.rotateSpeed;
    driftU.value = params.drift;
    pulseU.value = params.pulse;
    sizeScaleU.value = params.nodeSize;
    haloScaleU.value = params.haloSize;
    linkBrightU.value = params.linkBright;
    // layers
    linkSegs.visible = params.showLinks;
    labelGroup.visible = params.showLabels;
    applyVisibility();
    persist();
}

function applyVisibility() {
    const c = nodeGeo.attributes.aColor;
    const s = nodeGeo.attributes.aSize;
    for (let i = 0; i < N; i++) {
        const visible = params['c' + DATA.cats[i]] !== false;
        const col = COLOR[DATA.cats[i]];
        if (visible) {
            c.setXYZ(i, col.r, col.g, col.b);
            sizes[i] = baseSizes[i];
        } else {
            c.setXYZ(i, col.r*0.02, col.g*0.02, col.b*0.02);
            sizes[i] = baseSizes[i] * 0.15;
        }
    }
    c.needsUpdate = true; s.needsUpdate = true;
}

// ── ATMOSPHERE folder (bloom + tone) ─────────────────────────
const fAtm = gui.addFolder('Atmosphere');
fAtm.add(params, 'bloomStrength',  0, 2, 0.01).name('bloom strength').onChange(applyAll);
fAtm.add(params, 'bloomRadius',    0, 2, 0.01).name('bloom radius').onChange(applyAll);
fAtm.add(params, 'bloomThreshold', 0, 1, 0.01).name('bloom threshold').onChange(applyAll);
fAtm.add(params, 'exposure',       0, 2, 0.01).name('exposure').onChange(applyAll);

// ── NEBULA folder ───────────────────────────────────────────
const fNeb = gui.addFolder('Nebula Sky');
fNeb.add(params, 'nebulaIntensity', 0, 3,    0.05).name('nebula brightness').onChange(applyAll);
fNeb.add(params, 'nebulaHue',      -3.14, 3.14, 0.01).name('colour field').onChange(applyAll);
fNeb.add(params, 'nebulaPulse',     0, 3,    0.05).name('pulse depth').onChange(applyAll);
fNeb.add(params, 'starDensity',     0, 3,    0.05).name('star density').onChange(applyAll);

// ── RECENCY folder ──────────────────────────────────────────
const fRec = gui.addFolder('Recency');
fRec.add(params, 'recencyOn').name('highlight fresh notes').onChange(applyAll);
fRec.add(params, 'recencyStrength', 0, 2, 0.05).name('strength').onChange(applyAll);

// ── MOTION folder ─────────────────────────────────────────────
const fMot = gui.addFolder('Motion');
fMot.add(params, 'autoRotate').name('autorotate').onChange(applyAll);
fMot.add(params, 'rotateSpeed', 0, 2, 0.01).name('rotate speed').onChange(applyAll);
fMot.add(params, 'drift',       0, 15, 0.1).name('node drift').onChange(applyAll);
fMot.add(params, 'pulse',       0, 0.5, 0.01).name('node pulse').onChange(applyAll);

// ── NEURONS folder ───────────────────────────────────────────
const fNeu = gui.addFolder('Neurons & Synapses');
fNeu.add(params, 'nodeSize',   0.2, 3, 0.05).name('neuron size').onChange(applyAll);
fNeu.add(params, 'haloSize',   0,   3, 0.05).name('halo size').onChange(applyAll);
fNeu.add(params, 'linkBright', 0,   3, 0.05).name('synapse glow').onChange(applyAll);
fNeu.add(params, 'showLinks').name('show synapses').onChange(applyAll);

// ── FIRING folder ────────────────────────────────────────────
const fFir = gui.addFolder('Firing');
fFir.add(params, 'ambientFire',   0, 0.2,  0.001).name('ambient rate').onChange(persist);
fFir.add(params, 'cascadeChance', 0, 0.8,  0.01).name('cascade chance').onChange(persist);
fFir.add(params, 'arcOpacity',    0, 1,    0.01).name('arc opacity').onChange(persist);
fFir.add({ fire:  () => fireNeuron(Math.floor(Math.random()*N), 0, clock.getElapsedTime()) }, 'fire').name('🔥  fire random neuron');
fFir.add({ storm: () => fireStorm(clock.getElapsedTime()) }, 'storm').name('⚡  ignite storm');
fFir.add({ chain: () => { for (let i = 0; i < 5; i++) setTimeout(() => fireStorm(clock.getElapsedTime()), i*220); } }, 'chain').name('💥  chain reaction');

// ── LAYERS folder ────────────────────────────────────────────
const fLay = gui.addFolder('Layers');
fLay.add(params, 'showLabels').name('cortex labels').onChange(applyAll);
fLay.add(params, 'showDust').name('cortex dust').onChange(v => { dustGroups.forEach(g => g.geo.visible = v); persist(); });
fLay.add(params, 'showStars').name('star field').onChange(v => { stars.visible = v; galaxyGroup.visible = v; persist(); });
fLay.add(params, 'showAmbient').name('void dust').onChange(v => { ambient.visible = v; persist(); });

// ── CORTEXES folder (per-bucket toggles) ─────────────────────
const fCor = gui.addFolder('Cortex Filter');
['PROJECTS','LITIGATION','DESIGN','ADMINISTRATION','RESEARCH','CONTACTS','ARCHIVES','MISC'].forEach(cat => {
    fCor.add(params, 'c' + cat).name(cat).onChange(applyAll);
});
fCor.add({ all:  () => { ['PROJECTS','LITIGATION','DESIGN','ADMINISTRATION','RESEARCH','CONTACTS','ARCHIVES','MISC'].forEach(c => params['c'+c] = true); gui.controllersRecursive().forEach(ct => ct.updateDisplay()); applyAll(); } }, 'all').name('✓ show all');
fCor.add({ none: () => { ['PROJECTS','LITIGATION','DESIGN','ADMINISTRATION','RESEARCH','CONTACTS','ARCHIVES','MISC'].forEach(c => params['c'+c] = false); gui.controllersRecursive().forEach(ct => ct.updateDisplay()); applyAll(); } }, 'none').name('✗ hide all');

// ── CAMERA folder ────────────────────────────────────────────
const fCam = gui.addFolder('Camera');
fCam.add({ reset: () => flyTo(new THREE.Vector3(0,80,1250), new THREE.Vector3(0,0,0)) }, 'reset').name('↩  reset');
fCam.add({ top:   () => flyTo(new THREE.Vector3(0,1400,0),  new THREE.Vector3(0,0,0)) }, 'top').name('↑  top-down');
fCam.add({ side:  () => flyTo(new THREE.Vector3(1400,0,0),  new THREE.Vector3(0,0,0)) }, 'side').name('→  side');
fCam.add({ front: () => flyTo(new THREE.Vector3(0,0,1400),  new THREE.Vector3(0,0,0)) }, 'front').name('●  front');
fCam.add({ pull:  () => flyTo(new THREE.Vector3(0,200,2000), new THREE.Vector3(0,0,0)) }, 'pull').name('—  pull back');

// ── PRESETS folder ───────────────────────────────────────────
const presets = {
    Calm: { bloomStrength:0.35, exposure:0.55, drift:2.5, pulse:0.06, ambientFire:0.008, rotateSpeed:0.1, linkBright:0.7 },
    Default: { bloomStrength:0.45, exposure:0.62, drift:3.5, pulse:0.10, ambientFire:0.018, rotateSpeed:0.15, linkBright:1.0 },
    Active: { bloomStrength:0.8, exposure:0.75, drift:5,  pulse:0.18, ambientFire:0.06,  rotateSpeed:0.3,  linkBright:1.5 },
    Cinematic: { bloomStrength:1.2, exposure:0.9, drift:1.5, pulse:0.05, ambientFire:0.025, rotateSpeed:0.05, linkBright:1.3 },
    Frantic: { bloomStrength:1.5, exposure:1.1, drift:9, pulse:0.3, ambientFire:0.12, rotateSpeed:0.6, linkBright:2.0 },
};
const fPre = gui.addFolder('Presets');
for (const [name, vals] of Object.entries(presets)) {
    fPre.add({ go: () => { Object.assign(params, vals); gui.controllersRecursive().forEach(ct => ct.updateDisplay()); applyAll(); } }, 'go').name(name);
}

// ── VAULT SYNC folder ────────────────────────────────────────
const fSync = gui.addFolder('Vault Sync');
fSync.add({ rebuild: () => runRebuild(false) }, 'rebuild').name('🔄  rebuild from cache (~2s)');
fSync.add({ rescan:  () => runRebuild(true)  }, 'rescan').name('↻  full re-scan vault (~30s)');

async function runRebuild(fullScan) {
    if (document.getElementById('rb-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'rb-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,5,15,.78);z-index:200;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);pointer-events:auto';
    modal.innerHTML =
      '<div style="background:rgba(5,12,22,.97);border:1px solid rgba(140,200,230,.4);padding:32px 42px;min-width:360px;text-align:center;border-radius:4px;font-family:Courier New,monospace">' +
      '<div style="font-size:14px;letter-spacing:5px;color:#7affc4;text-shadow:0 0 14px rgba(122,255,196,.5)">◆ ' + (fullScan ? 'FULL SYNC' : 'REBUILD') + '</div>' +
      '<div id="rb-stage" style="font-size:10px;margin-top:14px;color:#8ee0ff;letter-spacing:3px">starting…</div>' +
      '<div style="width:280px;height:4px;background:rgba(140,200,230,.15);margin:18px auto;border-radius:2px;overflow:hidden">' +
        '<div id="rb-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#7affc4,#8ee0ff);transition:width .25s"></div>' +
      '</div>' +
      '<div id="rb-pct" style="color:#fff;font-size:18px;letter-spacing:2px">0%</div>' +
      '</div>';
    document.body.appendChild(modal);

    try {
        const r0 = await fetch('/api/rebuild' + (fullScan ? '?scan=true' : ''));
        if (!r0.ok && r0.status !== 202) {
            const j = await r0.json().catch(() => ({}));
            throw new Error(j.error || ('HTTP ' + r0.status));
        }
        const poll = setInterval(async () => {
            try {
                const j = await fetch('/api/rebuild-status').then(r => r.json());
                document.getElementById('rb-stage').textContent = (j.stage || '…').toUpperCase();
                document.getElementById('rb-pct').textContent   = (j.percent || 0) + '%';
                document.getElementById('rb-bar').style.width   = (j.percent || 0) + '%';
                if (j.done) {
                    clearInterval(poll);
                    if (j.error) {
                        document.getElementById('rb-stage').textContent = '⚠ FAILED';
                        document.getElementById('rb-stage').style.color = '#ff7a99';
                        document.getElementById('rb-pct').textContent   = j.error.slice(0, 60);
                        setTimeout(() => modal.remove(), 4500);
                    } else {
                        document.getElementById('rb-stage').textContent = '◆ COMPLETE — reloading';
                        document.getElementById('rb-stage').style.color = '#7affc4';
                        setTimeout(() => location.reload(), 700);
                    }
                }
            } catch(e) {
                clearInterval(poll);
                document.getElementById('rb-stage').textContent = '⚠ ' + e.message;
                setTimeout(() => modal.remove(), 4000);
            }
        }, 600);
    } catch(e) {
        document.getElementById('rb-stage').textContent = '⚠ ' + e.message;
        setTimeout(() => modal.remove(), 4000);
    }
}

// ── reset to defaults ────────────────────────────────────────
gui.add({ reset: () => { params = Object.assign({}, defaults); gui.controllersRecursive().forEach(ct => ct.updateDisplay()); applyAll(); } }, 'reset').name('↺ reset all to defaults');

// ── toggle visibility ────────────────────────────────────────
const guiToggle = document.getElementById('gui-toggle');
guiToggle.addEventListener('click', () => {
    gui.domElement.classList.add('open');
    guiToggle.style.display = 'none';
});
gui.domElement.addEventListener('dblclick', (e) => {
    if (e.target.closest('.title')) {
        gui.domElement.classList.remove('open');
        guiToggle.style.display = 'block';
    }
});
// keyboard shortcut: C
document.addEventListener('keydown', e => {
    if (e.code === 'KeyC' && !e.target.matches('input,textarea')) {
        const open = gui.domElement.classList.toggle('open');
        guiToggle.style.display = open ? 'none' : 'block';
    }
});

applyAll();

// ════════════════════════════════════════════════════════════════════════════
// ANIMATE
// ════════════════════════════════════════════════════════════════════════════
const clock = new THREE.Clock();
let prevT = 0;
function animate() {
    requestAnimationFrame(animate);
    const t  = clock.getElapsedTime();
    const dt = Math.min(t - prevT, 0.05); prevT = t;
    timeU.value = t;
    controls.update();
    updateFirings(t, dt);
    updateArcs(dt);
    updateAmbient();
    updateFPS();
    if (composer) composer.render(); else renderer.render(scene, camera);
}

window.addEventListener('load', () => {
    document.getElementById('loading').style.transition = 'opacity .8s';
    setTimeout(() => {
        document.getElementById('loading').style.opacity = '0';
        setTimeout(() => document.getElementById('loading').remove(), 800);
    }, 600);
    animate();
    // no auto-storm on load — calm by default; press F or button to ignite
});
</script>
</body>
</html>`;

fs.writeFileSync(OUT, HTML);
console.log(`✅  ${OUT}\n`);
