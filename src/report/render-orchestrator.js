/*
 * src/report/render-orchestrator.js — render-stage orchestration
 *
 * Wraps the deterministic runtime renderer in src/report/render-report.js
 * with the standard orchestrator concerns:
 *
 *   - Pre-flight: source Report JSON exists, run number resolves
 *   - Execute: drive the renderer (HTML written atomically)
 *   - Post-validate: read the written file back and re-check it
 *       * non-empty
 *       * no remaining placeholders ("{{INLINE...}}", "_placeholder: true")
 *       * still offline-safe (defense in depth — renderer also checks pre-write)
 *       * expected hostname appears verbatim in the embedded JSON
 *   - Print the final artifact path through structured logging
 *
 * Why a separate orchestrator: matches the pattern of the analyze and
 * narrate stages. The orchestrator owns logging, error mapping, and
 * post-write validation; src/report/render-report.js owns the actual
 * substitution and atomic write.
 *
 * No external npm dependencies. Built-in fs + path only.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const {
  renderReport,
  checkOfflineSafe,
  RenderError
} = require('./render-report');


/* ============================================================
 * Constants + error type
 * ============================================================ */

const CRITICAL = Object.freeze({
  NO_SOURCE:        'NO_SOURCE',
  RENDER_FAILED:    'RENDER_FAILED',
  POST_VALIDATION:  'POST_VALIDATION',
  NOT_OFFLINE_SAFE: 'NOT_OFFLINE_SAFE',
  BAD_INPUT:        'BAD_INPUT'
});

class RenderOrchestratorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RenderOrchestratorError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new RenderOrchestratorError(code, message);
}


/* ============================================================
 * Path + logging helpers
 * ============================================================ */

function repoRoot() {
  return path.resolve(__dirname, '..', '..');
}

function rel(p) {
  return path.relative(repoRoot(), p).split(path.sep).join('/');
}

function fileURL(absPath) {
  return 'file:///' + absPath.split(path.sep).join('/').replace(/^\//, '');
}

function noopLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}


/* ============================================================
 * Run-number resolution
 * ============================================================ */

