#!/usr/bin/env node
/**
 * Stella Sensorium → TASTE importer
 * Pulls photos + latest location from Stella's /sensorium endpoints and writes
 * one markdown note per item under Citadel-Main/TASTE/.
 *
 *   node importers/stella-sensorium.js              # both photos + location
 *   node importers/stella-sensorium.js --photos     # photos only
 *   node importers/stella-sensorium.js --location   # location only
 *   node importers/stella-sensorium.js --limit 100  # cap photo count
 */
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { writeTasteNote, isoToHumanDate } = require('./_common');

const STELLA_URL = process.env.STELLA_URL || 'http://100.69.150.90:8790';
let TOKEN = process.env.STELLA_MEMORY_TOKEN || '';
if (!TOKEN) {
    for (const f of [
        path.join(os.homedir(), 'Repo/Stella-Agent/.env.local'),
        path.join(os.homedir(), '.local/share/citadel-research-desk/.env'),
    ]) {
        try {
            const m = fs.readFileSync(f, 'utf8').match(/^STELLA_MEMORY_TOKEN\s*=\s*(.+)$/m);
            if (m) { TOKEN = m[1].trim().replace(/^["']|["']$/g, ''); break; }
        } catch (e) {}
    }
}
if (!TOKEN) { console.error('❌ STELLA_MEMORY_TOKEN not found'); process.exit(1); }

const args = process.argv.slice(2);
const wantPhotos   = !args.includes('--location');
const wantLocation = !args.includes('--photos');
const limit = (() => {
    const i = args.indexOf('--limit');
    return i >= 0 ? parseInt(args[i+1], 10) || 2000 : 2000;
})();
const PER_PAGE = 100;   // Stella caps at 100

async function get(url) {
    const r = await fetch(url, { headers: { 'x-stella-memory-token': TOKEN } });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    return await r.json();
}

(async () => {
    console.log('\n📸 Stella Sensorium → TASTE');
    console.log('   ' + STELLA_URL);

    let created = 0, skipped = 0;

    // ── PHOTOS ──────────────────────────────────────────────────────
    if (wantPhotos) {
        console.log('\n· Photos…');
        try {
            const photos = [];
            let offset = 0;
            while (photos.length < limit) {
                const want = Math.min(PER_PAGE, limit - photos.length);
                const data = await get(`${STELLA_URL}/sensorium/phone/photos?limit=${want}&offset=${offset}`);
                const batch = data.photos || [];
                if (!batch.length) break;
                photos.push(...batch);
                if (batch.length < want) break;
                offset += batch.length;
            }
            console.log(`   ${photos.length} photos returned`);

            for (const p of photos) {
                const iso = p.captured_at || p.imported_at || new Date().toISOString();
                const human = isoToHumanDate(iso);
                const refId = (p.source_ref || p.file_name || iso).replace(/[^a-z0-9-]+/gi, '-').slice(-32);
                const titleStem = `Photo- ${human.replace(/[:]/g, '-')} ${refId}`;
                const loc = p.location;
                const locStr = (loc && loc.latitude != null)
                    ? `${loc.latitude}, ${loc.longitude}` : null;

                const body = `# Photo: ${human}\n\n` +
                    (locStr ? `📍 ${locStr}\n\n` : '') +
                    `Captured ${human} · ${p.media_kind || 'image'} · ${p.file_name || ''}\n\n` +
                    (p.path ? `Local file: \`${p.path}\`\n\n` : '') +
                    (locStr ? `[Open in Maps](https://maps.google.com/?q=${loc.latitude},${loc.longitude})\n` : '');

                const ok = writeTasteNote('Photos', titleStem, {
                    type: 'taste-photo',
                    source: 'stella-sensorium',
                    source_ref: p.source_ref || '',
                    captured_at: iso,
                    file_path: p.path || '',
                    file_name: p.file_name || '',
                    media_kind: p.media_kind || 'image',
                    latitude:  loc && loc.latitude  != null ? loc.latitude  : null,
                    longitude: loc && loc.longitude != null ? loc.longitude : null,
                }, body);
                ok ? created++ : skipped++;
            }
        } catch (e) {
            console.error('   ⚠ photos: ' + e.message);
        }
    }

    // ── LOCATION (latest) ────────────────────────────────────────────
    if (wantLocation) {
        console.log('\n· Location…');
        try {
            const data = await get(`${STELLA_URL}/sensorium/phone/location/latest`);
            const l = data.location;
            if (l && l.latitude != null) {
                const iso = l.captured_at || new Date().toISOString();
                const human = isoToHumanDate(iso);
                const titleStem = `Location- ${human.replace(/[:]/g, '-')}`;
                const body = `# Location: ${human}\n\n` +
                    `📍 ${l.latitude}, ${l.longitude}\n\n` +
                    `Accuracy ${l.horizontal_accuracy_m || '?'} m · via ${l.provider || 'unknown'}\n\n` +
                    `[Open in Maps](https://maps.google.com/?q=${l.latitude},${l.longitude})\n`;
                const ok = writeTasteNote('Places', titleStem, {
                    type: 'taste-location',
                    source: 'stella-sensorium',
                    captured_at: iso,
                    latitude:  l.latitude,
                    longitude: l.longitude,
                    accuracy_m: l.horizontal_accuracy_m || null,
                    provider:  l.provider || '',
                }, body);
                ok ? created++ : skipped++;
                console.log('   ✓ ' + human + ' (' + l.latitude + ', ' + l.longitude + ')');
            }
        } catch (e) {
            console.error('   ⚠ location: ' + e.message);
        }
    }

    console.log(`\n✅ created ${created} · skipped ${skipped} (already imported)\n`);
})();
