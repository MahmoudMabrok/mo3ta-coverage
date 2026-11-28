import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { checkBaseRef, checkGitRepository } from './gitUtils.js';
import { clearScanCaches, separateSourceAndTestFiles } from './fileUtils.js';
import { validateJestEngineFlags } from './engines/jestEngine.js';
import {
  analyzeChangedFile,
  buildMarkdownCoverageReport,
  getChangedLines,
  getExplicitFiles,
  listChangedSourceFiles,
  loadCoverageIndex,
  parseJestArgs,
  parseFilter,
  resolveJestBin,
  resolveTestPlan,
  summarizeChangedLineResults,
  writeMarkdownReport
} from './cli.js';

const DEFAULT_BASE = 'origin/main';
const DEFAULT_LIMIT = 80;
const DEFAULT_LCOV = 'coverage/lcov.info';
const DEFAULT_TIMEOUT_MS = 300000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const JEST_MAX_BUFFER = 20 * 1024 * 1024;
const OUTPUT_TAIL_CHARS = 8000;
const MAX_LINES_RETURNED = 100;
const MAX_SNIPPETS_PER_FILE = 20;
const MAX_SNIPPETS_TOTAL = 60;
const MAX_SNIPPET_CHARS = 180;
const CONFIG_NAME = '.mo3ta-coverage.json';

/**
 * Failure the CLI would print and exit on. `code` is stable for agents.
 */
export class Mo3taError extends Error {
  constructor(message, code, hint, extra = {}) {
    super(message);
    this.name = 'Mo3taError';
    this.code = code;
    this.hint = hint || null;
    if (extra.jest) this.jest = extra.jest;
  }
}

/**
 * Repo the tool should inspect. An explicit `root` wins, then Claude Code's
 * project directory, then the server process cwd.
 * @param {string} [root]
 * @returns {string}
 */
export function resolveRepoRoot(root) {
  if (root !== undefined && root !== null && String(root).trim() !== '') {
    return path.resolve(String(root));
  }
  const claudeRoot = process.env.CLAUDE_PROJECT_DIR;
  if (claudeRoot && String(claudeRoot).trim() !== '') {
    return path.resolve(String(claudeRoot));
  }
  return process.cwd();
}

