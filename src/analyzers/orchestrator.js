/*
 * src/analyzers/orchestrator.js — analyzer pipeline orchestration
 *
 * Drives the five analyzer skills against the collector cache, producing
 * one validated JSON output per dimension under reports/analysis/<host>/.
 *
 *   seo            ← .claude/skills/seo-analyzer/SKILL.md
 *   performance    ← .claude/skills/performance-analyzer/SKILL.md
 *   accessibility  ← .claude/skills/accessibility-analyzer/SKILL.md
 *   security       ← .claude/skills/security-auditor/SKILL.md
 *   best-practices ← .claude/skills/best-practices-analyzer/SKILL.md
 *
 * The orchestration is deterministic in shape — fixed analyzer order,
 * fixed input extraction per dimension, fixed validation gates, fixed
 * output path convention. The LLM call is the only non-deterministic
 * step, and its output is validated against the analyzer contract
 * (`_shared/analyzer-schema.md`) before being persisted.
 *
 * Contract preservation:
 *   - Output must conform to analyzer-schema.md's eight-field shape
 *     (dimension, url, hostname, score, summary, findings, metadata).
 *   - `dimension` and `hostname` are cross-checked against expected values.
 *   - Output is written atomically (tmp + rename) per output-artifacts.md.
 *
 * Stop-on-critical policy:
 *   - No ANTHROPIC_API_KEY in env or .env  → critical
 *   - reports/.cache/<host>/ does not exist → critical
 *   - Missing SKILL.md for an enabled dim   → critical
 *   - All enabled analyzers failed           → critical
 *
 *   - One analyzer failed, others succeeded  → warn, continue
 *   - Cache missing for an analyzer's needs  → skip that analyzer
 *
 * No external npm dependencies. Built-in fs, path, https only.
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');


/* ============================================================
 * Configuration
 * ============================================================ */

const ANALYZER_DEFINITIONS = Object.freeze({
  'performance':    { skill: 'performance-analyzer',    needs: { lighthouse: 'required', security: 'no' } },
  'accessibility':  { skill: 'accessibility-analyzer',  needs: { lighthouse: 'required', security: 'no' } },
  'seo':            { skill: 'seo-analyzer',            needs: { lighthouse: 'required', security: 'optional' } },
  'security':       { skill: 'security-auditor',        needs: { lighthouse: 'optional', security: 'required' } },
  'best-practices': { skill: 'best-practices-analyzer', needs: { lighthouse: 'required', security: 'no' } }
});

/* Canonical order — matches sections-schema.md per-dimension render order */
const ANALYZER_ORDER = Object.freeze(
  ['performance', 'accessibility', 'seo', 'security', 'best-practices']
);

const REQUIRED_FIELDS = ['dimension', 'url', 'hostname', 'score', 'summary', 'findings', 'metadata'];

const DEFAULT_MODEL      = 'llama-3.3-70b-versatile';
const DEFAULT_MAX_TOKENS = 1200;
const DEFAULT_TIMEOUT_MS = 180000;   /* 3 minutes per analyzer */
const DEFAULT_RETRIES    = 3;

const CRITICAL = Object.freeze({
  NO_API_KEY:    'NO_API_KEY',
  NO_CACHE:      'NO_CACHE',
  MISSING_SKILL: 'MISSING_SKILL',
  ALL_FAILED:    'ALL_FAILED',
  BAD_INPUT:     'BAD_INPUT'
});


/* ============================================================
 * Error type
 * ============================================================ */

class AnalyzerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AnalyzerError';
    this.code = code;
  }
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

function noopLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}


/* ============================================================
 * API key resolution — env first, then .env
 * ============================================================ */

function loadDotEnv() {
  const envPath = path.join(repoRoot(), '.env');
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function resolveAPIKey(explicit) {
  if (explicit) return explicit;
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;
  const env = loadDotEnv();
  return env.GROQ_API_KEY || null;
}


/* ============================================================
 * Cache resolution — find the highest <pattern>-run<N>.json file
 * ============================================================ */

function latestRunFile(dir, pattern) {
  if (!fs.existsSync(dir)) return null;
  const matches = fs.readdirSync(dir).filter(f => pattern.test(f));
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    const na = parseInt(a.match(/run(\d+)/)[1], 10);
    const nb = parseInt(b.match(/run(\d+)/)[1], 10);
    return nb - na;
  });
  return path.join(dir, matches[0]);
}

function readJSONSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}


/* ============================================================
 * Lighthouse compression — extract only the dimension subset.
 * Keeps cache JSON bounded so prompts stay within context.
 * ============================================================ */

const LIGHTHOUSE_CAT_KEY = {
  'seo':            'seo',
  'performance':    'performance',
  'accessibility':  'accessibility',
  'best-practices': 'best-practices'
};


function compressAudit(a) {

  if (!a || typeof a !== 'object') return null;

  const c = {
    id:               a.id,
    title:            a.title,
    description:      a.description,
    score:            a.score,
    scoreDisplayMode: a.scoreDisplayMode
  };

  if (a.numericValue !== undefined) {
    c.numericValue = a.numericValue;
  }

  if (a.numericUnit !== undefined) {
    c.numericUnit = a.numericUnit;
  }

  if (a.displayValue !== undefined) {
    c.displayValue = a.displayValue;
  }

  if (a.errorMessage !== undefined) {
    c.errorMessage = a.errorMessage;
  }

  /* Keep only lightweight high-signal details */
  if (a.details && typeof a.details === 'object') {

    c.details = {
      type: a.details.type
    };

    if (a.details.overallSavingsMs !== undefined) {
      c.details.overallSavingsMs = a.details.overallSavingsMs;
    }

    if (a.details.overallSavingsBytes !== undefined) {
      c.details.overallSavingsBytes = a.details.overallSavingsBytes;
    }

  }

  return c;
}


function compressLighthouse(lhJSON, dimensionKey) {
  if (!lhJSON || !lhJSON.categories) return null;
  const cat = lhJSON.categories[dimensionKey];
  if (!cat) return null;

  const auditIds = (cat.auditRefs || []).map(r => r.id);

  /* Limit audits to reduce prompt size */
  const limitedAuditIds = auditIds.slice(0, 10);

  const audits = {};

  for (const id of limitedAuditIds) {

    const a = lhJSON.audits && lhJSON.audits[id];

    if (!a) continue;

    audits[id] = compressAudit(a);
  }


  return {
    requestedUrl: lhJSON.requestedUrl,
    finalUrl:     lhJSON.finalUrl,
    fetchTime:    lhJSON.fetchTime,
    formFactor:   (lhJSON.configSettings && lhJSON.configSettings.formFactor) || null,
    category: {
      id:        cat.id,
      title:     cat.title,
      score:     cat.score
    },
    audits
  };
}

/* Security-auditor reads Lighthouse only for is-on-https, no-vulnerable-libraries,
   csp-xss, uses-http2 — extract just those. */
const SECURITY_RELEVANT_AUDITS = ['is-on-https', 'no-vulnerable-libraries', 'csp-xss', 'uses-http2'];

function extractSecuritySubsetFromLighthouse(lhJSON) {
  if (!lhJSON || !lhJSON.audits) return null;
  const audits = {};
  for (const id of SECURITY_RELEVANT_AUDITS) {
    if (lhJSON.audits[id]) audits[id] = compressAudit(lhJSON.audits[id]);
  }
  return {
    fetchTime: lhJSON.fetchTime,
    formFactor: (lhJSON.configSettings && lhJSON.configSettings.formFactor) || null,
    audits
  };
}


/* ============================================================
 * Per-dimension input extraction
 * ============================================================ */

