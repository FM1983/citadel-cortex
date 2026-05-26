#!/usr/bin/env node
/**
 * Google Takeout Location History → TASTE/Places
 *
 *   node importers/google-takeout.js <path>
 *
 * <path> can be:
 *  • Records.json                  — flat GPS pings (huge; aggregated to days)
 *  • Semantic Location History/    — folder of YYYY_MONTH.json files (preferred)
 *  • takeout-*.zip                 — auto-extracts and finds the above
 *
 * Get yours at https://takeout.google.com  → Location History  → JSON.
 */
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');
const { writeTasteNote, isoToHumanDate } = require('./_common');

const arg = process.argv[2];
if (!arg) { console.error('Usage: node importers/google-takeout.js <path>'); process.exit(1); }

let root = arg;
if (arg.endsWith('.zip')) {
    const tmp = path.join(os.tmpdir(), 'gt-' + Date.now());
    fs.mkdirSync(tmp, { recursive: true });
    console.log('· unzipping → ' + tmp);
    execSync(`unzip -q -o "${arg}" -d "${tmp}"`);
    root = tmp;
}

function walk(d, ext, into) {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, ext, into);
        else if (e.name.toLowerCase().endsWith(ext)) into.push(p);
    }
}

let created = 0, skipped = 0;

function ingestPlaceVisit(v) {
    const loc = v.location || {};
    const dur = v.duration  || {};
    if (loc.latitudeE7 == null && !loc.latitude) return;
    const lat = loc.latitude  != null ? loc.latitude  : loc.latitudeE7  / 1e7;
    const lng = loc.longitude != null ? loc.longitude : loc.longitudeE7 / 1e7;
    const startIso = dur.startTimestamp || dur.startTimestampMs && new Date(+dur.startTimestampMs).toISOString();
    const endIso   = dur.endTimestamp   || dur.endTimestampMs   && new Date(+dur.endTimestampMs  ).toISOString();
    if (!startIso) return;
    const startMs = new Date(startIso).getTime();
    const endMs   = endIso ? new Date(endIso).getTime() : startMs;
    const durMin  = Math.round((endMs - startMs) / 60000);
    const name = loc.name || loc.address || 'place';
    const human = isoToHumanDate(startIso);
    const titleStem = `Visited- ${human.replace(/[:]/g,'-')} ${name}`;

    const body =
        `# Visited: ${name}\n\n` +
        `${human} · ${durMin} min\n\n` +
        (loc.address ? `${loc.address}\n\n` : '') +
        `📍 ${lat.toFixed(6)}, ${lng.toFixed(6)}\n\n` +
        `[Open in Maps](https://maps.google.com/?q=${lat},${lng})\n`;

    const ok = writeTasteNote('Places', titleStem, {
        type: 'taste-place',
        source: 'google-takeout',
        place_id: loc.placeId || '',
        name,
        address: loc.address || '',
        latitude: +lat.toFixed(6),
        longitude: +lng.toFixed(6),
        visited_at: startIso,
        duration_minutes: durMin,
    }, body);
    ok ? created++ : skipped++;
}

console.log('\n🌏 Google Takeout → TASTE/Places');

// prefer Semantic Location History
const semanticFiles = [];
walk(root, '.json', semanticFiles);
const monthly = semanticFiles.filter(f => /Semantic Location History.+\d{4}_[a-z]+\.json/i.test(f));

if (monthly.length) {
    console.log('· semantic location history: ' + monthly.length + ' monthly files');
    for (const f of monthly) {
        let data; try { data = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
        const objs = data.timelineObjects || [];
        for (const o of objs) {
            if (o.placeVisit) ingestPlaceVisit(o.placeVisit);
        }
    }
} else {
    // fallback to Records.json — aggregate to top 100 places by visit count
    const rec = semanticFiles.find(f => /Records\.json$/i.test(f));
    if (!rec) { console.error('❌ no Semantic Location History or Records.json found'); process.exit(1); }
    console.log('· using Records.json (will aggregate into ~places)');
    const data = JSON.parse(fs.readFileSync(rec, 'utf8'));
    const locs = data.locations || [];
    console.log('   ' + locs.length + ' GPS pings — aggregating');
    // bucket to 0.001 degree (~111m) and count visits
    const bucket = new Map();
    for (const l of locs) {
        if (l.latitudeE7 == null) continue;
        const lat = (l.latitudeE7 / 1e7).toFixed(3);
        const lng = (l.longitudeE7 / 1e7).toFixed(3);
        const k = lat + ',' + lng;
        if (!bucket.has(k)) bucket.set(k, { lat: +lat, lng: +lng, count: 0, first: l.timestamp || l.timestampMs });
        bucket.get(k).count++;
    }
    const top = [...bucket.values()].sort((a,b)=>b.count-a.count).slice(0, 150);
    for (const b of top) {
        const iso = typeof b.first === 'string' ? b.first : new Date(+b.first).toISOString();
        const human = isoToHumanDate(iso);
        const titleStem = `Place- ${b.lat.toFixed(3)} ${b.lng.toFixed(3)} (${b.count}x)`;
        const body =
            `# Place: ${b.lat.toFixed(4)}, ${b.lng.toFixed(4)}\n\n` +
            `${b.count} pings · first seen ${human}\n\n` +
            `[Open in Maps](https://maps.google.com/?q=${b.lat},${b.lng})\n`;
        const ok = writeTasteNote('Places', titleStem, {
            type: 'taste-place',
            source: 'google-takeout-records',
            latitude: b.lat,
            longitude: b.lng,
            ping_count: b.count,
            first_seen: iso,
        }, body);
        ok ? created++ : skipped++;
    }
}

console.log(`\n✅ created ${created} · skipped ${skipped}\n`);