function stripAnsi(text) {
  return String(text || '').replace(/\u001b\[[0-9;]*m/g, '');
}

function round2(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return Math.round(value * 100) / 100;
}

function capList(values, max = MAX_LINES_RETURNED) {
  return values.slice(0, max);
}

function clipOutput(text) {
  const clean = stripAnsi(text).trim();
  if (clean.length <= OUTPUT_TAIL_CHARS) {
    return { outputTail: clean, outputTruncated: false };
  }
  return {
    outputTail: clean.slice(-OUTPUT_TAIL_CHARS),
    outputTruncated: true
  };
}

function readProjectConfig(root, useConfig) {
  const configPath = path.resolve(root, CONFIG_NAME);
  if (useConfig === false) {
    return { config: {}, configPath, found: false, used: false };
  }
  if (!fs.existsSync(configPath)) {
    return { config: {}, configPath, found: false, used: true };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Mo3taError(
      `Could not parse ${configPath}: ${error.message}`,
      'INVALID_CONFIG',
      'Fix .mo3ta-coverage.json or call the tool with useConfig: false. The file only supplies base, mode, depth, engine, discoveryWorkers, fallback, jest, and filter.'
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Mo3taError(
      `Could not parse ${configPath}: expected a JSON object.`,
      'INVALID_CONFIG',
      'Fix .mo3ta-coverage.json or call the tool with useConfig: false.'
    );
  }

  return {
    config: {
      base: parsed.base,
      mode: parsed.mode,
      depth: parsed.depth,
      engine: parsed.engine,
      discoveryWorkers: parsed.discoveryWorkers,
      fallback: parsed.fallback,
      jest: parsed.jest,
      filter: parsed.filter
    },
    configPath,
    found: true,
    used: true
  };
}

function toMo3taError(error) {
  if (error instanceof Mo3taError) return error;
  if (error && error.code) {
    return new Mo3taError(error.message || String(error), error.code, error.hint || null);
  }
  return error;
}

function parseMode(explicit, configMode) {
  const raw = explicit !== undefined && explicit !== null && explicit !== ''
    ? explicit
    : configMode || 'smart';
  const mode = String(raw).toLowerCase();
  if (!['fast', 'smart', 'full'].includes(mode)) {
    throw new Mo3taError(
      `Invalid mode: ${raw}. Expected one of: fast, smart, full.`,
      'INVALID_MODE',
      'fast maps by filename and a direct import scan. smart adds a depth-limited reverse-import walk. full passes changed files to jest --findRelatedTests.'
    );
  }
  return mode;
}

function parseDepth(explicit, configDepth, mode) {
  if (mode !== 'smart') return null;
  const raw = explicit !== undefined && explicit !== null && explicit !== ''
    ? explicit
    : configDepth !== undefined ? configDepth : 2;
  const depth = Number.parseInt(raw, 10);
  if (!Number.isInteger(depth) || depth < 1 || depth > 10) {
    throw new Mo3taError(
      `Invalid depth: ${raw}. Expected an integer between 1 and 10.`,
      'INVALID_DEPTH',
      'Depth 1 keeps tests that import the changed file. Depth 2 also walks one intermediate module, such as a barrel index.js.'
    );
  }
  return depth;
}

function parseEngine(explicit, configEngine, mode) {
  if (mode !== 'smart') {
    if (explicit !== undefined && explicit !== null && explicit !== '') {
      const norm = String(explicit).toLowerCase();
      if (norm !== 'native' && norm !== 'jest') {
        throw new Mo3taError(
          `Invalid engine: ${explicit}. Expected one of: native, jest.`,
          'INVALID_ENGINE',
          'engine can be "native" (default) or "jest" (opt-in Jest dependency graph discovery in smart mode).'
        );
      }
      if (norm === 'jest') {
        throw new Mo3taError(
          "engine: 'jest' is only supported in smart mode.",
          'INVALID_ENGINE_MODE',
          'Use mode "smart" with engine "jest", or omit engine when using "fast" or "full" mode.'
        );
      }
    }
    return null;
  }

  const raw = explicit !== undefined && explicit !== null && explicit !== ''
    ? explicit
    : (configEngine || 'native');
  const engine = String(raw).toLowerCase();
  if (!['native', 'jest'].includes(engine)) {
    throw new Mo3taError(
      `Invalid engine: ${raw}. Expected one of: native, jest.`,
      'INVALID_ENGINE',
      'engine can be "native" (default) or "jest" (opt-in Jest dependency graph discovery in smart mode).'
    );
  }
  return engine;
}

function parseDiscoveryWorkers(explicit, configWorkers) {
  const raw = explicit !== undefined && explicit !== null && explicit !== ''
    ? explicit
    : (configWorkers !== undefined && configWorkers !== null && configWorkers !== '' ? configWorkers : 2);
  let workers;
  if (typeof raw === 'number') {
    workers = Number.isInteger(raw) ? raw : NaN;
  } else if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    workers = Number.parseInt(raw.trim(), 10);
  } else {
    workers = NaN;
  }
  if (!Number.isInteger(workers) || workers < 1 || workers > 16) {
    throw new Mo3taError(
      `Invalid discoveryWorkers: ${raw}. Expected an integer between 1 and 16.`,
      'INVALID_DISCOVERY_WORKERS',
      'discoveryWorkers controls parallel workers during Jest dependency discovery (default 2, range 1 to 16).'
    );
  }
  return workers;
}

function parseFallback(explicit, configFallback) {
  const raw = explicit !== undefined && explicit !== null && explicit !== ''
    ? explicit
    : (configFallback || 'error');
  const fallback = String(raw).toLowerCase();
  if (!['error', 'native'].includes(fallback)) {
    throw new Mo3taError(
      `Invalid fallback: ${raw}. Expected one of: error, native.`,
      'INVALID_FALLBACK',
      'fallback can be "error" (default, fail when Jest discovery fails) or "native" (fall back to native import-graph discovery with a warning).'
    );
  }
  return fallback;
}

function parseLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LIMIT;
  const limit = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(limit) || limit < 0 || limit > 100) {
    throw new Mo3taError(
      `Invalid limit: ${value}. Expected a number from 0 to 100.`,
      'INVALID_LIMIT',
      'The limit is the minimum percent of changed, coverable lines that must be covered.'
    );
  }
  return limit;
}

function parseTimeout(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_TIMEOUT_MS;
  const timeout = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > MAX_TIMEOUT_MS) {
    throw new Mo3taError(
      `Invalid timeoutMs: ${value}. Expected an integer from 1000 to ${MAX_TIMEOUT_MS}.`,
      'INVALID_TIMEOUT',
      'Jest is killed when this elapses. Narrow the run with mode "fast" or an explicit files list before raising it.'
    );
  }
  return timeout;
}

