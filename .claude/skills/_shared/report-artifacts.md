# Report Artifacts

Where the report-builder writes its outputs and what the HTML rendering layer reads.

- `analyzer-schema.md` — analyzer JSON shape.
- `output-artifacts.md` — analyzer persistence (`reports/analysis/<hostname>/`).
- `../report-builder/sections-schema.md` — the Report JSON shape.
- **This document** — where the Report JSON and the rendered HTML land on disk and how they pair up across runs.

When this document and a SKILL.md disagree, this document wins.

---

## Directory layout

```
reports/
├── .cache/                          # collector outputs
├── analysis/                        # analyzer outputs
└── final/                           # report-builder outputs (this doc)
    └── <hostname>/
        ├── report-run1.json         # intermediate narrative state (report-builder)
        ├── report-run1.html         # rendered report (future HTML renderer)
        ├── report-run2.json
        ├── report-run2.html
        └── manifest.json            # optional, informational
```

`<hostname>` matches the segment used in `reports/.cache/` and `reports/analysis/` so the three layers pair up by directory name.

---

## Naming convention

```
reports/final/<hostname>/report-run<N>.json
reports/final/<hostname>/report-run<N>.html
```

| Segment    | Rule |
|------------|------|
| `<hostname>` | Lowercase bare hostname. Must match `reports/analysis/<hostname>/`. |
| `report-`  | Literal prefix. There is exactly one Report per `(hostname, N)` pair. |
| `<N>`      | Positive integer, scoped to `<hostname>`. Append-only — see Run numbers. |
| extension  | `.json` for the narrative state; `.html` for the rendered output. Both files share the same `<N>`. |

---

## Run numbers

Append-only history, scoped per `<hostname>` (not per file extension).

To pick `<N>` when writing the JSON:
1. Glob `reports/final/<hostname>/report-run*.json`.
2. Extract the integer suffix.
3. `N = max(existing) + 1`, or `1` if no files exist.

The HTML renderer, when it runs against an existing `report-run<N>.json`, **reuses that `<N>`** and writes `report-run<N>.html` alongside it. The renderer does not pick a fresh number. JSON and HTML for the same run share their integer; if a renderer is run twice over the same JSON, it overwrites the HTML.

---

## Write protocol

| Rule | Why |
|---|---|
| **Atomic write.** Write `<filename>.tmp` then `mv` to the final name. | Prevents the renderer or a human from reading a half-written file. |
| **No empty files.** If the report-builder cannot produce a Report, do not create files. Exit non-zero. | Partial state is worse than no state. |
| **UTF-8, no BOM, LF line endings.** | Cross-platform consistency, including Windows git-bash. |
| **Two-space indentation** for JSON. | Stable diffs across runs. |
| **Field order** matches `../report-builder/sections-schema.md`. | Deterministic diffs. |

Reference implementation: `scripts/save-report.sh` (JSON persistence). The HTML renderer is responsible for the same protocol on its side.

---

## The renderer contract

The HTML rendering layer is a separate concern from the report-builder. The contract between them is intentionally narrow:

| | report-builder | renderer |
|---|---|---|
| Reads  | analyzer outputs in `reports/analysis/<hostname>/` | a single Report JSON `report-run<N>.json` |
| Writes | `report-run<N>.json` | `report-run<N>.html` in the same directory, **same `<N>`** |
| Owns   | narrative generation, section assembly, deterministic prose, quality gates | HTML markup, CSS inlining, image embedding, in-page sort/filter scripts |

The Report JSON is the **only** input the renderer needs. Pre-flight (the report-builder's own pre-flight from `output-artifacts.md`) has already happened by the time the JSON exists.

### Renderer pre-flight (defensive)

Even though the report-builder's quality gates should have caught these, the renderer **re-checks** before rendering and refuses to produce HTML if any fail:

1. JSON parses and matches the top-level shape in `../report-builder/sections-schema.md` (eight required keys).
2. `meta.hostname` equals the parent directory name.
3. `meta.dimensions_analyzed ∪ meta.dimensions_missing` equals the five expected dimensions.
4. `severity_overview.by_severity` sum and `by_priority` sum both equal `action_items.total`.
5. Every `FindingRef.anchor` matches the deterministic pattern `#finding-<dimension>-<finding_id>` so action-items rows resolve to per-dimension detail entries.
6. Every theme has `theme_id` of the form `theme-<slug>` and at least two `supporting_finding_refs` drawn from at least two dimensions.

Renderer pre-flight failures are user-facing — they cite the JSON path and the failed check.

---

## Cross-layer compatibility

| Invariant | Rule |
|---|---|
| Hostname coherence | The directory name = `meta.hostname` in the JSON = the hostname segment used by `analyzer-schema` outputs. Three-way mismatch is a hard error. |
| Run pairing | A `report-run<N>.html` file is meaningful only when the matching `report-run<N>.json` exists. The renderer refuses to write HTML without the source JSON. |
| Append-only history | Neither the report-builder nor the renderer rewrites a previously-written file. New runs always go to `N+1`. |
| URL consistency | `meta.url` is informational; the renderer surfaces it but does not validate it against anything else. |

---

## Optional manifest

The spec does not require a manifest. The directory glob is the source of truth.

A future orchestrator may write `reports/final/<hostname>/manifest.json` to record the latest run:

```json
{
  "latest_run":   3,
  "url":          "https://example.com",
  "audited_at":   "2026-05-12T10:14:23Z",
  "generated_at": "2026-05-12T10:16:01Z",
  "json":         "report-run3.json",
  "html":         "report-run3.html"
}
```

The manifest is informational only. Globbing still wins.

---

## How the report-builder persists

The report-builder procedure (§13 Emit) writes the Report JSON. Use one of:

1. **Preferred** — pipe to the helper, which validates and assigns `N`:
   ```bash
   bash scripts/save-report.sh <hostname>
   ```
   stdin: the Report JSON; stdout: the final path. Non-zero exit on validation failure.

2. **Direct write** — Write tool after computing `N` as the lowest integer such that `report-run<N>.json` does not already exist. Apply the atomic-write protocol manually.

The helper enforces:
- Input parses as JSON, top-level is an object.
- All eight required top-level fields present (`meta`, `executive_summary`, `severity_overview`, `key_findings`, `prioritized_roadmap`, `quick_wins`, `long_term_improvements`, `action_items`).
- `meta.hostname` matches the CLI argument.
- `meta.url` is a non-empty string.
- `meta.audited_at` is a non-empty string.
- Atomic file placement.

Any failure exits non-zero with a clear stderr message — the report-builder should treat that as a hard error and not retry the write blindly.
