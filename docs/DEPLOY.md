# Deployment

Three ways to access Citadel Cortex from anywhere.

---

## 1. Local-only (default)

```bash
npm run all
open http://localhost:8080
```

---

## 2. Tailscale (private, your devices only)

Best for: viewing on your phone/iPad/other laptop without exposing publicly.

### Prereqs
- [Tailscale](https://tailscale.com/) installed and logged in on both this Mac and your other devices.
- The Mac running the server is reachable on your tailnet.

### Option A — direct port
```bash
# server already running on :8080
tailscale ip -4                 # find this Mac's tailnet IP, e.g. 100.x.y.z
# then on any other tailnet device:
open http://100.x.y.z:8080
```

### Option B — `tailscale serve` (HTTPS, prettier URL)
```bash
# expose port 8080 as https on tailnet
tailscale serve --bg https / http://localhost:8080
tailscale serve status          # confirm
# accessible at https://<your-machine-name>.<tailnet>.ts.net
```

To stop:
```bash
tailscale serve reset
```

### Public (the whole internet)
```bash
tailscale funnel --bg 8080
# now https://<machine>.<tailnet>.ts.net hits your laptop from anywhere
```
**Strongly recommended: turn on Basic Auth first** (see §4).

---

## 3. Replit (cloud-hosted, password-protected)

Best for: 24/7 availability without leaving your laptop on.

### One-time setup
1. Push this repo to GitHub (already done if you `git push`ed).
2. Go to <https://replit.com/new> → "Import from GitHub" → paste the repo URL.
3. Replit reads `.replit` and `replit.nix` and spins up Node 20.
4. In the Replit **Secrets** pane (🔒 sidebar), add:
   - `AUTH_USER` — your username (e.g. `farhad`)
   - `AUTH_PASS` — a strong password
   - `CITADEL_VAULT` — leave **unset** (Replit can't see your local vault)
5. Click **Run**.

> ⚠ Note: Replit can't reach your local Obsidian vault. The 3D visualization works (the HTML is self-contained with all node positions/categories embedded), but `/api/note` and `/api/finder` will return 404 because the source files aren't on Replit's filesystem.
>
> **To make the notes load on Replit**, upload your vault to Replit as part of the project (or sync via git from another repo). For most users, **Tailscale Funnel is the better path** — it gives you the same remote access while keeping files on your machine.

### Permanent URL
After running once, click **Deploy** in Replit → "Reserved VM" or "Autoscale" → done. You get a `<project>.<user>.repl.co` URL with auth baked in.

---

## 4. Basic-auth (works everywhere)

Just set these before starting the server:

```bash
export AUTH_USER="farhad"
export AUTH_PASS="long-strong-password"
node server.js
```

Or use a tiny launch script:

```bash
# ~/run-cortex.sh
#!/bin/bash
cd "/path/to/repo"
AUTH_USER="farhad" AUTH_PASS="long-strong-pass" node server.js
```

Anyone hitting the URL gets a native browser HTTP-auth prompt.

---

## Architecture notes

- `server.js` is a 100-line stdlib-only Node HTTP server. No Express, no deps.
- Static files: served from the project directory (`neural-graph.html`).
- API:
  - `GET /api/manifest` — vault metadata
  - `GET /api/note?path=…` — reads a vault note (with traversal guard)
  - `GET /api/finder?path=…` — `open -R …` (macOS only)
  - `GET /api/obsidian?path=…` — 302 redirect to `obsidian://open?vault=…&file=…`
- Auth: if `AUTH_USER` + `AUTH_PASS` env vars are set, HTTP Basic Auth is enforced on every request including API.

---

## Recommended setup (Farhad)

For "I want this everywhere, password-protected":

```bash
# 1. Run the server on the Mac
cd ~/Workspace/citadel-cortex
AUTH_USER="farhad" AUTH_PASS="something-long" node server.js

# 2. Funnel it publicly via Tailscale
tailscale funnel --bg 8080
```

You now have `https://<machine>.<tailnet>.ts.net` accessible from any device — phone, iPad, friend's laptop — password-gated, but still reading your local vault.

Switch to `tailscale serve` (tailnet only, no funnel) if you don't want it on the public internet.