function findLatestRunNumber(outDir) {
  if (!fs.existsSync(outDir)) return 0;
  let max = 0;
  for (const entry of fs.readdirSync(outDir)) {
    const m = entry.match(/^report-run(\d+)\.json$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return max;
}


/* ============================================================
 * Post-write validation
 *
 *   Reads the freshly-written HTML back from disk and runs a strict
 *   set of checks. Catches anomalies the renderer's pre-write checks
 *   cannot see (post-write truncation, partial-rename races, external
 *   mutation between the renderer's write and our validation).
 * ============================================================ */

function postValidateHTML(htmlPath, expectedHostname) {
  let stat;
  try {
    stat = fs.statSync(htmlPath);
  } catch (e) {
    fail(CRITICAL.POST_VALIDATION,
      `expected HTML not found after render: ${rel(htmlPath)} (${e.message})`);
  }
  if (!stat.isFile()) {
    fail(CRITICAL.POST_VALIDATION, `output is not a regular file: ${rel(htmlPath)}`);
  }
  if (stat.size === 0) {
    fail(CRITICAL.POST_VALIDATION, `rendered HTML is empty: ${rel(htmlPath)}`);
  }

  let html;
  try {
    html = fs.readFileSync(htmlPath, 'utf8');
  } catch (e) {
    fail(CRITICAL.POST_VALIDATION, `cannot re-read HTML: ${e.message}`);
  }

  /* Placeholder substitutions all happened */
  if (html.includes('/* {{INLINE: templates/styles.css}} */')) {
    fail(CRITICAL.POST_VALIDATION, `CSS placeholder still present in HTML`);
  }
  if (html.includes('"_placeholder": true')) {
    fail(CRITICAL.POST_VALIDATION, `Report JSON placeholder still present in HTML`);
  }

  /* Offline-safety re-check — strips the data-script body internally so
     URLs in finding recommendations don't false-positive. */
  const offlineErr = checkOfflineSafe(html);
  if (offlineErr) {
    fail(CRITICAL.NOT_OFFLINE_SAFE, `output not offline-safe: ${offlineErr}`);
  }

  /* Hostname spot-check — soft warning only, since JSON quoting could vary */
  const warnings = [];
  if (!html.includes(`"hostname": "${expectedHostname}"`)) {
    warnings.push(`expected hostname "${expectedHostname}" not found verbatim in embedded JSON`);
  }

  /* Basic structural sanity */
  if (!/<!doctype html>/i.test(html)) {
    warnings.push(`output is missing a DOCTYPE declaration`);
  }
  if (!html.includes('<script type="application/json" id="report-data">')) {
    fail(CRITICAL.POST_VALIDATION, `embedded report-data script block missing`);
  }

  return {
    bytes: stat.size,
    lines: html.split('\n').length,
    warnings
  };
}


/* ============================================================
 * Top-level: run the HTML renderer for one (hostname, run) pair
 * ============================================================ */

async function runHTMLRenderer({ hostname, runNumber, log }) {
  if (!hostname || typeof hostname !== 'string') {
    fail(CRITICAL.BAD_INPUT, 'hostname (string) is required');
  }
  if (runNumber !== undefined && runNumber !== null) {
    if (!Number.isInteger(runNumber) || runNumber < 1) {
      fail(CRITICAL.BAD_INPUT, `invalid run number '${runNumber}' (expected positive integer)`);
    }
  }
  if (!log) log = noopLogger();

  const t0   = Date.now();
  const root = repoRoot();
  const outDir = path.join(root, 'reports', 'final', hostname);

  log.info('render', 'starting HTML renderer', { hostname });

  /* Pre-flight: source dir + JSON exist */
  if (!fs.existsSync(outDir)) {
    fail(CRITICAL.NO_SOURCE,
      `no source directory: ${rel(outDir)}. Run the narrate stage first.`);
  }

  let n = runNumber;
  if (n == null) {
    n = findLatestRunNumber(outDir);
    if (n === 0) {
      fail(CRITICAL.NO_SOURCE,
        `no report-run*.json in ${rel(outDir)}. Run the narrate stage first.`);
    }
    log.info('render', `resolved latest run #${n}`);
  }

  const sourcePath = path.join(outDir, `report-run${n}.json`);
  if (!fs.existsSync(sourcePath)) {
    fail(CRITICAL.NO_SOURCE, `${rel(sourcePath)} not found`);
  }

  log.info('render', 'rendering', { source: rel(sourcePath), run: n });

  /* Execute renderer. Silence its own stderr logging so the orchestrator's
     structured logs are the single source of truth. */
  let htmlPathRel;
  try {
    htmlPathRel = renderReport({ hostname, runNumber: n, log: false });
  } catch (e) {
    if (e instanceof RenderError) {
      fail(CRITICAL.RENDER_FAILED,
        `renderer failed (exit ${e.exitCode}): ${e.message}`);
    }
    throw e;
  }

  /* Resolve to absolute for post-validation + file:// URL */
  const htmlPathAbs = path.isAbsolute(htmlPathRel)
    ? htmlPathRel
    : path.join(root, htmlPathRel);

  /* Post-write validation */
  log.info('render', 'post-validating output');
  const validation = postValidateHTML(htmlPathAbs, hostname);

  for (const w of validation.warnings) {
    log.warn('render', w);
  }

  const elapsed_ms = Date.now() - t0;

  log.info('render', 'done', {
    html_path:  htmlPathRel,
    bytes:      validation.bytes,
    lines:      validation.lines,
    run:        n,
    warnings:   validation.warnings.length,
    elapsed_ms
  });

  /* Print the final artifact path clearly. The orchestrator entry (cli)
     additionally writes this path to stdout for capture; this log line is
     for human readers on stderr. */
  log.info('render', `artifact: ${fileURL(htmlPathAbs)}`);

  return {
    ok:        true,
    htmlPath:  htmlPathRel,
    fileURL:   fileURL(htmlPathAbs),
    run:       n,
    bytes:     validation.bytes,
    lines:     validation.lines,
    warnings:  validation.warnings,
    elapsed_ms
  };
}


/* ============================================================
 * Exports
 * ============================================================ */

module.exports = {
  runHTMLRenderer,
  postValidateHTML,
  findLatestRunNumber,
  RenderOrchestratorError,
  CRITICAL
};
