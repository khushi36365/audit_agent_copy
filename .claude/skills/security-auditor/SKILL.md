---
name: security-auditor
description: Use when interpreting security findings from a cached audit run. Reads the security scan JSON (TLS, headers, robots, sitemap, redirect, mixed-content) plus the Lighthouse best-practices subset that touches security, under reports/.cache/<hostname>/. Emits a structured per-finding analysis ready for the report builder. Does not collect data — runners in scripts/ produce the inputs.
---

# security-auditor

## Purpose

Interpret the deterministic security scan into prioritized, evidence-backed findings: transport security, security-header coverage and quality, redirect correctness, and surface-level information leakage. Each finding states the concrete observation, the threat model it relates to, and a specific remediation.

## Input artifacts

Read from `reports/.cache/<hostname>/`. Pick the highest-numbered run.

- `security/<hostname>-security-run<N>.json` — primary source. Sections used:
  - `tls` — protocol, cipher, certificate validity window, subject/issuer
  - `headers.present` — the ten security-relevant response headers
  - `robots_txt` — status, size, snippet (info-leak surface)
  - `sitemap_xml` — status, size, snippet (sensitive paths)
  - `http_redirect` — upgrade-to-HTTPS behavior
  - `mixed_content` — count + sample of insecure asset references
- `lighthouse/<hostname>-mobile-run<N>.json` — Lighthouse best-practices audits that overlap security: `'is-on-https'`, `'uses-http2'`, `'no-vulnerable-libraries'`, `'csp-xss'`. Pull these to corroborate or supplement the deterministic scan.

If the security artifact is missing, the skill should refuse and record the gap — Lighthouse alone is not a substitute.

## Output schema

This skill emits the canonical analyzer output defined in [`../_shared/analyzer-schema.md`](../_shared/analyzer-schema.md). That document is normative for field shapes, severity/priority semantics, sort order, and the extension registry. Per-skill specifics only:

- **`dimension`:** `"security"`
- **`category` enum:** `"transport" | "headers" | "redirect" | "mixed-content" | "information-disclosure" | "dependencies"`
- **`score` derivation:** a **control-coverage rollup**, not a Lighthouse score (Lighthouse does not cover transport/headers comprehensively). Start at 100, deduct per finding by severity: critical −25, high −15, medium −8, low −3, info 0. Floor at 0.
- **Tiebreaker** (within a priority/severity tier): exploitability ranking — remote-unauthenticated > authenticated > local > theoretical. This is a judgment call; no automated metric.
- **Extensions used:**
  - `findings[].extensions.cve` — array of CVE IDs, **only when** Lighthouse `'no-vulnerable-libraries'` provided them. Never fabricate CVEs.

`evidence` should quote the literal header value (or `"absent"`), TLS protocol/cipher, certificate dates, or a sample mixed-content URL from the security scan JSON.

## Analysis responsibilities

- **Transport:**
  - Negotiated protocol must be TLS 1.2+; flag TLS 1.0/1.1 as critical.
  - Certificate `notAfter` within 30 days → warning; expired → critical.
  - Note issuer for context (self-signed, internal CA, etc.); do not flag well-known public CAs.
- **Security headers** (per `headers.present`):
  - Required: `strict-transport-security` (with adequate max-age), `content-security-policy`, `x-content-type-options: nosniff`, `referrer-policy`.
  - Recommended: `permissions-policy`, `cross-origin-opener-policy`, `cross-origin-resource-policy`.
  - Legacy/deprecated: do not require `x-xss-protection`; note if present with unsafe value.
  - For CSP: flag `unsafe-inline`, `unsafe-eval`, wildcard sources — quote the offending directive in `evidence`.
- **HTTP→HTTPS redirect:** `upgrades_to_https` must be true; prefer 301/308 over 302/307 for canonical reasons.
- **Mixed content:** any `insecure_asset_refs > 0` on an https page is at least high severity. List the sample URLs in `evidence`. Note the documented limitation that JS-injected assets are not detected.
- **Information disclosure:**
  - `robots.txt` listing sensitive paths (admin, staging, backup) — flag as info leak.
  - `sitemap.xml` exposing non-public URLs — same.
- **Dependencies** (from Lighthouse `'no-vulnerable-libraries'`): list each known-vulnerable library with version and CVE if Lighthouse surfaces it; do not invent CVEs.

## Procedure

Follow the steps in [`../_shared/analysis-procedure.md`](../_shared/analysis-procedure.md). Skill-specific signal handling below.

### Load

Read these JSON files (highest-numbered run wins):
- `reports/.cache/<hostname>/security/<hostname>-security-run<N>.json` — **required**
- `reports/.cache/<hostname>/lighthouse/<hostname>-mobile-run<N>.json` — optional (for `is-on-https`, `no-vulnerable-libraries`, `csp-xss`)

If the security JSON is missing, emit `findings: []`, `score: 0`, and a `summary` that names the missing artifact and tells the operator to run `scripts/run-security-scan.sh`. Lighthouse alone is not a substitute.