function assertDirectory(root) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Mo3taError(
      `Repository path does not exist or is not a directory: ${root}`,
      'REPO_NOT_FOUND',
      'Pass root as the git checkout to inspect. When root is omitted, the server uses CLAUDE_PROJECT_DIR if set, otherwise its own cwd.'
    );
  }
}

function assertGitRepo(root) {
  const git = checkGitRepository(root);
  if (!git.ok) {
    throw new Mo3taError(
      `${root} is not a git repository.`,
      'NOT_A_GIT_REPO',
      'mo3ta-coverage compares files with git. Pass root as a local checkout (the folder that contains .git).'
    );
  }
}

function assertBase(base, root) {
  const result = checkBaseRef(base, root);
  if (!result.ok) {
    throw new Mo3taError(
      `Base ref "${base}" does not exist in ${root}.`,
      'INVALID_BASE_REF',
      'Fetch the ref (git fetch) or pass a local branch, tag, or commit. origin/main is the default and is missing until that remote ref exists locally.'
    );
  }
}

/**
 * Shared option resolution for every tool. Clears scan caches so a long-running
 * server sees edits made since the previous call.
 */
function openRepo(options = {}) {
  clearScanCaches();
  const root = resolveRepoRoot(options.root);
  assertDirectory(root);

  const { config, configPath, found, used } = readProjectConfig(root, options.useConfig);
  const mode = parseMode(options.mode, config.mode);
  const depth = parseDepth(options.depth, config.depth, mode);
  const engine = parseEngine(options.engine, config.engine, mode);
  const discoveryWorkers = parseDiscoveryWorkers(options.discoveryWorkers, config.discoveryWorkers);
  const fallback = parseFallback(options.fallback, config.fallback);
  const explain = options.explain === true || options.explain === 'true';
  const limit = parseLimit(options.limit);
  const timeoutMs = parseTimeout(options.timeoutMs);
  const base = options.base !== undefined && options.base !== null && options.base !== ''
    ? String(options.base)
    : config.base || DEFAULT_BASE;

  const rawFilter = options.filter !== undefined && options.filter !== null && options.filter !== ''
    ? options.filter
    : (config.filter || null);
  // Validate up front so a bad regex never reaches resolveTestPlan.
  let filter = null;
  try {
    filter = parseFilter(rawFilter);
  } catch (error) {
    if (error.code === 'INVALID_FILTER') {
      throw new Mo3taError(
        error.message,
        'INVALID_FILTER',
        'filter is a JavaScript regular expression matched against the repo-relative spec file paths, e.g. "src/__tests__/login".'
      );
    }
    throw error;
  }

  const jestArgs = parseJestArgs(
    options.jest !== undefined && options.jest !== null ? options.jest : config.jest
  );
  if (engine === 'jest') {
    try {
      validateJestEngineFlags(jestArgs);
    } catch (error) {
      throw toMo3taError(error);
    }
  }

  assertGitRepo(root);
  assertBase(base, root);

  return {
    root,
    base,
    mode,
    depth,
    engine,
    discoveryWorkers,
    fallback,
    explain,
    limit,
    lcov: options.lcov ? String(options.lcov) : DEFAULT_LCOV,
    runTests: options.runTests !== false && options.runTests !== 'false',
    showCovered: options.showCovered === true || options.showCovered === 'true',
    jestArgs,
    filter,
    timeoutMs,
    ciReport: options.ciReport ? String(options.ciReport) : null,
    configFound: found,
    configUsed: used,
    configPath
  };
}

function explicitListRequested(options) {
  const filesGiven = options.files !== undefined && options.files !== null && options.files !== false && options.files !== '';
  return filesGiven || Boolean(options.filesFrom);
}

function selectInputFiles(ctx, options) {
  let explicit = [];
  try {
    explicit = getExplicitFiles({
      files: options.files,
      filesFrom: options.filesFrom
    }, ctx.root);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Mo3taError(
        `Could not read the file list at ${options.filesFrom}.`,
        'FILE_LIST_NOT_FOUND',
        'Pass filesFrom as a path relative to the repo root, or pass files instead.'
      );
    }
    throw new Mo3taError(
      error.message || 'Could not read the explicit file list.',
      'FILE_LIST_INVALID',
      'files accepts a string array or a comma-separated string of repo-relative paths.'
    );
  }

  if (explicitListRequested(options)) {
    // Unlike the CLI, an explicit list that normalizes to nothing does not
    // silently fall back to git detection. An agent that passed the wrong
    // paths should see that, not a scan of the whole branch.
    return {
      files: explicit,
      detection: 'explicit',
      warning: explicit.length === 0
        ? 'The explicit file list was empty after normalization (missing paths, or only node_modules/coverage/dist/build entries). Git changed-file detection was not used.'
        : null
    };
  }

  try {
    return {
      files: listChangedSourceFiles(ctx.base, ctx.root, {
        includeSnapshots: ctx.mode === 'smart' && ctx.engine === 'jest'
      }),
      detection: 'git',
      warning: null
    };
  } catch (error) {
    throw new Mo3taError(
      `Git could not list files changed against ${ctx.base}. ${error.message || ''}`.trim(),
      'GIT_ERROR',
      'Fetch the base ref and make sure HEAD exists. Changed files are the merge-base..HEAD diff plus staged and unstaged edits.'
    );
  }
}

