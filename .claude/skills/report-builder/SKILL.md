---
name: report-builder
description: Use when assembling the final HTML audit report from a hostname's five analyzer outputs under reports/analysis/<hostname>/. Emits one self-contained HTML file at reports/<hostname>-<ISO-timestamp>.html. Does not collect data and does not interpret findings — analyzer skills produce its inputs.
---

# report-builder

## Purpose

Merge the five per-dimension analyzer outputs for a hostname into a single professional, self-contained HTML report. The report-builder is the **only** skill that produces user-facing output — analyzers produce machine-readable JSON; this skill turns that into something stakeholders read.

Specifically:
- Aggregate the five analyzer scores into a headline score.
- Resolve cross-analyzer deferred findings so nothing is double-reported.
- Identify cross-cutting themes — fixes that move multiple dimensions at once.
- Produce an executive summary, a priority-ordered roadmap, and a complete action plan covering audiences from CTO to IC.
- Render to a self-contained HTML file that opens offline.

## Input artifacts

Read from `reports/analysis/<hostname>/`. For each dimension, glob `<dimension>-run*.json` and pick the highest `<N>`:

- `seo-run<N>.json`             — required
- `performance-run<N>.json`     — required
- `accessibility-run<N>.json`   — required
- `security-run<N>.json`        — required
- `best-practices-run<N>.json`  — required
- `manifest.json`               — optional; informational

If a dimension is missing, the report still builds — its section shows a "not analyzed" placeholder and a build warning lands in the Appendix. The headline score reflects only dimensions actually present.

Run the report-builder pre-flight defined in [`../_shared/output-artifacts.md`](../_shared/output-artifacts.md) before merging: hostname match, URL match (soft), schema conformance, deferral resolution. Pre-flight failures are user-facing — never silently drop a dimension.

## Output

```
reports/final/<hostname>/report-run<N>.json   # intermediate narrative state (this skill)
reports/final/<hostname>/report-run<N>.html   # rendered report (future HTML renderer)
```

- `<N>` is an append-only positive integer scoped to `<hostname>` — see [`../_shared/report-artifacts.md`](../_shared/report-artifacts.md) for the full naming convention and write protocol.
- The JSON is the Report state defined by [`sections-schema.md`](sections-schema.md). It **is** the input to the HTML rendering layer — no separate render-context file.
- JSON and HTML for the same run share the **same** `<N>`. The renderer reuses the JSON's run number; it does not pick a fresh one.
- The HTML is self-contained per the constraint in `CLAUDE.md` — CSS inlined from `templates/styles.css`, images as `data:` URIs, no CDN / external font / cross-origin asset. Renders offline.

This skill writes only the JSON. The HTML is produced by a separate renderer (a future skill) that reads the JSON written here.

## Report section structure

Fixed order. Consecutive reports of the same site are visually diffable when the order is stable.

The **data shape** of each section is defined normatively in [`sections-schema.md`](sections-schema.md). Cross-section invariants (action items as superset, severity/priority sums, verbatim-fields list, stable identifiers) live there too. This document defines render order and report-level concerns; structures are not duplicated.

Render order:

1. **Cover** — URL, hostname, audit timestamp, headline score band, five per-dimension score badges. One screen tall. Renderer chrome — not a schema section.
2. **Executive summary** — `sections-schema.md#executivesummary`.
3. **Severity overview** — `sections-schema.md#severityoverview`. Drives the score dashboard layout.
4. **Key findings** — `sections-schema.md#keyfindings`. Curated subset of the most important findings with full context.
5. **Per-dimension sections** — one each, in this fixed order: Performance → Accessibility → SEO → Security → Best practices. Each carries the analyzer's `summary`, the full sorted `findings` list grouped by `category`, the dimension's `metadata.artifacts_consumed` list, and any dimension-specific extensions (e.g. `manual_review_required` for accessibility).
6. **Prioritized roadmap** — `sections-schema.md#prioritizedroadmap`.
7. **Quick wins** — `sections-schema.md#quickwins`.
8. **Long-term improvements** — `sections-schema.md#longtermimprovements`. **Cross-cutting themes** (fixes whose recommendation overlaps across dimensions, ≥ 2 source findings required) live inside this section's `themes[]` array.
9. **Action items** — `sections-schema.md#actionitems`. Single source of truth for every finding.
10. **Appendix** — methodology, build warnings (gaps, unresolved deferrals, schema-invalid inputs), severity/priority/effort/score-band glossary pulled from [`../_shared/analyzer-schema.md`](../_shared/analyzer-schema.md) and `sections-schema.md`, and the full list of consumed artifacts.