### TLS signals (from `.tls`)

Compare cert dates to `metadata.analyzed_at`.

| Signal | `id` | severity |
|---|---|---|
| `.checked == true && .reachable == false` | `tls-unreachable` | critical |
| `.protocol` in `["SSLv3", "TLSv1", "TLSv1.1"]` | `tls-protocol-outdated` | critical |
| `.protocol == "TLSv1.2"` | `tls-prefer-1.3` | low |
| `.certificate.notAfter` already past | `tls-cert-expired` | critical |
| `.certificate.notAfter` within 14 days | `tls-cert-expiring-soon` | critical |
| `.certificate.notAfter` within 30 days | `tls-cert-expiring` | high |

### Header signals (from `.headers.present`)

Each missing header is **one** finding. Quote the literal value (or `"absent"`) in `evidence`.

| Header | id (absent) | severity absent | severity present-but-weak |
|---|---|---|---|
| `strict-transport-security` | `sec-hsts-missing` | high | medium when `max-age < 15768000` |
| `content-security-policy` | `sec-csp-missing` | high | see CSP sub-checks |
| `x-content-type-options` | `sec-xcto-missing` | medium | medium when value ≠ `nosniff` |
| `referrer-policy` | `sec-referrer-policy-missing` | low | — |
| `permissions-policy` | `sec-permissions-policy-missing` | low | — |
| `x-frame-options` (or CSP `frame-ancestors`) | `sec-clickjacking-protection-missing` | medium | — |
| `cross-origin-opener-policy` | `sec-coop-missing` | low | — |
| `cross-origin-resource-policy` | `sec-corp-missing` | low | — |
| `cross-origin-embedder-policy` | `sec-coep-missing` | info | — |
| `x-xss-protection` | — | drop (deprecated) | low when value ≠ `0` |

CSP sub-checks (when CSP is present):
- `'unsafe-inline'` in `script-src` or `default-src` → `sec-csp-unsafe-inline` → medium
- `'unsafe-eval'` anywhere → `sec-csp-unsafe-eval` → medium
- wildcard source (`*`) in `script-src` / `default-src` → `sec-csp-wildcard-source` → high

### Redirect signals (from `.http_redirect`)

| Signal | `id` | severity |
|---|---|---|
| `.upgrades_to_https == false` AND audited URL scheme was https | `sec-no-http-to-https-redirect` | high |
| `.final_status` in `[302, 307]` (prefer 301/308) | `sec-redirect-not-canonical` | low |

### Mixed content (from `.mixed_content`)

| Signal | `id` | severity |
|---|---|---|
| `.insecure_asset_refs > 0` | `sec-mixed-content` | high |

Quote up to 3 URLs from `.sample` in `evidence`. Always append to `recommendation`: *"Note: only static HTML was scanned; JS-injected assets are not detected by this audit and should be reviewed separately."*

### Information disclosure (from `.robots_txt.snippet` and `.sitemap_xml.snippet`)

Case-insensitive substring scan for sensitive path patterns: `admin`, `staging`, `backup`, `private`, `internal`, `wp-admin`, `.git`, `.env`. At most one finding per artifact; quote the matching paths.

| Source | `id` | severity |
|---|---|---|
| robots.txt snippet contains a sensitive pattern | `sec-robots-leaks-paths` | medium |
| sitemap.xml snippet contains a sensitive pattern | `sec-sitemap-leaks-urls` | medium |

### Dependency signals (from Lighthouse `no-vulnerable-libraries`)

When the Lighthouse audit provides items, emit one finding per `details.items[]`. Pull CVE IDs only from the item itself.

| Lighthouse-reported severity | severity |
|---|---|
| `high`    | high |
| `medium`  | medium |
| `low`     | low |
| (missing) | medium |

`extensions.cve` = the literal CVE list from the artifact; `[]` if Lighthouse did not provide any. **Never invent CVEs.**

### Score formula

```
score = 100
for each finding:
  if severity == "critical": score -= 25
  elif severity == "high":   score -= 15
  elif severity == "medium": score -= 8
  elif severity == "low":    score -= 3
  // info: no deduction
score = max(0, score)
```

### Skill-specific rules

- HSTS recommendation: `Strict-Transport-Security: max-age=31536000; includeSubDomains` (preload is a separate decision — do not auto-recommend).
- CSP: do **not** suggest a full policy. Recommend starting from `default-src 'self'` and link to `https://csp-evaluator.withgoogle.com/`.
- Information-disclosure findings: the recommendation is to remove the path from the public artifact **and** verify the underlying resource is not actually exposed.

## Out of scope

- Active exploitation, fuzzing, or anything that mutates the target
- Authenticated/post-login surfaces (only public-page artifacts are available)
- Network-layer scanning (open ports, DNS records) — runners do not collect this
- Supply-chain SBOM analysis beyond what Lighthouse reports
