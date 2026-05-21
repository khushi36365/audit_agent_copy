# Report Section Schemas

Canonical data shapes for the report-builder's intermediate state. The builder reads the five analyzer outputs (per `../_shared/analyzer-schema.md`), merges them, then assembles a `Report` object matching the schemas in this document before rendering to HTML.

This document defines **structure only**. Render order, styling, HTML markup, and the heuristics that derive fields like `estimated_effort` are out of scope here — they live in [`SKILL.md`](SKILL.md).

When this document and `SKILL.md` disagree, this document wins for data shapes; `SKILL.md` wins for render rules and inference logic.

---

## Top-level Report

```json
{
  "meta":                    ReportMeta,
  "executive_summary":       ExecutiveSummary,
  "severity_overview":       SeverityOverview,
  "key_findings":            KeyFindings,
  "prioritized_roadmap":     PrioritizedRoadmap,
  "quick_wins":              QuickWins,
  "long_term_improvements":  LongTermImprovements,
  "action_items":            ActionItems
}
```

Every section is **required**. If input data does not support a section (e.g. no findings exist), emit the section with `count: 0` and required keys at empty/null defaults. Never omit a section — the renderer relies on the shape being complete.

---

## Shared types

### Severity / priority

Imported verbatim from `../_shared/analyzer-schema.md`. No redefinition here.

- `severity`: `"critical" | "high" | "medium" | "low" | "info"`
- `priority`: `"P0" | "P1" | "P2" | "P3"`

### Score band

Derived deterministically from a 0–100 `score`:

| Score range | Band |
|---|---|
| `score >= 90`         | `"excellent"`   |
| `75 <= score < 90`    | `"good"`        |
| `50 <= score < 75`    | `"needs-work"`  |
| `25 <= score < 50`    | `"poor"`        |
| `score < 25`          | `"critical"`    |

### Effort scale

T-shirt sizing for `estimated_effort`. The report-builder SKILL.md owns the inference rules; this document declares only the value set:

| Value | Meaning |
|---|---|
| `"S"`  | Under one hour. Single config line, single tag, single header value. |
| `"M"`  | Half-day to one day. Small refactor, build-step change, batched asset conversion. |
| `"L"`  | Multi-day. Refactor an area, restructure a component, dependency migration. |
| `"XL"` | Multi-week. Rewrite or architectural change. |

### FindingRef

A pointer back to a finding inside one of the analyzer outputs. Used wherever a section item must link to the canonical finding entry.

```json
{
  "finding_id":  "<finding.id from analyzer output>",
  "dimension":   "seo | performance | accessibility | security | best-practices",
  "anchor":      "#finding-<dimension>-<finding_id>"
}
```

`anchor` is the in-page HTML anchor of the finding's full entry in its per-dimension section. The slug is deterministic — same inputs produce the same anchor across builds.

---

## ReportMeta

```json
{
  "url":                  "https://example.com/path",
  "hostname":             "example.com",
  "audited_at":           "ISO-8601 UTC — earliest analyzer.metadata.analyzed_at",
  "generated_at":         "ISO-8601 UTC — this build",
  "run_id":               "string | null — from manifest.json when present",
  "dimensions_analyzed":  ["performance", "accessibility", "seo", "security", "best-practices"],
  "dimensions_missing":   [],
  "build_warnings":       ["one-line strings; surfaced in the Appendix"]
}
```

`dimensions_analyzed` ∪ `dimensions_missing` always equals the full set of five.

---

## ExecutiveSummary

A one-screen narrative. Strict structure:

```json
{
  "headline_score":     0,
  "score_band":         "excellent | good | needs-work | poor | critical",
  "headline_sentence":  "one sentence — the single most important issue",
  "score_paragraph":    "2-3 sentences: score, worst-scoring dimension, dominant driver",
  "top_issues": [
    {
      "ref":         FindingRef,
      "issue":       "<finding.issue>",
      "priority":    "P0 | P1",
      "severity":    "critical | high | medium | low | info",
      "dimension":   "<dimension>"
    }
  ],
  "next_step":          "one sentence, verbatim from the top P0 recommendation (or top P1 if no P0)"
}
```

Constraints:

- `top_issues` contains **3 to 5 items**, all of which are P0 or P1. If fewer than 3 P0/P1 findings exist, the array is shorter; never pad with lower-priority items.
- `headline_score` = minimum of the present-dimension scores (per `../_shared/output-artifacts.md`).
- `next_step` is a **verbatim quote** from the source finding's `recommendation`. No paraphrasing.

---