## Analysis responsibilities

- **Resolve deferrals.** Walk every input's `metadata.extensions.deferred_to`, match against the receiving dimension's findings by `id`. Findings deferred into a dimension keep their owning analyzer's `dimension` label in the action plan — deferral assigns remediation ownership, not visual section placement.
- **Compute the headline score** as the **minimum** of the present-dimension scores. Missing dimensions are surfaced on the cover and dashboard, not silently defaulted.
- **Identify cross-cutting themes.** Group findings whose `recommendation` strings overlap meaningfully across dimensions (e.g. "Convert images to WebP" appearing in both performance and accessibility-as-bandwidth). At least two distinct source findings drawn from at least two dimensions required — never invent a theme from a single finding. Themes are emitted under `long_term_improvements.themes[]` per `sections-schema.md`.
- **Surface gaps visibly.** Missing analyzer outputs, schema-invalid inputs, unresolved `deferred_to` references — all appear under "Build warnings" in the Appendix. Never hide them in console logs.
- **Quote, do not paraphrase.** The action plan and per-dimension sections carry analyzer-emitted `evidence`, `impact`, and `recommendation` strings verbatim. The **only** generated prose in the report is the executive-summary text, the cross-cutting-themes section text, and the roadmap card body. Everything else is a render of analyzer output.

## Procedure

Build the Report state from the five analyzer outputs. Data shapes are normative in [`sections-schema.md`](sections-schema.md). Shared anti-hallucination gates and emit-format rules apply from [`../_shared/analysis-procedure.md`](../_shared/analysis-procedure.md).

The Report JSON is the deliverable of this procedure. HTML rendering is a separate step (a future procedure) that consumes the Report JSON.

### 1. Load and pre-flight

For each dimension in `[seo, performance, accessibility, security, best-practices]`:
- Glob `reports/analysis/<hostname>/<dimension>-run*.json`, pick the highest `<N>`.
- Parse JSON. On parse error or schema violation: add the dimension to `meta.dimensions_missing`, append a `build_warning` of the form `"<dimension>: <reason>"`, continue with the others.

If **no** inputs loaded: emit a Report with all sections at empty defaults and a single `build_warning` explaining nothing was found.

Cross-input checks (per `../_shared/output-artifacts.md` pre-flight):
- Reject an input whose `.hostname` does not match the directory hostname (hard error; that input is dropped with a warning).
- Soft-warn if `.url` differs across inputs.
- For each `.metadata.extensions.deferred_to` entry of the form `"<finding-id> -> <target-dimension>"`:
  - If the target dimension has a finding with that `id` → mark the **source-side** finding as ceded (it is dropped during merge).
  - Else → append an unresolved-deferral `build_warning`; the source-side finding remains in the merge.

Populate `meta.dimensions_analyzed` (successful loads) and `meta.dimensions_missing`. Their union must equal the five expected dimensions.

### 2. Merge

Build the **canonical finding list**:
- Walk every loaded analyzer output's `findings[]`, tag each with its parent `dimension`.
- Drop findings flagged ceded in step 1.

Build a `(dimension, id) → finding` lookup for use by every later section's `FindingRef` resolution.

### 3. Compute scores and bands

- `headline_score = min(score across dimensions_analyzed)` (per `output-artifacts.md`).
- Per-dimension `score_band` and `executive_summary.score_band` from the table in `sections-schema.md`: `≥90 excellent / ≥75 good / ≥50 needs-work / ≥25 poor / <25 critical`.

### 4. Infer `estimated_effort` per finding

Apply the decision flow. **First match wins** — deterministic, no ambiguity.

1. **Lead-verb override → `S`.** If `recommendation` starts (case-insensitive) with `Add `, `Set `, `Remove `, `Replace `, `Enable `, or `Disable ` **and** the recommendation is ≤ 200 chars → `S`.
2. **XL keywords.** If `recommendation` contains (case-insensitive) `redesign`, `architectural`, or `rebuild` → `XL`.
3. **L keywords.** If `recommendation` contains `refactor`, `rewrite`, `migrate`, or `restructure` → `L`.
4. **Category default:**

