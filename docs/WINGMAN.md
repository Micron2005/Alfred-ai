# Wingman Voice Commands — How to use

## URL/YouTube/Search (works immediately)

These now open URLs **directly in your browser** — no Docker config needed.

- "Alfred, play Iron Man Mark 50 reveal on YouTube"
- "Alfred, look up tariff schedule"
- "Alfred, google quantum computing"
- "Alfred, search for sourdough recipe"

⚠ Your browser may block the new tab as a popup the first time. Click "Allow popups for this site" when it asks.

## Cut Alfred off mid-sentence

Three ways:

1. **Voice** — say any of these while he's talking:
   - "Alfred, stop"
   - "Stop"
   - "Stop talking"
   - "Shut up"
   - "Be quiet"
   - "Cut it" / "Cut it out"
   - "Enough" / "That's enough"
   - "Knock it off"
   - "Cancel"
   - "Hush" / "Quiet"
   - "Wait"
   - "Hold on"
   - "Pause"

   You can also re-trigger the wake word — saying "Hey Alfred" mid-sentence
   slams the TTS pipeline shut immediately and starts a fresh recording.

2. **Click the red ⏹ STOP TALKING button** that appears at the top of the screen the moment he starts speaking.

3. **Click your mic** — starting a new recording auto-cancels the in-flight reply.

The cancel command is intercepted BEFORE it hits the LLM, so response is sub-300ms — Alfred goes silent the instant you say "stop".

## File browsing — REQUIRES one-time Docker setup

If "Alfred, what's in my downloads" gets `Couldn't read that folder`, you missed one of these steps. Do them in order.

**Tip:** the latest build ships a `/api/desktop/diagnostics` endpoint that tells you EXACTLY which step you're missing. Open <http://localhost:8000/api/desktop/diagnostics> in your browser — the `fix_hint` field tells you what to do next.

### Step 1 — Edit `~/Alfred-ai/.env`

Find the line that starts with `ALFRED_ALLOWED_DIRS` (or add it if missing). Set it to the **in-container** paths:

```
ALFRED_ALLOWED_DIRS="/host/Documents,/host/Downloads"
```

### Step 2 — Edit `~/Alfred-ai/docker-compose.yml`

Find the `alfred-core` service's `volumes:` block. It should currently look like:

```yaml
    volumes:
      - ${ALFRED_MEMORY_HOST_PATH:-./alfred-memory}:/app/alfred-memory
      - .:/app/repo
```

Add these two lines (read-only mounts of your host folders):

```yaml
      - ${HOME}/Documents:/host/Documents:ro
      - ${HOME}/Downloads:/host/Downloads:ro
```

`:ro` makes them read-only — Alfred can read but never modify your files.

### Step 3 — Full rebuild

```bash
docker compose down
docker compose up --build -d
```

### Step 4 — Verify

```bash
docker compose exec -T alfred-core ls /host/Documents | head -5
docker compose exec -T alfred-core sh -c 'echo $ALFRED_ALLOWED_DIRS'
```

The first command should list real files in your Documents folder. The second should print exactly `/host/Documents,/host/Downloads`.

If both work, in the browser say:
- "Alfred, what's in my documents folder?" → he lists files
- "Alfred, list my downloads" → same for Downloads

### Adding more folders later

Add to `volumes:` in docker-compose.yml AND add the in-container path to `ALFRED_ALLOWED_DIRS`. Both are required. Then `docker compose up --build -d`.

## Earth voice control

- "Alfred, show me Tokyo"
- "Alfred, fly me to Paris"
- "Alfred, pull up the earth"
- "Alfred, close the earth"
- "Alfred, hide the earth"

## "Where am I" — GPS pin on the holographic earth

Ask any of these and Alfred uses your browser's Geolocation API to fly the
holographic earth to where you actually are. The first time you ask, the
browser will prompt for location permission — click "Allow".

- "Alfred, pull up my location"
- "Alfred, where am I"
- "Where am I, Alfred"
- "Alfred, show me my location"
- "Alfred, show me on the map"
- "Alfred, fly to my location"
- "Alfred, locate me"
- "Alfred, where is my phone"

