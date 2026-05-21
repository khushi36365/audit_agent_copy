---
name: accessibility-analyzer
description: Use when interpreting accessibility findings from a cached audit run. Reads Lighthouse accessibility-category audits under reports/.cache/<hostname>/lighthouse/ and emits a structured per-finding analysis mapped to WCAG criteria. Does not collect data — the lighthouse runner produces the inputs.
---

# accessibility-analyzer

## Purpose

Turn Lighthouse's axe-core-backed accessibility audits into prioritized, WCAG-mapped findings. Surface what was detected, explain who is affected and how, and flag the categories of failure that automated tools cannot detect so reviewers know where manual testing is still required.

## Input artifacts

Read from `reports/.cache/<hostname>/lighthouse/`. Pick the highest-numbered run pair.

- `<hostname>-mobile-run<N>.json` — primary source; touch-target audits are mobile-specific
- `<hostname>-desktop-run<N>.json` — comparison; some failures only manifest on one form factor

Within each Lighthouse JSON:
- `categories.accessibility.score`
- All audits under the `accessibility` category group, especially: `'color-contrast'`, `'image-alt'`, `'label'`, `'link-name'`, `'button-name'`, `'aria-*'`, `'heading-order'`, `'html-has-lang'`, `'tabindex'`, `'meta-viewport'`, `'tap-targets'` (mobile only)
- `audits[<id>].details.items` — the specific failing nodes (selector, snippet, explanation)

If an artifact is missing, record it in `metadata.gaps`.

## Output schema

This skill emits the canonical analyzer output defined in [`../_shared/analyzer-schema.md`](../_shared/analyzer-schema.md). That document is normative for field shapes, severity/priority semantics, sort order, and the extension registry. Per-skill specifics only:

- **`dimension`:** `"accessibility"`
- **`category` enum:** `"perceivable" | "operable" | "understandable" | "robust"` (the WCAG POUR principles)
- **`score` derivation:** `categories.accessibility.score` × 100 from the form factor that scored **lower** (worst-case reporting).
- **Tiebreaker** (within a priority/severity tier): descending failing-node count from `audit.details.items.length`.
- **Extensions used:**
  - `findings[].extensions.wcag` — array of WCAG 2.1 success-criterion numbers Lighthouse mapped (e.g. `["1.4.3"]`). Empty array allowed; **do not invent mappings Lighthouse did not provide**.
  - `metadata.extensions.manual_review_required` — array of accessibility categories that automated tooling cannot verify (screen-reader UX, focus order beyond DOM order, caption quality, error-message clarity, motion sensitivity, cognitive load). This array appears on **every** accessibility report.

`summary` must include the automated-coverage caveat — Lighthouse + axe catch roughly a third of WCAG failures.

`evidence` should quote failing selectors and snippets from `audit.details.items`, capped at ~3 examples per finding.

## Analysis responsibilities

- **Map each Lighthouse failure to one or more WCAG 2.1 success criteria** — do not invent mappings; if Lighthouse does not link a criterion, leave `wcag` empty rather than guess.
- **Quote the offending nodes**, but cap at ~3 examples per finding — the report is a prompt for action, not a dump.
- **Cross-form-factor diffs:** `tap-targets` and viewport-related failures are mobile-only; do not synthesize them for desktop.
- **Severity calibration:**
  - critical: blocks the workflow for at least one population (e.g. no keyboard focus, no form labels)
  - high: major barrier, workaround exists (low contrast, ambiguous link text)
  - medium: degraded experience (heading order, missing landmark)
  - low: code-quality nit (redundant aria, deprecated role)
- **Populate `manual_review_required`** with the standard list of axe blind spots: screen reader UX, focus order beyond DOM order, video captions, error-message clarity, motion-sensitivity, cognitive load. These should appear in every report.

## Procedure

Follow the steps in [`../_shared/analysis-procedure.md`](../_shared/analysis-procedure.md). Skill-specific signal handling below.

### Load

Read these JSON files (highest-numbered run pair wins):
- `reports/.cache/<hostname>/lighthouse/<hostname>-mobile-run<N>.json` — required
- `reports/.cache/<hostname>/lighthouse/<hostname>-desktop-run<N>.json` — optional

Extract `categories.accessibility.score` and all audits referenced by `categories.accessibility.auditRefs[].id`. For each failing audit collect every `details.items[]` (selector, snippet, explanation, `impact`).

### Severity — first try axe impact

Lighthouse passes axe-core's `impact` through `audits[x].details.items[i].impact`. When present, map directly:

| axe impact | severity |
|---|---|
| `critical` | critical |
| `serious`  | high |
| `moderate` | medium |
| `minor`    | low |

A finding's severity is the **worst** impact across its items.

### Audit-ID fallback — when axe impact is missing

| Audit ID | `category` | severity |
|---|---|---|
| `color-contrast` | perceivable | high |
| `image-alt`, `input-image-alt`, `object-alt` | perceivable | high |
| `label`, `button-name`, `link-name`, `select-name` | operable | high |
| `aria-required-attr`, `aria-valid-attr`, `aria-valid-attr-value`, `aria-allowed-attr` | robust | medium |
| `aria-hidden-focus`, `aria-hidden-body` | operable | high |
| `aria-roles` | robust | medium |
| `heading-order` | perceivable | medium |
| `html-has-lang`, `html-lang-valid` | understandable | medium |
| `meta-viewport` | operable | high |
| `tabindex` | operable | high |
| `tap-targets` (mobile only) | operable | medium |
| `duplicate-id-aria`, `duplicate-id-active` | robust | medium |
| `bypass` (skip link) | operable | medium |
| `frame-title` | perceivable | medium |

For any other failing audit with no axe impact, emit at `medium`. Choose `category` by mapping the WCAG criterion: `1.x` → perceivable, `2.x` → operable, `3.x` → understandable, `4.x` → robust. `id` is `a11y-<audit-id>`.

### Evidence

For each finding, quote **up to 3** items from `details.items[]`:
- the CSS selector
- the first ~80 chars of the snippet

Cap at 3 even when more failures exist. In `impact`, include the total node count: *"Affects 12 elements on the page, including ..."*.

### Extensions

- `findings[].extensions.wcag` — populate from `audit.description` only when it explicitly names a WCAG success criterion (e.g. the audit text contains `"WCAG 1.4.3"`). **Do not invent mappings.** If no criterion is named, emit `[]`.
- `metadata.extensions.manual_review_required` — emit the same canonical array on every report:
  - `"Screen-reader announcement quality"`
  - `"Focus order beyond DOM order"`
  - `"Video and audio captions"`
  - `"Error-message clarity"`
  - `"Motion and animation sensitivity"`
  - `"Cognitive load and reading level"`

### Score formula

```
mobile  = round(mobile.categories.accessibility.score * 100)
desktop = round(desktop.categories.accessibility.score * 100)   // null if absent
score   = min(mobile, desktop)                                    // worst-case; ignore nulls
```

### Skill-specific rules

- `summary` must include the automated-coverage caveat: *"Automated tooling detects roughly a third of WCAG failures; manual review is required for the categories listed in `manual_review_required`."*
- `impact` must name the affected population: screen-reader users, keyboard-only users, low-vision users, motor-impaired users.

## Out of scope

- Manual screen-reader testing (state in `manual_review_required` that it is still needed)
- Subjective content-quality judgments
- VPAT generation
- Inventing WCAG mappings Lighthouse did not provide
