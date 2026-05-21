#!/usr/bin/env node
/*
 * src/report/render-report.js
 *
 * Runtime HTML rendering layer.
 *
 * Reads:
 *   reports/final/<hostname>/report-run<N>.json   (the Report JSON)
 *   templates/report.html                          (HTML skeleton)
 *   templates/styles.css                           (design system)
 *
 * Writes:
 *   reports/final/<hostname>/report-run<N>.html   (self-contained)
 *
 * Behavior mirrors scripts/render-report.sh — both produce identical output
 * bytes for the same inputs. This module exists for:
 *   - cross-platform use without bash
 *   - programmatic invocation from a Node orchestrator
 *   - unit-testable building blocks (preflight, renderHTML, canonicalJSON)
 *
 * No external npm dependencies. Only Node built-ins (fs, path).
 *
 * Determinism:
 *   - JSON canonicalized via JSON.stringify(obj, null, 2). Object key order
 *     is insertion order per ES2015, which JSON.parse preserves from the
 *     source file. Same input file → same output JSON bytes.
 *   - Line endings normalized to LF on input. Output is pure LF.
 *   - No timestamps inserted by the render step. Any time info comes from
 *     the Report JSON itself.
 *
 * Renderer contract per .claude/skills/_shared/report-artifacts.md:
 *   - Re-uses the source JSON's <N> for the HTML.
 *   - Atomic write (.tmp then rename).
 *   - Defensive pre-flight (schema, hostname, sums, anchors, themes).
 *   - Hard fails on schema or hostname mismatch (the inline renderer can
 *     recover from sum/anchor/theme anomalies; bad schema or wrong host
 *     would produce a wrong report.)
 */

'use strict';

const fs   = require('fs');
const path = require('path');


/* ============================================================
 * Constants
 * ============================================================ */

const EXPECTED_DIMS = ['seo', 'performance', 'accessibility', 'security', 'best-practices'];

const REQUIRED_FIELDS = [
  'meta',
  'executive_summary',
  'severity_overview',
  'key_findings',
  'prioritized_roadmap',
  'quick_wins',
  'long_term_improvements',
  'action_items'
];

const CSS_PLACEHOLDER     = '/* {{INLINE: templates/styles.css}} */';
const DATA_SCRIPT_OPEN_RE = /<script type="application\/json" id="report-data">/;
const DATA_SCRIPT_BLOCK_RE = /<script type="application\/json" id="report-data">[\s\S]*?<\/script>/;
const PLACEHOLDER_MARKER  = '"_placeholder": true';

const EXTERNAL_ASSET_RE = /<(link|script|img|iframe|video|audio|source|embed|object)\b[^>]*\s(href|src|data)\s*=\s*["']https?:/i;

/* Exit codes — match scripts/render-report.sh */
const EX = Object.freeze({
  OK:           0,
  RENDER_FAIL:  1,
  USAGE:        64,
  INVALID:      65,
  NOINPUT:      66,
  UNAVAILABLE: 127
});


/* ============================================================
 * Error type — carries the exit code through the throw chain
 * ============================================================ */

class RenderError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = 'RenderError';
    this.exitCode = exitCode != null ? exitCode : EX.RENDER_FAIL;
  }
}

function fail(code, message) {
  throw new RenderError(message, code);
}


/* ============================================================
 * Path helpers
 * ============================================================ */

function repoRoot() {
  return path.resolve(__dirname, '..', '..');
}

function rel(p) {
  return path.relative(repoRoot(), p).split(path.sep).join('/');
}


/* ============================================================
 * Public: pre-flight validation
 *
 *   Returns an array of warnings. Hard-fails (throws RenderError) on the
 *   two contract-breaking conditions: missing required schema fields, or
 *   meta.hostname mismatch. Other issues are surfaced as warnings — the
 *   inline renderer handles them gracefully and the report-builder's
 *   own quality gates surface them in the Appendix.
 * ============================================================ */

