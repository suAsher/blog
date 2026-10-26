# Local performance and accessibility baseline

Measured 2026-10-26 against the preserved pre-upgrade production build. Chrome 155.0.8059.85, Lighthouse 13.5.0, three cold-cache navigation samples for each page/device. Lighthouse resets browser storage and HTTP cache before every sample; only the explicit session cookie header carries authentication. Scores are on a 0–100 scale. Each cell lists median / worst; for LCP, worst means highest latency.

| Page | Device | Performance | Accessibility | Best practices | LCP (ms) |
| --- | --- | --- | --- | --- | --- |
| Home `/` | Mobile | 99 / 98 | 100 / 100 | 100 / 100 | 1958 / 1967 |
| Example article | Mobile | 99 / 99 | 96 / 96 | 100 / 100 | 1660 / 1662 |
| Home `/` | Desktop | 100 / 100 | 100 / 100 | 100 / 100 | 527 / 528 |
| Example article | Desktop | 100 / 100 | 96 / 96 | 100 / 100 | 409 / 409 |

The example article is `/articles/build-a-learning-system/`. The controlled dataset contains 30 generated published documents, each with 80 repeated sample sentences. Real Go authentication and document APIs run against a disposable `/tmp` store. Each run snapshots the selected production build into its temporary directory so a later build cannot replace active assets. The HTTPS reverse proxy listens only on `127.0.0.1`, uses a one-day self-signed certificate, and follows the deployed private route/authentication shape. No SSH, deployment credentials, or user documents are used. Browser cookies and raw Lighthouse reports are never written to the aggregate report.

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

The local proxy gives each authenticated session one stable synthetic IPv6 ULA client address, derived in memory from the opaque cookie. Sessions represent independent test devices, so unrelated browser contexts do not consume a single shared loopback request budget. Anonymous login attempts retain the same loopback address. The real Go authentication, Origin checks and per-client API limit remain active; no cookie or derived identity is persisted in reports. Four unit checks cover stable identity, session separation, anonymous identity and exact cookie-name matching.

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

Captures are restricted to generated example routes. To capture the local private server, keep that server running, set `BLOG_TEST_LOCAL_AUTH=1`, `BLOG_TEST_LOCAL_FIXTURE` to its temporary fixture, and `BLOG_CAPTURE_BASE_URL` to its exact HTTPS origin. The script never enumerates or captures user-owned document IDs. `BLOG_CAPTURE_MODE=today` requires the temporary local auth fixture, creates four generated QA notes/articles through the real API, captures the default Today homepage, its generated published listing, and one generated published article in the selected themes/viewports, then removes only those generated documents. Example capture remains the default.

## Stage-one comparison

The complete stage-one browser suite passed 219 tests with zero skips, across the three device projects. The first comparable cold-cache measurement used the same Chrome, Lighthouse, dataset and sample count as the baseline:

| Page | Device | Performance | Accessibility | Best practices | LCP (ms) |
| --- | --- | --- | --- | --- | --- |
| Home `/` | Mobile | 97 / 87 | 100 / 100 | 100 / 100 | 2333 / 2553 |
| Example article | Mobile | 100 / 99 | 100 / 100 | 100 / 100 | 1507 / 1658 |
| Home `/` | Desktop | 100 / 100 | 100 / 100 | 100 / 100 | 568 / 575 |
| Example article | Desktop | 100 / 100 | 100 / 100 | 100 / 100 | 427 / 428 |

The mobile home samples scored 87, 98 and 97. The 87 remains part of the result; the median does not mean every cold startup exceeds 90.

## Mobile startup diagnostic follow-up

A separate three-sample cold-cache study of the preserved stage-one build added timing diagnostics. It does not replace or pool with the comparison above:

