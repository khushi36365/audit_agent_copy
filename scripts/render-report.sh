#!/usr/bin/env bash
#
# render-report.sh — turn a Report JSON into a self-contained HTML report.
#
# Reads:
#   reports/final/<hostname>/report-run<N>.json   (the Report JSON)
#   templates/report.html                          (HTML skeleton)
#   templates/styles.css                           (design system)
#
# Writes:
#   reports/final/<hostname>/report-run<N>.html   (self-contained)
#
# Pure substitution — no LLM calls, no template engine. CSS is inlined into
# the <style> block; the Report JSON is embedded into the <script id="report-data">
# block; the existing inline renderer in the template populates the DOM on load.
# The output renders offline in any modern browser (file:// works).
#
# Contract per .claude/skills/_shared/report-artifacts.md:
#   - Re-uses the source JSON's <N> for the HTML (HTML and JSON pair by N).
#   - Atomic write (.tmp then mv).
#   - Defensive pre-flight: schema shape, hostname match, sum invariants,
#     anchor pattern, theme structure. Pre-flight warnings are surfaced but
#     do not block the render — they are also surfaced inside the report's
#     Appendix → Build warnings section.

set -euo pipefail

# ---------------------------------------------------------------------------
# usage / args
# ---------------------------------------------------------------------------

usage() {
    cat <<EOF
Usage: $(basename "$0") <hostname> [<run-number>]

Renders the Report JSON at
    reports/final/<hostname>/report-run<N>.json
into a self-contained HTML file at
    reports/final/<hostname>/report-run<N>.html

If <run-number> is omitted, the highest-numbered existing report-run*.json
in the hostname directory is used.

Exit codes:
    0  success
   64  bad arguments
   65  invalid Report JSON (pre-flight failure)
   66  missing required input file
  127  required dependency not found
EOF
}

