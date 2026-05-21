#!/usr/bin/env bash
#
# save-report.sh — persist a report-builder Report JSON to the canonical
# location. Reads JSON from stdin, validates the schema-critical fields
# against the CLI argument, and writes atomically to
#   reports/final/<hostname>/report-run<N>.json
# per the contract in .claude/skills/_shared/report-artifacts.md.
#
# On success: prints the final path to stdout, exits 0.
# On failure: prints an error to stderr, exits non-zero.
#
# This script does not render HTML. It is the persistence primitive that the
# report-builder (and any other producer of Report JSON) pipes its output
# through. The downstream HTML renderer reads the file this script writes.

set -euo pipefail

# ---------------------------------------------------------------------------
# usage / args
# ---------------------------------------------------------------------------

usage() {
    cat <<EOF
Usage: $(basename "$0") <hostname>

Reads a Report JSON from stdin and writes it atomically to
reports/final/<hostname>/report-run<N>.json with the next free N.

  <hostname>   bare hostname; must match the JSON's .meta.hostname field

On success the final path is printed on stdout. Non-zero exit on validation
or write failure.
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

if [[ -z "$HOSTNAME_ARG" ]]; then
    echo "error: hostname is empty" >&2
    exit 64
fi

# Disallow path-traversal characters in the hostname segment.
if [[ "$HOSTNAME_ARG" == *'/'* || "$HOSTNAME_ARG" == *'\'* || "$HOSTNAME_ARG" == *'..'* ]]; then
    echo "error: hostname '$HOSTNAME_ARG' contains illegal characters (/, \\, ..)" >&2
    exit 64
fi

# ---------------------------------------------------------------------------
# dependency check
# ---------------------------------------------------------------------------

if ! command -v jq >/dev/null 2>&1; then
    echo "error: 'jq' not found in PATH" >&2
    echo "       install with: winget install jqlang.jq  (or your package manager)" >&2
    exit 127
fi

# ---------------------------------------------------------------------------
# read + validate stdin
# ---------------------------------------------------------------------------

INPUT="$(cat)"
if [[ -z "$INPUT" ]]; then
    echo "error: no JSON on stdin" >&2
    exit 65
fi

if ! printf '%s' "$INPUT" | jq empty >/dev/null 2>&1; then
    echo "error: stdin is not valid JSON" >&2
    exit 65
fi

TOP_TYPE="$(printf '%s' "$INPUT" | jq -r 'type')"
if [[ "$TOP_TYPE" != "object" ]]; then
    echo "error: JSON top-level is '$TOP_TYPE', expected 'object'" >&2
    exit 65
fi

# Eight required top-level fields per sections-schema.md.
REQUIRED='["meta","executive_summary","severity_overview","key_findings","prioritized_roadmap","quick_wins","long_term_improvements","action_items"]'
MISSING="$(printf '%s' "$INPUT" | jq -r --argjson req "$REQUIRED" \
    '($req - keys) | join(", ")')"
if [[ -n "$MISSING" ]]; then
    echo "error: missing required top-level fields: $MISSING" >&2
    exit 65
fi

# meta sub-checks
META_TYPE="$(printf '%s' "$INPUT" | jq -r '.meta | type')"
if [[ "$META_TYPE" != "object" ]]; then
    echo "error: .meta is '$META_TYPE', expected 'object'" >&2
    exit 65
fi

META_HOST="$(printf '%s' "$INPUT" | jq -r '.meta.hostname // ""')"
if [[ "$META_HOST" != "$HOSTNAME_ARG" ]]; then
    echo "error: hostname mismatch — argv='$HOSTNAME_ARG', meta.hostname='$META_HOST'" >&2
    exit 65
fi

META_URL="$(printf '%s' "$INPUT" | jq -r '.meta.url // ""')"
if [[ -z "$META_URL" ]]; then
    echo "error: meta.url is missing or empty" >&2
    exit 65
fi

META_AUDITED="$(printf '%s' "$INPUT" | jq -r '.meta.audited_at // ""')"
if [[ -z "$META_AUDITED" ]]; then
    echo "error: meta.audited_at is missing or empty" >&2
    exit 65
fi

# ---------------------------------------------------------------------------
# resolve path + next run number
# ---------------------------------------------------------------------------

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
REPO_ROOT="$( cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd )"

OUT_DIR="$REPO_ROOT/reports/final/$HOSTNAME_ARG"
mkdir -p "$OUT_DIR"

RUN_NUM=1
while [[ -e "$OUT_DIR/report-run${RUN_NUM}.json" ]]; do
    RUN_NUM=$((RUN_NUM + 1))
done

OUT_FILE="$OUT_DIR/report-run${RUN_NUM}.json"
TMP_FILE="$OUT_FILE.tmp"

# ---------------------------------------------------------------------------
# atomic write
# ---------------------------------------------------------------------------

# Canonicalize via jq: 2-space indent; preserve input field order (no sort).
printf '%s' "$INPUT" | jq --indent 2 '.' > "$TMP_FILE"
mv -f "$TMP_FILE" "$OUT_FILE"

# Caller (and the downstream HTML renderer) captures this path.
echo "${OUT_FILE#$REPO_ROOT/}"
