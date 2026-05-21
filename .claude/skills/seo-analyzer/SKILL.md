---
name: seo-analyzer
description: Use when interpreting SEO findings from a cached audit run. Reads Lighthouse SEO-category audits plus crawlability artifacts (robots.txt, sitemap.xml) under reports/.cache/<hostname>/ and emits a structured per-finding analysis ready for the report builder. Does not collect data — runners in scripts/ produce the inputs.
---

# seo-analyzer

## Purpose

Turn raw Lighthouse SEO audits and crawl-control artifacts into a prioritized, human-readable analysis. Each finding is grounded in concrete evidence from the artifacts and paired with an actionable recommendation. This skill **interprets** data; it does not fetch it and does not render reports.

## Input artifacts

Read from `reports/.cache/<hostname>/`. Pick the highest-numbered run unless told otherwise.

- `lighthouse/<hostname>-mobile-run<N>.json` — primary source; Lighthouse SEO category audits
- `lighthouse/<hostname>-desktop-run<N>.json` — cross-check (some SEO signals differ across form factors)
- `security/<hostname>-security-run<N>.json` — fields used:
  - `robots_txt` (status, size, snippet)
  - `sitemap_xml` (status, size, snippet)
  - `http_redirect.upgrades_to_https` (duplicate-content risk if no canonical scheme)

If an artifact is missing, note it in `metadata.gaps` and continue with what is available.

## Output schema

This skill emits the canonical analyzer output defined in [`../_shared/analyzer-schema.md`](../_shared/analyzer-schema.md). That document is normative for field shapes, severity/priority semantics, sort order, and the extension registry. Per-skill specifics only:

- **`dimension`:** `"seo"`
- **`category` enum:** `"crawlability" | "indexability" | "metadata" | "mobile" | "structured-data" | "content" | "i18n"`
- **`score` derivation:** start from `categories.seo.score` × 100 in the mobile Lighthouse run, then subtract for crawlability/canonical signals Lighthouse does not weight (missing sitemap, robots.txt blocking the root, http→https canonical inconsistency). Note the adjustment in `summary` if it changes the score by more than 5 points.
- **Tiebreaker** (within a priority/severity tier): descending Lighthouse audit weight; for non-Lighthouse signals, alphabetical by `category`.
- **Extensions used:** none.

## Analysis responsibilities

- **Crawlability:** robots.txt presence, syntax issues, accidental `Disallow: /`, sitemap reference present, sitemap reachable with non-empty `<loc>` set.
- **Indexability:** noindex/nofollow on the root document, canonical link presence and pointing to the served URL, http→https canonical consistency.
- **Metadata:** `<title>` length and uniqueness signals, meta description presence/length, Open Graph and Twitter Card basics if Lighthouse surfaces them.
- **Mobile:** viewport meta, tap target sizing, legible font sizes — flag mobile/desktop divergences.
- **Structured data:** presence of JSON-LD, schema-org type coverage (only what Lighthouse exposes — do not invent issues).
- **Content signals exposed by Lighthouse:** heading order, image alt presence as it relates to discovery (a11y owns the WCAG framing).
- **i18n:** `hreflang` presence and reciprocity *only if* Lighthouse surfaces it; otherwise note as out of scope.

## Procedure

Follow the steps in [`../_shared/analysis-procedure.md`](../_shared/analysis-procedure.md). Skill-specific signal handling below.

### Load

Read these JSON files (highest-numbered run wins):
- `reports/.cache/<hostname>/lighthouse/<hostname>-mobile-run<N>.json` — required
- `reports/.cache/<hostname>/lighthouse/<hostname>-desktop-run<N>.json` — optional
- `reports/.cache/<hostname>/security/<hostname>-security-run<N>.json` — optional

From each Lighthouse JSON extract:
- `categories.seo.score`
- The audits referenced by `categories.seo.auditRefs[].id`

From the security JSON extract:
- `.robots_txt.found`, `.robots_txt.snippet`
- `.sitemap_xml.found`, `.sitemap_xml.snippet`
- `.http_redirect.upgrades_to_https`

If a Lighthouse audit has `scoreDisplayMode` of `"manual"` or `"notApplicable"`, skip it.

### Signal-to-finding map

| Source signal | `id` (stable) | `category` | severity |
|---|---|---|---|
| `audits['is-crawlable'].score < 1` | `seo-blocked-from-indexing` | crawlability | critical |
| `audits['http-status-code'].score < 1` | `seo-http-error-status` | crawlability | critical |
| `audits['robots-txt'].score < 1` | `seo-robots-txt-invalid` | crawlability | high |
| `audits['document-title'].score < 1` | `seo-missing-title` | metadata | high |
| `audits['canonical'].score < 1` | `seo-canonical-invalid` | indexability | high |
| `audits['viewport'].score < 1` | `seo-viewport-missing` | mobile | high |
| `audits['plugins'].score < 1` | `seo-flash-or-plugin-content` | content | high |
| `audits['hreflang'].score < 1` | `seo-hreflang-invalid` | i18n | medium |
| `audits['meta-description'].score < 1` | `seo-meta-description-missing` | metadata | medium |
| `audits['link-text'].score < 1` | `seo-generic-link-text` | content | medium |
| `audits['tap-targets'].score < 1` (mobile only) | `seo-tap-targets-too-small` | mobile | medium |
| `audits['font-size'].score < 1` | `seo-font-size-illegible` | mobile | low |
| `audits['structured-data']` (manual) | — | — | drop |
| security `.robots_txt.found == false` | `seo-no-robots-txt` | crawlability | low |
| security `.sitemap_xml.found == false` | `seo-no-sitemap` | crawlability | medium |
| `.http_redirect.upgrades_to_https == false` AND audited URL scheme was http | `seo-no-https-canonical` | indexability | high |

For any other Lighthouse SEO-category audit with `score < 1`: emit at `medium`, derive `category` from the audit's `group` (`seo-content` → content, `seo-crawl` → crawlability, `seo-mobile` → mobile). Derive `id` as `seo-<audit-id>`.

### Score formula

```
base = round(categories.seo.score * 100)            // mobile run

deductions = 0
if security.robots_txt.found == false:                       deductions += 5
if security.sitemap_xml.found == false:                      deductions += 10
if security.http_redirect.upgrades_to_https == false
   AND original URL scheme == "http":                        deductions += 10

score = max(0, base - deductions)
```

If `deductions > 0`, the `summary` must state the adjustment, e.g. *"Score adjusted from 92 to 82 to reflect a missing sitemap, which Lighthouse does not weight."*

### Skill-specific rules

- `references` should pull from `audit.description` only when Lighthouse provides a doc URL inside it. Otherwise empty.
- Mobile-only audits (`tap-targets`, `font-size`): if only the desktop run is available, **drop** the signal — do not synthesize a mobile value.

## Out of scope

- Backlink/authority analysis (no data available here)
- Content quality, keyword targeting, SERP positioning
- Anything not derivable from the listed artifacts — do not fabricate findings
