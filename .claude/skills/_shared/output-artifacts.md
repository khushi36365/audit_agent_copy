# Analyzer Output Artifacts

Where analyzer outputs go on disk, how they are named, and the invariants that let the report-builder merge them deterministically.

- `analyzer-schema.md` defines **what** an analyzer emits (the JSON shape).
- `analysis-procedure.md` defines **how** an analyzer interprets inputs.
- **This document** defines **where** outputs go, how they are named, and how the report-builder finds them.

When this doc and a SKILL.md disagree, this doc wins.

---

## Directory layout

```
reports/
├── .cache/                          # collector outputs (deterministic data)
│   └── <hostname>/
│       ├── lighthouse/
│       └── security/
└── analysis/                        # analyzer outputs (interpretation)
    └── <hostname>/
        ├── seo-run1.json
        ├── performance-run1.json
        ├── accessibility-run1.json
        ├── security-run1.json
        ├── best-practices-run1.json
        ├── seo-run2.json            # later re-run of seo only
        └── ...
```

The `<hostname>` segment is the bare hostname — no scheme, port, path, or query. It **must** match the hostname segment under `reports/.cache/` so collector data and analyzer interpretation pair up by directory name.

---

## Naming convention

```
reports/analysis/<hostname>/<dimension>-run<N>.json
```

| Segment | Rule |
|---|---|
| `<hostname>` | Lowercase bare hostname. IDN already punycoded. No port, no path. |
| `<dimension>` | Exactly one of the five values from `analyzer-schema.md`: `seo`, `performance`, `accessibility`, `security`, `best-practices`. Hyphen-separated, never `bestpractices` or `best_practices`. |
| `<N>` | Positive integer, scoped to the `(hostname, dimension)` pair. Append-only — see Run numbers below. |
| extension | `.json`, UTF-8 without BOM, LF line endings. |

Examples:
- `reports/analysis/example.com/seo-run1.json`
- `reports/analysis/example.com/best-practices-run3.json`

---

## Run numbers

Run numbers are **append-only history**, scoped per `(hostname, dimension)`.

To pick `<N>` when writing:
1. Glob existing `reports/analysis/<hostname>/<dimension>-run*.json`.
2. Extract the integer suffix from each match.
3. `N = max(existing) + 1`, or `1` if no files exist.

Re-running the same analyzer over the same inputs **still creates a new file** at the next `N`. The report-builder reads only the latest; older runs are kept as history and can be diffed by hand.

Run numbers across dimensions are independent: a hostname can have `seo-run5.json` next to `performance-run2.json` with no consistency requirement.

---

## Write protocol

| Rule | Why |
|---|---|
| **Atomic write.** Write to `<filename>.tmp` then `mv` to the final filename. | Prevents the report-builder from reading a half-written file during a long emit. |
| **No empty files.** If the analyzer cannot produce output, do **not** create a file. Exit non-zero so the caller sees the failure. | Partial state is worse than no state. |
| **UTF-8, no BOM, LF line endings.** | Cross-platform consistency, especially Windows git-bash → Unix CI. |
| **Two-space indentation.** | Stable diffs across re-runs and tooling. |
| **Field order matches `analyzer-schema.md`.** | Deterministic diffs; readability. |

Reference implementation: `scripts/save-analysis.sh`.

---

## Cross-analyzer compatibility

The report-builder reads up to five analyzer outputs for a hostname and merges them. These invariants make the merge deterministic.

| Invariant | Rule |
|---|---|
| Hostname match | Every output in `analysis/<hostname>/` has `"hostname": "<hostname>"`. Mismatch = hard error, output rejected. |
| URL match (soft) | Outputs should share the same `url`. Mismatch = warning surfaced in the final report, not a rejection (re-analyzing a sibling page of the same site is allowed). |
| Schema conformance | Every output conforms to `analyzer-schema.md`. Schema-invalid outputs are skipped with a clear error. |
| Finding-ID uniqueness (within an analyzer) | `id` is unique inside a single file. Enforced by the analyzer. |
| Finding-ID overlap (across analyzers) | An `id` may appear in two analyzers' outputs **only when** one cedes it via `metadata.extensions.deferred_to`. Otherwise the dedup boundary rule in each SKILL.md decides ownership. |
| Run grouping (optional) | If `metadata.run_id` is present, outputs sharing the same `run_id` belong to one orchestrated run. Outputs without `run_id` are standalone re-runs. |

### Report-builder pre-flight (the consumer side)

1. Glob `reports/analysis/<hostname>/<dimension>-run*.json` for each of the five dimensions.
2. Pick the highest-numbered file per dimension.
3. Parse each. Reject schema-invalid files with a named error.
4. Verify each file's `hostname` matches the directory name.
5. Collect `metadata.run_id` values across the five. If two or more differ, surface a warning ("analyses span multiple orchestrated runs").
6. Resolve every `metadata.extensions.deferred_to` entry of the form `"<finding-id> -> <other-dimension>"` against the other dimension's `findings[].id`. Unresolved references = warning.
7. Compute the headline overall score as the **minimum** of the five analyzer scores. If a dimension is missing, surface it visibly — do not silently fill with a default.

Pre-flight failures are user-facing. Never silently drop a dimension.

---

## Optional manifest

The spec does **not** require a manifest file. The directory glob is the source of truth.

A future orchestrator MAY write `reports/analysis/<hostname>/manifest.json` to record a coordinated run:

```json
{
  "run_id": "uuid-or-timestamp",
  "started_at": "2026-05-12T10:14:23Z",
  "finished_at": "2026-05-12T10:16:01Z",
  "url": "https://example.com",
  "outputs": {
    "seo":            "seo-run3.json",
    "performance":    "performance-run3.json",
    "accessibility":  "accessibility-run3.json",
    "security":       "security-run3.json",
    "best-practices": "best-practices-run3.json"
  }
}
```

The manifest is informational. The directory glob still wins for "what is the latest". A missing or stale manifest is not an error.

---

## How analyzer skills persist

The shared procedure step 9 ("Emit") is the persistence hook. Each analyzer:

1. Builds the JSON object per `analyzer-schema.md`.
2. Pipes it to `bash scripts/save-analysis.sh <dimension> <hostname>` (recommended — validates and assigns `N`), **or** writes directly using the Write tool after computing `N` per the rules above.
3. Captures the returned path and emits it on stdout for the caller (the future orchestrator).

The helper enforces:
- The `dimension` argument matches the JSON's `dimension` field.
- The `hostname` argument matches the JSON's `hostname` field.
- The top-level shape has the seven required fields (`dimension`, `url`, `hostname`, `score`, `summary`, `findings`, `metadata`).
- The input parses as valid JSON.
- Atomic file placement.

Any failure exits non-zero with a clear stderr message — the analyzer should treat that as a hard error and not retry the write blindly.