function preflight(report, hostname) {
  const warnings = [];

  /* 1. Schema shape */
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    fail(EX.INVALID, 'Report JSON top-level is not an object');
  }
  const present = new Set(Object.keys(report));
  const missing = REQUIRED_FIELDS.filter(f => !present.has(f));
  if (missing.length > 0) {
    fail(EX.INVALID, `missing required top-level fields: ${missing.join(', ')}`);
  }

  /* 2. Hostname match */
  const metaHost = (report.meta && report.meta.hostname) || '';
  if (metaHost !== hostname) {
    fail(EX.INVALID, `meta.hostname='${metaHost}' does not match directory '${hostname}'`);
  }

  /* 3. Dimension coverage */
  const analyzed = Array.isArray(report.meta.dimensions_analyzed) ? report.meta.dimensions_analyzed : [];
  const missingD = Array.isArray(report.meta.dimensions_missing)  ? report.meta.dimensions_missing  : [];
  const covered  = new Set([...analyzed, ...missingD]);
  const notCovered = EXPECTED_DIMS.filter(d => !covered.has(d));
  if (notCovered.length > 0) {
    warnings.push(`dimensions not accounted for in meta: ${notCovered.join(', ')}`);
  }

  /* 4. Sum invariants */
  const sumOf = obj => obj && typeof obj === 'object'
    ? Object.values(obj).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0)
    : 0;
  const sumSev = sumOf(report.severity_overview && report.severity_overview.by_severity);
  const sumPri = sumOf(report.severity_overview && report.severity_overview.by_priority);
  const total  = (report.action_items && report.action_items.total) || 0;
  if (sumSev !== total || sumPri !== total) {
    warnings.push(`count mismatch: by_severity=${sumSev}, by_priority=${sumPri}, action_items.total=${total}`);
  }

  /* 5. FindingRef.anchor pattern — must start with "#finding-" */
  let badAnchors = 0;
  (function walk(node) {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.ref && typeof node.ref === 'object' && typeof node.ref.anchor === 'string') {
      if (!node.ref.anchor.startsWith('#finding-')) badAnchors++;
    }
    for (const k of Object.keys(node)) {
      if (k !== 'ref') walk(node[k]);
    }
  })(report);
  if (badAnchors > 0) {
    warnings.push(`${badAnchors} FindingRef.anchor(s) do not match '#finding-<dim>-<id>'`);
  }

  /* 6. Themes — theme_id form, ≥2 supporting refs from ≥2 distinct dimensions */
  const themes = (report.long_term_improvements && report.long_term_improvements.themes) || [];
  let badThemes = 0;
  for (const t of themes) {
    const id   = (t && t.theme_id) || '';
    const refs = (t && t.supporting_finding_refs) || [];
    const dims = new Set(refs.map(r => r && r.dimension).filter(Boolean));
    if (!id.startsWith('theme-') || refs.length < 2 || dims.size < 2) {
      badThemes++;
    }
  }
  if (badThemes > 0) {
    warnings.push(`${badThemes} theme(s) violate theme_id / 2-finding / 2-dimension invariants`);
  }

  return warnings;
}


/* ============================================================
 * Public: canonical JSON formatting
 * ============================================================ */

function canonicalJSON(report) {
  /* 2-space indent. Object key order = insertion order (ES2015), which
     JSON.parse preserves from the source file — so re-emitting yields the
     same key order. Numbers are emitted in JS's canonical form. */
  return JSON.stringify(report, null, 2);
}


/* ============================================================
 * Public: render HTML from template + CSS + canonical JSON
 *
 *   Pure function — no I/O. Returns the final HTML string.
 *   Substitutes the CSS placeholder once and the data-script block once.
 *   String.replace's callback form avoids $-pattern interpretation in
 *   the replacement.
 * ============================================================ */

function renderHTML(templateContent, cssContent, reportJsonString) {
  /* Normalize line endings on all inputs so the output is pure LF. */
  const template = templateContent.replace(/\r\n/g, '\n');
  const css      = cssContent.replace(/\r\n/g, '\n');
  const json     = reportJsonString.replace(/\r\n/g, '\n');

  /* 1. CSS placeholder. Replace only the first occurrence (default String
     search behavior). Callback form prevents $&/$1 interpretation. */
  if (!template.includes(CSS_PLACEHOLDER)) {
    fail(EX.RENDER_FAIL, `CSS placeholder not found in template (expected '${CSS_PLACEHOLDER}')`);
  }
  let out = template.replace(CSS_PLACEHOLDER, () => css);

  /* 2. Data-script body. Locate the open tag, walk to the first </script>
     after it, and replace the contents. */
  const openMatch = out.match(DATA_SCRIPT_OPEN_RE);
  if (!openMatch) {
    fail(EX.RENDER_FAIL, 'report-data script open tag not found in template');
  }
  const openIndex = openMatch.index + openMatch[0].length;
  const closeIndex = out.indexOf('</script>', openIndex);
  if (closeIndex === -1) {
    fail(EX.RENDER_FAIL, 'report-data script close tag not found');
  }

  /* Preserve the indent of the closing tag. Look back from closeIndex to
     the start of its line to capture leading whitespace. */
  let closeLineStart = closeIndex;
  while (closeLineStart > 0 && out[closeLineStart - 1] !== '\n') closeLineStart--;
  const closeIndent = out.slice(closeLineStart, closeIndex); /* the whitespace */

  const before = out.slice(0, openIndex);
  const after  = out.slice(closeIndex);

  out = before + '\n' + json + '\n' + closeIndent + after.replace(/^[ \t]*/, '');

  return out;
}