function extractInputs(dimension, hostname) {
  const cacheDir = path.join(repoRoot(), 'reports', '.cache', hostname);
  const def      = ANALYZER_DEFINITIONS[dimension];
  const inputs   = {};

  if (def.needs.lighthouse !== 'no') {
    const lhDir       = path.join(cacheDir, 'lighthouse');
    const mobilePath  = latestRunFile(lhDir, /-mobile-run\d+\.json$/);
    const desktopPath = latestRunFile(lhDir, /-desktop-run\d+\.json$/);

    if (dimension === 'security') {
      if (mobilePath) {
        const lh = readJSONSafe(mobilePath);
        if (lh) inputs.lighthouse_mobile = extractSecuritySubsetFromLighthouse(lh);
      }
    } else {
      const key = LIGHTHOUSE_CAT_KEY[dimension];
      if (mobilePath) {
        const lh = readJSONSafe(mobilePath);
        if (lh) inputs.lighthouse_mobile = compressLighthouse(lh, key);
      }
      if (desktopPath) {
        const lh = readJSONSafe(desktopPath);
        if (lh) inputs.lighthouse_desktop = compressLighthouse(lh, key);
      }
    }
  }

  if (def.needs.security !== 'no') {
    const secDir  = path.join(cacheDir, 'security');
    const secPath = latestRunFile(secDir, /-security-run\d+\.json$/);
    if (secPath) {
      const sec = readJSONSafe(secPath);
      if (sec) inputs.security = sec;
    }
  }

  return inputs;
}

function hasRequiredInputs(inputs, dimension) {
  const need = ANALYZER_DEFINITIONS[dimension].needs;
  if (need.lighthouse === 'required' && !inputs.lighthouse_mobile && !inputs.lighthouse_desktop) return false;
  if (need.security   === 'required' && !inputs.security) return false;
  return true;
}

function describeArtifactsConsumed(inputs, hostname) {
  const out = [];
  if (inputs.lighthouse_mobile)  out.push(`reports/.cache/${hostname}/lighthouse/<host>-mobile-run<N>.json`);
  if (inputs.lighthouse_desktop) out.push(`reports/.cache/${hostname}/lighthouse/<host>-desktop-run<N>.json`);
  if (inputs.security)           out.push(`reports/.cache/${hostname}/security/<host>-security-run<N>.json`);
  return out;
}


/* ============================================================
 * Prompt construction
 * ============================================================ */
function buildUserMessage(dimension, url, hostname, inputs) {

  return [

  `Analyze the ${dimension} dimension for ${url}.`,

  ``,

  `URL:      ${url}`,
  `Hostname: ${hostname}`,

  ``,

  `Cache artifacts (compressed, dimension-specific subset):`,

  ``,

  JSON.stringify(inputs),

  ``,

  `Follow the Procedure in your SKILL.md. Apply every quality gate before emitting.`,

  `Emit ONLY the analyzer-output JSON object — no prose before or after.`,

  `Required top-level fields:`,

  `- dimension`,
  `- url`,
  `- hostname`,
  `- score`,
  `- summary`,
  `- findings`,
  `- metadata`,

  `- findings must be a non-empty array`,

  `- If score is less than 100, findings must contain at least one item.`,
  `- A score below 100 with zero findings is invalid.`,

  `- each finding must contain:`,

`  - category            → short issue name`,
`  - evidence            → actual technical proof / metric / detected issue`,
`  - impact              → business or technical impact of the issue`,
`  - recommendation      → actionable fix instruction`,
`  - severity`,
`  - priority`,

`  - DO NOT repeat the same sentence across evidence, impact, and recommendation.`,
`  - evidence, impact, and recommendation MUST all be different.`,

  `Return valid JSON only.`

].join('\n');

}


/* ============================================================
 * Anthropic API client — built-in https, no SDK
 * ============================================================ */

