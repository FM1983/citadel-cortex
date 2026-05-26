# ◆ Citadel Cortex

3D neural-network visualisation of an Obsidian vault. Notes are neurons clustered into themed **cortexes**, wiki-links are **synapses**, and the whole structure pulses, drifts, and fires lightning between connected nodes.

Built with **Three.js**, **UnrealBloom**, custom GLSL shaders, **lil-gui** controls, served over a tiny Node HTTP server.

![cortex screenshot placeholder](docs/cortex.png)

---

## What it does

1. **Scans** your vault — finds every `.md`, extracts wiki-links and frontmatter.
2. **Categorises** each note into one of seven buckets:
   `PROJECTS · LITIGATION · CONTACTS · DESIGN · ADMINISTRATION · ARCHIVES · MISC`
   (rules in [`categorize-vault.js`](./categorize-vault.js) — adapt to your folder structure).
3. **Builds** a 3D brain:
   - Each cortex is a galactic lobe in 3D space.
   - Hubs (high-degree notes) sit near each lobe's centre; leaves drift on the periphery.
   - Wiki-links form the semantic backbone; k-NN densification creates cortical micro-columns; long-range tracts bridge cortexes.
   - Pre-tessellated **jagged lightning synapses** flow with animated bright sparks.
   - Per-neuron 4D drift baked into the vertex shader keeps everything dancing.
4. **Fires** — click a neuron and activation cascades through connected synapses, spawning fractal lightning arcs.
5. **Rationalises Obsidian's own graph view** — installs colour groups matching the cortex palette and tunes forces so Obsidian's built-in graph dances too.

---

## Install

```bash
git clone https://github.com/FM1983/citadel-cortex.git
cd citadel-cortex
```

No npm install needed — pure Node.js + browser CDNs.

---

## Configure

Edit [`config.js`](./config.js) or set the env var:

```bash
export CITADEL_VAULT="/path/to/your/Obsidian/Vault"
```

---

## Use

```bash
npm run pipeline   # scan → categorise → build
npm run serve      # serves on http://localhost:8080
# or all in one:
npm run all
```

Open <http://localhost:8080>.

### Optional — rationalise Obsidian's graph view too
```bash
npm run obsidian
```
Installs colour groups and tunes forces in `.obsidian/graph.json` (backs up the original to `graph.json.bak`).

---

## Control surface

In-browser controls (top-right ⚙ button or press `C`):

| Folder | Slider / Toggle |
|---|---|
| **Atmosphere** | bloom strength · radius · threshold · exposure |
| **Motion** | autorotate · rotate speed · node drift · pulse |
| **Neurons & Synapses** | neuron size · halo size · synapse glow · show/hide |
| **Firing** | ambient rate · cascade chance · arc opacity · manual fire / storm / chain |
| **Layers** | cortex labels · cortex dust · star field · void dust |
| **Cortex Filter** | per-bucket show/hide · show-all · hide-all |
| **Camera** | reset · top-down · side · front · pull-back |
| **Presets** | Calm · Default · Active · Cinematic · Frantic |

Settings persist via `localStorage`.

### Keyboard
- `C` — toggle control panel
- `F` — fire storm
- `Space` — reset camera
- `Esc` — clear isolation/search
- Click neuron — focus + fire it

---

## Pipeline

```
.md files  ─►  scan-vault.js   ─►  vault-cache.json
                    │
                    ▼
              categorize-vault.js  ─►  vault-categorized.json
                    │
                    ▼
              build-brain.js  ─►  neural-graph.html  ─►  server.js
```

Stage timings on a ~2,700-note vault on a Dropbox share:
- scan: 30–180s (file I/O bound)
- categorise: <1s
- build: <2s

Tweak visuals in `build-brain.js` → re-run `npm run build` → refresh tab. The cache stays valid until you add/remove notes.

---

## Adapt to your vault

Two files to edit for your own use:

### 1. `categorize-vault.js`
Replace the path/keyword rules with whatever buckets make sense for you. Each record has `relPath`, `id`, `wordCount`, `aliases`, `links` available.

### 2. `build-brain.js`
Adjust the `LOBES` object — each cortex needs `center` (3D coord), `radius`, and `color`.

---

## Tech

- **Three.js r128** with `EffectComposer` + `UnrealBloomPass`
- Custom GLSL vertex + fragment shaders for the plasma node material and animated synapse flow
- `three-spritetext` for 3D cortex labels
- `lil-gui` for the control surface
- ACESFilmic tone mapping for cinematic falloff
- Procedural Canvas-generated glow textures (cubic falloff)
- Fractal recursive midpoint-displacement for lightning arcs

---

## Licence

MIT — see [LICENSE](./LICENSE).
