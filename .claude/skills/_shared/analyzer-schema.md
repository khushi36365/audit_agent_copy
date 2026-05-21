# Analyzer Output Schema

Single source of truth for the JSON every analyzer skill emits. All five analyzers (`seo-analyzer`, `performance-analyzer`, `accessibility-analyzer`, `security-auditor`, `best-practices-analyzer`) **must** conform. The report-builder consumes this shape and renders it without per-dimension special-casing.

This document is normative. When a SKILL.md and this file disagree, this file wins.

---

## Top-level schema

```json
{
  "dimension":   "seo | performance | accessibility | security | best-practices",
  "url":         "https://example.com/path",
  "hostname":    "example.com",
  "score":       0,
  "summary":     "2-4 sentence executive summary.",
  "findings":    [ Finding, ... ],
  "metadata": {
    "analyzed_at":        "ISO-8601 UTC, e.g. 2026-05-12T10:14:23Z",
    "artifacts_consumed": ["reports/.cache/<host>/.../foo.json", "..."],
    "gaps":               ["expected-but-missing artifact path", "..."],
    "extensions":         { /* optional, skill-defined; see registry below */ }
  }
}
```

| Field                       | Type           | Required | Notes |
|----------------------------|----------------|----------|-------|
| `dimension`                | enum           | yes      | One of the five fixed values. |
| `url`                      | string         | yes      | The audited URL. |
| `hostname`                 | string         | yes      | Bare hostname, no scheme or path. |
| `score`                    | integer 0–100  | yes      | Rolled-up score. Derivation per skill (see SKILL.md). |
| `summary`                  | string         | yes      | 2–4 sentences, written for a non-engineer reader. |
| `findings`                 | array<Finding> | yes      | May be empty. Sort order is mandatory (see below). |
| `metadata.analyzed_at`     | string         | yes      | ISO-8601 UTC. |
| `metadata.artifacts_consumed` | array<string> | yes  | Relative paths. |
| `metadata.gaps`            | array<string>  | yes      | Empty array if no gaps. |
| `metadata.extensions`      | object         | no       | Analyzer-wide skill-specific data. |

---

## Finding schema

```json
{
  "id":             "kebab-case-stable-id",
  "issue":          "Short noun phrase describing the problem",
  "category":       "skill-defined subcategory",
  "severity":       "critical | high | medium | low | info",
  "priority":       "P0 | P1 | P2 | P3",
  "evidence":       "Concrete data quoted from the artifacts",
  "impact":         "Who or what is affected and how",
  "recommendation": "Specific actionable fix",
  "references":     ["https://...", "..."],
  "extensions":     { /* optional, skill-defined; see registry below */ }
}
```

| Field            | Type          | Required | Notes |
|------------------|---------------|----------|-------|
| `id`             | string        | yes      | kebab-case. **Stable across runs** for the same underlying signal — used for deduplication. Derive from the audit/signal id, not from the evidence text. |
| `issue`          | string        | yes      | Noun phrase, not a sentence. ≤ 80 chars. e.g. `"Missing canonical link"`. |
| `category`       | string        | yes      | Subcategory within the dimension. Each skill declares its enum in its SKILL.md. |
| `severity`       | enum          | yes      | See Severity. |
| `priority`       | enum          | yes      | See Priority. |
| `evidence`       | string        | yes      | Must quote actual data from artifacts. No paraphrasing of numbers. |
| `impact`         | string        | yes      | Plain language. Names the affected population (users, crawlers, screen-reader users, etc.). |
| `recommendation` | string        | yes      | Specific. Include concrete values when the standard prescribes one (`max-age=31536000`, `Cache-Control: public, max-age=...`). |
| `references`     | array<string> | yes      | Doc/spec URLs. Empty array allowed. |
| `extensions`     | object        | no       | Per-finding skill-specific data. |

---

## Severity levels

Severity describes the **technical magnitude of the defect itself**. Identical definitions across all dimensions — this keeps the report comparable across pages.

| Level      | When to use                                                                     | Examples |
|------------|----------------------------------------------------------------------------------|----------|
| `critical` | Active failure, security exposure, or total breakage for at least one population | Expired TLS cert; page-blocking JS error; form has no labels at all |
| `high`     | Major degradation or compliance failure with measurable harm                     | LCP > 4 s on mobile; missing HSTS; heading order completely broken |
| `medium`   | Noticeable degradation; partial compliance                                       | Missing meta description; no `Permissions-Policy`; low contrast on non-critical text |
| `low`      | Minor nit; hygiene/correctness issue with little user impact                     | Deprecated console warning; redundant ARIA role |
| `info`     | Observation, not a defect. Informational only.                                   | "robots.txt allows all crawlers"; "modern image formats already in use" |

---

## Priority levels

Priority describes **when** the issue should be addressed. Severity is one input; **reach** (how many users / pages affected), **ease of fix**, and **blast radius of the fix** are others.

