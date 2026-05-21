/*
 * src/report/orchestrator.js — report-builder pipeline orchestration
 *
 * Drives the report-builder skill against the 5 per-dimension analyzer
 * outputs, producing a validated Report JSON at:
 *
 *   reports/final/<hostname>/report-run<N>.json
 *
 * Contract preservation:
 *   - Output must conform to sections-schema.md (eight required top-level
 *     fields: meta, executive_summary, severity_overview, key_findings,
 *     prioritized_roadmap, quick_wins, long_term_improvements, action_items).
 *   - meta.hostname is cross-checked against the expected hostname.
 *   - meta.url and meta.audited_at are required.
 *   - meta.generated_at is unconditionally set by this orchestrator to the
 *     actual build time (post-process), preventing the LLM from emitting a
 *     hallucinated timestamp.
 *   - Output is written atomically (.tmp + rename) per output-artifacts.md.
 *
 * Stop-on-critical policy:
 *   - No ANTHROPIC_API_KEY in env or .env  → critical
 *   - reports/analysis/<host>/ does not exist → critical
 *   - Missing report-builder SKILL.md       → critical
 *   - Zero analyzer outputs found           → critical
 *   - LLM call failed after retries         → critical
 *   - Output failed schema validation       → critical (file not written)
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

const REQUIRED_TOP_LEVEL = [
  'meta',
  'executive_summary',
  'severity_overview',
  'key_findings',
  'prioritized_roadmap',
  'quick_wins',
  'long_term_improvements',
  'action_items',
  'appendix'
];

const ANALYZER_DIMENSIONS = Object.freeze(
  ['performance', 'accessibility', 'seo', 'security', 'best-practices']
);

const DEFAULT_MODEL      = 'llama-3.3-70b-versatile';
const DEFAULT_MAX_TOKENS = 2000;             /* Reports can be substantial */
const DEFAULT_TIMEOUT_MS = 300000;            /* 5 minutes — report-builder does more work */
const DEFAULT_RETRIES    = 3;

const CRITICAL = Object.freeze({
  NO_API_KEY:     'NO_API_KEY',
  NO_ANALYSIS:    'NO_ANALYSIS',
  MISSING_SKILL:  'MISSING_SKILL',
  BUILD_FAILED:   'BUILD_FAILED',
  VALIDATION:     'VALIDATION',
  BAD_INPUT:      'BAD_INPUT'
});


/* ============================================================
 * Error type
 * ============================================================ */

class BuilderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BuilderError';
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
 * Skill loading — concatenate SKILL.md + sections-schema.md
 * ============================================================ */

function loadSkillContext() {
  const root = repoRoot();
  const skillPath    = path.join(root, '.claude', 'skills', 'report-builder', 'SKILL.md');
  const sectionsPath = path.join(root, '.claude', 'skills', 'report-builder', 'sections-schema.md');

  if (!fs.existsSync(skillPath)) {
    throw new BuilderError(CRITICAL.MISSING_SKILL,
      `report-builder SKILL.md not found: ${rel(skillPath)}`);
  }

  const parts = [];
  parts.push('# report-builder/SKILL.md\n\n');
  parts.push(fs.readFileSync(skillPath, 'utf8'));

  if (fs.existsSync(sectionsPath)) {
    parts.push('\n\n---\n\n# report-builder/sections-schema.md (normative for output shape)\n\n');
    parts.push(fs.readFileSync(sectionsPath, 'utf8'));
  }

  return parts.join('');
}


/* ============================================================
 * Analyzer output loading — latest <dim>-run<N>.json per dimension
 * ============================================================ */