/* ============================================================
 * Public: offline-safety scan
 *
 *   Strips the data-script body (its content is JSON, not HTML — text
 *   that looks like external markup inside JSON does not load anything)
 *   and scans the remainder for resource elements with external src/href.
 *   Returns an error string or null.
 * ============================================================ */

function checkOfflineSafe(html) {
  const stripped = html.replace(DATA_SCRIPT_BLOCK_RE, '');
  const m = stripped.match(EXTERNAL_ASSET_RE);
  if (m) {
    /* Trim the matched fragment for the error message */
    const snippet = m[0].length > 80 ? m[0].slice(0, 77) + '...' : m[0];
    return `output contains external resource reference: ${snippet}`;
  }
  return null;
}


/* ============================================================
 * Internal: read JSON file with helpful error
 * ============================================================ */

function readJSONFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    fail(EX.NOINPUT, `cannot read ${rel(filePath)}: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(EX.INVALID, `${rel(filePath)}: invalid JSON: ${e.message}`);
  }
}


/* ============================================================
 * Internal: pick the highest existing run number in a directory
 * ============================================================ */

function pickLatestRun(outDir) {
  let entries;
  try {
    entries = fs.readdirSync(outDir);
  } catch (e) {
    fail(EX.NOINPUT, `cannot read directory ${rel(outDir)}: ${e.message}`);
  }
  let maxN = 0;
  const re = /^report-run(\d+)\.json$/;
  for (const e of entries) {
    const m = e.match(re);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (n > maxN) maxN = n;
  }
  return maxN;
}


/* ============================================================
 * Internal: atomic write (tmp + rename)
 * ============================================================ */

function atomicWrite(targetPath, content) {
  const tmp = targetPath + '.tmp';
  fs.writeFileSync(tmp, content, { encoding: 'utf8' });
  /* fs.renameSync is atomic on POSIX. On Windows, NTFS rename within the
     same directory is also atomic (MoveFileExW with REPLACE_EXISTING). */
  fs.renameSync(tmp, targetPath);
}


/* ============================================================
 * Internal: hostname guard
 * ============================================================ */

function validateHostname(hostname) {
  if (!hostname || typeof hostname !== 'string') {
    fail(EX.USAGE, 'hostname is empty');
  }
  if (hostname.includes('/') || hostname.includes('\\') || hostname.includes('..')) {
    fail(EX.USAGE, `hostname '${hostname}' contains illegal characters (/, \\, ..)`);
  }
}


/* ============================================================
 * Internal: stderr logger (silenced when log:false in options)
 * ============================================================ */

function makeLogger(enabled) {
  if (!enabled) return () => {};
  return (...args) => process.stderr.write(args.join(' ') + '\n');
}


/* ============================================================
 * Public: top-level entry point
 *
 *   Returns the canonical relative path to the rendered HTML.
 *   Throws RenderError on failure (with .exitCode).
 *
 *   Options:
 *     hostname  — required
 *     runNumber — optional positive integer; defaults to highest existing
 *     log       — boolean; default true; if false, no stderr output
 * ============================================================ */

function renderReport(opts) {
  if (opts == null) opts = {};
  const { hostname, runNumber } = opts;
  const log = makeLogger(opts.log !== false);

  validateHostname(hostname);

  const root     = repoRoot();
  const outDir   = path.join(root, 'reports', 'final', hostname);
  const template = path.join(root, 'templates', 'report.html');
  const styles   = path.join(root, 'templates', 'styles.css');

  if (!fs.existsSync(outDir))   fail(EX.NOINPUT, `directory does not exist: ${rel(outDir)}`);
  if (!fs.existsSync(template)) fail(EX.NOINPUT, `template not found: ${rel(template)}`);
  if (!fs.existsSync(styles))   fail(EX.NOINPUT, `styles not found: ${rel(styles)}`);

  /* Resolve run number */
  let n = runNumber;
  if (n == null) {
    n = pickLatestRun(outDir);
    if (n === 0) {
      fail(EX.NOINPUT, `no report-run*.json files in ${rel(outDir)} — run the report-builder first`);
    }
  }
  if (!Number.isInteger(n) || n < 1) {
    fail(EX.USAGE, `invalid run number '${runNumber}' (expected positive integer)`);
  }

  const jsonFile = path.join(outDir, `report-run${n}.json`);
  const outFile  = path.join(outDir, `report-run${n}.html`);

  if (!fs.existsSync(jsonFile)) {
    fail(EX.NOINPUT, `${rel(jsonFile)} not found`);
  }

  log('render-report');
  log(`  host:     ${hostname}`);
  log(`  run:      #${n}`);
  log(`  source:   ${rel(jsonFile)}`);
  log(`  target:   ${rel(outFile)}`);
  log('');

  /* Read inputs */
  const report          = readJSONFile(jsonFile);
  const templateContent = fs.readFileSync(template, 'utf8');
  const cssContent      = fs.readFileSync(styles,   'utf8');

  /* Pre-flight */
  log('  preflight:');
  const warnings = preflight(report, hostname);
  if (warnings.length === 0) {
    log('    [ok]   all 6 checks passed');
  } else {
    for (const w of warnings) log(`    [warn] ${w}`);
  }
  log(`  preflight complete (${warnings.length} warning(s))`);
  log('');

  /* Canonicalize and render */
  const reportJson = canonicalJSON(report);
  log('  rendering: substituting CSS and JSON ...');
  const html = renderHTML(templateContent, cssContent, reportJson);

  /* Sanity checks on output */
  if (html.includes(CSS_PLACEHOLDER)) {
    fail(EX.RENDER_FAIL, 'CSS placeholder not substituted (template drift?)');
  }
  if (html.includes(PLACEHOLDER_MARKER)) {
    fail(EX.RENDER_FAIL, 'Report JSON placeholder not substituted');
  }
  const offlineErr = checkOfflineSafe(html);
  if (offlineErr) {
    fail(EX.RENDER_FAIL, offlineErr);
  }

  /* Atomic write */
  atomicWrite(outFile, html);

  const bytes = Buffer.byteLength(html, 'utf8');
  const lines = html.split('\n').length;
  log(`  rendered: ${lines} lines, ${bytes} bytes`);
  log('');
  log('done.');
  log(`  open: file://${outFile.split(path.sep).join('/')}`);
  log('  the file is self-contained and renders offline.');
  log('');

  return rel(outFile);
}


