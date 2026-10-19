# NAFDAC Checker

An independent public-data checker for Nigerian product registration records. Search by NAFDAC number or product name, compare the returned record with product packaging, and review official recall alerts. A matching registration is **not proof that a particular pack is authentic**.

[Open NAFDAC Checker](https://nafdac-checker.netlify.app/)

## Features

- Searches Greenbook, with a server-side NAPAMS fallback for registration-number lookups.
- Accepts a registration number, product name, or both, with optional manufacturer and batch details.
- Distinguishes a registration found, a completed search with no match, and an incomplete check.
- Shows official alerts and Mobile Authentication Service (MAS) guidance.
- Caches completed public results and retries a gateway or upstream timeout once.

## Local development

Use Node.js 22.22.2+ within Node 22, Node 24.15+ within Node 24, or Node 26+. Exact engine constraints are in `package.json`.

```sh
npm ci
npm test
npm run build
```

Tests use fixtures and mocked requests to cover result parsing, lookup behaviour, retries, caching and streaming responses. They do not establish live upstream availability.

The build copies `index.html` and `_redirects` into `dist/`. Netlify bundles the NAPAMS function separately. For interactive development with the proxy routes and backend, install Chrome and set its executable path:

```sh
# Example for macOS; use the appropriate Chrome path on your system.
export CHROME_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
npx netlify-cli@27.8.1 dev
```

Searches in the development server make real requests to NAFDAC. A basic static file server cannot supply the proxy routes or NAPAMS endpoint.

## Project layout

| Path | Purpose |
| --- | --- |
| `index.html` | Interface, Greenbook and alert searches, comparison and retry logic |
| `_redirects` | Same-origin proxies to official endpoints |
| `lib/napams-result.mjs` | Strict result parsing and product-name normalization |
| `lib/napams-browser.mjs` | Public-form submission with Puppeteer and Chromium |
| `netlify/functions/napams.mjs` | Validated, rate-limited, streaming endpoint |
| `scripts/build.mjs` | Public-file build |
| `tests/` | UI and backend regression tests with public-product fixtures |

## API responses

`GET /api/napams?nrn=A2-5680` accepts a registration number. Completed checks normally return HTTP 200. A slower check can return HTTP 202 and stream whitespace before its final JSON. Read the complete response body and inspect `state`:

- `found`: a matching registration record was returned.
- `not_found`: the source completed the lookup and explicitly reported no match.
- `unavailable`: the lookup could not be completed.

HTTP status alone is insufficient. Pending and failed checks are not cached. Completed public results may be reused for five minutes at the function/CDN and two minutes in the interface. The configured function limit is six requests per minute per visitor IP/domain.

## Limitations

NAPAMS extends registration-number coverage only. Its public form may change, go offline or require interactive verification. CAPTCHA challenges are not bypassed or retried. The browser lookup has a 28-second deadline within a 30-second function timeout; cold starts and slow upstream responses can still leave a check incomplete after one retry.

An incomplete check is not evidence of counterfeiting. A registration expiry date concerns the registration, not an individual pack. Product-name and manufacturer comparisons are screening aids, not authenticity decisions. Always compare the official record with the packaging and use the product's supported verification channels.

## Deployment

`netlify.toml` configures `npm run build`, the `dist` publish directory, `netlify/functions`, and Chromium packaging. Deploy the complete source: an HTML-only upload omits the NAPAMS backend.

After signing in to the Netlify CLI, select the intended project and deploy:

```sh
npx netlify-cli@27.8.1 link
npx netlify-cli@27.8.1 deploy --build --prod
```

The application requires no NAFDAC API key. Hosting limits and upstream service availability still apply.