function classifySelected(files) {
  const { sourceFiles, testFiles } = separateSourceAndTestFiles(files);
  const known = new Set([...sourceFiles, ...testFiles]);
  return files.map(filePath => ({
    path: filePath,
    kind: sourceFiles.includes(filePath) ? 'source' : testFiles.includes(filePath) ? 'test' : 'skipped',
    reason: known.has(filePath) ? null : 'Config and JSON files are ignored by test selection and by the coverage check.'
  }));
}

function settingsView(ctx) {
  return {
    root: ctx.root,
    base: ctx.base,
    mode: ctx.mode,
    depth: ctx.depth,
    engine: ctx.engine,
    discoveryWorkers: ctx.discoveryWorkers,
    fallback: ctx.fallback,
    explain: ctx.explain,
    limit: ctx.limit,
    lcov: ctx.lcov,
    jestArgs: ctx.jestArgs,
    filter: ctx.filter ? String(ctx.filter) : null,
    configFound: ctx.configFound,
    configUsed: ctx.configUsed
  };
}

function takeSnippets(root, relPath, lines, budget) {
  let rows = null;
  try {
    rows = fs.readFileSync(path.resolve(root, relPath), 'utf8').split(/\r?\n/);
  } catch {
    rows = null;
  }

  const snippets = [];
  let truncated = false;
  for (const line of lines) {
    if (snippets.length >= MAX_SNIPPETS_PER_FILE || budget.remaining <= 0) {
      truncated = true;
      break;
    }
    const raw = rows ? (rows[line - 1] ?? '') : '';
    snippets.push({
      line,
      text: raw.length > MAX_SNIPPET_CHARS ? `${raw.slice(0, MAX_SNIPPET_CHARS)}…` : raw
    });
    budget.remaining -= 1;
  }
  if (lines.length > snippets.length) truncated = true;
  return { snippets, truncated };
}

function diffLines(relPath, base, root) {
  try {
    return getChangedLines(relPath, base, root);
  } catch (error) {
    throw new Mo3taError(
      `Git could not diff ${relPath} against ${base}. ${error.message || ''}`.trim(),
      'GIT_ERROR',
      'The path should be relative to the repo root, and the base ref must resolve to a commit.'
    );
  }
}

function presentAnalyzedFile(result, ctx, budget) {
  const uncovered = takeSnippets(ctx.root, result.filePath, result.uncoveredLines, budget);
  const presented = {
    file: result.filePath,
    absolutePath: result.absolutePath,
    changedLines: capList(result.changedLines),
    changedLinesTruncated: result.changedLines.length > MAX_LINES_RETURNED,
    hasCoverageInfo: result.hasCoverageInfo,
    changedCoverableLines: result.trackedChangedLines,
    coveredCount: result.coveredLines.length,
    uncoveredCount: result.uncoveredLines.length,
    coverage: result.trackedChangedLines > 0
      ? round2((result.coveredLines.length / result.trackedChangedLines) * 100)
      : null,
    uncoveredLines: capList(result.uncoveredLines),
    uncoveredLinesTruncated: result.uncoveredLines.length > MAX_LINES_RETURNED,
    uncovered: uncovered.snippets,
    uncoveredTruncated: uncovered.truncated
  };

  if (!result.hasCoverageInfo) {
    presented.note = 'No lcov record for this file. changedLines come from the git diff and were not counted toward the threshold (same as the CLI).';
  } else if (result.trackedChangedLines === 0 && result.changedLines.length > 0) {
    presented.note = 'The git diff has no coverable lines (for example imports or comments), so this file does not affect the threshold.';
  }

  if (ctx.showCovered) {
    presented.coveredLines = capList(result.coveredLines);
    presented.coveredLinesTruncated = result.coveredLines.length > MAX_LINES_RETURNED;
  }

  return presented;
}

