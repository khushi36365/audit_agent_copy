/*
 * src/runners/orchestrator.js — deterministic collector orchestration
 *
 * Drives the two bash collectors directly and validates their outputs:
 *
 *   scripts/run-lighthouse.sh    → reports/.cache/<host>/lighthouse/...
 *   scripts/run-security-scan.sh → reports/.cache/<host>/security/...
 *
 * Why this exists separately from src/index.js:
 *   - Lets the orchestrator entry stay high-level (stages in order).
 *   - Keeps runner-specific validation co-located with the runner names.
 *   - Each runner is independently exportable for tests.
 *
 * Determinism:
 *   - Sequential execution in fixed order: lighthouse first, then security.
 *   - Hostname is passed in from the caller (already URL-normalized) and
 *     verified against the on-disk artifacts the runners produced. If a
 *     runner extracts a different hostname, the cache directory mismatch
 *     is caught and the pipeline stops.
 *   - Output file lists are sorted for stable logging across runs.
 *
 * Stop-on-critical policy:
 *   - Missing runner script              → CollectorError (critical)
 *   - bash not on PATH                   → CollectorError (critical)
 *   - All enabled runners produced 0     → CollectorError (critical)
 *   - Expected hostname cache dir absent → CollectorError (critical)
 *
 *   - One runner failed, one succeeded   → warn, continue
 *   - Runner exit != 0 but valid output  → warn, continue
 *
 * No LLM calls.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');


/* ============================================================
 * Constants
 * ============================================================ */

const CRITICAL = Object.freeze({
  MISSING_SCRIPT:      'MISSING_SCRIPT',
  NO_BASH:             'NO_BASH',
  ALL_RUNNERS_FAILED:  'ALL_RUNNERS_FAILED',
  HOSTNAME_MISMATCH:   'HOSTNAME_MISMATCH',
  BAD_INPUT:           'BAD_INPUT'
});


/* ============================================================
 * Error type
 * ============================================================ */

class CollectorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CollectorError';
    this.code = code;
  }
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
 * Filesystem helpers
 * ============================================================ */

function snapshotDir(dir) {
  try {
    return new Set(fs.readdirSync(dir));
  } catch (e) {
    /* Dir doesn't exist yet — first run, snapshot is empty. */
    return new Set();
  }
}

function tryParseJSONFile(filePath) {
  try {
    JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return true;
  } catch (e) {
    return false;
  }
}

function noopLogger() {
  return {
    info:  () => {},
    warn:  () => {},
    error: () => {},
    debug: () => {}
  };
}


/* ============================================================
 * Subprocess execution
 *
 *   Routes bash stdout AND stderr to the parent's stderr (fd 2) so
 *   Node's stdout stays clean for the orchestrator's final-path emit.
 *   The user still sees runner progress live on the console.
 * ============================================================ */

function execRunner(name, scriptPath, url) {
  const t0 = Date.now();
  const result = spawnSync('bash', [scriptPath, url], {
    cwd:   repoRoot(),
    stdio: [0, 2, 2]   /* stdin from parent; stdout → stderr; stderr → stderr */
  });
  const elapsed_ms = Date.now() - t0;

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new CollectorError(CRITICAL.NO_BASH, `bash not found on PATH (running ${name})`);
    }
    return { ran: false, exit: null, elapsed_ms, spawn_error: result.error.message };
  }

  return { ran: true, exit: result.status, elapsed_ms };
}


/* ============================================================
 * Lighthouse runner
 * ============================================================ */

