# Security

## Reporting

Email assist@drev.space with details. Please do not open a public issue for
an exploitable vulnerability.

## Threat model & controls

This app takes **unauthenticated public intake** from possibly stranded
drivers, plus authenticated account/dispatcher endpoints and an admin
dashboard. Controls, by surface:

### Public intake (`POST /api/assist/requests`, `GET|POST /api/assist/status/:id`)
- Body capped at 16 KB; every field length-capped and validated (service ↔
  category mapping, coordinate ranges, phone/email formats).
- Rate-limited per IP (10 submissions / 10 min; 60 status lookups / min),
  keyed by a SHA-256 hash of the IP.
- Idempotent via `Idempotency-Key` so retries can't duplicate a request.
- Status is looked up by an unguessable UUID and returns minimal data;
  provider/window are exposed only after dispatch.
- A request is acknowledged only after it is stored; storage failure is a
  500, missing DB is a 503 — never a fabricated confirmation.

### Accounts & dispatch (JWT)
- Tokens are verified with WebCrypto: RS256 signature against the IdP JWKS
  (`AUTH_JWKS_URL` or `<AUTH_ISSUER>/.well-known/jwks.json`), plus
  `exp`/`nbf` and `iss`/`aud` when configured. JWKS is cached 5 minutes.
- **Fail closed:** with no IdP configured these endpoints return 503.
  Previously the code decoded JWTs without verifying them; any forged
  token was accepted. Do not reintroduce decode-only auth.
- Dispatcher endpoints additionally require the `drev_dispatcher` group in
  the *verified* claims. Customers can only read/delete their own
  vehicles/homes (ownership is in every `WHERE` clause).

### Admin (`/api/assist/admin`, `manager.html`)
- `ADMIN_KEY` (16+ chars) compared via SHA-256 digests with a timing-safe
  comparison; brute force is further bounded by the admin rate limit.
- The dashboard keeps the key in memory only, escapes all
  customer-supplied values (stored-XSS defence), and asks before
  cancelling. Status changes must follow the shared state machine and are
  audit-logged in `assist_request_events`.

### Platform
- CSP in `_headers` permits no inline scripts; dashboard/customer JS and
  CSS live in external files. `functions/_middleware.js` adds baseline
  security headers to every response and injects the (public, URL-restricted)
  Mapbox token at the edge so it never lives in the repo.
- All API JSON is `Cache-Control: no-store`. CORS never uses `*`; only
  same-origin or `ALLOWED_ORIGINS` callers are reflected.
- Secrets (`ADMIN_KEY`, Stripe keys, webhook secret) are read from the
  environment and never returned to the browser. Webhook signatures are
  verified with a timing-safe comparison inside a 5-minute replay window.

## Known limitations

- Rate limiting is D1 fixed-window and fails open if D1 is unreachable, so
  an outage degrades abuse protection rather than intake. For high-traffic
  production, add Cloudflare WAF rate-limit rules in front.
- Public status lookup relies on UUID unguessability; anyone with the link
  can view/cancel that request. Treat the reference like a bearer secret.
- The Mapbox token is public by design — restrict its allowed URLs in the
  Mapbox dashboard and set usage alerts.
