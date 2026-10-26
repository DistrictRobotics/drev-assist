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

## API

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/assist/requests` | public (rate-limited) | Create a request |
| `GET /api/assist/requests` | customer JWT | List your own requests |
| `GET /api/assist/status/:id` | public (UUID) | Track a request |
| `POST /api/assist/status/:id` | public (UUID) | Cancel `{ "action": "cancel" }` |
| `GET /api/assist/services` | public | Service catalogue (single source of truth) |
| `GET /api/assist/health` | public | Liveness/config booleans (no secrets) |
| `GET /api/assist/config` | public | Mapbox public token |
| `GET/PATCH /api/assist/admin` | `ADMIN_KEY` bearer | Manager queue + status updates |
| `GET/PUT /api/assist/dispatch` | dispatcher JWT | Dispatcher workspace |
| `GET/PATCH /api/assist/profile` | customer JWT | Profile |
| `GET/POST/DELETE /api/assist/vehicles`, `/homes` | customer JWT | Saved vehicles / homes |
| `POST /api/assist/checkout`, `/webhook` | — | Membership billing (optional) |

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
