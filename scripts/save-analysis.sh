#!/usr/bin/env bash
#
# save-analysis.sh — persist an analyzer output to the canonical location.
# Reads JSON from stdin, validates the placement-critical fields against the
# CLI args, then writes atomically to
#   reports/analysis/<hostname>/<dimension>-run<N>.json
# per the contract in .claude/skills/_shared/output-artifacts.md.
#
# On success: prints the final path to stdout, exits 0.
# On failure: prints an error to stderr, exits non-zero.
#
# This script does not run the analyzer. It is the persistence primitive that
# analyzers / orchestrators pipe their JSON through.

set -euo pipefail

# ---------------------------------------------------------------------------
# usage / args
# ---------------------------------------------------------------------------

usage() {
    cat <<EOF
Usage: $(basename "$0") <dimension> <hostname>

Reads an analyzer JSON output from stdin and writes it atomically to
reports/analysis/<hostname>/<dimension>-run<N>.json with the next free N.

  <dimension>   one of: seo, performance, accessibility, security, best-practices
  <hostname>    bare hostname; must match the JSON's .hostname field

On success, the final path is printed on stdout. Non-zero exit on validation
or write failure.
EOF
}

if [[ $# -lt 1 ]]; then
    echo "error: missing arguments" >&2
    usage >&2
    exit 64
fi

if [[ "$1" == "-h" || "$1" == "--help" ]]; then
    usage
    exit 0
fi

if [[ $# -lt 2 ]]; then
    echo "error: expected <dimension> <hostname>" >&2
    usage >&2
    exit 64
fi

DIMENSION="$1"
HOSTNAME_ARG="$2"

case "$DIMENSION" in
    seo|performance|accessibility|security|best-practices) ;;
    *)
        echo "error: invalid dimension '$DIMENSION'" >&2
        echo "       must be one of: seo, performance, accessibility, security, best-practices" >&2
        exit 64
        ;;
esac

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

# Top-level must be an object; required keys must be present.
TOP_TYPE="$(printf '%s' "$INPUT" | jq -r 'type')"
if [[ "$TOP_TYPE" != "object" ]]; then
    echo "error: JSON top-level is '$TOP_TYPE', expected 'object'" >&2
    exit 65
fi

REQUIRED='["dimension","url","hostname","score","summary","findings","metadata"]'
MISSING="$(printf '%s' "$INPUT" | jq -r --argjson req "$REQUIRED" \
    '($req - keys) | join(", ")')"
if [[ -n "$MISSING" ]]; then
    echo "error: missing required top-level fields: $MISSING" >&2
    exit 65
fi

# findings must be an array (may be empty).
FINDINGS_TYPE="$(printf '%s' "$INPUT" | jq -r '.findings | type')"
if [[ "$FINDINGS_TYPE" != "array" ]]; then
    echo "error: .findings is '$FINDINGS_TYPE', expected 'array'" >&2
    exit 65
fi

# Cross-check the placement-critical fields against the CLI args.
JSON_DIM="$(printf '%s' "$INPUT" | jq -r '.dimension')"
if [[ "$JSON_DIM" != "$DIMENSION" ]]; then
    echo "error: dimension mismatch — argv='$DIMENSION', json='$JSON_DIM'" >&2
    exit 65
fi

JSON_HOST="$(printf '%s' "$INPUT" | jq -r '.hostname')"
if [[ "$JSON_HOST" != "$HOSTNAME_ARG" ]]; then
    echo "error: hostname mismatch — argv='$HOSTNAME_ARG', json='$JSON_HOST'" >&2
    exit 65
fi

# ---------------------------------------------------------------------------
# resolve path + next run number
# ---------------------------------------------------------------------------

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
REPO_ROOT="$( cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd )"

OUT_DIR="$REPO_ROOT/reports/analysis/$HOSTNAME_ARG"
mkdir -p "$OUT_DIR"

RUN_NUM=1
while [[ -e "$OUT_DIR/${DIMENSION}-run${RUN_NUM}.json" ]]; do
    RUN_NUM=$((RUN_NUM + 1))
done

OUT_FILE="$OUT_DIR/${DIMENSION}-run${RUN_NUM}.json"
TMP_FILE="$OUT_FILE.tmp"

# ---------------------------------------------------------------------------
# atomic write
# ---------------------------------------------------------------------------

# Canonicalize via jq: 2-space indent, sorted keys disabled (preserve schema
# field order from input), LF line endings.
printf '%s' "$INPUT" | jq --indent 2 '.' > "$TMP_FILE"
mv -f "$TMP_FILE" "$OUT_FILE"

# Caller captures this path.
echo "${OUT_FILE#$REPO_ROOT/}"