function summarizeList(result) {
  if (result.files.length === 0) {
    return result.detection === 'explicit'
      ? 'No scannable JS/TS files were left in the explicit list.'
      : `No changed JS/TS files vs ${result.base}.`;
  }
  const lines = result.files.map(file => `- ${file.path} (${file.kind})`);
  const head = result.detection === 'explicit'
    ? `${result.files.length} explicit JS/TS file(s) in ${result.root}:`
    : `${result.files.length} changed JS/TS file(s) vs ${result.base}:`;
  return [head, ...lines].join('\n');
}

function resolvePlan(ctx, files) {
  try {
    return resolveTestPlan(
      files,
      ctx.mode,
      ctx.depth ?? 2,
      ctx.root,
      ctx.jestArgs,
      ctx.filter,
      {
        engine: ctx.engine,
        discoveryWorkers: ctx.discoveryWorkers,
        explain: ctx.explain,
        fallback: ctx.fallback,
        discoveryTimeoutMs: ctx.timeoutMs
      }
    );
  } catch (error) {
    throw toMo3taError(error);
  }
}

function summarizePlan(result) {
  const engineNote = result.mode === 'smart' && result.engine
    ? `, engine: ${result.engine}`
    : '';
  const header = result.delegatedToJest
    ? `full mode passes ${result.jestTargets.length} changed file(s) to jest --findRelatedTests. Without running Jest, only ${result.testsToRun.length} changed test file(s) are known.`
    : `${result.testsToRun.length} test file(s) selected in ${result.mode} mode${result.mode === 'smart' ? ` (depth ${result.depth}${engineNote})` : ''}.`;
  const filterLine = result.filter
    ? `Filter /${result.filter}/ kept ${result.testsToRun.length} of ${result.allTestsToRun.length} candidate test file(s).`
    : null;
  const fallbackLine = result.fallbackUsed
    ? `Requested engine "${result.requestedEngine}" fell back to "${result.engine}".`
    : null;
  const warningLines = Array.isArray(result.warnings) && result.warnings.length > 0
    ? result.warnings
    : (result.warning ? [result.warning] : []);
  const mappingLines = result.mappings.slice(0, 30).map(mapping => {
    if (mapping.tests.length === 0) return `- ${mapping.source} → no test file (${mapping.matchType})`;
    return `- ${mapping.source} → ${mapping.tests.join(', ')} (${mapping.matchType})`;
  });
  return [header, filterLine, fallbackLine, ...warningLines, ...mappingLines].filter(Boolean).join('\n');
}

function summarizeCheck(result) {
  if (result.noChangedFiles) {
    if (result.warnings && result.warnings.length > 0) return result.warnings.join('\n');
    return `No changed JS/TS files vs ${result.base}. Nothing to cover.`;
  }
  if (result.testsNotRunReason === 'no-tests') {
    const lines = [
      `No test files selected for mode ${result.mode}. Jest was not run, so changed-line coverage was not measured.`,
      'The CLI would exit 0 here. Write a test that imports the changed source, then run check_changed_line_coverage again.',
      ...result.files.flatMap(file => [
        `- ${file.file} changed lines: ${file.changedLines.slice(0, 15).join(', ') || '(none)'}`,
        ...file.uncovered.slice(0, 6).map(snippet => `  ${file.file}:${snippet.line}  ${snippet.text}`)
      ])
    ];
    if (result.fallbackUsed) {
      lines.unshift(`Requested engine "${result.requestedEngine}" fell back to "${result.engine}".`);
    }
    return lines.join('\n');
  }

  const coverage = result.totals.coverage;
  const status = result.coveragePassed ? 'PASSED' : 'FAILED';
  const percent = coverage === null ? 'n/a' : `${coverage.toFixed(2)}%`;
  const lines = [
    `Changed-line coverage ${status}: ${percent} (limit ${result.limit}%).`,
    `${result.totals.covered} of ${result.totals.changed} coverable changed lines covered; ${result.totals.uncovered} uncovered.`
  ];
  if (result.mode === 'smart' && (result.engine === 'jest' || result.fallbackUsed)) {
    const versionPart = result.jestVersion ? ` (Jest ${result.jestVersion})` : '';
    const fallbackPart = result.fallbackUsed ? ` (fallback from ${result.requestedEngine})` : '';
    lines.push(`Discovery engine: ${result.engine}${versionPart}${fallbackPart}.`);
  }
  if (result.warnings && result.warnings.length > 0) {
    lines.push(...result.warnings);
  }
  if (result.testsFailed) {
    lines.push('Jest reported failures. The line results below are from the lcov file it left behind.');
  }
  if (!result.runTests) {
    lines.push('Jest was not run (runTests: false). Results come from the existing lcov file.');
  }
  result.files.filter(file => file.uncoveredLines.length > 0).forEach(file => {
    lines.push(`${file.file} uncovered: ${file.uncoveredLines.slice(0, 20).join(', ')}`);
    file.uncovered.slice(0, 8).forEach(snippet => {
      lines.push(`  ${file.file}:${snippet.line}  ${snippet.text}`);
    });
  });
  const missing = result.files.filter(file => file.hasCoverageInfo === false);
  if (missing.length > 0) {
    lines.push(`No lcov data for: ${missing.map(file => file.file).join(', ')}. Those diffs were not counted toward the threshold.`);
  }
  return lines.join('\n');
}