if [[ $# -lt 1 ]]; then
    echo "error: missing hostname argument" >&2
    usage >&2
    exit 64
fi

if [[ "$1" == "-h" || "$1" == "--help" ]]; then
    usage
    exit 0
fi

HOSTNAME_ARG="$1"
RUN_ARG="${2:-}"

if [[ -z "$HOSTNAME_ARG" ]]; then
    echo "error: hostname is empty" >&2
    exit 64
fi

# path-traversal guard
if [[ "$HOSTNAME_ARG" == *'/'* || "$HOSTNAME_ARG" == *'\'* || "$HOSTNAME_ARG" == *'..'* ]]; then
    echo "error: hostname '$HOSTNAME_ARG' contains illegal characters (/, \\, ..)" >&2
    exit 64
fi

# ---------------------------------------------------------------------------
# dependency check
# ---------------------------------------------------------------------------

for cmd in jq awk; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "error: '$cmd' not found in PATH" >&2
        exit 127
    fi
done

# ---------------------------------------------------------------------------
# resolve paths
# ---------------------------------------------------------------------------

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
REPO_ROOT="$( cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd )"

OUT_DIR="$REPO_ROOT/reports/final/$HOSTNAME_ARG"
TEMPLATE="$REPO_ROOT/templates/report.html"
STYLES="$REPO_ROOT/templates/styles.css"

if [[ ! -d "$OUT_DIR" ]]; then
    echo "error: directory '${OUT_DIR#$REPO_ROOT/}' does not exist" >&2
    echo "       run the report-builder first to produce a report-run<N>.json file" >&2
    exit 66
fi

[[ -f "$TEMPLATE" ]] || { echo "error: template not found: ${TEMPLATE#$REPO_ROOT/}" >&2; exit 66; }
[[ -f "$STYLES"   ]] || { echo "error: styles not found: ${STYLES#$REPO_ROOT/}"     >&2; exit 66; }

# ---------------------------------------------------------------------------
# determine run number (highest existing if not provided)
# ---------------------------------------------------------------------------

if [[ -z "$RUN_ARG" ]]; then
    RUN_NUM=0
    shopt -s nullglob
    for f in "$OUT_DIR"/report-run*.json; do
        base="$(basename "$f")"
        n="${base#report-run}"
        n="${n%.json}"
        if [[ "$n" =~ ^[0-9]+$ ]] && (( n > RUN_NUM )); then
            RUN_NUM="$n"
        fi
    done
    shopt -u nullglob
    if (( RUN_NUM == 0 )); then
        echo "error: no report-run*.json files in ${OUT_DIR#$REPO_ROOT/}" >&2
        echo "       run the report-builder first" >&2
        exit 66
    fi
else
    if [[ ! "$RUN_ARG" =~ ^[1-9][0-9]*$ ]]; then
        echo "error: invalid run number '$RUN_ARG' (expected positive integer)" >&2
        exit 64
    fi
    RUN_NUM="$RUN_ARG"
fi

JSON_FILE="$OUT_DIR/report-run${RUN_NUM}.json"
OUT_FILE="$OUT_DIR/report-run${RUN_NUM}.html"
TMP_FILE="$OUT_FILE.tmp"

[[ -f "$JSON_FILE" ]] || { echo "error: ${JSON_FILE#$REPO_ROOT/} not found" >&2; exit 66; }

echo "render-report" >&2
echo "  host:     $HOSTNAME_ARG"       >&2
echo "  run:      #$RUN_NUM"           >&2
echo "  source:   ${JSON_FILE#$REPO_ROOT/}" >&2
echo "  target:   ${OUT_FILE#$REPO_ROOT/}"  >&2
echo                                     >&2

# ---------------------------------------------------------------------------
# pre-flight per .claude/skills/_shared/report-artifacts.md
# ---------------------------------------------------------------------------

echo "  preflight:" >&2

# 1. JSON parses + has the eight required top-level keys
if ! jq empty "$JSON_FILE" >/dev/null 2>&1; then
    echo "    error: ${JSON_FILE#$REPO_ROOT/} is not valid JSON" >&2
    exit 65
fi

REQUIRED='["meta","executive_summary","severity_overview","key_findings","prioritized_roadmap","quick_wins","long_term_improvements","action_items"]'
MISSING="$(jq -r --argjson req "$REQUIRED" '($req - keys) | join(", ")' "$JSON_FILE")"
if [[ -n "$MISSING" ]]; then
    echo "    error: missing required top-level fields: $MISSING" >&2
    exit 65
fi
echo "    [ok] schema: 8 top-level fields present" >&2

# 2. meta.hostname matches the directory
META_HOST="$(jq -r '.meta.hostname // ""' "$JSON_FILE")"
if [[ "$META_HOST" != "$HOSTNAME_ARG" ]]; then
    echo "    error: meta.hostname='$META_HOST' does not match directory '$HOSTNAME_ARG'" >&2
    exit 65
fi
echo "    [ok] meta.hostname matches directory" >&2

WARNINGS=0

# 3. dimensions_analyzed ∪ dimensions_missing covers the five expected
EXPECTED_DIMS='["seo","performance","accessibility","security","best-practices"]'
DIM_DIFF="$(jq -r --argjson expected "$EXPECTED_DIMS" \
    '($expected - ((.meta.dimensions_analyzed // []) + (.meta.dimensions_missing // []))) | join(", ")' \
    "$JSON_FILE")"
if [[ -n "$DIM_DIFF" ]]; then
    echo "    [warn] dimensions not accounted for in meta: $DIM_DIFF" >&2
    WARNINGS=$((WARNINGS + 1))
else
    echo "    [ok] all five dimensions accounted for in meta" >&2
fi

# 4. by_severity sum == by_priority sum == action_items.total
IFS=$'\t' read -r SUM_SEV SUM_PRI TOTAL < <(jq -r '
    [
        ((.severity_overview.by_severity // {}) | to_entries | map(.value) | add // 0),
        ((.severity_overview.by_priority // {}) | to_entries | map(.value) | add // 0),
        (.action_items.total // 0)
    ] | @tsv
' "$JSON_FILE")

if [[ "$SUM_SEV" != "$TOTAL" || "$SUM_PRI" != "$TOTAL" ]]; then
    echo "    [warn] count mismatch: by_severity=$SUM_SEV, by_priority=$SUM_PRI, action_items.total=$TOTAL" >&2
    WARNINGS=$((WARNINGS + 1))
else
    echo "    [ok] severity/priority/total sums match ($TOTAL)" >&2
fi

# 5. Every FindingRef.anchor begins with "#finding-"
BAD_ANCHORS="$(jq '[
    .. | objects | .ref? | select(. != null) | .anchor? | select(. != null) |
    select(startswith("#finding-") | not)
] | length' "$JSON_FILE")"
if (( BAD_ANCHORS > 0 )); then
    echo "    [warn] $BAD_ANCHORS FindingRef.anchor(s) do not match '#finding-<dim>-<id>'" >&2
    WARNINGS=$((WARNINGS + 1))
else
    echo "    [ok] FindingRef anchors conform" >&2
fi

# 6. Every theme has theme_id of form theme-<slug> AND >=2 supporting refs
#    drawn from >=2 distinct dimensions.
BAD_THEMES="$(jq '[
    (.long_term_improvements.themes // [])[] |
    select(
        ((.theme_id // "") | startswith("theme-") | not)
        or ((.supporting_finding_refs // []) | length < 2)
        or (((.supporting_finding_refs // []) | map(.dimension) | unique | length) < 2)
    )
] | length' "$JSON_FILE")"
if (( BAD_THEMES > 0 )); then
    echo "    [warn] $BAD_THEMES theme(s) violate theme_id / 2-finding / 2-dimension invariants" >&2
    WARNINGS=$((WARNINGS + 1))
else
    echo "    [ok] themes conform" >&2
fi

echo "  preflight complete ($WARNINGS warning(s))" >&2
echo                                                  >&2

# ---------------------------------------------------------------------------
# render
# ---------------------------------------------------------------------------

# Canonicalize the JSON: 2-space indent, preserve input field order.
# Writing the canonicalized JSON to a temp file so awk reads it like the CSS
# (variable size limits on -v vary by awk implementation; file reads don't).
JSON_TMP="$(mktemp)"
trap 'rm -f "$JSON_TMP"' EXIT

jq --indent 2 '.' "$JSON_FILE" > "$JSON_TMP"

echo "  rendering: substituting CSS and JSON ..." >&2

awk -v css_file="$STYLES" -v json_file="$JSON_TMP" '
    BEGIN {
        # Slurp CSS
        while ((getline line < css_file) > 0) {
            css = (css == "" ? line : css "\n" line)
        }
        close(css_file)

        # Slurp JSON
        while ((getline line < json_file) > 0) {
            json = (json == "" ? line : json "\n" line)
        }
        close(json_file)

        in_data = 0
    }

    # CSS placeholder — replace in-line, preserving any leading/trailing text
    # on the same line (currently the line is just whitespace + placeholder).
    {
        ph = "/* {{INLINE: templates/styles.css}} */"
        idx = index($0, ph)
        if (idx > 0) {
            print substr($0, 1, idx - 1) css substr($0, idx + length(ph))
            next
        }
    }

    # Opening of the JSON data <script>: print it, then emit the report JSON,
    # then flag that we are inside the data script body so we skip subsequent
    # lines until the matching </script>.
    /<script type="application\/json" id="report-data">/ {
        print
        print json
        in_data = 1
        next
    }

    # Closing </script> while inside the data script: emit it, leave the flag.
    in_data == 1 && /<\/script>/ {
        print
        in_data = 0
        next
    }

    # Inside data script: skip (the placeholder JSON is dropped).
    in_data == 1 { next }

    # Everything else passes through.
    { print }
' "$TEMPLATE" > "$TMP_FILE"

# ---------------------------------------------------------------------------
# sanity checks on the output (defensive — catch template drift)
# ---------------------------------------------------------------------------

if grep -q '{{INLINE: templates/styles.css}}' "$TMP_FILE"; then
    echo "error: CSS placeholder not substituted (template may have drifted)" >&2
    rm -f "$TMP_FILE"
    exit 1
fi

if grep -q '"_placeholder": true' "$TMP_FILE"; then
    echo "error: Report JSON placeholder not substituted" >&2
    rm -f "$TMP_FILE"
    exit 1
fi

# Reject leftover external references — the output must be offline-safe.
if grep -Eq '(href|src)="https?:' "$TMP_FILE"; then
    # Allow http(s) URLs only inside the embedded JSON or as analyzer-provided
    # references that the report-builder vouched for. Anything as src/href on
    # markup elements (outside the data script) is a problem.
    # Quick heuristic: if any <link href="http..."> or <script src="http..."> appears, fail.
    if grep -Eq '<(link|script)[^>]*\s(href|src)="https?:' "$TMP_FILE"; then
        echo "error: output contains external <link>/<script> references; not offline-safe" >&2
        rm -f "$TMP_FILE"
        exit 1
    fi
fi

# Atomic rename
mv -f "$TMP_FILE" "$OUT_FILE"

BYTES="$(wc -c < "$OUT_FILE" | tr -d ' ')"
LINES="$(wc -l < "$OUT_FILE" | tr -d ' ')"

echo "  rendered: $LINES lines, $BYTES bytes" >&2
echo                                            >&2
echo "done."                                    >&2
echo "  open: file://$OUT_FILE"                 >&2
echo "  the file is self-contained and renders offline." >&2
echo                                            >&2

# stdout: just the canonical path so callers can capture it
echo "${OUT_FILE#$REPO_ROOT/}"