function runLighthouse({ url, hostname, log = noopLogger() }) {
  const root   = repoRoot();
  const script = path.join(root, 'scripts', 'run-lighthouse.sh');

  if (!fs.existsSync(script)) {
    throw new CollectorError(CRITICAL.MISSING_SCRIPT, `lighthouse runner not found: ${rel(script)}`);
  }

  const outDir = path.join(root, 'reports', '.cache', hostname, 'lighthouse');
  const before = snapshotDir(outDir);

  log.info('collect', '[lighthouse] starting', { script: rel(script), url });

  const exec = execRunner('lighthouse', script, url);

  if (!exec.ran) {
    log.warn('collect', `[lighthouse] spawn error: ${exec.spawn_error}`);
    return {
      name:        'lighthouse',
      ok:          false,
      exit:        null,
      elapsed_ms:  exec.elapsed_ms,
      spawn_error: exec.spawn_error,
      outputs:     { found: 0, files: [], issues: ['spawn error'] }
    };
  }

  const outputs = validateLighthouseOutputs(outDir, before);
  const ok = outputs.found > 0;

  if (!ok) {
    log.warn('collect', `[lighthouse] failed (exit ${exec.exit}); no valid outputs`,
             { issues: outputs.issues });
  } else if (exec.exit !== 0) {
    log.warn('collect', `[lighthouse] exit ${exec.exit} but ${outputs.found} valid output(s) produced`,
             { issues: outputs.issues });
  } else {
    log.info('collect', `[lighthouse] done`,
             { elapsed_ms: exec.elapsed_ms, files: outputs.files });
  }

  return {
    name:       'lighthouse',
    ok,
    exit:       exec.exit,
    elapsed_ms: exec.elapsed_ms,
    outputs
  };
}

function validateLighthouseOutputs(outDir, beforeSnapshot) {
  if (!fs.existsSync(outDir)) {
    return { found: 0, files: [], issues: ['output directory not created'] };
  }

  const after = fs.readdirSync(outDir);
  const newFiles = after.filter(f => !beforeSnapshot.has(f)).sort();

  const mobile  = newFiles.find(f => /-mobile-run\d+\.json$/.test(f));
  const desktop = newFiles.find(f => /-desktop-run\d+\.json$/.test(f));

  const issues = [];
  if (!mobile)  issues.push('no new mobile JSON');
  if (!desktop) issues.push('no new desktop JSON');

  const valid = [];
  for (const f of [mobile, desktop].filter(Boolean)) {
    if (tryParseJSONFile(path.join(outDir, f))) {
      valid.push(f);
    } else {
      issues.push(`${f}: invalid JSON`);
    }
  }

  return { found: valid.length, files: valid.sort(), issues };
}


/* ============================================================
 * Security runner
 * ============================================================ */

function runSecurity({ url, hostname, log = noopLogger() }) {
  const root   = repoRoot();
  const script = path.join(root, 'scripts', 'run-security-scan.sh');

  if (!fs.existsSync(script)) {
    throw new CollectorError(CRITICAL.MISSING_SCRIPT, `security runner not found: ${rel(script)}`);
  }

  const outDir = path.join(root, 'reports', '.cache', hostname, 'security');
  const before = snapshotDir(outDir);

  log.info('collect', '[security] starting', { script: rel(script), url });

  const exec = execRunner('security', script, url);

  if (!exec.ran) {
    log.warn('collect', `[security] spawn error: ${exec.spawn_error}`);
    return {
      name:        'security',
      ok:          false,
      exit:        null,
      elapsed_ms:  exec.elapsed_ms,
      spawn_error: exec.spawn_error,
      outputs:     { found: 0, files: [], issues: ['spawn error'] }
    };
  }

  const outputs = validateSecurityOutputs(outDir, before);
  const ok = outputs.found > 0;

  if (!ok) {
    log.warn('collect', `[security] failed (exit ${exec.exit}); no valid outputs`,
             { issues: outputs.issues });
  } else if (exec.exit !== 0) {
    log.warn('collect', `[security] exit ${exec.exit} but valid output produced`,
             { issues: outputs.issues });
  } else {
    log.info('collect', `[security] done`,
             { elapsed_ms: exec.elapsed_ms, files: outputs.files });
  }

  return {
    name:       'security',
    ok,
    exit:       exec.exit,
    elapsed_ms: exec.elapsed_ms,
    outputs
  };
}

