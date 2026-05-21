# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

AI-powered website audit framework. Takes a URL, runs five audit dimensions (SEO, performance, accessibility, security, best practices), uses Claude to interpret raw findings, and emits a professional, self-contained HTML report.

Status: scaffolded. Folder layout and architectural contract are in place; runners, skills, and the orchestrator are not yet implemented.

## Pipeline architecture

The audit runs in three strictly separated stages. Each stage writes structured artifacts to disk so the next stage can be re-run independently when iterating.

1. **Collect** — `src/runners/` and `scripts/`. Deterministic data gathering only: Lighthouse for performance/SEO/accessibility/best-practices, separate security checks (TLS, headers, mixed content, etc.). No LLM calls. Emits one JSON file per dimension.
2. **Analyze** — `.claude/skills/<dimension>-analyzer/` and `src/analyzers/`. Claude interprets the raw JSON from stage 1 into prioritized findings (severity, evidence, recommendation). One skill per audit dimension, plus `report-builder` for the final assembly step.
3. **Report** — `.claude/skills/report-builder/` plus templates in `templates/`. The report-builder skill merges per-dimension analyses into a Report JSON state (per `.claude/skills/report-builder/sections-schema.md`); a separate HTML renderer turns that JSON into the user-facing report. Outputs land in `reports/final/<hostname>/report-run<N>.{json,html}` — see [`.claude/skills/_shared/report-artifacts.md`](.claude/skills/_shared/report-artifacts.md).

`src/orchestrator.js` (planned) is the only module that knows about all three stages. Runners, analyzers, and the report builder must not call each other directly — they communicate via the on-disk artifacts.

## The skill/code boundary

This is the central design rule and is easy to violate:

- **Node and Bash** handle anything deterministic: invoking Lighthouse, parsing response headers, hashing, file I/O, HTML assembly. **No model calls here.**
- **Claude Code skills** handle anything judgmental: ranking severity, writing the human-readable recommendation, deciding what to surface. Skills consume JSON, produce JSON or markdown — they do not shell out to scanners.

When adding a new audit dimension, add **both** a runner (collects data) and an analyzer skill (interprets it), then wire them into the orchestrator. Adding only one is a smell.

## Report output constraint

Reports must be self-contained HTML: all CSS inlined from `templates/styles.css`, no CDN links, no external fonts, no remote images (embed as data URIs if needed). Reports are emailed and archived, so they have to render offline years from now.

## Commands

Not yet wired up. Once `package.json` and the runner scripts exist, the expected entry points are:

- `node src/index.js <url>` — full audit
- `bash scripts/run-lighthouse.sh <url>` — Lighthouse pass only (writes `reports/.cache/<domain>-lighthouse.json`)
- `bash scripts/run-security-scan.sh <url>` — security pass only

Update this section when those land.

## Configuration

- `.env` (gitignored) holds `ANTHROPIC_API_KEY` and any other secrets.
- `config/audit.config.json` (planned) will hold per-dimension thresholds, Claude model selection, and report branding (title, logo data-URI, footer).
