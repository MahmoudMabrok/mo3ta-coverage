import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { separateSourceAndTestFiles } from '../fileUtils.js';
import jestLoader from './jestLoader.cjs';

const { WORKER_PATH } = jestLoader;

export const INCOMPATIBLE_JEST_FLAGS = [
  '--findRelatedTests',
  '--watch',
  '--watchAll',
  '--listTests',
  '--showConfig',
  '--clearCache',
  '--init',
  '--help',
  '-h',
  '--version',
  '-v',
  '--runTestsByPath',
  '--onlyChanged',
  '-o',
  '--lastCommit',
  '--changedSince',
  '--changedFilesWithAncestor'
];

const INCOMPATIBLE_FLAG_SET = new Set(INCOMPATIBLE_JEST_FLAGS);

const DISCOVERY_BOOLEAN_FLAGS = new Set([
  '--watchman',
  '--no-watchman'
]);

const DISCOVERY_SINGLE_VALUE_FLAGS = new Set([
  '--config',
  '-c',
  '--rootDir',
  '--moduleNameMapper',
  '--haste',
  '--resolver'
]);

const DISCOVERY_MULTI_VALUE_FLAGS = new Set([
  '--projects',
  '--selectProjects',
  '--ignoreProjects',
  '--roots',
  '--testMatch',
  '--testRegex',
  '--testPathIgnorePatterns',
  '--testPathPatterns',
  '--testPathPattern',
  '--modulePathIgnorePatterns'
]);

function createEngineError(message, code, hint = null) {
  const err = new Error(message);
  err.code = code;
  err.hint = hint;
  return err;
}

function toPosix(filePath) {
  return String(filePath).replace(/\\/g, '/');
}

function normalizeInputPaths(files, root) {
  const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
  const result = [];
  const seen = new Set();

  for (const rawFile of files || []) {
    const file = String(rawFile ?? '').trim();
    if (!file) continue;
    const abs = path.resolve(realRoot, file);
    const realOrAbs = fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
    const rel = path.relative(realRoot, realOrAbs);
    const normalized = (!rel.startsWith('..') && !path.isAbsolute(rel))
      ? toPosix(rel)
      : toPosix(file);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return result;
}

function normalizeFilterRegex(filter, filterRegex) {
  const raw = filterRegex ?? filter ?? null;
  if (!raw) return null;
  if (raw instanceof RegExp) {
    return new RegExp(raw.source, raw.flags.replace(/[gy]/g, ''));
  }
  const pattern = String(raw).trim();
  return pattern ? new RegExp(pattern) : null;
}

function applyFilter(files, filterRegex) {
  if (!filterRegex) return [...files];
  return files.filter(file => filterRegex.test(file));
}

function hasProjectSelectionFlag(jestArgs = []) {
  return jestArgs.some(arg => {
    const flagName = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    return flagName === '--selectProjects' || flagName === '--ignoreProjects';
  });
}

/**
 * Validates that `jestArgs` do not contain flags incompatible with the Jest
 * discovery engine (such as watch mode, `--findRelatedTests`, or `--listTests`).
 *
 * @param {string[]} [jestArgs]
 */
export function validateJestEngineFlags(jestArgs = []) {
  for (const rawArg of jestArgs || []) {
    const arg = String(rawArg ?? '');
    if (!arg) continue;
    if (arg === '--watchAll=false') continue;

    const eqIdx = arg.indexOf('=');
    const flagName = eqIdx >= 0 ? arg.slice(0, eqIdx) : arg;

    if (INCOMPATIBLE_FLAG_SET.has(flagName)) {
      throw createEngineError(
        `Jest flag "${arg}" cannot be used with the "jest" discovery engine.`,
        'INVALID_JEST_FLAG_FOR_ENGINE',
        `Remove "${flagName}" when using engine "jest" (mo3ta-coverage supplies --runTestsByPath itself), or use --mode full / --engine native.`
      );
    }
  }
}

/**
 * Extracts Jest CLI flags that affect configuration, project selection, module
 * resolution, or test matching so the isolated discovery worker uses the same
 * project configuration as Jest execution.
 *
 * @param {string[]} [jestArgs]
 * @returns {string[]}
 */
export function extractDiscoveryJestArgs(jestArgs = []) {
  const args = Array.isArray(jestArgs) ? jestArgs : [];
  const extracted = [];

  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i] ?? '');
    if (!arg) continue;

    const eqIdx = arg.indexOf('=');
    const flagName = eqIdx >= 0 ? arg.slice(0, eqIdx) : arg;

    if (DISCOVERY_BOOLEAN_FLAGS.has(flagName)) {
      extracted.push(arg);
      continue;
    }

    if (DISCOVERY_SINGLE_VALUE_FLAGS.has(flagName)) {
      extracted.push(arg);
      if (eqIdx < 0 && i + 1 < args.length && !String(args[i + 1]).startsWith('-')) {
        extracted.push(String(args[++i]));
      }
      continue;
    }

    if (DISCOVERY_MULTI_VALUE_FLAGS.has(flagName)) {
      extracted.push(arg);
      if (eqIdx < 0) {
        while (i + 1 < args.length && !String(args[i + 1]).startsWith('-')) {
          extracted.push(String(args[++i]));
        }
      }
    }
  }

  return extracted;
}