function loadAnalyzerOutputs(hostname) {
  const dir = path.join(repoRoot(), 'reports', 'analysis', hostname);
  if (!fs.existsSync(dir)) {
    throw new BuilderError(CRITICAL.NO_ANALYSIS,
      `no analyzer outputs directory: ${rel(dir)}. Run the analyze stage first.`);
  }

  const entries  = fs.readdirSync(dir);
  const outputs  = {};
  const missing  = [];
  const corrupt  = [];

  for (const dim of ANALYZER_DIMENSIONS) {
    const re = new RegExp(`^${dim}-run(\\d+)\\.json$`);
    const matches = entries.filter(f => re.test(f));
    if (matches.length === 0) {
      missing.push(dim);
      continue;
    }
    /* Pick the highest run number. */
    matches.sort((a, b) => {
      const na = parseInt(a.match(/run(\d+)/)[1], 10);
      const nb = parseInt(b.match(/run(\d+)/)[1], 10);
      return nb - na;
    });
    const latestPath = path.join(dir, matches[0]);
    try {
      outputs[dim] = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
    } catch (e) {
      corrupt.push({ dim, file: matches[0], error: e.message });
      missing.push(dim);
    }
  }

  if (Object.keys(outputs).length === 0) {
    throw new BuilderError(CRITICAL.NO_ANALYSIS,
      `no usable analyzer outputs in ${rel(dir)}. ` +
      (corrupt.length > 0 ? `Corrupt files: ${corrupt.map(c => c.file).join(', ')}` : 'Run the analyze stage first.'));
  }

  return { outputs, missing, corrupt };
}


// collect artifacts
function collectArtifacts(hostname) {

  const analysisDir =
    path.join(repoRoot(), 'reports', 'analysis', hostname);

  if (!fs.existsSync(analysisDir)) {
    return [];
  }

  return fs.readdirSync(analysisDir)
    .filter(f => f.endsWith('.json'));
}


/* ============================================================
 * Prompt construction
 * ============================================================ */