function presentPlan(ctx, selected, plan) {
  const fullModeWarning = plan.delegatedToJest
    ? 'full mode discovers related tests inside Jest --findRelatedTests. This list is only the changed test files, which is all --dryRun can know without running Jest.'
    : null;
  const warnings = [
    selected.warning,
    ...(plan.warnings || []),
    fullModeWarning
  ].filter(Boolean);
  const warning = warnings.join(' ') || null;
  const result = {
    ok: true,
    root: ctx.root,
    base: ctx.base,
    mode: ctx.mode,
    depth: ctx.depth,
    engine: plan.engine ?? ctx.engine,
    requestedEngine: plan.requestedEngine ?? ctx.engine,
    fallbackUsed: Boolean(plan.fallbackUsed),
    detection: selected.detection,
    delegatedToJest: plan.delegatedToJest,
    sourceFiles: plan.sourceFiles,
    changedTestFiles: plan.testFiles,
    mappings: plan.mappings.map(mapping => ({
      source: mapping.source,
      matchType: mapping.matchType,
      tests: mapping.tests
    })),
    filter: plan.filter,
    allTestsToRun: plan.allTestsToRun,
    testsToRun: plan.testsToRun,
    jestTargets: plan.jestTargets,
    metrics: plan.metrics ?? null,
    projects: plan.projects ?? null,
    jestVersion: plan.jestVersion ?? null,
    explanation: plan.explanation ?? null,
    warnings,
    warning
  };
  result.summary = summarizePlan(result);
  return result;
}

/**
 * JS/TS files changed vs a base ref, or an explicit list when `files` / `filesFrom` is set.
 * Includes every author's commits since the merge base, plus staged and unstaged edits.
 * @param {object} [options]
 */
export function listChangedFiles(options = {}) {
  const ctx = openRepo(options);
  const selected = selectInputFiles(ctx, options);
  const result = {
    ok: true,
    ...settingsView(ctx),
    detection: selected.detection,
    warning: selected.warning,
    files: classifySelected(selected.files),
    sourceFiles: separateSourceAndTestFiles(selected.files).sourceFiles,
    testFiles: separateSourceAndTestFiles(selected.files).testFiles
  };
  result.summary = summarizeList(result);
  return result;
}

/**
 * Test files the selected mode would run for the changed (or explicit) sources.
 * Does not run Jest and does not read lcov.
 * @param {object} [options]
 */
export function mapRelatedTests(options = {}) {
  const ctx = openRepo(options);
  const selected = selectInputFiles(ctx, options);
  const plan = resolvePlan(ctx, selected.files);
  return presentPlan(ctx, selected, plan);
}

/**
 * Builds the argument array for a captured (non-interactive) Jest run.
 * Always disables watch mode. Adds `--runInBand` unless the caller already
 * chose a worker strategy, because Jest rejects `--runInBand` together with
 * `--maxWorkers` ("only one is allowed").
 * @param {string[]} [jestArgs]
 * @returns {string[]}
 */
export function buildCapturedJestArgs(jestArgs = []) {
  const callerSetsWorkers = jestArgs.some(arg =>
    arg === '--runInBand' ||
    arg === '-i' ||
    arg === '--maxWorkers' ||
    arg === '-w' ||
    arg.startsWith('--maxWorkers=') ||
    arg.startsWith('-w=')
  );

  return [
    ...jestArgs,
    '--watchAll=false',
    ...(callerSetsWorkers ? [] : ['--runInBand'])
  ];
}

