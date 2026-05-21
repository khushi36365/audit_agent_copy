#!/usr/bin/env bash
#
# run-security-scan.sh — collect stage runner for the audit pipeline.
# Gathers TLS info, security headers, robots.txt, sitemap.xml, redirect
# behavior, and mixed-content indicators for a URL and writes a single
# structured JSON artifact under reports/.cache/<hostname>/security/.
#
# No LLM calls. Deterministic data collection only.

set -euo pipefail

# ---------------------------------------------------------------------------
# usage / args
# ---------------------------------------------------------------------------

usage() {
    cat <<EOF
Usage: $(basename "$0") <url>

Collects security signals for <url> and writes a JSON artifact to
reports/.cache/<hostname>/security/.

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
# dependency checks
# ---------------------------------------------------------------------------

for cmd in curl openssl jq; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "error: '$cmd' not found in PATH" >&2
        echo "       required dependencies: curl, openssl, jq" >&2
        exit 127
    fi
done

# ---------------------------------------------------------------------------
# paths + url parsing
# ---------------------------------------------------------------------------

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
REPO_ROOT="$( cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd )"

SCHEME="${URL%%://*}"
REST="${URL#*://}"
HOSTPORT="${REST%%/*}"
HOSTPORT="${HOSTPORT%%\?*}"
HOSTPORT="${HOSTPORT%%#*}"

HOSTNAME="${HOSTPORT%%:*}"
PORT="${HOSTPORT##*:}"
if [[ "$PORT" == "$HOSTPORT" ]]; then
    # no explicit port — pick the default for the scheme
    if [[ "$SCHEME" == "https" ]]; then PORT=443; else PORT=80; fi
fi

if [[ -z "$HOSTNAME" ]]; then
    echo "error: could not extract hostname from '$URL'" >&2
    exit 64
fi

ORIGIN="${SCHEME}://${HOSTPORT}"

OUT_DIR="$REPO_ROOT/reports/.cache/$HOSTNAME/security"
mkdir -p "$OUT_DIR"

# run number
RUN_NUM=1
while [[ -e "$OUT_DIR/${HOSTNAME}-security-run${RUN_NUM}.json" ]]; do
    RUN_NUM=$((RUN_NUM + 1))
done
OUT_FILE="$OUT_DIR/${HOSTNAME}-security-run${RUN_NUM}.json"

# ---------------------------------------------------------------------------
# temp workspace (cleaned on exit)
# ---------------------------------------------------------------------------

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

UA="audit-agent/0.1 (+security-scan)"
CURL_BASE=(curl --silent --show-error --connect-timeout 10 --max-time 30 -A "$UA")

# Ensure a value is valid JSON before it flows into `jq --argjson`. Empty or
# malformed inputs become `null` rather than aborting the final assembly.
safe_json() {
    local v="$1"
    if [[ -z "$v" ]]; then printf 'null'; return; fi
    if printf '%s' "$v" | jq empty >/dev/null 2>&1; then
        printf '%s' "$v"
    else
        printf 'null'
    fi
}

# ---------------------------------------------------------------------------
# collectors — each returns a JSON value via stdout
# ---------------------------------------------------------------------------

collect_tls() {
    if [[ "$SCHEME" != "https" ]]; then
        jq -n '{checked:false, reason:"non-https URL"}'
        return
    fi

    local raw
    raw="$(openssl s_client \
            -connect "${HOSTNAME}:${PORT}" \
            -servername "$HOSTNAME" \
            -showcerts \
            </dev/null 2>/dev/null || true)"

    if [[ -z "$raw" ]]; then
        jq -n '{checked:true, reachable:false}'
        return
    fi

    local protocol cipher
    protocol="$(echo "$raw" | awk -F': ' '/^[[:space:]]*Protocol[[:space:]]*:/ {print $2; exit}' | tr -d '\r')"
    cipher="$(echo "$raw" | awk -F': ' '/^[[:space:]]*Cipher[[:space:]]*:/ {print $2; exit}' | tr -d '\r')"

    local cert_info subject issuer not_before not_after
    cert_info="$(echo "$raw" | openssl x509 -noout -subject -issuer -dates 2>/dev/null || true)"
    subject="$(echo  "$cert_info" | awk -F'=' '/^subject=/   {sub(/^subject=/,""); print; exit}')"
    issuer="$(echo   "$cert_info" | awk -F'=' '/^issuer=/    {sub(/^issuer=/,"");  print; exit}')"
    not_before="$(echo "$cert_info" | awk -F'=' '/^notBefore=/ {print $2; exit}')"
    not_after="$(echo  "$cert_info" | awk -F'=' '/^notAfter=/  {print $2; exit}')"

    jq -n \
        --arg protocol  "$protocol" \
        --arg cipher    "$cipher" \
        --arg subject   "$subject" \
        --arg issuer    "$issuer" \
        --arg notBefore "$not_before" \
        --arg notAfter  "$not_after" \
        '{
            checked:    true,
            reachable:  true,
            protocol:   ($protocol  | select(length>0) // null),
            cipher:     ($cipher    | select(length>0) // null),
            certificate: {
                subject:   ($subject   | select(length>0) // null),
                issuer:    ($issuer    | select(length>0) // null),
                notBefore: ($notBefore | select(length>0) // null),
                notAfter:  ($notAfter  | select(length>0) // null)
            }
        }'
}

# Fetch the final response headers (after redirects) into $TMP_DIR/headers.txt,
# then extract a fixed set of security-relevant headers.
collect_headers() {
    local raw last
    raw="$("${CURL_BASE[@]}" -I -L --max-redirs 5 "$URL" 2>/dev/null || true)"

    if [[ -z "$raw" ]]; then
        jq -n '{checked:true, reachable:false}'
        return
    fi

    # Keep only the final response block (after blank-line separators).
    last="$(echo "$raw" | awk 'BEGIN{RS=""} END{print}')"

    get() {
        echo "$last" \
            | grep -i "^${1}:" \
            | head -1 \
            | sed -E 's/^[^:]+:[[:space:]]*//' \
            | tr -d '\r\n'
    }

    jq -n \
        --arg hsts  "$(get strict-transport-security)" \
        --arg csp   "$(get content-security-policy)" \
        --arg xfo   "$(get x-frame-options)" \
        --arg xcto  "$(get x-content-type-options)" \
        --arg ref   "$(get referrer-policy)" \
        --arg pp    "$(get permissions-policy)" \
        --arg xxss  "$(get x-xss-protection)" \
        --arg coop  "$(get cross-origin-opener-policy)" \
        --arg corp  "$(get cross-origin-resource-policy)" \
        --arg coep  "$(get cross-origin-embedder-policy)" \
        '{
            checked: true,
            reachable: true,
            present: {
                strict_transport_security:   ($hsts | select(length>0) // null),
                content_security_policy:     ($csp  | select(length>0) // null),
                x_frame_options:             ($xfo  | select(length>0) // null),
                x_content_type_options:      ($xcto | select(length>0) // null),
                referrer_policy:             ($ref  | select(length>0) // null),
                permissions_policy:          ($pp   | select(length>0) // null),
                x_xss_protection:            ($xxss | select(length>0) // null),
                cross_origin_opener_policy:  ($coop | select(length>0) // null),
                cross_origin_resource_policy:($corp | select(length>0) // null),
                cross_origin_embedder_policy:($coep | select(length>0) // null)
            }
        }'
}

# Fetch a well-known file off the origin and report status + size + first
# kilobyte of body (enough for downstream analyzers; avoids unbounded JSON).
collect_well_known() {
    local path="$1"
    local target="${ORIGIN}/${path}"
    local body_file="$TMP_DIR/$(echo "$path" | tr '/.' '__')"
    local status size

    status="$("${CURL_BASE[@]}" -L --max-redirs 3 \
                -o "$body_file" \
                -w '%{http_code}' \
                "$target" 2>/dev/null || echo "000")"

    if [[ -f "$body_file" ]]; then
        size=$(wc -c < "$body_file" | tr -d ' ')
    else
        size=0
    fi

    local snippet=""
    if [[ "$status" == "200" && -f "$body_file" ]]; then
        snippet="$(head -c 1024 "$body_file" || true)"
    fi

    jq -n \
        --arg url     "$target" \
        --arg status  "$status" \
        --argjson size "$size" \
        --arg snippet "$snippet" \
        '{
            url:     $url,
            status:  ($status | tonumber? // 0),
            found:   ($status == "200"),
            size_bytes: $size,
            snippet: ($snippet | select(length>0) // null)
        }'
}

# Whether http://host redirects to https://host.
collect_http_redirect() {
    local http_url="http://${HOSTPORT/:[0-9]*/}"   # drop any explicit port
    local final status

    final="$("${CURL_BASE[@]}" -o /dev/null \
                -L --max-redirs 5 \
                -w '%{url_effective}|%{http_code}|%{num_redirects}' \
                "$http_url" 2>/dev/null || echo "||")"

    local eff code redirects
    eff="${final%%|*}"
    final="${final#*|}"
    code="${final%%|*}"
    redirects="${final#*|}"

    local upgrades_to_https=false
    if [[ "$eff" =~ ^https:// ]]; then upgrades_to_https=true; fi

    jq -n \
        --arg probed "$http_url" \
        --arg final  "$eff" \
        --arg code   "$code" \
        --arg n      "$redirects" \
        --argjson up "$upgrades_to_https" \
        '{
            probed:           $probed,
            final_url:        ($final | select(length>0) // null),
            final_status:     ($code  | tonumber? // 0),
            num_redirects:    ($n     | tonumber? // 0),
            upgrades_to_https: $up
        }'
}

# Cheap mixed-content heuristic: when the page is https, count and sample
# http:// asset references in the served HTML.
collect_mixed_content() {
    if [[ "$SCHEME" != "https" ]]; then
        jq -n '{checked:false, reason:"non-https URL"}'
        return
    fi

    local body_file="$TMP_DIR/page.html"
    if ! "${CURL_BASE[@]}" -L --max-redirs 5 -o "$body_file" "$URL" 2>/dev/null; then
        jq -n '{checked:true, fetched:false}'
        return
    fi

    # Extract attribute-style http:// references (src=, href=, action=, srcset=, etc.).
    local matches
    matches="$(grep -oiE '(src|href|action|srcset|poster|data)[[:space:]]*=[[:space:]]*["'\''"]http://[^"'\'' >]+' "$body_file" \
                | sed -E 's/^[^=]+=["'\''"]*//' \
                | sort -u || true)"

    local count=0
    if [[ -n "$matches" ]]; then
        count=$(echo "$matches" | wc -l | tr -d ' ')
    fi

    local sample
    sample="$(echo "$matches" | head -10)"

    jq -n \
        --argjson count "$count" \
        --arg sample "$sample" \
        '{
            checked: true,
            fetched: true,
            insecure_asset_refs: $count,
            sample: ($sample
                     | split("\n")
                     | map(select(length>0)))
        }'
}

# ---------------------------------------------------------------------------
# run collectors
# ---------------------------------------------------------------------------

echo "security scan"
echo "  url:   $URL"
echo "  host:  $HOSTNAME"
echo "  run:   #$RUN_NUM"
echo "  out:   ${OUT_FILE#$REPO_ROOT/}"
echo

echo "  [tls]            ..."
TLS_JSON="$(collect_tls)"
echo "  [headers]        ..."
HEADERS_JSON="$(collect_headers)"
echo "  [robots]         ..."
ROBOTS_JSON="$(collect_well_known robots.txt)"
echo "  [sitemap]        ..."
SITEMAP_JSON="$(collect_well_known sitemap.xml)"
echo "  [http-redirect]  ..."
REDIRECT_JSON="$(collect_http_redirect)"
echo "  [mixed-content]  ..."
MIXED_JSON="$(collect_mixed_content)"

# ---------------------------------------------------------------------------
# assemble + write
# ---------------------------------------------------------------------------

TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

# Defensive: any collector that returned empty/invalid output becomes `null`
# rather than aborting the assembly with "invalid JSON text passed to --argjson".
TLS_JSON="$(safe_json     "$TLS_JSON")"
HEADERS_JSON="$(safe_json "$HEADERS_JSON")"
ROBOTS_JSON="$(safe_json  "$ROBOTS_JSON")"
SITEMAP_JSON="$(safe_json "$SITEMAP_JSON")"
REDIRECT_JSON="$(safe_json "$REDIRECT_JSON")"
MIXED_JSON="$(safe_json   "$MIXED_JSON")"

jq -n \
    --arg  url       "$URL" \
    --arg  hostname  "$HOSTNAME" \
    --arg  origin    "$ORIGIN" \
    --arg  scheme    "$SCHEME" \
    --argjson port   "$PORT" \
    --arg  ts        "$TIMESTAMP" \
    --argjson run    "$RUN_NUM" \
    --argjson tls    "$TLS_JSON" \
    --argjson hdrs   "$HEADERS_JSON" \
    --argjson rbt    "$ROBOTS_JSON" \
    --argjson smp    "$SITEMAP_JSON" \
    --argjson rdr    "$REDIRECT_JSON" \
    --argjson mxd    "$MIXED_JSON" \
    '{
        url:        $url,
        hostname:   $hostname,
        origin:     $origin,
        scheme:     $scheme,
        port:       $port,
        run:        $run,
        collected_at: $ts,
        tls:        $tls,
        headers:    $hdrs,
        robots_txt: $rbt,
        sitemap_xml: $smp,
        http_redirect: $rdr,
        mixed_content: $mxd
    }' > "$OUT_FILE"

echo
echo "done."
echo "  -> ${OUT_FILE#$REPO_ROOT/}"
