#!/usr/bin/env node
/**
 * iCloud Photos → Claude Vision → enriched TASTE notes
 *
 * Reads photo file paths from Stella's sensorium endpoint, converts each
 * HEIC to JPEG via `sips`, sends to Anthropic vision API, writes the
 * resulting analysis as a TASTE/Photos/Photo-….md note.
 *
 *   node importers/icloud-vision.js --limit 12
 *   node importers/icloud-vision.js --skip-existing
 *
 * Cost: ~$0.002–0.005 per photo with claude-haiku-4-5 vision.
 */
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');
const { writeTasteNote, isoToHumanDate, TASTE_ROOT } = require('./_common');

const STELLA_URL = process.env.STELLA_URL || 'http://100.69.150.90:8790';
let STELLA_TOKEN = process.env.STELLA_MEMORY_TOKEN || '';
let ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
for (const f of [
    path.join(os.homedir(), 'Repo/Stella-Agent/.env.local'),
    path.join(os.homedir(), '.local/share/citadel-research-desk/.env'),
]) {
    try {
        const txt = fs.readFileSync(f, 'utf8');
        if (!STELLA_TOKEN) { const m = txt.match(/^STELLA_MEMORY_TOKEN\s*=\s*(.+)$/m); if (m) STELLA_TOKEN = m[1].trim().replace(/^["']|["']$/g,''); }
        if (!ANTHROPIC_KEY) { const m = txt.match(/^ANTHROPIC_API_KEY\s*=\s*(.+)$/m); if (m) ANTHROPIC_KEY = m[1].trim().replace(/^["']|["']$/g,''); }
    } catch (e) {}
}
if (!STELLA_TOKEN)  { console.error('❌ STELLA_MEMORY_TOKEN missing'); process.exit(1); }
if (!ANTHROPIC_KEY) { console.error('❌ ANTHROPIC_API_KEY missing'); process.exit(1); }

const args = process.argv.slice(2);
const limit = (() => {
    const i = args.indexOf('--limit');
    return i >= 0 ? parseInt(args[i+1], 10) || 12 : 12;
})();
const MODEL = process.env.VISION_MODEL || 'claude-haiku-4-5';

const tmpDir = path.join(os.tmpdir(), 'cortex-vision');
fs.mkdirSync(tmpDir, { recursive: true });

async function stellaGet(url) {
    const r = await fetch(STELLA_URL + url, { headers: { 'x-stella-memory-token': STELLA_TOKEN } });
    if (!r.ok) throw new Error('Stella HTTP ' + r.status);
    return await r.json();
}

function heicToJpegBase64(srcPath) {
    const tmp = path.join(tmpDir, 'frame_' + Date.now() + '_' + Math.random().toString(36).slice(2,8) + '.jpg');
    try {
        // sips: convert + cap size to keep API call cheap
        execSync(`sips -s format jpeg -Z 1280 "${srcPath}" --out "${tmp}"`, { stdio: 'pipe' });
        const buf = fs.readFileSync(tmp);
        const b64 = buf.toString('base64');
        try { fs.unlinkSync(tmp); } catch {}
        return b64;
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch {}
        throw new Error('sips failed: ' + e.message.slice(0, 160));
    }
}

async function analyseImage(b64) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            model: MODEL,
            max_tokens: 320,
            system: 'You are analysing a personal photo. Be concise, sensory, and human. Output ONLY valid JSON with no prose around it.',
            messages: [{
                role: 'user',
                content: [
                    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
                    { type: 'text', text:
                      'Describe this photo in 1–2 sentences capturing mood, subject and palette. Then propose 3–6 single-word lowercase tags reflecting aesthetic / subject / setting. Return JSON only:\n' +
                      '{"caption": "...", "tags": ["...","..."]}'
                    },
                ],
            }],
        }),
    });
    if (!r.ok) throw new Error('Anthropic ' + r.status + ': ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    const text = (j.content?.[0]?.text || '').match(/\{[\s\S]*\}/);
    if (!text) throw new Error('no json in response');
    const parsed = JSON.parse(text[0]);
    return { ...parsed, usage: j.usage };
}

(async () => {
    console.log('\n👁  iCloud Vision → TASTE');
    console.log('   model: ' + MODEL + ' · limit ' + limit);

    // gather photos from Stella
    const photos = [];
    let offset = 0;
    while (photos.length < limit) {
        const want = Math.min(100, limit - photos.length);
        const data = await stellaGet(`/sensorium/phone/photos?limit=${want}&offset=${offset}`);
        const batch = data.photos || [];
        if (!batch.length) break;
        photos.push(...batch);
        if (batch.length < want) break;
        offset += batch.length;
    }
    console.log(`   ${photos.length} photos to consider\n`);

    let analysed = 0, skipped = 0, errored = 0, totIn = 0, totOut = 0;

    for (let i = 0; i < photos.length; i++) {
        const p = photos[i];
        const iso = p.captured_at || new Date().toISOString();
        const human = isoToHumanDate(iso);
        const refId = (p.source_ref || p.file_name || iso).replace(/[^a-z0-9-]+/gi, '-').slice(-32);
        const titleStem = `Photo- ${human.replace(/[:]/g, '-')} ${refId}`;
        const finalPath = path.join(TASTE_ROOT, 'Photos', titleStem.replace(/[<>:"/\\|?*]/g, '') + '.md');

        // skip if already analysed (has 'caption:' in frontmatter)
        if (fs.existsSync(finalPath)) {
            try {
                const txt = fs.readFileSync(finalPath, 'utf8');
                if (txt.includes('caption:')) { skipped++; continue; }
                // delete metadata-only version so vision-enriched note replaces it
                fs.unlinkSync(finalPath);
            } catch {}
        }
        if (!p.path || !fs.existsSync(p.path)) { errored++; continue; }

        process.stdout.write(`  [${i+1}/${photos.length}] ${path.basename(p.path)} … `);
        try {
            const b64 = heicToJpegBase64(p.path);
            const r = await analyseImage(b64);
            totIn  += r.usage?.input_tokens  || 0;
            totOut += r.usage?.output_tokens || 0;

            const loc = p.location;
            const body =
                `# Photo: ${human}\n\n` +
                `**${r.caption}**\n\n` +
                (r.tags?.length ? r.tags.map(t => '#'+t).join(' ') + '\n\n' : '') +
                (loc && loc.latitude != null ? `📍 ${loc.latitude}, ${loc.longitude}\n\n` : '') +
                `Captured ${human} · \`${p.file_name || ''}\`\n\n` +
                `Local file: \`${p.path}\`\n`;

            writeTasteNote('Photos', titleStem, {
                type: 'taste-photo',
                source: 'icloud-vision',
                source_ref: p.source_ref || '',
                captured_at: iso,
                file_path: p.path || '',
                file_name: p.file_name || '',
                caption: r.caption,
                tags: r.tags || [],
                latitude:  loc && loc.latitude  != null ? loc.latitude  : null,
                longitude: loc && loc.longitude != null ? loc.longitude : null,
            }, body);
            analysed++;
            console.log('✓ ' + r.caption.slice(0, 60));
        } catch (e) {
            errored++;
            console.log('⚠ ' + e.message.slice(0, 80));
        }
    }

    const inDollars  = totIn  / 1_000_000 * (MODEL.includes('haiku') ? 1.0  : MODEL.includes('sonnet') ? 3.0  : 15.0);
    const outDollars = totOut / 1_000_000 * (MODEL.includes('haiku') ? 5.0  : MODEL.includes('sonnet') ? 15.0 : 75.0);
    const cost = inDollars + outDollars;

    console.log(`\n✅ ${analysed} analysed · ${skipped} skipped · ${errored} errored`);
    console.log(`   tokens: ${totIn}/${totOut}  ·  est cost: $${cost.toFixed(4)}\n`);
})();