function buildUserMessage({ url, hostname, analyzerOutputs, missing, artifactsConsumed }) {

  const present = Object.keys(analyzerOutputs).sort();

  /* Compress analyzer outputs before prompting */
  const compactOutputs = {};

  for (const [dim, data] of Object.entries(analyzerOutputs)) {

    compactOutputs[dim] = {
      dimension: data.dimension,

      score: data.score,

      summary: data.summary,

      findings: Array.isArray(data.findings)
        ? data.findings.slice(0, 3).map((f) => ({
            title: f.title || '',
            severity: f.severity || '',
            priority: f.priority || '',
            description: f.description || '',
            metric: f.metric || '',
            recommendation: f.recommendation || ''
          }))
        : [],

      metadata: data.metadata || {}
    };


  }

  return [

    `Build the Report JSON for ${url}.`,

    ``,

    JSON.stringify(compactOutputs),

    ``,

    ``,
    `Artifacts available:`,
    JSON.stringify(artifactsConsumed),
    ``,

    `Follow the Procedure in your SKILL.md (13 steps). Apply every quality gate in §12 before emitting.`,

    `Emit ONLY the Report JSON object — no prose before or after, no markdown fence.`,

    `Return ONLY raw JSON.`, 
    `Do not use markdown.`, 
    `Do not use code fences.`, 
    `Do not explain anything.`,

    `Required:`,

    `  - .meta.url MUST equal "${url}"`,
    `  - .meta.hostname MUST equal "${hostname}"`,

    `  - .meta.dimensions_analyzed MUST list: ${present.join(', ') || '(empty array)'}`,

    `  - .meta.dimensions_missing MUST list: ${missing.join(', ') || '(empty array)'}`,

    `  - All eight top-level fields per sections-schema.md MUST be present`,

    ``,
    `FINDING CONTENT RULES (MANDATORY):`,

    ``,
    `Each finding MUST follow this structure exactly:`,

    ``,
    `CATEGORY:`,
    `Short issue title only.`,
    ``,
    `EVIDENCE:`,
    `Observable technical proof only.`,
    `Include metrics, missing headers, failed audits, oversized assets, unused JS/CSS, render blocking resources, accessibility violations, or detected technical problems.`,
    `Evidence MUST describe WHAT was detected.`,
    ``,
    `IMPACT:`,
    `Describe the consequence of the issue.`,
    `Impact MUST explain WHY the issue matters.`,
    `Impact MUST mention performance, UX, SEO, accessibility, security, scalability, or maintainability consequences.`,
    `Impact MUST NOT repeat evidence wording.`,
    ``,
    `RECOMMENDATION:`,
    `Describe HOW to fix the issue.`,
    `Recommendation MUST contain implementation guidance.`,
    `Recommendation MUST be actionable.`,
    ``,
    `STRICT RULES:`,

    `- evidence, impact, and recommendation MUST all contain different wording`,
    `- NEVER reuse the same sentence`,
    `- NEVER paraphrase the same sentence`,
    `- DO NOT copy category or description into other fields`,
    `- evidence MUST be technical`,
    `- impact MUST be consequence-focused`,
    `- recommendation MUST be implementation-focused`,
    ``,
    `BAD:`,

    `evidence: "Optimize images to improve performance."`,
    `impact: "Optimize images to improve performance."`,
    ``,
    `GOOD:`,

    `evidence: "Homepage banner images exceed 1MB and are served without compression."`,
    `impact: "Large image payloads increase LCP and slow mobile rendering."`,
    `recommendation: "Convert large assets to WebP and implement responsive image sizing."`,

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

          const err = new BuilderError(
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
            new BuilderError(
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
        new BuilderError(
          'TIMEOUT',
          `API request timed out after ${timeoutMs || DEFAULT_TIMEOUT_MS}ms`
        )
      );

    });

    req.on('error', e => {
      reject(new BuilderError('NETWORK', e.message));
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
 * Response parsing
 * ============================================================ */
function extractJSONFromResponse(response) {

  if (
    !response ||
    !response.choices ||
    !Array.isArray(response.choices) ||
    !response.choices[0] ||
    !response.choices[0].message
  ) {
    throw new BuilderError(
      'BAD_RESPONSE',
      'response missing choices[0].message'
    );
  }

  const text = response.choices[0].message.content;

  if (typeof text !== 'string') {
    throw new BuilderError(
      'BAD_RESPONSE',
      'message content is not a string'
    );
  }

  let cleaned = text.trim();

  const fence = cleaned.match(/^```(?:json)?\s*\n([\s\S]+?)\n```\s*$/);

  if (fence) {
    cleaned = fence[1];
  }

  const first = cleaned.indexOf('{');
  const last  = cleaned.lastIndexOf('}');

  if (first === -1 || last === -1 || last < first) {
    throw new BuilderError(
      'NO_JSON',
      'response does not contain a JSON object'
    );
  }

  const jsonSlice = cleaned.slice(first, last + 1);

  try {
    return JSON.parse(jsonSlice);
  } catch (e) {
    throw new BuilderError(
      'PARSE_FAIL',
      `Report JSON does not parse: ${e.message}`
    );
  }
}

/* ============================================================
 * Validation against sections-schema.md
 *
 *   Hard fails:
 *     - Top-level shape (8 required fields)
 *     - meta.hostname / meta.url / meta.audited_at
 *     - action_items shape (total + items array)
 *
 *   Soft warnings (returned, not thrown):
 *     - Severity/priority/total sum mismatch
 *     - Dimensions arg vs meta.dimensions_analyzed mismatch
 *     - Theme structural violations
 *
 *   Soft warnings are recorded in the meta.build_warnings array (the
 *   renderer surfaces them in the Appendix).
 * ============================================================ */

function validateReport(report, expected) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new BuilderError(CRITICAL.VALIDATION, 'Report is not an object');
  }

  const missing = REQUIRED_TOP_LEVEL.filter(f => !(f in report));
  if (missing.length > 0) {
    throw new BuilderError(CRITICAL.VALIDATION,
      `missing required top-level fields: ${missing.join(', ')}`);
  }

  /* meta */
  if (!report.meta || typeof report.meta !== 'object' || Array.isArray(report.meta)) {
    throw new BuilderError(CRITICAL.VALIDATION, '.meta is missing or not an object');
  }
  if (report.meta.hostname !== expected.hostname) {
    throw new BuilderError(CRITICAL.VALIDATION,
      `.meta.hostname mismatch: expected '${expected.hostname}', got '${report.meta.hostname}'`);
  }
  if (typeof report.meta.url !== 'string' || report.meta.url.length === 0) {
    throw new BuilderError(CRITICAL.VALIDATION, '.meta.url must be a non-empty string');
  }
  if (typeof report.meta.audited_at !== 'string' || report.meta.audited_at.length === 0) {
    throw new BuilderError(CRITICAL.VALIDATION, '.meta.audited_at must be a non-empty string');
  }

  /* action_items */
  if (!report.action_items || typeof report.action_items !== 'object' || Array.isArray(report.action_items)) {
    throw new BuilderError(CRITICAL.VALIDATION, '.action_items is missing or not an object');
  }
  if (typeof report.action_items.total !== 'number') {
    throw new BuilderError(CRITICAL.VALIDATION, '.action_items.total must be a number');
  }
  if (!Array.isArray(report.action_items.items)) {
    throw new BuilderError(CRITICAL.VALIDATION, '.action_items.items must be an array');
  }

  /* Sum invariants — soft warning */
  const warnings = [];
  if (report.severity_overview && typeof report.severity_overview === 'object') {
    const sumOf = obj => obj && typeof obj === 'object'
      ? Object.values(obj).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0)
      : 0;
    const sumSev = sumOf(report.severity_overview.by_severity);
    const sumPri = sumOf(report.severity_overview.by_priority);
    const total  = report.action_items.total;
    if (sumSev !== total || sumPri !== total) {
      warnings.push(`count mismatch: by_severity=${sumSev}, by_priority=${sumPri}, action_items.total=${total}`);
    }
  }

  /* Dimension coverage — soft warning */
  const analyzed = Array.isArray(report.meta.dimensions_analyzed) ? report.meta.dimensions_analyzed : [];
  const missingD = Array.isArray(report.meta.dimensions_missing)  ? report.meta.dimensions_missing  : [];
  const covered  = new Set([...analyzed, ...missingD]);
  const notCovered = ANALYZER_DIMENSIONS.filter(d => !covered.has(d));
  if (notCovered.length > 0) {
    warnings.push(`dimensions not accounted for in meta: ${notCovered.join(', ')}`);
  }

  /* Themes — soft warning */
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
 * Post-processing — ensure generated_at is authoritative + merge
 *                   any orchestrator-detected warnings into meta.
 * ============================================================ */

function postProcessReport(report, warnings) {
  /* Unconditionally set generated_at to actual build time. */
  report.meta.generated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  report.meta.audited_at_human =
  new Date(report.meta.audited_at)
    .toUTCString()
    .replace('GMT', 'UTC');

  /* Merge orchestrator warnings with any existing build_warnings (the
     LLM may have populated some from its own quality gates). */
  if (!Array.isArray(report.meta.build_warnings)) report.meta.build_warnings = [];
  for (const w of warnings) {
    if (!report.meta.build_warnings.includes(w)) {
      report.meta.build_warnings.push(w);
    }
  }


}


/* ============================================================
 * Persistence — atomic write to reports/final/<host>/report-run<N>.json
 * ============================================================ */

function saveReport(report, hostname) {
  const outDir = path.join(repoRoot(), 'reports', 'final', hostname);
  fs.mkdirSync(outDir, { recursive: true });


  /* Copy frontend assets */
  const templateDir = path.join(repoRoot(), 'src', 'templates');

  const assets = [
    'styles.css',
    'presentation.js'
  ];

  for (const asset of assets) {

    const src = path.join(templateDir, asset);
    const dest = path.join(outDir, asset);

    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    }

  }

  let n = 1;
  while (fs.existsSync(path.join(outDir, `report-run${n}.json`))) n++;

  const finalPath = path.join(outDir, `report-run${n}.json`);
  const tmpPath   = finalPath + '.tmp';

  fs.writeFileSync(tmpPath, JSON.stringify(report, null, 2), { encoding: 'utf8' });
  fs.renameSync(tmpPath, finalPath);

  return { runNumber: n, file: finalPath };
}