function postLLM({ apiKey, model, system, userMessage, maxTokens, timeoutMs }) {
  return new Promise((resolve, reject) => {

    const body = JSON.stringify({
      model: model || DEFAULT_MODEL,
      messages: [
        {
          role: 'system',
          content: system
        },
        {
          role: 'user',
          content: userMessage
        }
      ],
      temperature: 0.2,
      max_tokens: maxTokens || DEFAULT_MAX_TOKENS
    });

    const req = https.request({
      hostname: 'api.groq.com',
      port: 443,
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: timeoutMs || DEFAULT_TIMEOUT_MS
    }, (res) => {

      const chunks = [];

      res.on('data', c => chunks.push(c));

      res.on('end', () => {

        const text = Buffer.concat(chunks).toString('utf8');

        if (res.statusCode !== 200) {
          const err = new AnalyzerError(
            'API_ERROR',
            `Groq API ${res.statusCode}: ${text.slice(0, 500)}`
          );

          err.statusCode = res.statusCode;
          return reject(err);
        }

        try {
          resolve(JSON.parse(text));
        } catch (e) {
          reject(
            new AnalyzerError(
              'API_PARSE',
              `non-JSON API response: ${e.message}`
            )
          );
        }

      });

    });

    req.on('timeout', () => {
      req.destroy();

      reject(
        new AnalyzerError(
          'TIMEOUT',
          `API request timed out after ${timeoutMs || DEFAULT_TIMEOUT_MS}ms`
        )
      );
    });

    req.on('error', e => {
      reject(new AnalyzerError('NETWORK', e.message));
    });

    req.write(body);
    req.end();
  });
}


async function callLLMWithRetry(opts, maxAttempts) {
  maxAttempts = maxAttempts || DEFAULT_RETRIES;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await postLLM(opts);
    } catch (e) {
      lastErr = e;
      const sc = e.statusCode;
      const retryable = (sc === 429) || (sc >= 500 && sc < 600) ||
                        e.code === 'NETWORK' || e.code === 'TIMEOUT';
      if (retryable && attempt < maxAttempts) {
        const delay = Math.min(30000, Math.pow(2, attempt - 1) * 1000);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}


/* ============================================================
 * Response parsing — pull the JSON object out of Claude's text
 * ============================================================ */
function extractJSONFromResponse(response) {

  if (
    !response ||
    !response.choices ||
    !Array.isArray(response.choices) ||
    !response.choices[0] ||
    !response.choices[0].message
  ) {
    throw new AnalyzerError(
      'BAD_RESPONSE',
      'response missing choices[0].message'
    );
  }

  const text = response.choices[0].message.content;

  if (typeof text !== 'string') {
    throw new AnalyzerError(
      'BAD_RESPONSE',
      'message content is not a string'
    );
  }

  let cleaned = text.trim();

  /* Strip markdown fence if model adds one */
  const fence = cleaned.match(/^```(?:json)?\s*\n([\s\S]+?)\n```\s*$/);

  if (fence) {
    cleaned = fence[1];
  }

  const first = cleaned.indexOf('{');
  const last  = cleaned.lastIndexOf('}');

  if (first === -1 || last === -1 || last < first) {
    throw new AnalyzerError(
      'NO_JSON',
      'response does not contain JSON object'
    );
  }

  const jsonSlice = cleaned.slice(first, last + 1);

  try {
    return JSON.parse(jsonSlice);
  } catch (e) {
    throw new AnalyzerError(
      'PARSE_FAIL',
      `invalid JSON output: ${e.message}`
    );
  }
}

/* ============================================================
 * Output validation against the analyzer contract
 * ============================================================ */

function validateAnalyzerOutput(output, dimension, hostname) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new AnalyzerError('VALIDATION', 'analyzer output is not an object');
  }

  const missing = REQUIRED_FIELDS.filter(f => !(f in output));
  if (missing.length > 0) {
    throw new AnalyzerError('VALIDATION', `missing required fields: ${missing.join(', ')}`);
  }

  if (output.dimension !== dimension) {
    throw new AnalyzerError('VALIDATION',
      `.dimension mismatch: expected '${dimension}', got '${output.dimension}'`);
  }
  if (output.hostname !== hostname) {
    throw new AnalyzerError('VALIDATION',
      `.hostname mismatch: expected '${hostname}', got '${output.hostname}'`);
  }

  if (typeof output.score !== 'number' || output.score < 0 || output.score > 100) {
    throw new AnalyzerError('VALIDATION', `.score must be a number 0-100, got ${output.score}`);
  }
  if (typeof output.summary !== 'string' || output.summary.length === 0) {
    throw new AnalyzerError('VALIDATION', '.summary must be a non-empty string');
  }
  if (!Array.isArray(output.findings)) {
    throw new AnalyzerError('VALIDATION', '.findings must be an array');
  }

  /* NEW RULE */
  if (
    output.score < 100 &&
    output.findings.length === 0
  ) {
    throw new AnalyzerError(
      'VALIDATION',
      `score ${output.score} requires at least one finding`
    );
  }

  if (!output.metadata || typeof output.metadata !== 'object') {
    throw new AnalyzerError('VALIDATION', '.metadata must be an object');
  }
}


