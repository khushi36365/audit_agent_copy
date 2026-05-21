#!/usr/bin/env bash
#
# run-lighthouse.sh — collect stage runner for the audit pipeline.
# Runs mobile + desktop Lighthouse audits for a URL and saves JSON + HTML
# under reports/.cache/<hostname>/lighthouse/.
#
# No LLM calls. Deterministic data collection only.

set -euo pipefail

# ---------------------------------------------------------------------------
# usage / args
# ---------------------------------------------------------------------------

usage() {
    cat <<EOF
Usage: $(basename "$0") <url>

Runs mobile and desktop Lighthouse audits against <url> and writes
JSON + HTML reports to reports/.cache/<hostname>/lighthouse/.

Example:
    $(basename "$0") https://example.com
EOF
}

if [[ $# -lt 1 ]]; then
    echo "error: missing URL argument" >&2
    usage >&2
    exit 64
fi

if [[ "$1" == "-h" || "$1" == "--help" ]]; then
    usage
    exit 0
fi

URL="$1"

if [[ ! "$URL" =~ ^https?:// ]]; then
    echo "error: URL must start with http:// or https://" >&2
    exit 64
fi

# ---------------------------------------------------------------------------
# dependency check
# ---------------------------------------------------------------------------

if ! command -v lighthouse >/dev/null 2>&1; then
    echo "error: 'lighthouse' CLI not found in PATH" >&2
    echo "       install with: npm install -g lighthouse" >&2
    exit 127
fi

# ---------------------------------------------------------------------------
# paths
# ---------------------------------------------------------------------------

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
REPO_ROOT="$( cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd )"

# Extract hostname: strip scheme, path, query, fragment, port.
HOSTNAME="${URL#*://}"
HOSTNAME="${HOSTNAME%%/*}"
HOSTNAME="${HOSTNAME%%\?*}"
HOSTNAME="${HOSTNAME%%#*}"
HOSTNAME="${HOSTNAME%%:*}"

if [[ -z "$HOSTNAME" ]]; then
    echo "error: could not extract hostname from '$URL'" >&2
    exit 64
fi

OUT_DIR="$REPO_ROOT/reports/.cache/$HOSTNAME/lighthouse"
mkdir -p "$OUT_DIR"

# ---------------------------------------------------------------------------
# run number — increment until neither mobile nor desktop slot is taken,
# so mobile/desktop pairs stay aligned even if a previous run failed mid-way.
# ---------------------------------------------------------------------------

RUN_NUM=1
while [[ -e "$OUT_DIR/${HOSTNAME}-mobile-run${RUN_NUM}.json" \
      || -e "$OUT_DIR/${HOSTNAME}-desktop-run${RUN_NUM}.json" ]]; do
    RUN_NUM=$((RUN_NUM + 1))
done

# ---------------------------------------------------------------------------
# audit runner
# ---------------------------------------------------------------------------

# Common flags. --chrome-flags must be a single string per lighthouse CLI.
CHROME_FLAGS="--headless=new --no-sandbox --disable-gpu"

run_audit() {
    local preset="$1"   # 'mobile' or 'desktop'
    local base="${OUT_DIR}/${HOSTNAME}-${preset}-run${RUN_NUM}"
    local extra=()

    if [[ "$preset" == "desktop" ]]; then
        extra+=(--preset=desktop)
    fi
    # 'mobile' is Lighthouse's default form factor; pass nothing extra.

    echo "  [$preset] running ..."

    # With multiple --output values, Lighthouse treats --output-path as a
    # prefix and appends '.report.<ext>'. We rename afterward for cleaner paths.
    lighthouse "$URL" \
        --quiet \
        --output=json \
        --output=html \
        --output-path="$base" \
        --chrome-flags="$CHROME_FLAGS" \
        "${extra[@]}" >/dev/null

    [[ -f "$base.report.json" ]] && mv -f "$base.report.json" "$base.json"
    [[ -f "$base.report.html" ]] && mv -f "$base.report.html" "$base.html"

    echo "  [$preset] -> ${base#$REPO_ROOT/}.json"
    echo "  [$preset] -> ${base#$REPO_ROOT/}.html"
}

# ---------------------------------------------------------------------------
# go
# ---------------------------------------------------------------------------

echo "lighthouse audit"
echo "  url:   $URL"
echo "  host:  $HOSTNAME"
echo "  run:   #$RUN_NUM"
echo "  out:   ${OUT_DIR#$REPO_ROOT/}"
echo

run_audit mobile
run_audit desktop

echo
echo "done."