/* ============================================================
 * CLI
 * ============================================================ */

function printUsage(stream) {
  stream.write(
    'Usage: node src/report/render-report.js <hostname> [<run-number>]\n' +
    '\n' +
    'Renders the Report JSON at\n' +
    '    reports/final/<hostname>/report-run<N>.json\n' +
    'into a self-contained HTML file at\n' +
    '    reports/final/<hostname>/report-run<N>.html\n' +
    '\n' +
    'If <run-number> is omitted, the highest-numbered existing report-run*.json\n' +
    'in the hostname directory is used.\n' +
    '\n' +
    'Exit codes:\n' +
    '    0  success\n' +
    '    1  render failure (sanity check, output not safe)\n' +
    '   64  bad arguments\n' +
    '   65  invalid Report JSON (pre-flight failure)\n' +
    '   66  missing required input file\n'
  );
}

function cli(argv) {
  if (argv.length < 1 || argv[0] === '-h' || argv[0] === '--help') {
    printUsage(argv.length < 1 ? process.stderr : process.stdout);
    process.exit(argv.length < 1 ? EX.USAGE : EX.OK);
  }

  let runNumber;
  if (argv.length >= 2) {
    if (!/^[1-9]\d*$/.test(argv[1])) {
      process.stderr.write(`error: invalid run number '${argv[1]}' (expected positive integer)\n`);
      process.exit(EX.USAGE);
    }
    runNumber = parseInt(argv[1], 10);
  }

  try {
    const finalPath = renderReport({ hostname: argv[0], runNumber });
    process.stdout.write(finalPath + '\n');
  } catch (e) {
    if (e instanceof RenderError) {
      process.stderr.write(`error: ${e.message}\n`);
      process.exit(e.exitCode);
    }
    process.stderr.write(`error: ${(e && e.stack) || e}\n`);
    process.exit(EX.RENDER_FAIL);
  }
}

if (require.main === module) {
  cli(process.argv.slice(2));
}


/* ============================================================
 * Exports — for programmatic use (orchestrator, tests).
 * ============================================================ */

module.exports = {
  renderReport,
  preflight,
  canonicalJSON,
  renderHTML,
  checkOfflineSafe,
  RenderError,
  EX
};
