# Analyzer Procedure (shared)

Every analyzer skill follows this procedure. Skill-specific signal handling is layered on top in each SKILL.md's `## Procedure` section.

When this document and a SKILL.md disagree, **this document wins for procedural rules** (how to load, score, emit); the SKILL.md wins for **what signals to look at** and **what severity each signal maps to**.

---

## 1. Resolve inputs

1. The skill is invoked with a `<hostname>` (and optionally a `<run>` number). Default: highest-numbered run available.
2. Resolve the cache directory: `reports/.cache/<hostname>/`.
3. For each artifact listed in the SKILL.md's "Input artifacts":
   - If present: record its relative path in `metadata.artifacts_consumed`.
   - If missing: record its expected relative path in `metadata.gaps`. Continue with what is available.
4. If **all** primary inputs are missing, emit an analyzer object with `findings: []`, a `summary` stating which artifacts are missing and how to produce them, and the lowest score the rubric allows. Do not invent findings to fill the report.

---

## 2. Extract signals

For every signal that becomes a finding:

- Locate the **precise field path** inside the artifact (e.g. `audits['largest-contentful-paint'].numericValue`).
- Quote the **literal value** as it appears in the artifact into `evidence`. Do not paraphrase numbers. Do not round. Do not translate units the artifact did not use.
- If the artifact reports both mobile and desktop values, include both with labels: `"LCP: 4.2 s mobile / 1.8 s desktop"`.

A signal becomes a finding **only if** it has all four of:
- a defined value in the artifact
- a defined severity per the skill's rubric
- a recommendation that is more specific than "improve X"
- a stated impact that names the affected population

If any of the four is missing, drop the signal. Do not emit a half-built finding.

---

## 3. Assign severity

Use the rubric table in the skill's SKILL.md. The five level definitions (`critical | high | medium | low | info`) in `analyzer-schema.md` are normative — skills only specify which signal maps to which level.

**Tie-break rule:** if a signal could land in either of two adjacent levels (e.g. high or medium), choose the **lower** level. Do not inflate severity for emphasis.

---

## 4. Assign priority

1. Start with the default mapping from `analyzer-schema.md` (`critical`→P0, `high`→P1, `medium`→P2, `low`→P3, `info`→P3).
2. Apply **at most one** override:
   - **Reach bump (+1):** low-severity issue present on every URL the audit covered.
   - **Scope demote (−1):** high-severity issue confined to a deprecated subpath or non-production surface (only when evidence shows this).
   - **Quick-win bump (+1):** medium-severity issue fixable with a single config line / single tag / single header value.
   - **Compliance lock (P0):** violates a written legal/contractual obligation. Only apply when the SKILL.md or input data names the obligation.
3. Document the override reason in `impact` or `recommendation`. If no override applies, do not mention priority in those fields.

When in doubt: **do not override**. The default mapping is the right answer most of the time.

---

## 5. Write recommendations

- One sentence preferred; two when a concrete value needs it.
- Lead with the verb: *Set*, *Add*, *Replace*, *Remove*, *Move*, *Inline*, *Defer*.
- Include the exact value when the standard prescribes one (`Cache-Control: public, max-age=31536000`, `Strict-Transport-Security: max-age=31536000; includeSubDomains`).
- Do not write conditional recommendations ("if you support IE…") — the artifact reflects the current environment.
- Do not recommend removing a third party without flagging that the decision is a product call: `"Evaluate removing or deferring the <name> tag; it accounts for X ms of main-thread work."`

---

## 6. Write impact

- Plain language. Name the population (users, mobile users, screen-reader users, crawlers, returning visitors). Tie to a real consequence.
- Good: *"Screen-reader users skip the navigation entirely; they have no way to discover product categories."*
- Bad: *"Affects accessibility."*

---

## 7. Write the executive summary

- 2–4 sentences. Written for a non-engineer who scans only the summary and the score.
- Lead with the **worst** finding (highest priority, then severity).
- State the score and the single biggest reason it is what it is.
- End with one next-step sentence **only if** one finding clearly dominates. Otherwise stop.
- No bullet points, no markdown formatting, no analyst-voice hedging ("we found", "it appears"). Just facts.

---

## 8. Quality gates — run **before** emitting

A finding is **invalid and must be dropped** if any check fails:

| Check | Failure mode caught |
|---|---|
| `evidence` quotes a value that does not appear in any artifact under `artifacts_consumed` | Hallucinated data |
| `recommendation` is generic ("improve", "consider", "review") | Vague advice |
| `references` includes a URL that is neither in the artifact nor a well-known standards site (WCAG / MDN / web.dev / web.archive.org / RFC / OWASP / Schema.org) | Made-up reference |
| `extensions.wcag` is populated but Lighthouse did not map a criterion in the source audit | Invented WCAG mapping |
| `extensions.cve` is populated but Lighthouse did not provide that CVE | Invented CVE |
| `extensions.savings_ms` or `savings_bytes` differs from the Lighthouse `details.overallSavingsMs` / `overallSavingsBytes` | Fabricated savings |
| `severity` does not match the rubric and no rubric override is justified in `impact` | Severity inflation |
| `category` is not in the SKILL.md's declared enum | Invented category |

After the per-finding pass, also verify:
- Findings are sorted by `priority` → `severity` → the skill's tiebreaker.
- No two findings share an `id`. If a collision happens, the older one wins; the duplicate is dropped.
- `metadata.gaps` is non-empty if any expected artifact was missing.

---

## 9. Emit and persist

Build **a single JSON object** matching the schema in `analyzer-schema.md`. **Nothing else** — no prose, no markdown fence, no commentary outside the JSON.

Format rules:
- No markdown code fence around the JSON.
- No prose before or after the JSON.
- No trailing commas.
- `null` for absent string fields, **not** `""`.
- `[]` for empty arrays, **not** `null`.
- ISO-8601 UTC for `analyzed_at`: `"2026-05-12T10:14:23Z"`.
- Two-space indentation.
- Field order in each object matches the order in `analyzer-schema.md` (helps the report-builder diff outputs across runs).

### Persist to disk

Write the JSON to its canonical location per [`output-artifacts.md`](output-artifacts.md):

```
reports/analysis/<hostname>/<dimension>-run<N>.json
```

Use one of these mechanisms:

1. **Preferred** — pipe to the helper, which validates and assigns `N`:
   ```bash
   bash scripts/save-analysis.sh <dimension> <hostname>
   ```
   stdin: the JSON; stdout: the final path. Non-zero exit on validation failure — treat that as a hard error.

2. **Direct write** — use the Write tool after determining `N` as `max(existing <dimension>-run*.json) + 1`. Write atomically (tmp + rename) per the protocol in `output-artifacts.md`.

After persisting, emit the final relative path on stdout so the caller can capture it. The emitted JSON itself is the only thing the report-builder reads; the path lets the orchestrator track which run was produced.
