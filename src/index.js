#!/usr/bin/env node
/*
 * src/index.js — pipeline orchestrator
 *
 * Single entry point that drives the full audit pipeline:
 *
 *   collect  → bash scripts/run-audit.sh <url>            (deterministic)
 *   analyze  → 5 analyzer skills produce <dim>-run<N>.json (LLM-driven)
 *   narrate  → report-builder skill produces report-run<N>.json (LLM-driven)
 *   render   → node src/report/render-report.js <host>    (deterministic)
 *
 * The two deterministic stages (collect, render) are fully invoked from
 * this orchestrator. The two LLM-driven stages (analyze, narrate) are
 * verification checkpoints: this orchestrator detects whether their
 * outputs are present on disk and proceeds accordingly. Driving the
 * actual Claude API calls is left to whichever harness invokes the
 * analyzer/report-builder skills (Claude Code, an SDK wrapper, etc.) —
 * the orchestrator stays honest about what it can deterministically do.
 *
 * Usage:
 *   node src/index.js <url> [options]
 *
 *   -h, --help                Show usage
 *   -v, --verbose             Verbose logging
 *   --skip=<stages>           Skip stages (comma-separated)
 *   --only=<stage>            Run only one stage
 *   --json                    Emit log lines as JSON
 *
 * Stdout: final HTML path on success.
 * Stderr: structured progress / errors.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const {
  runCollectors,
  CollectorError,
  CRITICAL: COLLECTOR_CRITICAL
} = require('./runners/orchestrator');
const {
  runAnalyzers,
  AnalyzerError,
  CRITICAL: ANALYZER_CRITICAL
} = require('./analyzers/orchestrator');
const {
  runReportBuilder,
  BuilderError,
  CRITICAL: BUILDER_CRITICAL
} = require('./report/orchestrator');
const {
  runHTMLRenderer,
  RenderOrchestratorError,
  CRITICAL: RENDER_CRITICAL
} = require('./report/render-orchestrator');


/* ============================================================
 * Constants
 * ============================================================ */

const STAGES = Object.freeze(['collect', 'analyze', 'narrate', 'render']);

const EXPECTED_DIMS = Object.freeze([
  'seo', 'performance', 'accessibility', 'security', 'best-practices'
]);

const EX = Object.freeze({
  OK:               0,
  GENERIC_FAIL:     1,
  USAGE:           64,
  INVALID_URL:     65,
  MISSING_INPUTS:  66,
  STAGE_FAILED:    70,
  RENDER_FAILED:   71
});


/* ============================================================
 * Error type — carries exit code through the throw chain
 * ============================================================ */

class OrchestratorError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.name = 'OrchestratorError';
    this.exitCode = exitCode;
  }
}

function fail(code, message) {
  throw new OrchestratorError(code, message);
}


/* ============================================================
 * Path helpers
 * ============================================================ */

function repoRoot() {
  return path.resolve(__dirname, '..');
}

function rel(p) {
  return path.relative(repoRoot(), p).split(path.sep).join('/');
}


/* ============================================================
 * CLI argument parsing
 * ============================================================ */

function parseArgs(argv) {
  const opts = {
    url:     null,
    verbose: false,
    skip:    new Set(),
    only:    null,
    json:    false,
    help:    false
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === '-h' || a === '--help')    { opts.help = true; continue; }
    if (a === '-v' || a === '--verbose') { opts.verbose = true; continue; }
    if (a === '--json')                  { opts.json = true; continue; }

    if (a.startsWith('--skip=')) {
      a.slice(7).split(',').filter(Boolean).forEach(s => opts.skip.add(s));
      continue;
    }
    if (a.startsWith('--only=')) {
      opts.only = a.slice(7);
      continue;
    }

    if (a.startsWith('-')) {
      fail(EX.USAGE, `unknown option: ${a}`);
    }

    if (!opts.url) { opts.url = a; continue; }
    fail(EX.USAGE, `unexpected positional argument: ${a}`);
  }

  return opts;
}

