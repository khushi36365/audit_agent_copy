---
name: performance-analyzer
description: Use when interpreting performance findings from a cached audit run. Reads Lighthouse mobile + desktop runs under reports/.cache/<hostname>/lighthouse/ and emits a structured per-finding analysis covering Core Web Vitals and resource-level opportunities. Does not collect data — the lighthouse runner produces the inputs.
---

# performance-analyzer

## Purpose

Interpret Lighthouse performance data into prioritized, concrete findings: which metrics are failing, which audits contribute most to those failures, and what specific changes will move the needle. Pair mobile and desktop runs so regressions on one form factor are not hidden by acceptable numbers on the other.

## Input artifacts

Read from `reports/.cache/<hostname>/lighthouse/`. Pick the highest-numbered run pair.

- `<hostname>-mobile-run<N>.json` — primary source (mobile is the throttled "hard mode" baseline)
- `<hostname>-desktop-run<N>.json` — comparison; cross-form-factor regressions are first-class findings

Within each Lighthouse JSON, the relevant locations are:
- `categories.performance.score` and per-audit `score`
- `audits['largest-contentful-paint' | 'cumulative-layout-shift' | 'interaction-to-next-paint' | 'first-contentful-paint' | 'speed-index' | 'total-blocking-time' | 'server-response-time']`
- Opportunity audits: `'render-blocking-resources'`, `'unused-javascript'`, `'unused-css-rules'`, `'modern-image-formats'`, `'uses-text-compression'`, `'uses-long-cache-ttl'`, `'uses-rel-preconnect'`, etc.
- Diagnostic audits: `'mainthread-work-breakdown'`, `'bootup-time'`, `'third-party-summary'`, `'network-rtt'`, `'network-server-latency'`

If an artifact is missing, record it in `metadata.gaps`. If only one form factor was collected, do not synthesize the other.

## Output schema

This skill emits the canonical analyzer output defined in [`../_shared/analyzer-schema.md`](../_shared/analyzer-schema.md). That document is normative for field shapes, severity/priority semantics, sort order, and the extension registry. Per-skill specifics only:

- **`dimension`:** `"performance"`
- **`category` enum:** `"core-web-vitals" | "render-blocking" | "javascript" | "css" | "images" | "network" | "caching" | "third-party" | "main-thread"`
- **`score` derivation:** `categories.performance.score` × 100 from the **mobile** run (the conservative target). Desktop-only regressions surface as findings but do not lower the headline score below the mobile value.
- **Tiebreaker** (within a priority/severity tier): descending `extensions.savings_ms`, then descending `extensions.savings_bytes`.
- **Extensions used** (per finding):
  - `savings_ms` — `audits[x].details.overallSavingsMs`, when Lighthouse reports it.
  - `savings_bytes` — `audits[x].details.overallSavingsBytes`, when Lighthouse reports it.
  - `cwv_metric` — `"lcp" | "inp" | "cls"` when the finding is the direct cause of a failing Core Web Vital.

`evidence` should quote both form-factor values when the audit ran on both (e.g. `"LCP: 4.2 s mobile / 1.8 s desktop; budget 2.5 s"`).

## Analysis responsibilities

- **Core Web Vitals (LCP, INP, CLS):** report each metric against the standard thresholds (LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.1) for both form factors. Flag any "good → needs-improvement" or worse transition between desktop and mobile.
- **Supporting metrics:** FCP, TBT, Speed Index, TTFB — surface only when they contribute to a failing CWV.
- **Render-blocking resources:** name the specific scripts/stylesheets and their wasted bytes / blocking time.
- **JavaScript:** unused JS, long main-thread tasks, expensive third parties — point at the offending origins.
- **CSS:** unused rules, render-blocking sheets.
- **Images:** non-modern formats, oversized assets, missing dimensions (note CLS link).
- **Network/caching:** preconnect opportunities, compression, long cache TTLs.
- **Third parties:** quantify their main-thread cost from `third-party-summary` — never recommend removal blindly; flag and ask.

## Procedure

Follow the steps in [`../_shared/analysis-procedure.md`](../_shared/analysis-procedure.md). Skill-specific signal handling below.

### Load

