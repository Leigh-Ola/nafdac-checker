# NAFDAC Checker

An independent public-data checker for Nigerian product registration records. Search by NAFDAC number or product name, compare a record with packaging, and review official recall alerts. A matching registration is **not proof that a particular pack is authentic**.

Existing site: https://nafdac-checker.netlify.app/. Netlify's dashboard recorded deployment `6aca9fd67b9a618c80d271a7` as published on October 10, 2026. This import preserves its corrected source; no deployment or live lookup was performed during the GitHub import.

## Features

- Greenbook searches with a server-side NAPAMS fallback for registration numbers.
- Number and product-name inputs, optional manufacturer/batch comparison, official alerts and MAS guidance.
- Separate results for a registration found, a completed search with no match, and an incomplete check.
- Normalization of repeated registration-number suffixes, including Hollandia `01-7506`.
- Completed-result caching and one retry for a gateway/upstream timeout. CAPTCHA challenges are never retried or bypassed.

## Local setup and validation

Use Node.js 22.22.2+ within Node 22, Node 24.15+ within Node 24, or Node 26+. Exact engine constraints are in `package.json`.

```sh
npm ci
npm test
npm run build
```

Tests use fixtures and mocked requests; they do not call Netlify or live NAFDAC services. The build copies `index.html` and `_redirects` into `dist/`; Netlify bundles the function separately.

For interactive development with the proxy routes and backend:

```sh
export CHROME_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
npx netlify-cli@27.8.1 dev
```

Set an installed Chrome path appropriate to your OS. Searching in this development server makes real requests to NAFDAC; `npm test` does not. Static file serving alone cannot supply the proxy routes or NAPAMS endpoint.

## Layout

| Path | Purpose |
| --- | --- |
| `index.html` | Interface, Greenbook/alert lookup, comparison and retry logic |
| `_redirects` | Same-origin proxies to official endpoints |
| `lib/napams-result.mjs` | Strict result parsing and name normalization |
| `lib/napams-browser.mjs` | Public-form submission with Puppeteer/Chromium |
| `netlify/functions/napams.mjs` | Validated, rate-limited, streaming endpoint |
| `scripts/build.mjs` | Public-file build |
| `tests/` | UI, parser, validation, cache and streaming regression tests |

## Response contract and known limitations

`GET /api/napams?nrn=A2-5680` accepts a registration number. Completed checks normally return HTTP 200. A slower check can return HTTP 202 and stream whitespace before its final JSON: read the complete body and inspect `state` (`found`, `not_found` or `unavailable`). HTTP status alone is insufficient. Pending and failed checks are not cached.

Completed public results may be reused for five minutes at the function/CDN and two minutes in the interface. The configured limit is six requests per minute per visitor IP/domain. The browser lookup has a 28-second deadline within the recorded 30-second function limit. Cold starts and slow upstream responses can still leave a check incomplete after the one permitted retry.

NAPAMS extends registration-number coverage only. Its public form may change, go offline or require interactive verification. The app does not solve CAPTCHAs or interpret an upstream failure as a missing registration. Registration expiry concerns the registration, not an individual pack. Name comparison is a screening aid, not an authenticity decision.

Bounded operational diagnostics record timings and error codes, not registration inputs, page contents, cookies or tokens. Captured logs, dependency caches and local Netlify account state are excluded. The public-product fixture in `tests/fixtures` is never served as a fallback result.

## Deployment reference

`netlify.toml` specifies `npm run build`, `dist`, `netlify/functions` and Chromium packaging. Deploy the complete source with its function; an HTML-only upload omits the NAPAMS backend. When a future manual deployment is intended, use an existing authorized Netlify CLI login and select the correct site:

```sh
npx netlify-cli@27.8.1 link
npx netlify-cli@27.8.1 deploy --build --prod
```

These commands publish and may consume Netlify credits. Creating this repository does not run them or connect automatic deployments. The application needs no API key, but Netlify usage limits and upstream availability still apply.

## Import provenance

Recovered from the corrected October 10 archive and compared with its working copy. Application code, dependency lockfile and existing tests are preserved. Commits represent current import steps: interface/proxies, registry backend, then build/tests/documentation; they do not invent historical development dates.

Local tests do not establish current hosted or upstream availability. No license or private conversation export has been added.