function runJestCaptured(ctx, jestArgs) {
  const jestBin = resolveJestBin(ctx.root);
  if (!fs.existsSync(jestBin)) {
    throw new Mo3taError(
      `Jest is not installed in ${ctx.root} (expected ${jestBin}).`,
      'JEST_NOT_FOUND',
      'Install dependencies in that repo so node_modules/jest/bin/jest.js exists. mo3ta-coverage runs the local Jest binary and does not download Jest.'
    );
  }

  // --watchAll=false keeps a non-interactive server from sitting in watch mode.
  // --runInBand keeps Jest in one process so a timeout can actually stop it,
  // but it is dropped when the caller picked a worker strategy (they conflict).
  const args = buildCapturedJestArgs(jestArgs);
  try {
    const stdout = execFileSync(process.execPath, [jestBin, ...args], {
      cwd: ctx.root,
      timeout: ctx.timeoutMs,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: JEST_MAX_BUFFER,
      env: { ...process.env, FORCE_COLOR: '0' }
    });
    return {
      ran: true,
      testsFailed: false,
      timedOut: false,
      ...clipOutput(stdout)
    };
  } catch (error) {
    if (error.code === 'ETIMEDOUT') {
      throw new Mo3taError(
        `Jest exceeded ${ctx.timeoutMs}ms and was stopped.`,
        'JEST_TIMEOUT',
        'Raise timeoutMs (milliseconds, up to 30 minutes), use mode "fast", or pass files so fewer tests run.'
      );
    }
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new Mo3taError(
        'Jest produced more than 20MB of output, which is more than the MCP server keeps.',
        'JEST_OUTPUT_TOO_LARGE',
        'Re-run with a narrower files list or mode "fast". coverage/lcov.info may still have been written.'
      );
    }
    const combined = `${error.stdout || ''}\n${error.stderr || ''}`;
    return {
      ran: true,
      testsFailed: true,
      timedOut: false,
      exitCode: typeof error.status === 'number' ? error.status : 1,
      ...clipOutput(combined)
    };
  }
}

function filesWithoutCoverageRun(ctx, plan, budget) {
  return plan.sourceFiles.map(file => {
    const changedLines = diffLines(file, ctx.base, ctx.root);
    const snippets = takeSnippets(ctx.root, file, changedLines, budget);
    return {
      file,
      absolutePath: path.resolve(ctx.root, file),
      changedLines: capList(changedLines),
      changedLinesTruncated: changedLines.length > MAX_LINES_RETURNED,
      hasCoverageInfo: false,
      changedCoverableLines: 0,
      coveredCount: 0,
      uncoveredCount: 0,
      coverage: null,
      uncoveredLines: [],
      uncovered: snippets.snippets,
      uncoveredTruncated: snippets.truncated,
      note: 'No related test was run. These are changed lines from the git diff, not uncovered-line verdicts.'
    };
  });
}

/**
 * Runs the changed-line coverage check and returns per-file uncovered lines.
 * `runTests: false` only reads an existing lcov file. Jest writes `coverage/`
 * inside the repo when tests run, same as the CLI.
 * @param {object} [options]
 */