| Effort | Categories |
|---|---|
| **S** | `security.{transport, headers, redirect, information-disclosure}`; `seo.{crawlability, indexability, metadata, mobile}`; `accessibility.{robust}`; `performance.{network, caching}`; `best-practices.{browser-platform, trust-signals, protocol}` |
| **M** | `security.{mixed-content}`; `seo.{structured-data, content}`; `accessibility.{perceivable, operable, understandable}`; `performance.{render-blocking, css, images, core-web-vitals}`; `best-practices.{runtime-errors, deprecations, dependencies}` |
| **L** | `security.{dependencies}`; `seo.{i18n}`; `performance.{javascript, main-thread, third-party}` |

5. **Default** for any category not listed → `M`.

Store the result on the canonical-list entry. It drives quick-wins/long-term partition and theme effort rollup.

### 5. Assemble `action_items` (the superset)

Build this **first** — every other section references it.

- Sort the canonical list: `priority` (P0→P3) → `severity` (critical→info) → canonical dimension order (Performance, Accessibility, SEO, Security, Best practices).
- For each, emit an `ActionItem` per `sections-schema.md`. `ref.anchor` = `"#finding-<dimension>-<finding_id>"` (deterministic).
- `total` = length of the list. `sort` = `"priority,severity,dimension"`.

### 6. Assemble `severity_overview`

- `total_findings` = `action_items.total`.
- `by_severity` and `by_priority`: counts per level.
- `by_dimension`: one entry per analyzed dimension, with `score`, `score_band`, `finding_count`, per-dimension `by_severity`, and a generated `headline` (step 11c).

Sanity checks (run inline; bail with a quality-gate error if any fail): `by_severity` sums = `total_findings`; `by_priority` sums = `total_findings`; each `by_dimension[].by_severity` sums = its `finding_count`.

### 7. Assemble `key_findings`

- Filter canonical list to `priority ∈ {P0, P1}`.
- Sort: priority → severity → canonical dimension order.
- If `count(P0) > 10`: include **all** P0, skip P1 (never truncate a P0).
- Else: include all P0 + enough P1 to reach 10 items.
- For each entry, copy `evidence`, `impact`, `recommendation` **verbatim** — zero paraphrasing.

### 8. Assemble `prioritized_roadmap`

Build all four buckets, always present, in fixed order `[Now, Next, Later, Watch]`.

| Bucket | Priority | `items` | `summary` | `empty_state` |
|---|---|---|---|---|
| Now    | P0 | every P0 finding → RoadmapItem | `null` | `"No immediate-action items."` when empty |
| Next   | P1 | every P1 finding → RoadmapItem | `null` | `"No near-term items."` when empty |
| Later  | P2 | `[]` | `{ total, top_categories }` (top 3 P2 categories by finding count; alphabetical tiebreak) | `"Nothing scheduled for later."` when empty |
| Watch  | P3 | `[]` | `{ total, top_categories: null }` | `"Backlog is empty."` when empty |

`RoadmapItem.recommendation_short`: truncate the full recommendation to ≤ 120 chars at the last word boundary, append `…` only if truncated. Never cut mid-word.

### 9. Assemble `quick_wins`

Filter the canonical list:
- `severity ∈ {critical, high, medium}` (exclude low and info — not worth surfacing as a "win"),
- `estimated_effort ∈ {S, M}`,
- Recommendation is **one sentence** (heuristic: `recommendation.replace(/\. $/, '').split('. ').length <= 1`).

Sort: severity (critical first) → effort ascending (S before M) → canonical dimension order.

Cap at 8. If more qualify, prefer higher severity, then the dimension with the largest finding count (canonical order breaks final ties).

For each, generate `impact_summary` per step 11g.

### 10. Assemble `long_term_improvements`

**Items.** Filter canonical list to `estimated_effort ∈ {L, XL}`. Sort severity → canonical dimension order. For each, generate `scope_note` per step 11f.

**Themes.** Detect cross-cutting groups:

1. Build a **theme key** per finding: lowercase its `recommendation`, drop stopwords (`a, an, the, and, or, to, for, in, on, with, as, by, of, from, into, your, that`), then keep the **first two tokens of length ≥ 4** in document order. Join with `space`. Example: *"Convert images to WebP and add `loading=lazy`"* → key `"convert images"`.
2. Group findings by theme key.
3. Drop groups that fail **either**: fewer than 2 supporting findings, or all supporting findings come from the same `dimension`.
4. For each surviving group:
   - `title` and `description` are generated prose (steps 11d, 11e).
   - `theme_id` = `"theme-" + slugify(title)` — deterministic kebab-case from the title.
   - `spans_dimensions` = sorted unique list of source dimensions.
   - `supporting_finding_refs` = sorted FindingRefs (priority → severity → dimension).
   - `estimated_effort` = the highest effort across supporting findings (`XL > L > M > S`), with a minimum of `M`.

