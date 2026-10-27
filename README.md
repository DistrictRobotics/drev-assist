# DREV Assist

Roadside + home-energy request intake for the Charlotte, NC area: a customer
app (`index.html`), a manager dashboard (`manager.html`), and Cloudflare
Pages Functions backed by D1. Vanilla JavaScript, no build step.

## Run locally

```sh
cp .dev.vars.example .dev.vars   # fill in MAPBOX_TOKEN + a 16+ char ADMIN_KEY
npx wrangler d1 execute drev-assist-db --local --file=schema.sql
npm run dev                      # wrangler pages dev on :8788
npm test                         # node --test suite (also: npm run check)
```

Open `/` for the customer app and `/manager.html` for the dashboard
(sign in with `ADMIN_KEY`). The map needs a real `MAPBOX_TOKEN`; everything
else works without one.

For an existing database, apply migrations in order instead of `schema.sql`:

```sh
npx wrangler d1 migrations apply drev-assist-db
```

## How a request flows

1. The customer picks a service, drags the map pin, **confirms the pin
   location**, adds name/phone (required for roadside) and reviews a frozen
   snapshot of exactly what will be sent.
2. `POST /api/assist/requests` validates, rate-limits (10 / 10 min / IP),
   and stores the request in D1 — **only then** does the customer see the
   green "submitted" state, with the server-issued UUID. Any failure shows a
   visually distinct **REQUEST NOT SENT** state with a local-only reference;
   the app never fabricates success. Retries reuse an `Idempotency-Key`, so a
   flaky connection cannot create duplicates.
3. Customers track or cancel (while `submitted`/`reviewed`) at
   `GET|POST /api/assist/status/:id`.
4. Managers work the queue in `/manager.html`: search, filter, expand a
   request, set provider/scheduled window, and advance status. The server
   enforces the state machine everywhere:

   `submitted → reviewed → dispatched → complete`, with `cancelled`
   reachable from any non-terminal state. Every change writes an audit row
   to `assist_request_events`.

## Realtime 3D / 4D layer

Both apps share a realtime core (`js/live-data.js`); the API mirrors it
server-side (`functions/api/assist/_live-sim.js`, `/api/assist/live`).

- **Manager dispatch map (3D):** terrain + sky, 3D buildings, real request
  pins colored by status, provider units moving along routes, click
  popups, layer toggles, and a cinematic Fly Over. Providers are a
  **simulated feed** (labelled in the legend, meta line, and popups) until
  a real GPS source is connected — the rendering consumes the same shape
  a real feed would produce.
- **4D replay:** switch LIVE → REPLAY 24H and scrub the time slider (or
  press play). A demand heatmap shows the trailing 90 minutes — computed
  from real request history once there are ≥5 located requests, seeded
  demo data before that (labelled in the meta line either way).
- **Customer live tracking:** when a tracked request is `dispatched`, the
  status API includes a `providerFeed` whose position is a deterministic
  function of the dispatch timestamp. The customer app renders a 3D
  follow-cam: animated route, moving provider marker, distance/heading
  HUD, progress bar — with a SIMULATED LIVE FEED badge, and it ends itself
  if the request status changes.
- **Outages (demo):** extruded outage zones for the home-energy view,
  labelled demo in data and legend.
- **Privacy:** `/api/assist/live` gives public callers only status counts
  and demand points rounded to ~100 m — no ids, labels, or fleet. The full
  picture requires the admin key or a verified dispatcher JWT.

To go truly live later: replace `providersSnapshot` /
`providerPositionFor` with GPS telemetry (same response shapes), swap the
client's bowed-line routes for Mapbox Directions, and — if sub-second
updates matter — move polling to a Durable Object WebSocket. Nothing in
the rendering layer would change.