// logo

async function detectWebsiteLogo(url) {

  return new Promise((resolve) => {

    try {

      https.get(url, (res) => {

        let html = '';

        res.on('data', chunk => {
          html += chunk.toString();
        });

        res.on('end', () => {

          /* favicon */
          const faviconMatch =
            html.match(/<link[^>]+rel=["'](?:shortcut icon|icon)["'][^>]+href=["']([^"']+)["']/i);

          /* og:image fallback */
          const ogMatch =
            html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);

          let logo =
            (faviconMatch && faviconMatch[1]) ||
            (ogMatch && ogMatch[1]) ||
            null;

          if (!logo) {
            return resolve(null);
          }

          try {

            const absolute =
              new URL(logo, url).href;

            resolve(absolute);

          } catch {

            resolve(null);

          }

        });

      }).on('error', () => resolve(null));

    } catch {

      resolve(null);

    }

  });

}



/* ============================================================
 * Top-level: drive the report-builder skill
 * ============================================================ */

async function runReportBuilder({ url, hostname, log, apiKey, model, maxTokens, timeoutMs, retries }) {
  if (!url || typeof url !== 'string') {
    throw new BuilderError(CRITICAL.BAD_INPUT, 'url (string) is required');
  }
  if (!hostname || typeof hostname !== 'string') {
    throw new BuilderError(CRITICAL.BAD_INPUT, 'hostname (string) is required');
  }
  if (!log) log = noopLogger();

  const t0 = Date.now();
  log.info('narrate', 'starting report-builder');

  /* Resolve API key */
  apiKey = resolveAPIKey(apiKey);
  if (!apiKey) {
    throw new BuilderError(CRITICAL.NO_API_KEY,
      'GROQ_API_KEY not found in process.env or .env');
  }

  /* 1. Load skill context */
  const skillContent = loadSkillContext();
  log.debug('narrate', 'skill loaded', { system_chars: skillContent.length });

  /* 2. Load analyzer outputs */
  const { outputs: analyzerOutputs, missing, corrupt } = loadAnalyzerOutputs(hostname);

  //  load artifacts 
  const artifactsConsumed = collectArtifacts(hostname);

  if (corrupt.length > 0) {
    log.warn('narrate', `skipping ${corrupt.length} corrupt analyzer file(s)`,
             { corrupt: corrupt.map(c => c.file) });
  }
  log.info('narrate', `loaded ${Object.keys(analyzerOutputs).length}/${ANALYZER_DIMENSIONS.length} analyzer outputs`,
           { analyzed: Object.keys(analyzerOutputs).sort(), missing });

  /* 3. Build prompt */
  const userMessage = buildUserMessage({ url, hostname, analyzerOutputs, missing, artifactsConsumed });
  log.debug('narrate', 'prompt sized', {
    system_chars: skillContent.length,
    user_chars:   userMessage.length
  });

  /* 4. Call API (with retry) */
  let response;


  /* Prevent Groq TPM burst */
  await new Promise(r => setTimeout(r, 15000));

  try {
    response = await callLLMWithRetry({
      apiKey, model,
    
system: `
You are an enterprise website audit report builder.

Return ONLY valid JSON.

Required top-level fields: 
- executive_summary 
- severity_overview 
- key_findings 
- prioritized_roadmap 
- quick_wins 
- long_term_improvements 
- action_items 

.meta.audited_at must be a non-empty ISO timestamp string
.action_items.total must be a number


key_findings MUST be an array.
Each key_findings item must contain:
- dimension
- title
- severity
- priority
- description
- recommendation


executive_summary MUST be an object with:
- summary
- top_issues
- next_step
top_issues must contain at least 1 item.
next_step must never be empty.


long_term_improvements MUST contain:
{
  "themes": [
    {
      "title": string,
      "description": string
    }
  ],
  "multi_day_items": [
    {
      "title": string,
      "description": string,
      "recommendation": string
    }
  ]
}
Do not return empty arrays.

quick_wins.items must contain at least 1 item.
Infer quick wins from high-impact low-effort findings if needed.

If analyzer findings are limited:
- infer monitoring improvements
- infer scalability improvements
- infer maintainability recommendations
- infer observability improvements
- infer future optimization opportunities


Each action item MUST include:
- title
- description
- priority
- severity
- dimension
- recommendation


No markdown.

`,
      userMessage,
      maxTokens, timeoutMs
    }, retries);
  } catch (e) {
    throw new BuilderError(CRITICAL.BUILD_FAILED,
      `LLM call failed: ${e.message}`);
  }

  /* 5. Parse */
  let report;
  try {
    report = extractJSONFromResponse(response);
  } catch (e) {
    throw new BuilderError(CRITICAL.BUILD_FAILED,
      `failed to extract Report JSON: ${e.message}`);
  }


  
// appendix
  if (!report.appendix) {

    report.appendix = {
      methodology:
        'The audit combined Lighthouse analysis with automated accessibility, SEO, security, and performance inspection.',

      artifacts_consumed:
        artifactsConsumed
    };

  }


  /* 6. Validate (throws BuilderError on hard fails; returns warning list) */
  const warnings = validateReport(report, { hostname });

  if (warnings.length > 0) {
    log.warn('narrate', `${warnings.length} soft warning(s) — surfacing into report meta`, { warnings });
  }

  /* 7. Post-process — authoritative generated_at + warning merge */
  postProcessReport(report, warnings);


  
  /* Universal logo detection */
  async function getWebsiteLogo(targetUrl) {

    try {

      const hostname = new URL(targetUrl).hostname;

      /* Primary favicon source */
      return `https://www.google.com/s2/favicons?domain=${hostname}&sz=128`;

    } catch (e) {

      return null;
    }
  }

  report.meta.logo_url =
    await getWebsiteLogo(url) ||
    `https://ui-avatars.com/api/?name=${encodeURIComponent(
      report.meta.hostname || 'Site'
    )}&background=f3f4f6&color=0f172a`;

  report.meta.initial =
    String(report.meta.hostname || '?')
      .charAt(0)
      .toUpperCase();

  /* Normalize severity overview for renderer */
  if (!report.severity_overview.by_severity) {

    report.severity_overview = {
      total_findings: (report.action_items?.items || []).length,

      by_severity: {
        critical: report.severity_overview.critical || 0,
        high: report.severity_overview.high || 0,
        medium: report.severity_overview.medium || 0,
        low: report.severity_overview.low || 0,
        info: report.severity_overview.info || 0
      },

      by_priority: {
        P0: 0,
        P1: 0,
        P2: 0,
        P3: 0
      },

      by_dimension: []
    };

    (report.action_items?.items || []).forEach(function(item) {

      var p = String(item.priority || '').toLowerCase();

      if (p === 'critical' || p === 'p0') {
        report.severity_overview.by_priority.P0++;
      }
      else if (p === 'high' || p === 'p1') {
        report.severity_overview.by_priority.P1++;
      }
      else if (p === 'medium' || p === 'p2') {
        report.severity_overview.by_priority.P2++;
      }
      else {
        report.severity_overview.by_priority.P3++;
      }
    });
  }

  /* Derive executive sections from findings */
  let findings = report.action_items?.items || [];

  /* Fallback to analyzer findings */
  if (!findings.length) {

    findings =
      report.dimension_details?.performance?.findings || [];

  }


  const effortMap = {
    S: '< 1 hour',
    M: '1 day',
    L: '2–5 days',
    XL: '1–2 weeks'
  };

  /* Normalize findings */
  findings = findings.map(f => ({

    ...f,

    title:
      f.title ||
      f.issue ||
      f.category ||
      'Untitled finding',

    category:
      f.category ||
      f.title ||
      'General',

    dimension:
      f.dimension ||
      'Performance',

    priority:
    (
      String(f.priority).toLowerCase() === 'critical'
        ? 'P0'
        : String(f.priority).toLowerCase() === 'high'
          ? 'P1'
          : String(f.priority).toLowerCase() === 'medium'
            ? 'P2'
            : 'P3'
    ),

    priority_class:
    (
      String(f.priority).toLowerCase() === 'critical'
        ? 'p0'
        : String(f.priority).toLowerCase() === 'high'
          ? 'p1'
          : String(f.priority).toLowerCase() === 'medium'
            ? 'p2'
            : 'p3'
    ),

    estimated_effort:
      effortMap[f.estimated_effort] ||
      f.estimated_effort ||
      '1 day',

    severity:
    (
      ['critical', 'high', 'medium', 'low', 'info']
        .includes(String(f.severity).toLowerCase())
        ? String(f.severity).toLowerCase()
        : 'info'
    ),


    recommendation:
      f.recommendation ||
      'Review and monitor this finding.',

    evidence:
      f.evidence ||
      f.description ||
      'No supporting evidence provided.',

    impact:
      f.impact ||
      f.description ||
      'Potential impact requires review.'

  }));

  const priorityOrder = {
    P0: 0,
    P1: 1,
    P2: 2,
    P3: 3
  };

  findings.sort((a, b) => {
    return (priorityOrder[a.priority] || 99)
         - (priorityOrder[b.priority] || 99);
  });


/* Replace report sections with normalized findings */

report.key_findings = findings.slice(0, 5);

report.action_items.items = findings;

report.action_items.total = findings.length;



  /* Ensure executive_summary exists */



  
  const dimensionScores = Object.values(analyzerOutputs || {})
  .map(d => d.score)
  .filter(score => typeof score === 'number');

  const overallScore =
    dimensionScores.length > 0
      ? Math.round(
          dimensionScores.reduce((a, b) => a + b, 0) /
          dimensionScores.length
        )
      : null;



  if (
    !report.executive_summary ||
    typeof report.executive_summary !== 'object'
  ) {

    report.executive_summary = {

      summary:
        typeof report.executive_summary === 'string'
          ? report.executive_summary
          : 'Audit completed successfully.',

      top_issues: [],
      next_step:
        report.action_items?.items?.[0]?.recommendation ||
        'Review and address the highest-priority findings first.'
    };
  }

  report.executive_summary.headline_score = overallScore;


  /* Top issues and next step  */
  const realIssues = findings.filter(f => {
  const p = String(f.priority || '').toLowerCase();

    return !['info', 'pass'].includes(p);
  });

  report.executive_summary.top_issues = realIssues.slice(0, 3);

  report.executive_summary.next_step =
    realIssues.length > 0
      ? realIssues[0]
      : {
          title: 'No major issues detected',
          description:
            'The website appears healthy based on the analyzed dimensions.',
          recommendation:
            'Continue monitoring performance and maintain current best practices.',
          priority: 'info'
        };


  /* Quick wins */
  report.quick_wins = {
    items: findings
      .filter(f =>
        ['P1', 'P2'].includes(f.priority) &&
        ['< 1 hour', '1 day', '2–5 days']
          .includes(f.estimated_effort)
      )
      .slice(0, 5)
  };


  report.recommendations_combined = [

    ...new Map(

      [

        ...(report.key_findings || []),

        ...(report.quick_wins?.items || [])

      ].map(item => [item.title, item])

    ).values()

  ];

  /* Roadmap */
  report.prioritized_roadmap = {
    items: findings.slice(0, 6).map((f, i) => ({

      phase:
        i < 2 ? 'Immediate' :
        i < 4 ? 'Short-term' :
                'Long-term',

      title:
        f.title || 'Untitled finding',

      description:
        f.description ||
        f.evidence ||
        '',

      recommendation:
        f.recommendation || '',

      priority:
        f.priority || 'P2',

      priority_class:
        f.priority_class || 'p2',

      severity:
        f.severity || 'medium',

      dimension:
        f.dimension || 'general',

      estimated_effort:
        f.estimated_effort || '1 day'

    }))
  };


  /* Normalize multi-day items for renderer */

  if (
    report.long_term_improvements &&
    Array.isArray(report.long_term_improvements.multi_day_items)
  ) {

    report.long_term_improvements.multi_day_items =
      report.long_term_improvements.multi_day_items.map(item => ({

        title:
          item.title || 'Untitled improvement',

        description:
          item.description || '',

        recommendation:
          item.recommendation || '',

        priority:
          item.priority || 'P3',

        priority_class:
          item.priority_class || 'p3',

        severity:
          item.severity || 'medium',

        dimension:
          item.dimension || 'Architecture',

        estimated_effort:
          item.estimated_effort || '1–2 weeks'

      }));

  }
  
  /* Inject analyzer payloads for renderer */
  report.dimension_details = analyzerOutputs;

  /* 8. Save atomically */
  const saved = saveReport(report, hostname);

  log.info('narrate', 'done', {
    file:        rel(saved.file),
    run:         saved.runNumber,
    score:       (report.executive_summary && report.executive_summary.headline_score) || null,
    findings:    report.action_items.total,
    warnings:    warnings.length,
    elapsed_ms:  Date.now() - t0
  });

  return {
    ok:         true,
    file:       rel(saved.file),
    run:        saved.runNumber,
    headline_score: (report.executive_summary && report.executive_summary.headline_score) || null,
    total_findings: report.action_items.total,
    warnings,
    elapsed_ms: Date.now() - t0
  };
}


/* ============================================================
 * Exports
 * ============================================================ */

module.exports = {
  runReportBuilder,
  /* primitives — exposed for tests / orchestrator extension */
  loadSkillContext,
  loadAnalyzerOutputs,
  buildUserMessage,
  extractJSONFromResponse,
  validateReport,
  postProcessReport,
  saveReport,
  resolveAPIKey,
  /* types + constants */
  BuilderError,
  CRITICAL,
  REQUIRED_TOP_LEVEL,
  ANALYZER_DIMENSIONS,
  DEFAULT_MODEL
};
