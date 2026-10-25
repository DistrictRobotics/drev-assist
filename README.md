# DREV Assist standalone

Vanilla JavaScript, no build step. The parent network app is unchanged.

## Preview / deploy

From this directory:

```sh
npx wrangler pages dev . --ip 0.0.0.0 --port 8788
npx wrangler pages deploy . --project-name drev-assist
```

Set the Cloudflare Pages build output to this directory (or root `drev-assist` when deploying from the parent repository); no build command is needed. Configure `assist.drev.space` in Pages custom domains after verifying the deployment. Do not use a SPA catch-all redirect for API routes.

## Important production gate

The Windows scaffold and `functions/api/assist/*.js` source files described in the brief were **not present** in this checkout. The available backend implementations are Netlify/AWS-specific and have not been copied or silently converted. The included Pages routes deliberately return JSON **503**; they do not store requests, authenticate users, take payments, or dispatch providers. Replace these stubs with the supplied, audited Cloudflare implementation before launch. No backend receipt or live tracking is claimed in offline mode. The TRACK STATUS button dismisses a card that explicitly reports tracking availability; no tracking API was supplied.

Network failures and 503 responses produce a local reference, clearly marked **not sent**. A minimal summary is saved to sessionStorage, never automatically retried. Vehicle and free-text details are not persisted. Other non-success statuses remain errors. Timeouts have ambiguous receipt, so users must verify before resubmitting. For a wired backend, add server-side validation, authorization as appropriate, rate limiting, idempotent submission, retention/privacy controls, and abuse monitoring. The current client sends exactly the requested payload fields.

The Mapbox token is public by design. Restrict its allowed URLs to the production and approved preview origins in Mapbox, and set usage alerts. No payment or authentication secrets are included. Mapbox and Google Fonts require browser internet access. This sandbox cannot reach those CDNs, so live map/geocoding requires verification in an unrestricted browser.

## Launch verification

- Confirm the chosen style, imagery (the requested navigation-night style is a vector basemap, **not satellite imagery**), fog, and 3D buildings load using the production-origin token.
- Test search results, interrupted reverse-geocoding, denied geolocation, map drag/pin centering, resize, attribution visibility, and mobile safe areas.
- Test mouse/touch handle dragging, upward/downward flings, keyboard panel toggle, and reduced motion. Map gestures lock only in FULL.
- Check all 14 services, category resets, and the incident warning in FULL before submission.
- Test confirmed response with `{ "requestId": "..." }`, 400/401/429/500 errors, 503, network timeout, blocked storage, and double-submit protection.
- Verify offline wording, dialog keyboard focus/escape behavior, and no guaranteed dispatch/ETA claims.
- Supply and audit the backend; test actual persistence and operational review before making the service public.

Run offline checks from the repository root: `node tools/assist-standalone-test.mjs`.

## Refined request journey

The expanded panel now includes service-specific guidance for all 14 services, a location verification checkbox (invalidated whenever the map moves), and a final review dialog showing the exact request details before transmission. The submitted payload is a frozen-in-time snapshot of that review; the form is not reread during transmission. Sending disables repeat submission and dialog dismissal until the request resolves. Night/satellite switching uses actual Mapbox raster imagery while retaining labels and buildings, not a visual filter. No fake providers, prices, availability, or countdowns are displayed.
