# Local performance and accessibility baseline

Measured 2026-10-26 against the preserved pre-upgrade production build. Chrome 155.0.8059.85, Lighthouse 13.5.0, three cold-cache navigation samples for each page/device. Lighthouse resets browser storage and HTTP cache before every sample; only the explicit session cookie header carries authentication. Scores are on a 0–100 scale. Each cell lists median / worst; for LCP, worst means highest latency.

| Page | Device | Performance | Accessibility | Best practices | LCP (ms) |
| --- | --- | --- | --- | --- | --- |
| Home `/` | Mobile | 99 / 98 | 100 / 100 | 100 / 100 | 1958 / 1967 |
| Example article | Mobile | 99 / 99 | 96 / 96 | 100 / 100 | 1660 / 1662 |
| Home `/` | Desktop | 100 / 100 | 100 / 100 | 100 / 100 | 527 / 528 |
| Example article | Desktop | 100 / 100 | 96 / 96 | 100 / 100 | 409 / 409 |

The example article is `/articles/build-a-learning-system/`. The controlled dataset contains 30 generated published documents, each with 80 repeated sample sentences. Real Go authentication and document APIs run against a disposable `/tmp` store. The HTTPS reverse proxy listens only on `127.0.0.1`, uses a one-day self-signed certificate, and follows the deployed private route/authentication shape. No SSH, deployment credentials, or user documents are used. Browser cookies and raw Lighthouse reports are never written to the aggregate report.

Mobile uses a 390×844 viewport with Lighthouse's simulated mobile network/CPU defaults. Desktop uses 1440×1000, simulated 40ms RTT, 10240kbps throughput, and no CPU slowdown. Chrome runs headlessly, with extensions and background networking disabled. This localhost baseline controls transport and dataset; it does not represent Internet latency or a production hardware capacity test.

## Reproduce

```sh
npm run build
npm run test:e2e
BLOG_PERF_PATHS=/,/articles/build-a-learning-system/ \
  BLOG_PERF_OUTPUT=/tmp/asher-blog-performance.json \
  node scripts/audit-performance.mjs
```

The audit script starts and cleans up its own server and creates random credentials with the production PBKDF2-SHA256 verifier (600,000 iterations). `BLOG_PERF_SAMPLES` defaults to 3 (minimum 3), `BLOG_PERF_DOCUMENTS` to 30, and `BLOG_PERF_PATHS` to home, article listing, example article, and writing workspace. `BLOG_TEST_LOCAL_DIST` optionally points to a preserved production build. `BLOG_TEST_LOCAL_PORT` changes the default HTTPS port 4443. Run comparable audits with the same Chrome version, dataset size, paths and machine workload; run audits sequentially.

The default E2E run uses the real local private service (Go 1.26+ and OpenSSL are required). Set `BLOG_TEST_STATIC_ONLY=1` to run only the static preview on port 4390, with authentication/content cases skipped. Explicit `BLOG_TEST_BASE_URL` and optional SSH target retain the deployment workflow. Tests refuse to reuse an unrelated local preview.

The local E2E mode uses a mode-0600 credential fixture directly under `/tmp`, scoped to the exact HTTPS origin. Traces, screenshots, and video are disabled in this mode. All 162 existing baseline E2E tests passed across desktop, mobile, and tablet with three workers (49.8 seconds), including the 78 cases previously skipped without an SSH target. No existing assertion was removed.

The new axe WCAG 2.0/2.1 AA checks intentionally exercise both themes and core pages. The original build reports label/name mismatches on the brand and search control; these are tracked separately from Lighthouse's aggregate accessibility score. Automated checks complement keyboard, reduced-motion, responsive, and real document lifecycle tests.

## Example-only previews

```sh
BLOG_CAPTURE_BASE_URL=http://127.0.0.1:4321 \
  BLOG_CAPTURE_THEMES=dark,light \
  BLOG_CAPTURE_VIEWPORTS=desktop,tablet,mobile \
  BLOG_CAPTURE_OUTPUT=/tmp/asher-blog-previews \
  node scripts/capture-preview.mjs
```

Captures are restricted to generated example routes. To capture the local private server, keep that server running, set `BLOG_TEST_LOCAL_AUTH=1`, `BLOG_TEST_LOCAL_FIXTURE` to its temporary fixture, and `BLOG_CAPTURE_BASE_URL` to its exact HTTPS origin. The script never enumerates or captures private document IDs.