/* ============================================================
 * Output persistence — atomic write to reports/analysis/<host>/
 * ============================================================ */

function saveAnalyzerOutput(output, dimension, hostname) {
  const outDir = path.join(repoRoot(), 'reports', 'analysis', hostname);
  fs.mkdirSync(outDir, { recursive: true });

  let n = 1;
  while (fs.existsSync(path.join(outDir, `${dimension}-run${n}.json`))) n++;

  const finalPath = path.join(outDir, `${dimension}-run${n}.json`);
  const tmpPath   = finalPath + '.tmp';

  /* Canonical 2-space indent, preserve key order. */
  fs.writeFileSync(tmpPath, JSON.stringify(output, null, 2), { encoding: 'utf8' });
  fs.renameSync(tmpPath, finalPath);

  return { runNumber: n, file: finalPath };
}


/* ============================================================
 * Per-dimension analyzer driver
 * ============================================================ */

async function runAnalyzer({ dimension, hostname, url, log, apiKey, model, maxTokens, timeoutMs, retries }) {
  if (!ANALYZER_DEFINITIONS[dimension]) {
    throw new AnalyzerError(CRITICAL.BAD_INPUT, `unknown dimension: ${dimension}`);
  }

  const t0 = Date.now();
  log.info('analyze', `[${dimension}] starting`);

  /* 1. Load skill */
  const skillPath = path.join(
    repoRoot(), '.claude', 'skills',
    ANALYZER_DEFINITIONS[dimension].skill, 'SKILL.md'
  );
  if (!fs.existsSync(skillPath)) {
    throw new AnalyzerError(CRITICAL.MISSING_SKILL,
      `skill not found: ${rel(skillPath)}`);
  }
  const skillContent = fs.readFileSync(skillPath, 'utf8');

  /* 2. Extract inputs */
  const inputs = extractInputs(dimension, hostname);
  if (!hasRequiredInputs(inputs, dimension)) {
    log.warn('analyze', `[${dimension}] required cache inputs missing — skipping`);
    return {
      dimension, ok: false, reason: 'missing-inputs',
      elapsed_ms: Date.now() - t0
    };
  }

  /* 3. Build prompt */
  const userMessage = buildUserMessage(dimension, url, hostname, inputs);
  log.debug('analyze', `[${dimension}] prompt sized`, {
    system_chars: skillContent.length,
    user_chars:   userMessage.length
  });

  /* 4. Call API */
  let response;

  /* Prevent Groq TPM burst */ 
  await new Promise(r => setTimeout(r, 15000));

  try {
    response = await callLLMWithRetry({
      apiKey, model,
      system:      skillContent,
      userMessage,
      maxTokens, timeoutMs
    }, retries);
  } catch (e) {
    log.warn('analyze', `[${dimension}] API call failed: ${e.message}`);
    return {
      dimension, ok: false, error: e.message, code: e.code,
      elapsed_ms: Date.now() - t0
    };
  }

  /* 5. Parse + validate */
  let output;
  try {
    output = extractJSONFromResponse(response);
    validateAnalyzerOutput(output, dimension, hostname);
  } catch (e) {
    log.warn('analyze', `[${dimension}] output invalid: ${e.message}`);
    return {
      dimension, ok: false, error: e.message, code: e.code,
      elapsed_ms: Date.now() - t0
    };
  }

  /* 6. Save */
  const saved = saveAnalyzerOutput(output, dimension, hostname);

  log.info('analyze', `[${dimension}] done`, {
    file:       rel(saved.file),
    run:        saved.runNumber,
    score:      output.score,
    findings:   output.findings.length,
    elapsed_ms: Date.now() - t0
  });

  return {
    dimension, ok: true,
    file: rel(saved.file),
    run:  saved.runNumber,
    score: output.score,
    findings_count: output.findings.length,
    elapsed_ms: Date.now() - t0
  };
}


