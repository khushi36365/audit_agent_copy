---
name: best-practices-analyzer
description: Use when interpreting general web best-practices findings from a cached audit run. Reads Lighthouse's best-practices-category audits under reports/.cache/<hostname>/lighthouse/ (excluding items already owned by the security-auditor) and emits a structured per-finding analysis. Does not collect data — the lighthouse runner produces the inputs.
---

# best-practices-analyzer

## Purpose

Cover the catch-all Lighthouse "best practices" category: code hygiene, browser-platform correctness, trust signals, and modern-web compliance items that do not fit into SEO, performance, accessibility, or security. Avoids double-reporting items that the security-auditor already owns.

## Input artifacts

Read from `reports/.cache/<hostname>/lighthouse/`. Pick the highest-numbered run pair.

- `<hostname>-mobile-run<N>.json` — primary source
- `<hostname>-desktop-run<N>.json` — comparison; some audits run on only one form factor

Relevant audit IDs (illustrative, not exhaustive — read whatever Lighthouse emits in the `best-practices` category):
- Code/runtime: `'errors-in-console'`, `'no-document-write'`, `'deprecations'`, `'js-libraries'`, `'inspector-issues'`
- Browser platform: `'doctype'`, `'charset'`, `'image-aspect-ratio'`, `'image-size-responsive'`, `'viewport'`
- Trust/UX: `'geolocation-on-start'`, `'notification-on-start'`, `'paste-preventing-inputs'`
- HTTP/protocol: `'uses-http2'` (skip if security-auditor already covered it)

If an artifact is missing, record it in `metadata.gaps`.

## Output schema

This skill emits the canonical analyzer output defined in [`../_shared/analyzer-schema.md`](../_shared/analyzer-schema.md). That document is normative for field shapes, severity/priority semantics, sort order, and the extension registry. Per-skill specifics only:

- **`dimension`:** `"best-practices"`
- **`category` enum:** `"runtime-errors" | "deprecations" | "browser-platform" | "trust-signals" | "protocol" | "dependencies"`
- **`score` derivation:** `categories.best-practices.score` × 100 from the form factor that scored **lower**.
- **Tiebreaker** (within a priority/severity tier): descending node/error count from `audit.details.items.length`.
- **Extensions used:**
  - `metadata.extensions.deferred_to` — array of strings of the form `"<finding-id> -> <other-dimension>"` listing items this skill detected but ceded to another analyzer per the dedup boundary (HTTPS/mixed-content/vuln-libs → security; CLS metric → performance; image alt → accessibility; canonical/title → seo).

`evidence` should quote the actual console message, deprecation name, or audit-item details — not just a count.

## Analysis responsibilities

- **Runtime errors:** console errors (`errors-in-console`) — quote the messages, group by source file, do not just count.
- **Deprecations:** named deprecated API usage with removal timeline if Lighthouse provides it.
- **Browser-platform correctness:** missing/incorrect doctype, charset, viewport; image aspect-ratio and responsive-size issues (note CLS link — performance owns the metric, this owns the markup).
- **Trust signals:** geolocation/notification/clipboard permission requests on page load — these are UX dark patterns at best.
- **Protocol:** HTTP/2 usage **only if** the security-auditor is not already reporting it. Coordinate via the report-builder if both surface it; this skill defers to security-auditor.
- **Dependencies:** general library-version hygiene (`js-libraries`); known vulnerabilities are owned by security-auditor — do not duplicate.

## Coordination with other analyzers

To avoid duplicate findings in the merged report:
- **HTTPS / mixed content / vulnerable libs** → security-auditor owns these.
- **Image dimensions / CLS** → performance-analyzer owns the metric framing; this skill owns the markup-level fix.
- **Image alt / contrast / labels** → accessibility-analyzer owns these.
- **Title / description / canonical** → seo-analyzer owns these.

When in doubt, file the finding under the dimension whose recommended fix is the same as what this skill would suggest.

## Procedure

Follow the steps in [`../_shared/analysis-procedure.md`](../_shared/analysis-procedure.md). Skill-specific signal handling below.

### Load

Read these JSON files (highest-numbered run pair wins):
- `reports/.cache/<hostname>/lighthouse/<hostname>-mobile-run<N>.json` — required
- `reports/.cache/<hostname>/lighthouse/<hostname>-desktop-run<N>.json` — optional

Extract `categories['best-practices'].score` and all audits referenced by `categories['best-practices'].auditRefs[].id`.

### Defer first — coordinate before scoring

For each failing audit, check whether it belongs to another analyzer. If so, append `"<lighthouse-audit-id> -> <other-dimension>"` to `metadata.extensions.deferred_to` and **do not** emit a finding here.

| Lighthouse audit | Defer to |
|---|---|
| `is-on-https` | security |
| `no-vulnerable-libraries` | security |
| `csp-xss` | security |
| `uses-http2` | security |
| `image-aspect-ratio` (when CLS audit also failing) | performance |

### Signal-to-finding map

| Source signal | `id` | `category` | severity |
|---|---|---|---|
| `audits['errors-in-console'].score < 1` | `bp-console-errors` | runtime-errors | high |
| `audits['inspector-issues'].score < 1` | `bp-browser-inspector-issues` | runtime-errors | medium |
| `audits['no-document-write'].score < 1` | `bp-document-write` | deprecations | medium |
| `audits['deprecations'].score < 1` | `bp-deprecated-api` | deprecations | medium |
| `audits['doctype'].score < 1` | `bp-doctype-missing-or-invalid` | browser-platform | medium |
| `audits['charset'].score < 1` | `bp-charset-missing-or-invalid` | browser-platform | medium |
| `audits['viewport'].score < 1` | `bp-viewport-missing` | browser-platform | medium |
| `audits['image-aspect-ratio'].score < 1` (no CLS link) | `bp-image-aspect-ratio` | browser-platform | low |
| `audits['image-size-responsive'].score < 1` | `bp-image-size-responsive` | browser-platform | low |
| `audits['geolocation-on-start'].score < 1` | `bp-geolocation-on-load` | trust-signals | high |
| `audits['notification-on-start'].score < 1` | `bp-notification-on-load` | trust-signals | high |
| `audits['paste-preventing-inputs'].score < 1` | `bp-paste-blocked` | trust-signals | medium |
| `audits['valid-source-maps'].score < 1` | `bp-source-maps-invalid` | runtime-errors | low |

For any other failing best-practices audit not in the table and not deferred: emit at `medium`. `id` is `bp-<audit-id>`. `category` is `browser-platform` unless the audit's `group` clearly indicates otherwise.

### Evidence

- `errors-in-console`: quote `source` and `description` of each error in `details.items[]`, capped at 3. Include the total count in `impact`.
- `deprecations`: name the specific deprecated API per item.
- `inspector-issues`: copy the issue summary verbatim.

### Score formula

```
mobile  = round(mobile.categories['best-practices'].score * 100)
desktop = round(desktop.categories['best-practices'].score * 100)   // null if absent
score   = min(mobile, desktop)                                        // ignore nulls
```

Deferred audits do **not** affect this score — they are already counted by the analyzer that owns them.

### Skill-specific rules

- Console errors with no message body (just a source line) get severity `low`, not `high` — without a message they are not actionable.
- `image-aspect-ratio` and `image-size-responsive` are markup-level findings here; the CLS impact (if any) belongs to performance. If both an image-shape audit and a CLS audit fail, defer this one to performance.

## Out of scope

- Anything already covered by another analyzer (defer rather than duplicate)
- Subjective code-quality opinions not derivable from Lighthouse audits
- Browser-specific bugs not surfaced as Lighthouse audits
