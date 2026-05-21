#!/usr/bin/env bash
#
# run-audit.sh — collect-stage orchestrator.
# Runs Lighthouse + security scan sequentially against a URL. Each runner
# fails independently; this script reports per-stage status and only exits
# non-zero if every stage failed.
#
# No LLM calls. Analysis happens later, in Claude Code skills.

set -euo pipefail

# ---------------------------------------------------------------------------
# usage / args
# ---------------------------------------------------------------------------

usage() {
    cat <<EOF
Usage: $(basename "$0") <url>

Runs the collect stage of the audit pipeline against <url>:
    1. scripts/run-lighthouse.sh    — mobile + desktop Lighthouse
    2. scripts/run-security-scan.sh — TLS, headers, robots, sitemap, etc.

Artifacts land under reports/.cache/<hostname>/.

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
# paths + hostname
# ---------------------------------------------------------------------------

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
REPO_ROOT="$( cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd )"

HOSTNAME="${URL#*://}"
HOSTNAME="${HOSTNAME%%/*}"
HOSTNAME="${HOSTNAME%%\?*}"
HOSTNAME="${HOSTNAME%%#*}"
HOSTNAME="${HOSTNAME%%:*}"

if [[ -z "$HOSTNAME" ]]; then
    echo "error: could not extract hostname from '$URL'" >&2
    exit 64
fi

LIGHTHOUSE_SCRIPT="$SCRIPT_DIR/run-lighthouse.sh"
SECURITY_SCRIPT="$SCRIPT_DIR/run-security-scan.sh"

for s in "$LIGHTHOUSE_SCRIPT" "$SECURITY_SCRIPT"; do
    if [[ ! -f "$s" ]]; then
        echo "error: missing runner '$s'" >&2
        exit 1
    fi
done

# ---------------------------------------------------------------------------
# run
# ---------------------------------------------------------------------------

START_TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
START_EPOCH="$(date +%s)"

echo "=========================================="
echo "audit run"
echo "=========================================="
echo "  url:    $URL"
echo "  host:   $HOSTNAME"
echo "  start:  $START_TS"
echo "  cache:  reports/.cache/$HOSTNAME/"
echo

LH_STATUS="ok"
SEC_STATUS="ok"

echo "------------------------------------------"
echo "[1/2] lighthouse"
echo "------------------------------------------"
if ! bash "$LIGHTHOUSE_SCRIPT" "$URL"; then
    LH_STATUS="failed"
    echo "  ! lighthouse stage failed (continuing)" >&2
fi
echo

echo "------------------------------------------"
echo "[2/2] security"
echo "------------------------------------------"
if ! bash "$SECURITY_SCRIPT" "$URL"; then
    SEC_STATUS="failed"
    echo "  ! security stage failed (continuing)" >&2
fi
echo

END_EPOCH="$(date +%s)"
ELAPSED=$((END_EPOCH - START_EPOCH))

echo "=========================================="
echo "summary"
echo "=========================================="
printf "  %-12s %s\n" "lighthouse:" "$LH_STATUS"
printf "  %-12s %s\n" "security:"   "$SEC_STATUS"
printf "  %-12s %ss\n" "elapsed:"    "$ELAPSED"
printf "  %-12s %s\n" "artifacts:"  "reports/.cache/$HOSTNAME/"
echo

if [[ "$LH_STATUS" == "failed" && "$SEC_STATUS" == "failed" ]]; then
    echo "all stages failed." >&2
    exit 1
fi

if [[ "$LH_STATUS" == "failed" || "$SEC_STATUS" == "failed" ]]; then
    # Partial success: signal but don't hard-fail — analyzers can still run on
    # whatever artifacts landed.
    exit 2
fi

exit 0