| Level | When to use |
|-------|-------------|
| `P0`  | Address immediately. Security incidents, production-blocking defects, compliance violations with legal exposure. |
| `P1`  | Address in the next release/sprint. High-severity defects, or medium-severity defects with high reach. |
| `P2`  | Plan for the current quarter. Medium-severity defects; low-severity defects with broad reach. |
| `P3`  | Backlog. Low-severity defects, info items worth tracking. |

### Default mapping (severity → priority)

When reach and ease-of-fix are unknown or unremarkable, use the default:

| Severity   | Default priority |
|------------|------------------|
| `critical` | `P0` |
| `high`     | `P1` |
| `medium`   | `P2` |
| `low`      | `P3` |
| `info`     | `P3` |

### When to override the default

Override only when one of these applies. The reason for the override **must** appear in `impact` or `recommendation` — never bury the reasoning.

- **Reach bump (+1):** a low-severity issue present on every page → priority up one level.
- **Scope demote (−1):** a high-severity issue confined to a deprecated subpath or a non-production surface → priority down one level.
- **Quick-win bump (+1):** a one-line fix (single header, single tag) sitting at medium severity — quick wins should land first.
- **Compliance lock (P0):** any finding that violates a written legal/contractual obligation is `P0` regardless of severity.

---

## Shared analysis conventions

1. **Evidence is mandatory and must be quoted.** If a value comes from `audits['x'].details.items[0].selector`, the selector text appears verbatim in `evidence`. Numbers are not paraphrased.

2. **No fabrication.** If an artifact does not contain a value, do not infer it. Record the missing artifact in `metadata.gaps`. Do not synthesize cross-form-factor data (e.g. do not invent desktop numbers when only mobile ran).

3. **Recommendations are specific and actionable.** "Add a `Content-Security-Policy` header with at least `default-src 'self'`" — not "improve security headers". Include the concrete value the standard prescribes when one exists.

4. **`issue` is a noun phrase.** "Missing canonical link" — not "The page is missing a canonical link element." The report-builder uses this as a heading.

5. **`id` is stable across runs.** Two analyses over the same artifact set produce the same `id` for the same finding. Derive from the underlying audit id (e.g. Lighthouse `audit.id`) or a fixed slug for skill-specific signals (`tls-protocol-outdated`). Do not hash the evidence text.

6. **`category` is a skill-defined enum.** Each SKILL.md declares its category set. Do not invent categories per finding.

7. **Sort order is mandatory:** `findings` sorted by `priority` (`P0` → `P3`), then by `severity` (`critical` → `info`), then by the skill-defined tiebreaker. The report-builder relies on this order.

8. **Deduplication boundary:** when two analyzers would surface the same finding, the analyzer that owns the *remediation* keeps it as a `finding`. The other adds an entry to `metadata.extensions.deferred_to` (an array of strings of the form `"<finding-id> -> <other-dimension>"`) instead of duplicating the finding. See each SKILL.md's "Coordination" notes for ownership rules.

9. **`score` is 0–100.** Each SKILL.md defines its derivation. Score is not a sum of severities — it is the upstream tool's rollup (Lighthouse category score, or a control-coverage rollup) adjusted only for signals the tool does not weight. Document the adjustment.

10. **`summary` is for humans.** 2–4 sentences. Lead with the most important finding. Do not list every category. Avoid jargon unless the reader has to deal with the jargon to fix the issue.

11. **Empty findings is a valid result.** If everything passes, emit `findings: []` and a `summary` that says so. Do not invent low-priority noise to fill space.

---

## Extension registry

Skills may add fields under `metadata.extensions.<key>` (analyzer-wide) or `findings[].extensions.<key>` (per-finding). Reserved keys currently in use:

| Key                       | Owner                    | Location          | Type            | Meaning |
|---------------------------|--------------------------|-------------------|-----------------|---------|
| `wcag`                    | accessibility-analyzer   | finding           | array<string>   | WCAG 2.1 success criteria, e.g. `["1.4.3", "2.4.6"]`. Empty array allowed. |
| `manual_review_required`  | accessibility-analyzer   | analyzer metadata | array<string>   | Categories Lighthouse cannot verify; appears on every accessibility report. |
| `savings_ms`              | performance-analyzer     | finding           | number          | Lighthouse-reported potential savings, milliseconds. |
| `savings_bytes`           | performance-analyzer     | finding           | number          | Lighthouse-reported potential byte savings. |
| `cwv_metric`              | performance-analyzer     | finding           | string          | Linked Core Web Vital: `"lcp" \| "inp" \| "cls"`. |
| `cve`                     | security-auditor         | finding           | array<string>   | CVE IDs **only when** Lighthouse provided them. No fabrication. |
| `deferred_to`             | any analyzer             | analyzer metadata | array<string>   | Findings ceded to another analyzer per the dedup boundary. |

**Adding a new extension key:** add a row to this table in the same change that introduces it. An extension key that is not in this registry is a contract violation.