Sort `themes[]` by descending support count, ties broken by `theme_id` alphabetically.

### 11. Generate narrative prose

Generated prose appears **only** in the seven locations enumerated below. Everywhere else, copy analyzer fields verbatim. Each location has its own voice to avoid repetition across the report.

#### a. `executive_summary.headline_sentence`

Template:
> `"<Dimension-Title> drives this audit's headline: <issue>."`

Where `<Dimension-Title>` is the title-cased name of the top finding's dimension (Performance, Accessibility, SEO, Security, Best practices) and `<issue>` is the top finding's `issue` field verbatim. The "top finding" = first entry of `key_findings.findings`.

If `headline_score ≥ 90` and no P0/P1 exist:
> `"Audit passes with no immediate-action items; the highest-priority opportunities are listed below."`

#### b. `executive_summary.score_paragraph`

2–3 sentences, strict shape:

> `"The headline score is <score>/100 (<score_band>). <Worst-Dimension-Title> is the weakest dimension at <dim_score>/100, driven by <N> <highest-severity> finding(s)."`

If a second dimension is also below 75:

> Append: `" <Next-Weakest-Dimension-Title> follows at <dim_score>/100."`

Avoid the words *good*, *bad*, *best*, *worst* — they read as marketing. State facts.

#### c. `severity_overview.by_dimension[].headline`

One line, ≤ 120 chars. Pick by `score_band`:

| Band | Template |
|---|---|
| excellent | `"<N>/100 — no immediate-action items."` |
| good | `"<N>/100 — clean; <C> <highest-severity> finding(s) outstanding."` |
| needs-work | `"<N>/100 — <C> <highest-severity> finding(s); <dominant-category> is the dominant area."` |
| poor | `"<N>/100 — significant defects across <K> categories."` |
| critical | `"<N>/100 — critical: <C> P0 finding(s) require immediate action."` |

`<dominant-category>` = category with the most findings in this dimension. `<K>` = distinct-category count.

#### d. `long_term_improvements.themes[].title`

Title-case noun phrase, ≤ 80 chars. Use the mapping table; fall back to the formula when no entry matches.

| Tokens in theme key (any order) | Title |
|---|---|
| images, webp / images, modern / images, formats | `"Modernize Image Delivery"` |
| javascript, bundle / unused, javascript | `"Refactor the JavaScript Bundle"` |
| third-party, blocking / third-party, scripts | `"Reduce Third-Party Footprint"` |
| headers, security / strict, transport / content, security | `"Establish a Security Header Baseline"` |
| contrast, color / contrast, ratio | `"Address Color Contrast Across the Site"` |
| caching, ttl / cache, policy | `"Tune Caching Policy"` |
| labels, form / accessible, name | `"Label Interactive Elements"` |
| render-blocking, resources | `"Eliminate Render-Blocking Resources"` |

Fallback when no mapping matches: `"Address " + TitleCase(theme_key)`.

#### e. `long_term_improvements.themes[].description`

1–3 sentences, strict shape:

> `"This theme covers <N> findings across <comma-list of spans_dimensions in canonical order>. <one sentence describing what addressing the theme would unlock, derived from the union of source findings' 'impact' fields — no new claims>. <optional sentence: a single concrete reference quoted from the highest-priority supporting finding's 'evidence'>."`

The "what it unlocks" sentence may **only** restate consequences that appear in at least one source finding's `impact`. The optional `evidence` sentence is a verbatim quote, surrounded by quotation marks.

#### f. `long_term_improvements.items[].scope_note`

One sentence. Select the first matching template:

| Condition | Template |
|---|---|
| recommendation contains `refactor` | `"Requires refactoring the <category> layer."` |
| recommendation contains `migrate` | `"Requires migration off the affected technology."` |
| recommendation contains `rewrite` or `redesign` | `"Requires significant rework."` |
| `estimated_effort == "XL"` | `"Architectural change; budget multi-week effort."` |
| (default) | `"Multi-day effort; sequence after the immediate-action items."` |