Read these JSON files (highest-numbered run pair wins):
- `reports/.cache/<hostname>/lighthouse/<hostname>-mobile-run<N>.json` — required
- `reports/.cache/<hostname>/lighthouse/<hostname>-desktop-run<N>.json` — optional

Extract `categories.performance.score`, all audits referenced by `categories.performance.auditRefs[].id`, and each audit's `details` (especially `overallSavingsMs`, `overallSavingsBytes`, `items`).

### Core Web Vitals — threshold-based, not Lighthouse-score-based

CWV thresholds are stable across Lighthouse versions; use them directly. Mobile values are canonical.

| Metric | Field | Critical | High | Pass |
|---|---|---|---|---|
| LCP | `audits['largest-contentful-paint'].numericValue` (ms) | > 4000 | 2500–4000 | ≤ 2500 |
| INP | `audits['interaction-to-next-paint'].numericValue` (ms) | > 500 | 200–500 | ≤ 200 |
| CLS | `audits['cumulative-layout-shift'].numericValue` | > 0.25 | 0.1–0.25 | ≤ 0.1 |

If INP is absent (older Lighthouse), use TBT as a proxy: `audits['total-blocking-time'].numericValue` > 600 ms → high, 200–600 ms → medium.

Cross-form-factor rule:
- Mobile failing + desktop passing → emit at the **mobile** severity; include both numbers in `evidence` with the suffix `"(mobile-only regression)"`.
- Both failing → emit at the worse of the two.
- Only one form factor available → cap severity at `high` (no cross-validation possible).

CWV findings carry `extensions.cwv_metric` = `"lcp"`, `"inp"`, or `"cls"`.

### Opportunity audits — Lighthouse score + savings

For numeric-scored audits with `details.overallSavingsMs` (or `Bytes`):

| Lighthouse score | savings_ms | Severity |
|---|---|---|
| < 0.5 | > 1000 | high |
| < 0.5 | 300–1000 | medium |
| < 0.5 | < 300 | low |
| 0.5 ≤ score < 0.9 | > 1000 | medium |
| 0.5 ≤ score < 0.9 | ≤ 1000 | low |
| ≥ 0.9 | any | drop (passing) |

Applies to: `render-blocking-resources`, `unused-javascript`, `unused-css-rules`, `unminified-javascript`, `unminified-css`, `modern-image-formats`, `uses-text-compression`, `uses-responsive-images`, `efficient-animated-content`, `uses-rel-preconnect`, `uses-long-cache-ttl`, `uses-optimized-images`. `id` is `perf-<audit-id>`.

### Diagnostic audits

| Source signal | `id` | `category` | severity |
|---|---|---|---|
| `audits['server-response-time'].numericValue > 600` ms | `perf-ttfb-slow` | network | high |
| `audits['server-response-time'].numericValue` 200–600 ms | `perf-ttfb-elevated` | network | medium |
| `audits['mainthread-work-breakdown'].numericValue > 4000` ms | `perf-main-thread-heavy` | main-thread | high |
| `audits['bootup-time'].numericValue > 3500` ms | `perf-js-bootup-slow` | javascript | high |
| `audits['third-party-summary']` main-thread blocking > 250 ms | `perf-third-party-blocking` | third-party | medium |
| `audits['dom-size'].numericValue > 1500` nodes | `perf-dom-too-large` | main-thread | medium |

### Extensions per finding

- `extensions.savings_ms` = literal `details.overallSavingsMs` from the artifact (when present)
- `extensions.savings_bytes` = literal `details.overallSavingsBytes` (when present)
- `extensions.cwv_metric` = the linked CWV id (when the finding causes a failing CWV)

### Score formula

```
score = round(categories.performance.score * 100)   // mobile run
```

If only desktop ran, cap the emitted score at 70 and note the cap in `summary` (*"Mobile run unavailable; desktop-only audits do not reflect throttled real-world conditions."*).

### Skill-specific rules

- Never recommend removing a third party outright. Phrase as: *"Evaluate removing or deferring the &lt;name&gt; tag; it accounts for &lt;X&gt; ms of main-thread work."*
- For image audits, quote up to 3 URLs from `details.items[].url`.

## Out of scope

- Field data (CrUX/RUM) — only lab data is available here
- Server-side performance tuning beyond what TTFB exposes
- Synthetic regression tracking across runs (single-run analysis only)
- Fabricating savings numbers that Lighthouse did not report