function printUsage(stream) {
  stream.write([
    'Usage: node src/index.js <url> [options]',
    '',
    'Orchestrates the full audit pipeline:',
    '   collect   bash scripts/run-audit.sh <url>',
    '   analyze   verifies the 5 analyzer outputs (invoke skills via Claude Code)',
    '   narrate   verifies the Report JSON (invoke report-builder via Claude Code)',
    '   render    node src/report/render-report.js <host>',
    '',
    'Options:',
    '  -h, --help                 Show this usage',
    '  -v, --verbose              Verbose logging',
    '  --skip=<stages>            Skip stages (comma-separated: collect,analyze,narrate,render)',
    '  --only=<stage>             Run only one stage',
    '  --json                     Emit log lines as JSON (one per line)',
    '',
    'Exit codes:',
    '    0  success',
    '   64  usage error',
    '   65  invalid URL',
    '   66  missing required inputs for a stage',
    '   70  stage execution failed',
    '   71  render failed',
    '',
    'Stdout: the final rendered HTML path (on success).',
    'Stderr: structured progress and errors.',
    ''
  ].join('\n'));
}


/* ============================================================
 * URL validation + hostname extraction
 * ============================================================ */

function validateURL(rawURL) {
  if (!rawURL) fail(EX.USAGE, 'missing URL argument');

  let parsed;
  try {
    parsed = new URL(rawURL);
  } catch (e) {
    fail(EX.INVALID_URL, `invalid URL: '${rawURL}' (${e.message})`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail(EX.INVALID_URL, `URL must use http or https scheme: ${rawURL}`);
  }

  if (!parsed.hostname) {
    fail(EX.INVALID_URL, `URL has no hostname: ${rawURL}`);
  }

  return parsed;
}


/* ============================================================
 * Structured logger
 * ============================================================ */

function makeLogger({ json, verbose }) {
  function emit(level, stage, msg, extras) {
    if (level === 'debug' && !verbose) return;

    if (json) {
      const entry = {
        ts:    new Date().toISOString(),
        level: level,
        stage: stage || null,
        msg:   msg
      };
      if (extras) Object.assign(entry, extras);
      process.stderr.write(JSON.stringify(entry) + '\n');
      return;
    }

    const tag = level === 'error' ? '[ERROR]'
             : level === 'warn'  ? '[WARN] '
             : level === 'info'  ? '[INFO] '
             :                     '[DEBUG]';
    const stageStr = stage ? ` (${stage})` : '';
    process.stderr.write(`${tag}${stageStr} ${msg}\n`);

    if (extras && verbose) {
      for (const [k, v] of Object.entries(extras)) {
        const vStr = typeof v === 'object' ? JSON.stringify(v) : String(v);
        process.stderr.write(`            ${k}=${vStr}\n`);
      }
    }
  }

  return {
    debug: (stage, msg, extras) => emit('debug', stage, msg, extras),
    info:  (stage, msg, extras) => emit('info',  stage, msg, extras),
    warn:  (stage, msg, extras) => emit('warn',  stage, msg, extras),
    error: (stage, msg, extras) => emit('error', stage, msg, extras)
  };
}


/* ============================================================
 * Stage: collect — direct runner orchestration
 *
 *   Drives scripts/run-lighthouse.sh and scripts/run-security-scan.sh
 *   directly via src/runners/orchestrator.js. The orchestrator:
 *     - Runs in fixed sequential order (lighthouse → security)
 *     - Validates each runner's outputs are present and parseable JSON
 *     - Verifies hostname consistency (expected cache dir was populated)
 *     - Throws CollectorError on critical failures the pipeline cannot
 *       proceed past; returns a partial-but-usable result otherwise.
 * ============================================================ */

function stageCollect({ url, hostname, log }) {
  const t0 = Date.now();
  log.info('collect', 'starting', { url, hostname });

  let result;
  try {
    result = runCollectors({ url, hostname, log });
  } catch (e) {
    if (e instanceof CollectorError) {
      /* Map collector-side criticality to orchestrator exit codes. */
      const exitCode =
        e.code === COLLECTOR_CRITICAL.MISSING_SCRIPT ? EX.MISSING_INPUTS :
        e.code === COLLECTOR_CRITICAL.NO_BASH        ? EX.MISSING_INPUTS :
        e.code === COLLECTOR_CRITICAL.BAD_INPUT      ? EX.USAGE :
                                                       EX.STAGE_FAILED;
      fail(exitCode, e.message);
    }
    throw e;
  }

  log.info('collect', 'done', {
    elapsed_ms: result.elapsed_ms,
    succeeded:  result.succeeded,
    failed:     result.failed
  });

  return {
    elapsed_ms: result.elapsed_ms,
    all_ok:     result.all_ok,
    runners:    result.runners,
    failed:     result.failed,
    succeeded:  result.succeeded
  };
}


/* ============================================================
 * Stage: analyze — drive the 5 analyzer skills via the Anthropic API
 *
 *   Implemented in src/analyzers/orchestrator.js. The orchestrator:
 *     - Reads each SKILL.md as the system prompt
 *     - Extracts a dimension-specific compressed subset of the cache
 *     - Calls the API (with retry/backoff) and validates the JSON output
 *       against the analyzer contract before saving
 *     - Writes to reports/analysis/<host>/<dim>-run<N>.json atomically
 * ============================================================ */

async function stageAnalyze({ url, hostname, log }) {
  log.info('analyze', 'starting analyzer pipeline');

  let result;
  try {
    result = await runAnalyzers({ url, hostname, log});
  } catch (e) {
    if (e instanceof AnalyzerError) {
      const exitCode =
        e.code === ANALYZER_CRITICAL.NO_API_KEY    ? EX.MISSING_INPUTS :
        e.code === ANALYZER_CRITICAL.NO_CACHE      ? EX.MISSING_INPUTS :
        e.code === ANALYZER_CRITICAL.MISSING_SKILL ? EX.MISSING_INPUTS :
        e.code === ANALYZER_CRITICAL.BAD_INPUT     ? EX.USAGE :
                                                     EX.STAGE_FAILED;
      fail(exitCode, e.message);
    }
    throw e;
  }

  log.info('analyze', 'done', {
    elapsed_ms: result.elapsed_ms,
    succeeded:  result.succeeded,
    failed:     result.failed
  });

  return {
    elapsed_ms: result.elapsed_ms,
    all_ok:     result.all_ok,
    analyzers:  result.analyzers,
    succeeded:  result.succeeded,
    failed:     result.failed
  };
}


/* ============================================================
 * Stage: narrate — drive the report-builder skill via the Anthropic API
 *
 *   Implemented in src/report/orchestrator.js. The orchestrator:
 *     - Reads SKILL.md + sections-schema.md as the system prompt
 *     - Loads the 5 (or fewer) analyzer outputs from reports/analysis/
 *     - Calls the API with retry/backoff
 *     - Validates output against the 8-field Report contract
 *     - Post-processes meta.generated_at and meta.build_warnings
 *     - Writes to reports/final/<host>/report-run<N>.json atomically
 * ============================================================ */

async function stageNarrate({ url, hostname, log }) {
  log.info('narrate', 'starting report-builder');

  let result;
  try {
    result = await runReportBuilder({ url, hostname, log });
  } catch (e) {
    if (e instanceof BuilderError) {
      const exitCode =
        e.code === BUILDER_CRITICAL.NO_API_KEY    ? EX.MISSING_INPUTS :
        e.code === BUILDER_CRITICAL.NO_ANALYSIS   ? EX.MISSING_INPUTS :
        e.code === BUILDER_CRITICAL.MISSING_SKILL ? EX.MISSING_INPUTS :
        e.code === BUILDER_CRITICAL.BAD_INPUT     ? EX.USAGE :
                                                    EX.STAGE_FAILED;
      fail(exitCode, e.message);
    }
    throw e;
  }

  log.info('narrate', 'done', {
    file:           result.file,
    run:            result.run,
    headline_score: result.headline_score,
    total_findings: result.total_findings,
    warnings:       result.warnings.length,
    elapsed_ms:     result.elapsed_ms
  });

  return {
    elapsed_ms:    result.elapsed_ms,
    run:           result.run,
    file:          result.file,
    headline_score: result.headline_score,
    total_findings: result.total_findings,
    warnings:      result.warnings
  };
}


/* ============================================================
 * Stage: render — drive the runtime HTML renderer
 *
 *   Implemented in src/report/render-orchestrator.js. The orchestrator:
 *     - Resolves the source Report JSON (latest run if not specified)
 *     - Executes src/report/render-report.js (deterministic substitution)
 *     - Re-reads the written HTML and runs post-write validation:
 *         file non-empty, no remaining placeholders, still offline-safe,
 *         expected hostname appears in embedded JSON, DOCTYPE present
 *     - Prints the final artifact path through structured logging
 * ============================================================ */

async function stageRender({ hostname, runNumber, log }) {
  let result;
  try {
    result = await runHTMLRenderer({ hostname, runNumber, log });
  } catch (e) {
    if (e instanceof RenderOrchestratorError) {
      const exitCode =
        e.code === RENDER_CRITICAL.NO_SOURCE        ? EX.MISSING_INPUTS :
        e.code === RENDER_CRITICAL.BAD_INPUT        ? EX.USAGE :
        e.code === RENDER_CRITICAL.NOT_OFFLINE_SAFE ? EX.RENDER_FAILED :
        e.code === RENDER_CRITICAL.POST_VALIDATION  ? EX.RENDER_FAILED :
                                                       EX.RENDER_FAILED;
      fail(exitCode, e.message);
    }
    throw e;
  }

  return {
    elapsed_ms: result.elapsed_ms,
    htmlPath:   result.htmlPath,
    fileURL:    result.fileURL,
    run:        result.run,
    bytes:      result.bytes,
    lines:      result.lines,
    warnings:   result.warnings
  };
}


/* ============================================================
 * Main pipeline orchestration
 * ============================================================ */

function shouldRun(stage, opts) {
  if (opts.only) return opts.only === stage;
  return !opts.skip.has(stage);
}

async function runPipeline({ url, opts, log }) {
  /* URL validation */
  const parsedURL = validateURL(url);
  const hostname  = parsedURL.hostname;     /* already lowercased by URL class */
  const finalURL  = parsedURL.toString();   /* normalized: scheme, host, path, etc. */

  log.info(null, 'audit pipeline starting', { url: finalURL, hostname });

  /* Stage filter validation */
  if (opts.only && !STAGES.includes(opts.only)) {
    fail(EX.USAGE, `--only must be one of: ${STAGES.join(', ')} (got '${opts.only}')`);
  }
  for (const s of opts.skip) {
    if (!STAGES.includes(s)) {
      fail(EX.USAGE, `--skip values must be in: ${STAGES.join(', ')} (got '${s}')`);
    }
  }

  const t0      = Date.now();
  const results = {};

  /* Execute stages in fixed order; each is opt-out via --skip / --only. */

  if (shouldRun('collect', opts)) {
    results.collect = stageCollect({ url: finalURL, hostname, log });
  } else {
    log.info('collect', 'skipped');
  }

  if (shouldRun('analyze', opts)) {
    results.analyze = await stageAnalyze({ url: finalURL, hostname, log });
  } else {
    log.info('analyze', 'skipped');
  }

  if (shouldRun('narrate', opts)) {
    results.narrate = await stageNarrate({ url: finalURL, hostname, log });
  } else {
    log.info('narrate', 'skipped');
  }

  if (shouldRun('render', opts)) {
    /* If narrate ran, use the run it found; otherwise let render pick latest. */
    const runNumber = results.narrate ? results.narrate.run : undefined;
    results.render = await stageRender({ hostname, runNumber, log });
  } else {
    log.info('render', 'skipped');
  }

  const totalElapsed = Date.now() - t0;
  log.info(null, 'pipeline complete', {
    elapsed_ms:    totalElapsed,
    stages_run:    Object.keys(results),
    html_path:     results.render ? results.render.htmlPath : null
  });

  return { results, elapsed_ms: totalElapsed, hostname, url: finalURL };
}


/* ============================================================
 * CLI entry
 * ============================================================ */

async function cli(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof OrchestratorError) {
      process.stderr.write(`error: ${e.message}\n\n`);
      printUsage(process.stderr);
      process.exit(e.exitCode);
    }
    throw e;
  }

  if (opts.help) {
    printUsage(process.stdout);
    process.exit(EX.OK);
  }

  const log = makeLogger(opts);

  try {
    const { results } = await runPipeline({ url: opts.url, opts, log });

    /* Emit final HTML path to stdout (so the path can be captured by callers). */
    if (results.render && results.render.htmlPath) {
      process.stdout.write(results.render.htmlPath + '\n');
    }
    process.exit(EX.OK);
  } catch (e) {
    if (e instanceof OrchestratorError) {
      log.error(null, e.message);
      process.exit(e.exitCode);
    }
    log.error(null, `unexpected error: ${(e && e.stack) || e}`);
    process.exit(EX.GENERIC_FAIL);
  }
}

if (require.main === module) {
  cli(process.argv.slice(2));
}


/* ============================================================
 * Exports — for programmatic use and tests
 * ============================================================ */

module.exports = {
  /* high-level */
  runPipeline,
  cli,
  /* per-stage */
  stageCollect,
  stageAnalyze,
  stageNarrate,
  stageRender,
  /* primitives */
  parseArgs,
  validateURL,
  makeLogger,
  /* types + constants */
  OrchestratorError,
  EX,
  STAGES,
  EXPECTED_DIMS
};