#### g. `quick_wins.items[].impact_summary`

One short line, ≤ 100 chars, lead with the outcome. Derive from the source finding's `impact` only — no new claims.

Heuristic:
- If `impact` names a numeric measurement (e.g. `"LCP increases by 1.2 s"`): preserve the number → `"Removes 1.2 s of <topic>."`
- If `impact` names a population (e.g. `"Screen-reader users skip the navigation"`): outcome → `"Restores <thing> for <population>."`
- Otherwise: take the first sentence of `impact`, truncate to 100 chars with `…` only if needed.

#### Anti-repetition rule

Within a single Report, no two sections may emit the **identical sentence** as generated prose. If the executive summary's `headline_sentence` is by construction also the natural phrasing of a dimension `headline`, vary the dimension headline by foregrounding the count instead of the issue (use the band-specific template). The seven distinct templates above are designed so this rule is satisfied automatically when followed literally.

### 12. Quality gates — run before emitting

| Check | Failure mode |
|---|---|
| Every `FindingRef` in any section resolves to an entry in `action_items.items` | Dangling reference |
| `severity_overview.by_severity` sum == `severity_overview.by_priority` sum == `action_items.total` | Sum mismatch |
| Each `severity_overview.by_dimension[].by_severity` sums to its `finding_count` | Per-dimension count mismatch |
| `key_findings.count` ≤ 10 **or** equals the count of P0 findings when that exceeds 10 | KeyFindings overflow |
| All four roadmap buckets present; `Now`/`Next` have `summary: null`; `Later`/`Watch` have `items: []` | Roadmap shape violation |
| Every `quick_wins.items[].estimated_effort` ∈ `{S, M}` | Quick-wins effort violation |
| Every `long_term_improvements.items[].estimated_effort` ∈ `{L, XL}` | Long-term effort violation |
| No `(dimension, finding_id)` pair appears in both `quick_wins.items` and `long_term_improvements.items` | Effort-disjoint violation |
| Every theme has ≥ 2 `supporting_finding_refs` from ≥ 2 distinct dimensions | Single-source theme |
| Generated prose appears **only** in the seven enumerated locations | Verbatim violation |
| `executive_summary.next_step` is verbatim from the top P0 (or top P1 when no P0) finding's `recommendation` | Paraphrasing |
| `key_findings.findings[].{evidence, impact, recommendation}` are verbatim from the source analyzer output | Paraphrasing |
| `meta.dimensions_analyzed` ∪ `meta.dimensions_missing` == the five expected dimensions | Dimension set incomplete |

Any failure: stop and emit a Report with `meta.build_warnings` describing the failed gate. Never emit a partially-correct report silently.

### 13. Emit and persist

Emit a single JSON object matching the top-level Report schema in `sections-schema.md`. Apply the emit-format rules from [`../_shared/analysis-procedure.md`](../_shared/analysis-procedure.md) §9:

- No prose outside the JSON.
- 2-space indent, LF line endings, UTF-8 no BOM.
- `null` for absent string fields; `[]` for empty arrays.
- ISO-8601 UTC for `meta.audited_at` and `meta.generated_at`.

Persist to the canonical path per [`../_shared/report-artifacts.md`](../_shared/report-artifacts.md):

```
reports/final/<hostname>/report-run<N>.json
```

Use one of these mechanisms:

1. **Preferred** — pipe to the helper, which validates and assigns `<N>`:
   ```bash
   bash scripts/save-report.sh <hostname>
   ```
   stdin: the Report JSON; stdout: the final path. Non-zero exit on validation failure — treat as a hard error.

2. **Direct write** — Write tool after computing `<N>` as the lowest integer such that `report-run<N>.json` does not yet exist. Apply the atomic-write protocol from `report-artifacts.md` (write `.tmp` then `mv`).

Emit the final relative path on stdout so the caller (orchestrator or HTML renderer) can locate the file. The downstream HTML renderer reads this JSON and writes `report-run<N>.html` alongside it, reusing the same `<N>`.

## Out of scope

- Data collection — owned by `scripts/run-*.sh`.
- Finding interpretation — owned by the five analyzer skills.
- Delivery (email, upload, share link) — the HTML file is the deliverable.
- Multi-page audits — single URL is the unit of work; multi-page is a future enhancement.
- Cross-run comparison and trend tracking — each report is single-run; diffs are done out-of-band against prior `reports/*.html` files.