function validateSecurityOutputs(outDir, beforeSnapshot) {
  if (!fs.existsSync(outDir)) {
    return { found: 0, files: [], issues: ['output directory not created'] };
  }

  const after = fs.readdirSync(outDir);
  const newFiles = after.filter(f => !beforeSnapshot.has(f)).sort();

  const json = newFiles.find(f => /-security-run\d+\.json$/.test(f));

  const issues = [];
  if (!json) {
    issues.push('no new security JSON');
    return { found: 0, files: [], issues };
  }

  if (!tryParseJSONFile(path.join(outDir, json))) {
    issues.push(`${json}: invalid JSON`);
    return { found: 0, files: [], issues };
  }

  return { found: 1, files: [json], issues };
}


/* ============================================================
 * Top-level: orchestrate both runners
 *
 *   Sequential execution, deterministic order. Throws CollectorError on
 *   conditions that should stop the pipeline; returns a structured
 *   result on non-critical outcomes (warning-level partial failures).
 * ============================================================ */

function runCollectors({ url, hostname, log, enabled }) {
  if (!url || typeof url !== 'string') {
    throw new CollectorError(CRITICAL.BAD_INPUT, 'url (string) is required');
  }
  if (!hostname || typeof hostname !== 'string') {
    throw new CollectorError(CRITICAL.BAD_INPUT, 'hostname (string) is required');
  }
  if (!log) log = noopLogger();

  const enabledList = Array.isArray(enabled) ? enabled : ['lighthouse', 'security'];
  for (const r of enabledList) {
    if (r !== 'lighthouse' && r !== 'security') {
      throw new CollectorError(CRITICAL.BAD_INPUT,
        `unknown runner '${r}' (allowed: lighthouse, security)`);
    }
  }

  const t0      = Date.now();
  const runners = {};

  /* Sequential execution in canonical order. */
  if (enabledList.includes('lighthouse')) {
    runners.lighthouse = runLighthouse({ url, hostname, log });
  }
  if (enabledList.includes('security')) {
    runners.security = runSecurity({ url, hostname, log });
  }

  const runnerNames = Object.keys(runners);
  const okRunners   = runnerNames.filter(n => runners[n].ok);
  const failed      = runnerNames.filter(n => !runners[n].ok);

  /* Critical: all enabled runners failed. */
  if (okRunners.length === 0 && runnerNames.length > 0) {
    const detail = runnerNames.map(n => {
      const r = runners[n];
      return `${n}: exit ${r.exit}, issues: ${(r.outputs.issues || []).join('; ') || 'none'}`;
    }).join(' | ');
    throw new CollectorError(
      CRITICAL.ALL_RUNNERS_FAILED,
      `all collectors failed; pipeline cannot proceed. ${detail}`
    );
  }

  /* Critical: hostname consistency.
     The runners extract the hostname themselves from the URL. If they
     extracted something different from what we expect, their outputs
     would not land in reports/.cache/<expected-host>/. */
  const cacheDir = path.join(repoRoot(), 'reports', '.cache', hostname);
  if (!fs.existsSync(cacheDir)) {
    throw new CollectorError(
      CRITICAL.HOSTNAME_MISMATCH,
      `expected cache directory not created: ${rel(cacheDir)}. ` +
      `A runner may have extracted a different hostname from the URL.`
    );
  }

  /* Non-critical: at least one runner failed. */
  if (failed.length > 0) {
    log.warn('collect',
      `partial: ${failed.join(', ')} failed; ${okRunners.join(', ')} succeeded. Downstream stages will use partial data.`,
      { failed, ok: okRunners });
  } else {
    log.info('collect', `all ${runnerNames.length} runner(s) succeeded`);
  }

  return {
    ok:         okRunners.length > 0,
    all_ok:     failed.length === 0,
    elapsed_ms: Date.now() - t0,
    hostname,
    runners,
    failed,
    succeeded:  okRunners
  };
}


/* ============================================================
 * Exports
 * ============================================================ */

module.exports = {
  runCollectors,
  runLighthouse,
  runSecurity,
  validateLighthouseOutputs,
  validateSecurityOutputs,
  CollectorError,
  CRITICAL
};