## SeverityOverview

The numerical bird's-eye view that drives the score dashboard.

```json
{
  "total_findings":   0,
  "by_severity": {
    "critical": 0,
    "high":     0,
    "medium":   0,
    "low":      0,
    "info":     0
  },
  "by_priority": {
    "P0": 0,
    "P1": 0,
    "P2": 0,
    "P3": 0
  },
  "by_dimension": [
    {
      "dimension":      "<dimension>",
      "score":          0,
      "score_band":     "excellent | good | needs-work | poor | critical",
      "finding_count":  0,
      "by_severity":    { "critical": 0, "high": 0, "medium": 0, "low": 0, "info": 0 },
      "headline":       "one-line 'what is driving the score', max 120 chars"
    }
  ]
}
```

Constraints:

- `by_dimension` contains exactly one entry **per analyzed dimension**. Missing dimensions appear in `meta.dimensions_missing`, never as zero-filled entries here.
- `by_severity` integers sum to `total_findings`.
- `by_priority` integers sum to `total_findings`.
- Each `by_dimension[].by_severity` sums to that dimension's `finding_count`.

---

## KeyFindings

Top findings across all dimensions, surfaced with full context. Distinct from the executive summary (shorter, headline-only) and action items (full table).

```json
{
  "criteria":   "All P0 plus the top P1 entries, capped at 10 items total",
  "count":      0,
  "findings": [
    {
      "ref":             FindingRef,
      "dimension":       "<dimension>",
      "issue":           "<finding.issue>",
      "category":        "<finding.category>",
      "priority":        "P0 | P1",
      "severity":        "critical | high | medium | low | info",
      "evidence":        "<finding.evidence>",
      "impact":          "<finding.impact>",
      "recommendation":  "<finding.recommendation>"
    }
  ]
}
```

Constraints:

- Cap `count` at 10. If P0 alone exceeds 10, **include all P0** anyway and skip P1 — never truncate a P0.
- Sort: `priority` (P0 first) → `severity` (critical first) → canonical dimension order (Performance, Accessibility, SEO, Security, Best practices).
- `evidence`, `impact`, `recommendation` are **verbatim** from the analyzer output.

---

## PrioritizedRoadmap

Time-ordered fix sequence, bucketed by priority.

```json
{
  "buckets": [
    RoadmapBucket,   // Now / P0
    RoadmapBucket,   // Next / P1
    RoadmapBucket,   // Later / P2
    RoadmapBucket    // Watch / P3
  ]
}
```

Where `RoadmapBucket` is:

```json
{
  "label":         "Now | Next | Later | Watch",
  "priority":      "P0 | P1 | P2 | P3",
  "count":         0,
  "items":         [ RoadmapItem, ... ],
  "summary":       RoadmapSummary | null,
  "empty_state":   "Display string when count == 0, e.g. 'No immediate-action items.' Null when count > 0."
}
```

`RoadmapItem`:

```json
{
  "ref":                    FindingRef,
  "issue":                  "<finding.issue>",
  "dimension":              "<dimension>",
  "severity":               "<severity>",
  "recommendation_short":   "<recommendation, truncated to <= 120 chars; ends with '…' if truncated>"
}
```

`RoadmapSummary`:

```json
{
  "total":            0,
  "top_categories":   ["javascript", "images", "headers"]   // up to 3, descending by finding count; null when not applicable
}
```

Constraints:

- `Now` (P0) and `Next` (P1) buckets populate `items` fully; `summary` is `null` in those buckets.
- `Later` (P2) bucket leaves `items: []` and populates `summary`.
- `Watch` (P3) bucket leaves `items: []`; `summary.top_categories` may be `null` (count-only).
- All four buckets are always present, even when `count == 0`. The empty bucket renders `empty_state`.

---

## QuickWins

Findings the report-builder classifies as low-effort with meaningful impact. The selection heuristic is owned by `SKILL.md`.

```json
{
  "criteria":  "Single-sentence imperative recommendation in a fast-fix category, severity >= medium",
  "count":     0,
  "items": [
    {
      "ref":                  FindingRef,
      "issue":                "<finding.issue>",
      "dimension":            "<dimension>",
      "severity":             "<severity>",
      "recommendation":       "<finding.recommendation>",
      "estimated_effort":     "S | M",
      "impact_summary":       "one line, derived from finding.impact — no new claims"
    }
  ]
}
```

Constraints:

- `estimated_effort` for a quick win is always `"S"` or `"M"`. Anything `"L"` or larger belongs in `long_term_improvements`.
- A finding **may appear in both** `quick_wins` and `key_findings` — quick wins is a curated cross-section, not a partition.
- `impact_summary` must be derivable from the source finding's `impact` field. No invented consequences.
- Cap `count` at 8. If more qualify, prefer higher severity, then broader reach.

---

## LongTermImprovements

Strategic work: high-effort findings plus cross-cutting themes that span multiple dimensions.

```json
{
  "themes": [
    {
      "theme_id":                "kebab-case-stable-slug",
      "title":                   "noun phrase, max 80 chars",
      "description":             "1-3 sentences: what the theme is and what it would unlock",
      "spans_dimensions":        ["performance", "accessibility"],
      "supporting_finding_refs": [ FindingRef, ... ],
      "estimated_effort":        "M | L | XL"
    }
  ],
  "items": [
    {
      "ref":                  FindingRef,
      "issue":                "<finding.issue>",
      "dimension":            "<dimension>",
      "severity":             "<severity>",
      "estimated_effort":     "L | XL",
      "scope_note":           "one sentence: why this is long-term (e.g. 'requires ESM migration')"
    }
  ]
}
```

Constraints:

- A theme requires **at least 2** distinct `supporting_finding_refs`, drawn from **at least 2** distinct dimensions. Single-finding themes are forbidden.
- `themes[].title` and `themes[].description` are generated prose. Every other field references analyzer data verbatim.
- `items[].estimated_effort` is `"L"` or `"XL"` only. `"M"` belongs in `quick_wins`; `"S"` is too small to surface here.
- `themes` may be `[]`. `items` may be `[]`. Both empty is valid — the section renders an empty-state message.
- `theme_id` is a deterministic kebab-case slug derived from `title`; two builds over the same inputs produce the same `theme_id`.

---

## ActionItems

The single source of truth for every finding in the report. Strict superset of every other section.

```json
{
  "total":  0,
  "sort":   "priority,severity,dimension",
  "items": [
    {
      "ref":              FindingRef,
      "priority":         "<priority>",
      "severity":         "<severity>",
      "dimension":        "<dimension>",
      "category":         "<finding.category>",
      "issue":            "<finding.issue>",
      "recommendation":   "<finding.recommendation>"
    }
  ]
}
```

Constraints:

- `total` equals the total findings across all analyzer outputs, **minus** any finding deferred away via `metadata.extensions.deferred_to` (the receiving analyzer's copy is the canonical one).
- Sort: priority (P0 first) → severity (critical first) → canonical dimension order.
- **Every** finding referenced from any other section appears here. The reverse is not true — a finding may live in `action_items` without appearing in `key_findings`, `quick_wins`, etc.
- `recommendation` is verbatim. Do not truncate.

---

## Cross-section invariants

These invariants make the report internally consistent and the build deterministic:

1. **Action items is the superset.** Every `FindingRef` used in any other section must resolve to an entry in `action_items.items`. Dangling refs are a build error.
2. **Roadmap is a partition.** A finding appears in exactly one bucket of `prioritized_roadmap` — the bucket matching its `priority`.
3. **Quick-wins overlap is allowed.** Quick wins is a curated cross-section, not a partition — a P1 finding can simultaneously appear in `key_findings`, `quick_wins`, the P1 roadmap bucket, and `action_items`.
4. **Quick wins and long-term items are effort-disjoint.** A finding's `estimated_effort` places it in `quick_wins` (S/M) **or** `long_term_improvements.items` (L/XL) — never both.
5. **Themes are not findings.** `long_term_improvements.themes[]` carries generated prose backed by ≥ 2 source findings drawn from ≥ 2 dimensions. Themes have a `theme_id`, not a `finding_id`, and never appear in `action_items`.
6. **Severity and priority sums match.** `severity_overview.by_severity` and `by_priority` each sum to `total_findings`, which equals `action_items.total`.
7. **Verbatim fields are verbatim.** `evidence`, `impact`, `recommendation` from analyzer findings are quoted as-is wherever they appear. Generated prose is confined to: `executive_summary.headline_sentence`, `executive_summary.score_paragraph`, `severity_overview.by_dimension[].headline`, `long_term_improvements.themes[].title`, `long_term_improvements.themes[].description`, `long_term_improvements.items[].scope_note`, and `quick_wins.items[].impact_summary` (derived from `impact`, no new claims).
8. **Stable identifiers.** `theme_id` and `FindingRef.anchor` are deterministic across builds. Anchors follow `#finding-<dimension>-<finding_id>`; theme ids are kebab-case slugs derived from `title`.