| Sample | Performance | FCP (ms) | LCP (ms) | TBT (ms) | Script bootup (ms) | Main-thread work (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 97 | 1732 | 2386 | 51 | 308 | 841 |
| 2 | 98 | 1903 | 2032 | 0 | 111 | 629 |
| 3 | 98 | 1903 | 2032 | 0 | 100 | 607 |

All three measured CLS at approximately 0.000105. The LCP element was `main#main > section.hero > div.hero-copy > h1`, rather than the decorative canvas. JavaScript transferred 61,421 bytes across seven requests; all resources totaled 84,148 bytes across twelve requests, with no third-party requests.

The first sample attributed 198ms of script evaluation to the nebula chunk. The same chunk did not exceed Lighthouse's 50ms per-URL reporting threshold in the later samples. The shared visual runtime attributed 81–91ms to script evaluation and 323–351ms to total work per sample. This supports investigating initial WebGL setup and visual-runtime startup. The original 87 was not reproduced in this follow-up, and its missing TBT trace cannot be reconstructed; GPU setup remains a candidate rather than a proven explanation for that earlier result.

For a later optimization phase, first test deferring optional engine initialization until an idle window after visible content paints, while retaining the existing CSS artwork. Also test loading Lenis only for the smooth-scroll policy: the shared runtime currently imports it even when mobile's coarse pointer disables smooth scrolling. Preserve pause, offscreen, visibility, reduced-motion, and failed-context behavior. Compare three fresh mobile samples, record the worst result, and retain the accessibility and lifecycle gates. No application optimization was made during this diagnostic task.

Reproduce a focused diagnostic without changing the current application build:

```sh
BLOG_TEST_LOCAL_DIST=/tmp/asher-blog-stage1-dist \
  BLOG_PERF_DEVICES=mobile BLOG_PERF_PATHS=/ \
  BLOG_PERF_OUTPUT=/tmp/asher-blog-stage1-mobile-diagnostics.json \
  node scripts/audit-performance.mjs
```

`BLOG_PERF_DEVICES` defaults to `mobile,desktop`. The aggregate now records FCP, TBT, CLS, speed index, script bootup, main-thread categories, sanitized local script paths and the LCP selector. It retains neither raw traces, HTML, request headers, cookies nor page text. LCP insight subparts are observed trace timings; headline paint metrics use Lighthouse simulation and should not be equated to the sum of those subparts.

## Stage-two validation

The final stage-two build (2026-10-26 17:08:09 local time) passed all 234 browser tests with zero skips and three workers, including the original regressions, Today capture and metadata publishing, long-title layout, engine-download budgets, and private authentication/document workflows. The local proxy retains real Go rate limits while isolating independent browser-session client identities.

Six new cold-cache homepage audits used the same Chrome 155.0.8059.85, Lighthouse 13.5.0, 30 generated published documents and network/CPU settings. Each device has three samples; the article page was not re-audited in this stage.

| Device | Performance (median / worst) | Accessibility | Best practices | LCP (ms, median / worst) | TBT (ms, median / worst) |
| --- | --- | --- | --- | --- | --- |
| Mobile | 98 / 98 | 100 / 100 | 100 / 100 | 2127 / 2128 | 0 / 112 |
| Desktop | 100 / 100 | 100 / 100 | 100 / 100 | 457 / 494 | 0 / 0 |

Mobile scores were 98, 98 and 99; CLS was approximately 0.000105. Desktop scored 100 in all three runs. The earlier stage-one 87 remains recorded above. These results support the mobile engine-loading change without claiming it reconstructs the cause of that earlier outlier.

The Today screenshot dataset is separate: four generated QA documents, consisting of two published articles and two private drafts. The capture also exercises the prior-year review using a generated article date, without inventing prior writing activity. Eighteen views were captured across Today, its generated published listing and one generated published article in both themes and three viewports. Only the six Today homepage views are saved in this repository; the twelve other generated views remain temporary.

- [Desktop dark](evolution-stage2-home-desktop-dark.png), [desktop light](evolution-stage2-home-desktop-light.png)
- [Tablet dark](evolution-stage2-home-tablet-dark.png), [tablet light](evolution-stage2-home-tablet-light.png)
- [Mobile dark](evolution-stage2-home-mobile-dark.png), [mobile light](evolution-stage2-home-mobile-light.png)

All screenshot content was generated for local QA. The capture removes its own documents, and the wrapper shuts down the local auth/proxy/preview processes and removes temporary credentials/data. No real account, remote server or private notes were accessed.

## Real graph performance dataset

`BLOG_PERF_GRAPH=1` changes the generated audit dataset to 300 published documents with eight distinct forward Wiki references per document. The script verifies the real Go graph API returns exactly 300 nodes and 2,400 edges before measuring. Seeding uses independent authenticated QA sessions after each 100 documents, then a fresh audit session; the real per-client request limit remains active. No graph response is mocked.

```sh
BLOG_TEST_LOCAL_DIST=/tmp/asher-blog-stage3-dist \
  BLOG_PERF_GRAPH=1 BLOG_PERF_PATHS=/graph/ \
  BLOG_PERF_OUTPUT=/tmp/asher-blog-stage3-graph-cold.json \
  node scripts/audit-performance.mjs
```

The default homepage dataset remains 30 documents for comparison with earlier stages. The graph stress dataset is a separate workload, so its LCP must not be described as the homepage LCP or pooled with the 30-document homepage samples. Audit summaries also record failed accessibility rule IDs and selectors, without retaining HTML or page text.

`BLOG_CAPTURE_MODE=knowledge` uses a separate legible dataset of 12 generated published QA documents and 24 real Wiki edges. It captures the graph and a generated article with outgoing, unresolved and backlink examples in both themes and all three viewports, then removes only those generated documents. The screenshot dataset is not the 300-node stress dataset.

## Stage-three validation

The complete stage-three gate passed 258 browser tests with zero skips in 1.7 minutes, preserving all 234 prior cases and adding 24 knowledge-connection cases across the three device projects. It includes the 300-node/2,400-edge interaction budget, published-snapshot isolation, backlinks, Wiki completion and related-document selection.

The final graph markup and target-size repairs then passed 18 focused checks across all three projects: four graph cases per device and both-theme accessibility checks. The final graph list uses a named navigation landmark; its anchors retain at least 32px height instead of shrinking to 16px inside the scrolling column. These repairs address the observed `aria-prohibited-attr` and populated-list `target-size` findings. No accessibility rule was disabled.

| Workload | Device | Performance (median / worst) | Accessibility | Best practices | LCP (ms, median / worst) | TBT (ms, median / worst) |
| --- | --- | --- | --- | --- | --- | --- |
| Home, 30 published documents | Mobile | 98 / 98 | 100 / 100 | 100 / 100 | 2128 / 2160 | 0 / 28 |
| Home, 30 published documents | Desktop | 100 / 100 | 100 / 100 | 100 / 100 | 475 / 495 | 0 / 0 |
| Graph, 300 nodes / 2,400 real edges | Mobile | 92 / 91 | 100 / 100 | 100 / 100 | 3312 / 3315 | 0 / 0 |
| Graph, 300 nodes / 2,400 real edges | Desktop | 100 / 100 | 100 / 100 | 100 / 100 | 731 / 768 | 0 / 0 |

Every workload/device row has three cold-browser-cache samples with the same Chrome/Lighthouse settings. Home and mobile graph figures come from the initial stage-three audit batch; the desktop graph row was remeasured on the final repaired build (18:29:44). The final populated-graph desktop audits report no failed accessibility rules. The graph's 3.315-second worst mobile LCP belongs to the separate maximum-size graph stress workload; the homepage remains below 2.5 seconds. Mobile graph CLS was 0.04021; final desktop graph CLS was zero.

The final screenshot dataset contains 12 generated published QA documents, 24 real Wiki connections, and one unresolved example. It demonstrates outgoing links, the visible “待创建” state and 11 backlinks without using user notes. Seven selected views are retained; the other five reader theme/device views remain temporary.

- [Graph desktop dark](evolution-stage3-graph-desktop-dark.png), [desktop light](evolution-stage3-graph-desktop-light.png)
- [Graph tablet dark](evolution-stage3-graph-tablet-dark.png), [tablet light](evolution-stage3-graph-tablet-light.png)
- [Graph mobile dark](evolution-stage3-graph-mobile-dark.png), [mobile light](evolution-stage3-graph-mobile-light.png)
- [Published reader with Wiki links and backlinks](evolution-stage3-reader-backlinks-desktop-dark.png)

All screenshot documents were removed after capture, and all temporary authentication credentials, content stores and QA processes were shut down. The stage-three build snapshots and aggregate reports remain under `/tmp` only for subsequent comparison.