The acknowledgement reads back the nearest city (best-effort reverse-geocode
via Nominatim) and the GPS accuracy in meters — e.g. "You're at Brooklyn, NY,
sir (±12 m)."

## Turn-by-turn routing — "Alfred, route me to X"

Powered by **Stadia Maps' hosted Valhalla** (free tier — 2,500 requests/day),
proxied through `alfred-core` so the browser never talks to Stadia directly.
This sidesteps Stadia's origin whitelist (which rejects `localhost`) and
keeps your API key out of the JS bundle. To enable:

1. Sign up at <https://client.stadiamaps.com/signup>
2. Dashboard → Properties → New Property → name "Alfred AI"
3. Copy the API key into your `.env` as `STADIA_API_KEY=<your-key>`
4. `docker compose restart alfred-core` (no rebuild needed — alfred-core
   reloads env on restart)

No domain/origin whitelisting needed — the request originates from the
backend container, not the browser. Phones over Tailscale, the future GPU
rig, any device on the LAN — all "just work" without per-device config.

**Voice triggers:**

- "Alfred, route me to JFK Airport"
- "Alfred, directions to Times Square"
- "Alfred, navigate to the nearest Whole Foods"
- "Alfred, take me to Boston"
- "Alfred, plot a course to Atlantic City"
- "Alfred, chart a course to Tokyo"
- "Alfred, set a course to LaGuardia"
- "Alfred, how do I get to Penn Station"
- "Alfred, show me a route to the airport"
- "Alfred, give me directions to the gym"
- "Alfred, walk me to the gym" → walking route
- "Alfred, bike me to the park" → cycling route
- "Alfred, route me to Boston by bike" → cycling route
- "Alfred, route me to the park walking" → walking route
- "Alfred, navigate to my office on my motorcycle"

**What happens:**

1. Earth opens immediately, Alfred says "Plotting a course to X, sir…"
2. Browser asks for GPS permission (first time only — click Allow)
3. Geocodes the destination via Nominatim
4. Calls Valhalla `/route` with origin + destination + costing
5. Decodes the polyline6 geometry and draws a cyan glowing line on the 3D earth
6. Fits the camera to the route bounds with 55° pitch tilt (JARVIS fly-over)
7. Alfred reads back "Course plotted to X, sir. 23 minutes driving, 12.4 mi."
8. Route label appears as a HUD chip top-right ("ROUTE · 23 MIN · 12.4 MI")

## "What can I reach in N minutes" — isochrone overlay

- "Alfred, what can I reach in 15 minutes"
- "Alfred, where can I get to in 10 minutes walking"
- "Alfred, show me everywhere within 20 minutes drive"
- "Alfred, show me every place reachable in 30 minutes"
- "Alfred, isochrone 25 minutes biking"
- "Alfred, where can we travel to in 45 minutes"

Renders a translucent cyan polygon on the 3D earth marking everywhere
reachable from your GPS location inside that time budget. Mode defaults
to driving; say "walking" / "cycling" / "biking" to switch.

## Clearing the map overlay

- "Alfred, clear the route"
- "Alfred, wipe the route"
- "Alfred, hide the path"
- "Alfred, dismiss the course"
- "Alfred, clear the isochrone"

## Swapping to a self-hosted Valhalla (later, when the new GPU rig lands)

When you eventually want offline routing with no rate limit, run the
[`gisops/valhalla`](https://hub.docker.com/r/gisops/valhalla) Docker image
alongside Alfred (it needs ~25 GB disk for North America, ~120 GB for the
planet). Then set `VALHALLA_BASE_URL=http://valhalla:8002` in `.env`, leave
`STADIA_API_KEY` blank, and `docker compose restart alfred-core`. **No
code change needed** — the proxy auto-detects self-host mode and stops
adding the Stadia API key.

## Continuous conversation

After Alfred replies, the mic auto-reopens. End the session with:
- "Thanks Alfred"
- "That's it for now"
- "Stand down"
- "Bye"

End with the green ENGAGED pip going dark.
