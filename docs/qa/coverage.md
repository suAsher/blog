# Frontend unit coverage scope

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

## Why four module rows initially appeared absent

Vitest 4.1.12 detects agent environments and sets the text reporter's `skipFull` option to `true` unless the reporter explicitly overrides it. This hides files whose statement, branch, and function coverage are all 100%. The HTML report and total denominators already included all eight modules; collection and source maps were working correctly.

The configuration now explicitly sets `['text', { skipFull: false }]`, retaining the existing V8 provider, selected modules, and 80% thresholds. It also writes `coverage/coverage-summary.json` so module membership and denominator counts can be checked without relying on terminal formatting. The rerun displays all eight rows and retains the same totals. No test, coverage exclusion, or threshold was weakened.

The provider's local formatter implementation is in `node_modules/vitest/dist/chunks/coverage.*.js`, in the `isAgent` reporter branch. Generated reports remain ignored by Git.