export function checkChangedLineCoverage(options = {}) {
  const ctx = openRepo(options);
  const selected = selectInputFiles(ctx, options);
  const warnings = selected.warning ? [selected.warning] : [];

  if (selected.files.length === 0) {
    const result = {
      ok: true,
      ...settingsView(ctx),
      requestedEngine: ctx.engine,
      fallbackUsed: false,
      runTests: ctx.runTests,
      detection: selected.detection,
      noChangedFiles: true,
      testsFailed: false,
      testsNotRunReason: 'no-files',
      coveragePassed: true,
      cliWouldExit: 0,
      warnings,
      metrics: null,
      projects: null,
      jestVersion: null,
      explanation: null,
      files: [],
      totals: { changed: 0, covered: 0, uncovered: 0, coverage: null },
      jest: { ran: false, testsFailed: false, outputTail: '', outputTruncated: false }
    };
    result.summary = summarizeCheck(result);
    return result;
  }

  const plan = resolvePlan(ctx, selected.files);
  const mergedWarnings = [...warnings, ...(plan.warnings || [])];
  const nothingToRun = plan.delegatedToJest
    ? plan.jestTargets.length === 0
    : plan.testsToRun.length === 0;

  if (ctx.runTests && nothingToRun) {
    const budget = { remaining: MAX_SNIPPETS_TOTAL };
    const result = {
      ok: false,
      ...settingsView(ctx),
      engine: plan.engine ?? ctx.engine,
      requestedEngine: plan.requestedEngine ?? ctx.engine,
      fallbackUsed: Boolean(plan.fallbackUsed),
      runTests: true,
      detection: selected.detection,
      noChangedFiles: false,
      testsFailed: false,
      testsNotRunReason: 'no-tests',
      coveragePassed: null,
      cliWouldExit: 0,
      warnings: [
        ...mergedWarnings,
        'No test files were selected, so Jest did not run. The CLI exits 0 in this case and never measures coverage. Add a test that imports the changed file.' +
        (plan.filter ? ` All candidate test files were dropped by the filter /${plan.filter}/.` : '')
      ],
      mappings: plan.mappings.map(mapping => ({
        source: mapping.source,
        matchType: mapping.matchType,
        tests: mapping.tests
      })),
      testsToRun: plan.testsToRun,
      allTestsToRun: plan.allTestsToRun,
      metrics: plan.metrics ?? null,
      projects: plan.projects ?? null,
      jestVersion: plan.jestVersion ?? null,
      explanation: plan.explanation ?? null,
      files: filesWithoutCoverageRun(ctx, plan, budget),
      totals: { changed: 0, covered: 0, uncovered: 0, coverage: null },
      jest: { ran: false, testsFailed: false, outputTail: '', outputTruncated: false }
    };
    result.summary = summarizeCheck(result);
    return result;
  }

  let jest = { ran: false, testsFailed: false, outputTail: '', outputTruncated: false };
  if (ctx.runTests) {
    jest = runJestCaptured(ctx, plan.jestArgs);
  }

  let index;
  try {
    index = loadCoverageIndex(selected.files, ctx.lcov, ctx.root);
  } catch (error) {
    if (error.code === 'LCOV_NOT_FOUND') {
      throw new Mo3taError(
        `No lcov report at ${error.lcovPath}.`,
        'LCOV_NOT_FOUND',
        jest.testsFailed
          ? 'Jest failed before writing coverage. The tail of its output is in jest.outputTail. Fix the failure and run the check again.'
          : 'Call the tool with runTests: true so Jest writes coverage/lcov.info, or pass lcov set to an existing report.',
        { jest }
      );
    }
    throw error;
  }

  const budget = { remaining: MAX_SNIPPETS_TOTAL };
  const analyzed = [];
  index.relevantFiles.forEach(relPath => {
    analyzed.push(analyzeChangedFile(relPath, index.coverageByFile, ctx.base, ctx.root));
  });
  const totals = summarizeChangedLineResults(analyzed, ctx.limit);
  const files = analyzed.map(result => presentAnalyzedFile(result, ctx, budget));

  if (ctx.ciReport) {
    const reportPath = path.resolve(ctx.root, ctx.ciReport);
    const markdown = buildMarkdownCoverageReport(totals.rows, {
      overallCoverage: totals.overallCoverage === null ? null : totals.overallCoverage.toFixed(2),
      changedLinesLimit: ctx.limit,
      totalChanged: totals.totalChanged,
      totalNotCovered: totals.totalNotCovered
    });
    writeMarkdownReport(markdown, reportPath);
  }

  const coveragePassed = totals.passed;
  const cliWouldExit = (jest.testsFailed || !coveragePassed) ? 1 : 0;
  const result = {
    ok: coveragePassed && !jest.testsFailed,
    ...settingsView(ctx),
    engine: plan.engine ?? ctx.engine,
    requestedEngine: plan.requestedEngine ?? ctx.engine,
    fallbackUsed: Boolean(plan.fallbackUsed),
    runTests: ctx.runTests,
    detection: selected.detection,
    noChangedFiles: false,
    testsFailed: jest.testsFailed,
    testsNotRunReason: ctx.runTests ? null : 'runTests-false',
    coveragePassed,
    cliWouldExit,
    warnings: mergedWarnings,
    ciReport: ctx.ciReport ? path.resolve(ctx.root, ctx.ciReport) : null,
    filter: plan.filter,
    mappings: plan.mappings.map(mapping => ({
      source: mapping.source,
      matchType: mapping.matchType,
      tests: mapping.tests
    })),
    testsToRun: plan.testsToRun,
    allTestsToRun: plan.allTestsToRun,
    metrics: plan.metrics ?? null,
    projects: plan.projects ?? null,
    jestVersion: plan.jestVersion ?? null,
    explanation: plan.explanation ?? null,
    files,
    totals: {
      changed: totals.totalChanged,
      covered: totals.totalChanged - totals.totalNotCovered,
      uncovered: totals.totalNotCovered,
      coverage: round2(totals.overallCoverage)
    },
    jest
  };
  result.summary = summarizeCheck(result);
  return result;
}