/**
 * Spawns the isolated CommonJS Jest discovery worker (`jestWorker.cjs`) and
 * returns the structured discovery payload.
 *
 * @param {{
 *   root?: string,
 *   files?: string[],
 *   depth?: number | null,
 *   discoveryWorkers?: number,
 *   explain?: boolean,
 *   jestArgs?: string[],
 *   timeoutMs?: number
 * }} params
 */
export function runJestDiscovery({
  root = process.cwd(),
  files = [],
  depth = 2,
  discoveryWorkers = 2,
  explain = false,
  jestArgs = [],
  timeoutMs = 120000
} = {}) {
  validateJestEngineFlags(jestArgs);
  const discoveryArgs = extractDiscoveryJestArgs(jestArgs);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mo3ta-jest-discovery-'));
  try {
    fs.chmodSync(tmpDir, 0o700);
    const reqPath = path.join(tmpDir, 'request.json');
    const resPath = path.join(tmpDir, 'response.json');

    const requestPayload = {
      root: path.resolve(root),
      files,
      maxDepth: depth === Infinity ? 'Infinity' : depth,
      discoveryWorkers,
      explain: Boolean(explain),
      discoveryArgs
    };

    fs.writeFileSync(reqPath, JSON.stringify(requestPayload), 'utf8');

    let spawnError = null;
    try {
      execFileSync(process.execPath, [WORKER_PATH, reqPath, resPath], {
        cwd: root,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
      });
    } catch (err) {
      spawnError = err;
      if (err && err.code === 'ETIMEDOUT') {
        throw createEngineError(
          `Jest dependency discovery timed out after ${timeoutMs}ms.`,
          'JEST_DISCOVERY_TIMEOUT',
          'Increase discoveryTimeoutMs, reduce depth, or run with --engine native.'
        );
      }
    }

    if (!fs.existsSync(resPath)) {
      const stderr = spawnError && spawnError.stderr ? String(spawnError.stderr).trim() : '';
      const msg = stderr || (spawnError && spawnError.message) || 'Jest discovery worker exited without writing a response.';
      throw createEngineError(
        `Jest discovery failed: ${msg}`,
        'JEST_DISCOVERY_FAILED',
        'Check Jest configuration and dependencies in the target repo, or fall back to --engine native.'
      );
    }

    let response;
    try {
      response = JSON.parse(fs.readFileSync(resPath, 'utf8'));
    } catch (parseErr) {
      throw createEngineError(
        `Jest discovery worker returned malformed JSON: ${parseErr.message}`,
        'JEST_DISCOVERY_FAILED',
        'Run with --engine native or inspect Jest configuration for unexpected stdout output.'
      );
    }

    if (!response || response.ok !== true) {
      const errInfo = (response && response.error) || {};
      throw createEngineError(
        errInfo.message || 'Jest discovery failed.',
        errInfo.code || 'JEST_DISCOVERY_FAILED',
        errInfo.hint || 'Check Jest installation and configuration, or run with --engine native.'
      );
    }

    return response.result;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Resolves a test execution plan using Jest's own configuration, HasteFS,
 * DependencyResolver, and SearchSource in an isolated worker process.
 *
 * @param {{
 *   files?: string[],
 *   mode?: string,
 *   depth?: number | null,
 *   root?: string,
 *   jestArgs?: string[],
 *   extraJestArgs?: string[],
 *   filter?: string | RegExp | null,
 *   filterRegex?: RegExp | null,
 *   discoveryWorkers?: number,
 *   explain?: boolean,
 *   discoveryTimeoutMs?: number
 * }} params
 */
export function resolveJestPlan({
  files = [],
  mode = 'smart',
  depth = 2,
  root = process.cwd(),
  jestArgs = [],
  extraJestArgs,
  filter = null,
  filterRegex = null,
  discoveryWorkers = 2,
  explain = false,
  discoveryTimeoutMs = 120000
} = {}) {
  const effectiveArgs = Array.isArray(extraJestArgs) ? extraJestArgs : (Array.isArray(jestArgs) ? jestArgs : []);
  const activeFilter = normalizeFilterRegex(filter, filterRegex);
  const normalizedFiles = normalizeInputPaths(files, root);

  const discovery = runJestDiscovery({
    root,
    files: normalizedFiles,
    depth,
    discoveryWorkers,
    explain,
    jestArgs: effectiveArgs,
    timeoutMs: discoveryTimeoutMs
  });

  const warnings = [...(discovery.warnings || [])];
  const bySource = discovery.bySource || {};
  const nativeSplit = separateSourceAndTestFiles(normalizedFiles);
  const nativeSourceSet = new Set(nativeSplit.sourceFiles);
  const nativeTestSet = new Set(nativeSplit.testFiles);

  const sourceFiles = [];
  const testFiles = [];
  const allTestsSet = new Set();

  for (const file of normalizedFiles) {
    const entry = bySource[file];
    const isJestDepth0Test = Boolean(entry && entry.distances && entry.distances[file] === 0);

    if (isJestDepth0Test) {
      testFiles.push(file);
      allTestsSet.add(file);
    } else if (nativeTestSet.has(file)) {
      testFiles.push(file);
      allTestsSet.add(file);
    } else if (nativeSourceSet.has(file)) {
      sourceFiles.push(file);
    }
  }

  // Also ensure any extra non-source inputs (such as snapshot files) that matched tests contribute them
  const mappingInputs = [...sourceFiles];
  for (const file of normalizedFiles) {
    if (!sourceFiles.includes(file) && !testFiles.includes(file)) {
      const entry = bySource[file];
      if (entry && Array.isArray(entry.tests) && entry.tests.length > 0) {
        mappingInputs.push(file);
      }
    }
  }

  const matchType = depth === Infinity
    ? 'jest haste graph (unbounded)'
    : `jest haste graph, depth ≤ ${depth}`;

  const mappings = mappingInputs.map(source => {
    const entry = bySource[source] || { tests: [], distances: {}, paths: {} };
    const relatedTests = Array.isArray(entry.tests) ? entry.tests : [];
    const filteredTests = applyFilter(relatedTests, activeFilter);
    relatedTests.forEach(t => allTestsSet.add(t));

    const details = relatedTests.map(test => ({
      test,
      depth: entry.distances && entry.distances[test] !== undefined ? entry.distances[test] : null,
      ...(explain && entry.paths && entry.paths[test] ? { path: entry.paths[test] } : {})
    }));

    return {
      source,
      tests: filteredTests,
      allTests: [...relatedTests],
      matchType,
      details
    };
  });

  for (const test of discovery.testsToRun || []) {
    allTestsSet.add(test);
  }

  const allTestsToRun = Array.from(allTestsSet).sort();
  const testsToRun = applyFilter(allTestsToRun, activeFilter);

  const projects = Array.isArray(discovery.projects) ? discovery.projects : [];
  const projectMatches = Array.isArray(discovery.projectMatches) ? discovery.projectMatches : [];

  let executionJestArgs = [];
  if (testsToRun.length > 0) {
    const projectNarrowingFlags = [];
    if (projects.length > 1 && !hasProjectSelectionFlag(effectiveArgs)) {
      const testsToRunSet = new Set(testsToRun);
      const activeProjects = projects.filter(project =>
        Array.isArray(project.matchedTests) && project.matchedTests.some(t => testsToRunSet.has(t))
      );

      if (activeProjects.length > 0 && activeProjects.length < projects.length) {
        if (activeProjects.every(p => typeof p.name === 'string' && p.name.length > 0)) {
          projectNarrowingFlags.push('--selectProjects', ...activeProjects.map(p => p.name));
        } else {
          warnings.push(
            'Multiple Jest projects are configured, and one or more active projects lack a displayName; running Jest across all configured projects.'
          );
        }
      }
    }

    executionJestArgs = [
      '--passWithNoTests',
      '--coverage',
      '--runTestsByPath',
      ...testsToRun,
      ...projectNarrowingFlags,
      ...effectiveArgs
    ];
  }

  let explanation = null;
  if (explain) {
    const testsToRunSet = new Set(testsToRun);
    explanation = projectMatches
      .filter(match => testsToRunSet.has(match.test))
      .map(match => ({
        source: match.source,
        test: match.test,
        depth: match.depth,
        path: match.path || [],
        projectName: match.projectName ?? null
      }));
  }

  return {
    mode,
    depth,
    filter: activeFilter ? activeFilter.source : null,
    sourceFiles,
    testFiles,
    mappings,
    allTestsToRun,
    testsToRun,
    jestTargets: testsToRun,
    jestArgs: executionJestArgs,
    delegatedToJest: false,
    engine: 'jest',
    requestedEngine: 'jest',
    fallbackUsed: false,
    warnings,
    metrics: discovery.metrics || null,
    projects,
    projectMatches,
    explanation,
    jestVersion: discovery.jestVersion || null
  };
}
