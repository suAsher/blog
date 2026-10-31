# Frontend unit coverage scope

## Interactive long-form reading — 2026-10-29

The current selected-library run passes 231 tests across 28 files. The scope adds
`editorial-reader.ts` (caption/line parsing and overview selection) and
`explorers.ts` (strict teaching definitions, input budgets and deterministic
request/network models). Existing global 80% thresholds remain unchanged.

| Metric | Covered / total | Coverage |
| --- | --- | --- |
| Statements | 1134 / 1321 | 85.84% |
| Branches | 1160 / 1371 | 84.60% |
| Functions | 297 / 325 | 91.38% |
| Lines | 960 / 1092 | 87.91% |

These are selected Node-library coverage figures, not whole-application or DOM
coverage. Real-browser reading/annotation/keyboard regressions, generated-guide
Axe states and the server-side publishing-tool tests provide separate evidence
in [the long-form QA record](field-guides/README.md).

`npm run test:coverage` measures explicitly selected library modules using Vitest's V8 provider. The 2026-10-26 stage-one run measured eight modules and passed 73 tests across eight test files:

| Metric | Covered / total | Coverage |
| --- | --- | --- |
| Statements | 248 / 249 | 99.59% |
| Branches | 272 / 280 | 97.14% |
| Functions | 64 / 64 | 100% |
| Lines | 184 / 184 | 100% |

The scope is `commands.ts`, `content-blocks.ts`, `documents.ts`, `motion-capabilities.ts`, `reading-preferences.ts`, `search.ts`, `storage.ts`, and `writing-tools.ts`, under `src/lib/`. These percentages describe that scope. They do not measure Astro components, DOM scripts, the entire application, or Go code. Browser regressions and Go tests provide separate evidence.

## Stage two: expanded scope

The scope now also includes `animation-clock.ts`, `daily.ts`, and `quick-note.ts`, for eleven modules. The latest run passes 92 tests across twelve files (including local test-harness checks). The measured eleven-module coverage is:

| Metric | Covered / total | Coverage |
| --- | --- | --- |
| Statements | 317 / 325 | 97.53% |
| Branches | 327 / 343 | 95.33% |
| Functions | 89 / 94 | 94.68% |
| Lines | 267 / 272 | 98.16% |

Separate `go test -race -cover ./...` reports authentication 87.7% and content service 88.0%. No thresholds were lowered to admit new features.

## Stage three: knowledge links and graph

The stage-three snapshot adds `graph.ts` and `wikilinks.ts`, bringing the selected scope to thirteen library modules. Its 100 unit tests across fourteen files pass; coverage is 97.09% statements, 93.54% branches, 95.61% functions and 98.55% lines. Separate Go race coverage is authentication 87.7% and content 89.0%. The full browser gate passes 258 cases with zero skips; the final graph landmark and 32px target repairs also pass eighteen focused regressions. Performance and screenshot evidence is recorded in [performance.md](performance.md).

## Final stages four and five

The final run passes 186 unit tests across 21 test files. The selected library scope is now 21 modules: the prior thirteen plus `auth-lifecycle.ts`, `reading-sync.ts`, `offline-vault-model.ts`, `vault-crypto.ts`, `offline-snapshot.ts`, `pwa-update.ts`, `pwa-readiness.ts`, and `examples.ts`.

| Metric | Covered / total | Coverage |
| --- | --- | --- |
| Statements | 861 / 1041 | 82.70% |
| Branches | 892 / 1094 | 81.53% |
| Functions | 215 / 242 | 88.84% |
| Lines | 713 / 841 | 84.78% |

The original global 80% thresholds remain unchanged. This includes the partly browser-dependent snapshot module; it is not a claim that every individual file reaches 80%, or that all DOM code is covered by Node tests. Structural sanitization, IndexedDB concurrency/budgets, expiry, revocation, actual service-worker registration and offline reload are additionally exercised by the 24 real-browser PWA cases, while 27 reading-sync cases cover devices, tabs, storage failure and reauthentication. Browser coverage is not merged into these V8/Node percentages. Generated-worker policy also has eleven direct behavioral VM tests.

Separate final Go race coverage is authentication 87.7% and content 89.6%. Final full browser validation is 318 cases with no skips, plus three examples-disabled build cases outside the default suite.

## Why four module rows initially appeared absent

Vitest 4.1.12 detects agent environments and sets the text reporter's `skipFull` option to `true` unless the reporter explicitly overrides it. This hides files whose statement, branch, and function coverage are all 100%. The HTML report and total denominators already included all eight modules; collection and source maps were working correctly.

The configuration now explicitly sets `['text', { skipFull: false }]`, retaining the existing V8 provider, selected modules, and 80% thresholds. It also writes `coverage/coverage-summary.json` so module membership and denominator counts can be checked without relying on terminal formatting. The rerun displays all eight rows and retains the same totals. No test, coverage exclusion, or threshold was weakened.

The provider's local formatter implementation is in `node_modules/vitest/dist/chunks/coverage.*.js`, in the `isAgent` reporter branch. Generated reports remain ignored by Git.