/* ============================================================
 * Top-level: orchestrate all analyzers
 * ============================================================ */

async function runAnalyzers({ hostname, url, log, enabled, apiKey, model, maxTokens, timeoutMs, retries }) {
  if (!hostname || typeof hostname !== 'string') {
    throw new AnalyzerError(CRITICAL.BAD_INPUT, 'hostname (string) is required');
  }
  if (!url || typeof url !== 'string') {
    throw new AnalyzerError(CRITICAL.BAD_INPUT, 'url (string) is required');
  }
  if (!log) log = noopLogger();

  /* Resolve API key */
  apiKey = resolveAPIKey(apiKey);
  if (!apiKey) {
    throw new AnalyzerError(CRITICAL.NO_API_KEY,
      'GROQ_API_KEY not found in process.env or .env');
  }

  /* Check cache exists */
  const cacheDir = path.join(repoRoot(), 'reports', '.cache', hostname);
  if (!fs.existsSync(cacheDir)) {
    throw new AnalyzerError(CRITICAL.NO_CACHE,
      `no collector cache at ${rel(cacheDir)}. Run the collect stage first.`);
  }

  /* Resolve list of analyzers to run, in canonical order */
  let dims;
  if (Array.isArray(enabled) && enabled.length > 0) {
    for (const d of enabled) {
      if (!ANALYZER_DEFINITIONS[d]) {
        throw new AnalyzerError(CRITICAL.BAD_INPUT,
          `unknown dimension '${d}' (allowed: ${ANALYZER_ORDER.join(', ')})`);
      }
    }
    dims = ANALYZER_ORDER.filter(d => enabled.includes(d));
  } else {
    dims = [...ANALYZER_ORDER];
  }

  /* Pre-flight: all skills present */
  for (const dim of dims) {
    const sp = path.join(repoRoot(), '.claude', 'skills',
                          ANALYZER_DEFINITIONS[dim].skill, 'SKILL.md');
    if (!fs.existsSync(sp)) {
      throw new AnalyzerError(CRITICAL.MISSING_SKILL,
        `skill not found for '${dim}': ${rel(sp)}`);
    }
  }

  const t0      = Date.now();
  const results = {};

  /* Sequential — deterministic order, gentle on rate limits. */
  for (const dim of dims) {
    results[dim] = await runAnalyzer({
      dimension: dim, hostname, url, log,
      apiKey, model, maxTokens, timeoutMs, retries
    });
  }

  const succeeded = Object.values(results).filter(r => r.ok).map(r => r.dimension);
  const failed    = Object.values(results).filter(r => !r.ok).map(r => r.dimension);

  if (succeeded.length === 0) {
    const detail = Object.values(results).map(r =>
      `${r.dimension}: ${r.error || r.reason || 'unknown'}`).join(' | ');
    throw new AnalyzerError(CRITICAL.ALL_FAILED,
      `all analyzers failed; pipeline cannot proceed. ${detail}`);
  }

  if (failed.length > 0) {
    log.warn('analyze',
      `partial: ${failed.join(', ')} failed; ${succeeded.join(', ')} succeeded`,
      { failed, succeeded });
  } else {
    log.info('analyze', `all ${dims.length} analyzer(s) succeeded`);
  }

  return {
    ok:         true,
    all_ok:     failed.length === 0,
    elapsed_ms: Date.now() - t0,
    hostname,
    analyzers:  results,
    succeeded,
    failed
  };
}


/* ============================================================
 * Exports
 * ============================================================ */

module.exports = {
  runAnalyzers,
  runAnalyzer,
  /* primitives (exposed for tests / orchestrator extension) */
  extractInputs,
  compressLighthouse,
  extractJSONFromResponse,
  validateAnalyzerOutput,
  saveAnalyzerOutput,
  resolveAPIKey,
  /* types + constants */
  AnalyzerError,
  CRITICAL,
  ANALYZER_DEFINITIONS,
  ANALYZER_ORDER,
  REQUIRED_FIELDS,
  DEFAULT_MODEL
};