## API

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/assist/requests` | public (rate-limited) | Create a request |
| `GET /api/assist/requests` | customer JWT | List your own requests |
| `GET /api/assist/status/:id` | public (UUID) | Track a request |
| `POST /api/assist/status/:id` | public (UUID) | Cancel `{ "action": "cancel" }` |
| `GET /api/assist/services` | public | Service catalogue (single source of truth) |
| `GET /api/assist/live` | public aggregates / admin or dispatcher for full | Realtime map picture (simulated provider feed, labelled) |
| `GET /api/assist/health` | public | Liveness/config booleans (no secrets) |
| `GET /api/assist/config` | public | Mapbox public token |
| `GET/PATCH /api/assist/admin` | `ADMIN_KEY` bearer | Manager queue + status updates |
| `GET/PUT /api/assist/dispatch` | dispatcher JWT | Dispatcher workspace |
| `GET/PATCH /api/assist/profile` | customer JWT | Profile |
| `GET/POST/DELETE /api/assist/vehicles`, `/homes` | customer JWT | Saved vehicles / homes |
| `POST /api/assist/checkout`, `/webhook` | — | Membership billing (optional) |

## Mobile & performance

The app must load on any phone, including low-end Android on a weak
connection:

- **Nothing render-blocking in `<head>`.** Mapbox GL + Geocoder load
  dynamically with a 9-second timeout; boot runs at `DOMContentLoaded`,
  never on `window.load`. First paint is ~26 KB of HTML + local CSS.
- **Device tiers.** Capability detection (WebGL probe, `deviceMemory`,
  cores, coarse pointer, Save-Data, reduced motion) picks a low-power
  profile: no antialiasing, 32° pitch, pixel ratio 1, no 3D buildings/
  fog/terrain, reduced backdrop-blur — the usual mobile freeze culprits.
- **No-map mode.** If WebGL is off, the CDN dies, or no token is set, the
  request flow still works: type an address or use GPS, submit as normal.
- **Intro splash** is branded, skippable by tap, auto-dismisses when the
  app is ready, and has a 2.6 s hard cap so it can never trap a stranded
  user. It also surfaces a 911 link.
- The manager map lazy-loads after login with the same tiering.

## Security model

See [SECURITY.md](SECURITY.md). The short version:

- **JWTs are verified** (RS256 against `AUTH_ISSUER`/`AUTH_JWKS_URL`),
  never just decoded. With no IdP configured, account endpoints return
  `503 AUTH_NOT_CONFIGURED` rather than trusting tokens — set those env
  vars before offering accounts. Public intake/tracking work regardless.
- Admin key compared by SHA-256 digest (timing-safe); `ADMIN_KEY` must be
  16+ characters. The key is kept in memory only in the dashboard.
- CORS reflects only same-origin / `ALLOWED_ORIGINS` callers, never `*`.
- All input is length-capped, control-character-stripped, and validated
  server-side; request bodies are capped at 16 KB. The manager dashboard
  escapes every customer-supplied value before rendering.
- Rate-limit buckets store a SHA-256 hash of the IP, never the IP itself.
- CSP allows no inline scripts (`script-src` has no `'unsafe-inline'`).

## Environment variables

See `.dev.vars.example` — `MAPBOX_TOKEN`, `ADMIN_KEY`, optional
`AUTH_ISSUER` / `AUTH_JWKS_URL` / `AUTH_AUDIENCE`, `ALLOWED_ORIGINS`, and the
billing keys if memberships are enabled.

## Honesty rules (do not regress)

- No fake providers, prices, ETAs, or countdowns anywhere.
- "Submitted" only after a stored 201. Failures say **NOT SENT**.
- A minimal local pending summary (id, time, category, service — no contact
  details, vehicle, or notes) may be kept in `sessionStorage`; nothing is
  auto-retried.
- Tracking shows provider/scheduled window only once dispatched.

## Layout

```
index.html / manager.html     customer app / manager dashboard
css/ js/                      styles + app logic (no inline <script>/<style>)
functions/api/assist/         Pages Functions (+ _shared.js helpers)
functions/_middleware.js      Mapbox token injection + security headers
schema.sql                    full schema for a fresh D1 database
migrations/                   incremental migrations for existing databases
tests/                        node --test suites (unit, JWT, routes, static)
tools/assist-standalone-test.mjs   smoke-check entry point
```
