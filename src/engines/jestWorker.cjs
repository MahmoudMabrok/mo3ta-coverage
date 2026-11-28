'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { createCodedError, loadJestPackages } = require('./jestLoader.cjs');

function toPosix(filePath) {
  return String(filePath).replace(/\\/g, '/');
}

function toRepoRel(realRoot, targetPath) {
  const rel = path.relative(realRoot, targetPath);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    return toPosix(rel) || '.';
  }
  return toPosix(targetPath);
}

function getProjectName(cfg) {
  if (!cfg || !cfg.displayName) return null;
  if (typeof cfg.displayName === 'string') {
    return cfg.displayName || null;
  }
  if (typeof cfg.displayName === 'object' && typeof cfg.displayName.name === 'string') {
    return cfg.displayName.name || null;
  }
  return null;
}

function normalizeMaxDepth(rawDepth) {
  if (rawDepth === null || rawDepth === undefined || rawDepth === Infinity || rawDepth === 'Infinity') {
    return Infinity;
  }
  const parsed = Number(rawDepth);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    throw createCodedError(
      `Invalid maxDepth: ${rawDepth}. Expected a non-negative integer or Infinity.`,
      'JEST_DISCOVERY_FAILED',
      'Pass a valid depth (e.g. 1-10 or Infinity).'
    );
  }
  return parsed;
}

function hasWatchmanFlag(args) {
  return args.some(arg =>
    arg === '--watchman' ||
    arg === '--no-watchman' ||
    arg.startsWith('--watchman=')
  );
}

/**
 * Invokes `jest-cli`'s `buildArgv` while preventing `yargs` from exiting the
 * worker process or writing raw output to stdout/stderr on invalid flags.
 */
async function buildJestArgvSafely(buildArgv, rawArgs) {
  const origExit = process.exit;
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origConsoleError = console.error;
  const origConsoleWarn = console.warn;
  const origConsoleLog = console.log;

  const captured = [];
  const capture = (...args) => {
    captured.push(args.map(a => String(a)).join(' '));
  };

  process.exit = (code) => {
    const detail = captured.join('\n').trim();
    throw new Error(detail || `Jest CLI argument parsing exited with code ${code}.`);
  };
  process.stderr.write = (chunk, encoding, cb) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString(encoding || 'utf8'));
    if (typeof encoding === 'function') encoding();
    else if (typeof cb === 'function') cb();
    return true;
  };
  process.stdout.write = (chunk, encoding, cb) => {
    if (typeof encoding === 'function') encoding();
    else if (typeof cb === 'function') cb();
    return true;
  };
  console.error = capture;
  console.warn = capture;
  console.log = () => {};

  try {
    return await buildArgv(rawArgs);
  } catch (err) {
    const detail = captured.join('\n').trim() || err.message || String(err);
    throw createCodedError(
      `Invalid Jest configuration or CLI flags: ${detail}`,
      'JEST_CONFIG_ERROR',
      'Check the Jest config and --jest flags passed to mo3ta-coverage.'
    );
  } finally {
    process.exit = origExit;
    process.stderr.write = origStderrWrite;
    process.stdout.write = origStdoutWrite;
    console.error = origConsoleError;
    console.warn = origConsoleWarn;
    console.log = origConsoleLog;
  }
}

function selectProjectConfigs(configs, argv, warnings) {
  const selectProjects = Array.isArray(argv.selectProjects)
    ? argv.selectProjects
    : (argv.selectProjects ? [argv.selectProjects] : null);
  const ignoreProjects = Array.isArray(argv.ignoreProjects)
    ? argv.ignoreProjects
    : (argv.ignoreProjects ? [argv.ignoreProjects] : null);

  const availableNames = new Set(configs.map(getProjectName).filter(Boolean));

  if (selectProjects && selectProjects.length > 0) {
    for (const name of selectProjects) {
      if (!availableNames.has(name)) {
        warnings.push(`Requested Jest project "${name}" was not found in the Jest configuration.`);
      }
    }
  }

  if (ignoreProjects && ignoreProjects.length > 0) {
    for (const name of ignoreProjects) {
      if (!availableNames.has(name)) {
        warnings.push(`Ignored Jest project "${name}" was not found in the Jest configuration.`);
      }
    }
  }

  const selectedFn = selectProjects && selectProjects.length > 0
    ? name => Boolean(name && selectProjects.includes(name))
    : () => true;
  const notIgnoredFn = ignoreProjects && ignoreProjects.length > 0
    ? name => !(name && ignoreProjects.includes(name))
    : () => true;

  const selectedConfigs = configs.filter(cfg => {
    const name = getProjectName(cfg);
    return selectedFn(name) && notIgnoredFn(name);
  });

  if (selectedConfigs.length === 0) {
    throw createCodedError(
      'No Jest projects remained after applying --projects / --selectProjects / --ignoreProjects.',
      'JEST_CONFIG_ERROR',
      'Verify project displayName values in your Jest configuration and project selection flags.'
    );
  }

  return selectedConfigs;
}

function createSilentConsole(warnings) {
  const noop = () => {};
  return {
    log: noop,
    info: noop,
    debug: noop,
    warn: (...args) => {
      const msg = args.map(a => String(a)).join(' ').trim();
      if (msg) warnings.push(msg);
    },
    error: (...args) => {
      const msg = args.map(a => String(a)).join(' ').trim();
      if (msg) warnings.push(msg);
    }
  };
}

async function runDiscovery(request) {
  const totalStart = performance.now();
  const warnings = [];
  const root = path.resolve(request.root || process.cwd());

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw createCodedError(
      `Repository path does not exist or is not a directory: ${root}`,
      'JEST_DISCOVERY_FAILED',
      'Pass a valid repository root directory.'
    );
  }

  const realRoot = fs.realpathSync(root);
  process.chdir(realRoot);

  const maxDepth = normalizeMaxDepth(request.maxDepth);
  const discoveryWorkers = Number.isInteger(request.discoveryWorkers) && request.discoveryWorkers > 0
    ? request.discoveryWorkers
    : 2;
  const explain = Boolean(request.explain);
  const discoveryArgs = Array.isArray(request.discoveryArgs) ? [...request.discoveryArgs] : [];

  const jest = loadJestPackages(realRoot);
  const { buildReverseGraph, traverseReverseGraphWithPaths, reconstructPath } = await import('./reverseGraph.js');

  const configStart = performance.now();
  const argvInput = hasWatchmanFlag(discoveryArgs)
    ? discoveryArgs
    : [...discoveryArgs, '--watchman=false'];

  const argv = await buildJestArgvSafely(jest.buildArgv, argvInput);

  const projectPaths = Array.isArray(argv.projects) && argv.projects.length > 0
    ? argv.projects.map(p => path.resolve(realRoot, p))
    : [realRoot];

  let configsResult;
  try {
    configsResult = await jest.readConfigs(argv, projectPaths);
  } catch (err) {
    throw createCodedError(
      `Failed to read Jest configuration in ${root}: ${err.message || err}`,
      'JEST_CONFIG_ERROR',
      'Ensure jest.config.* or package.json "jest" configuration is valid and any --config path exists.'
    );
  }

  const rawConfigs = (configsResult && configsResult.configs) || [];
  if (rawConfigs.length === 0) {
    throw createCodedError(
      `No Jest project configurations found in ${root}.`,
      'JEST_CONFIG_ERROR',
      'Verify your Jest configuration or --projects/--config flags.'
    );
  }

  const selectedConfigs = selectProjectConfigs(rawConfigs, argv, warnings);
  const configMs = performance.now() - configStart;

  // Normalize requested input files
  const normalizedInputs = [];
  const seenInputs = new Set();
  for (const inputFile of request.files || []) {
    const abs = path.resolve(realRoot, String(inputFile));
    const existsOnDisk = fs.existsSync(abs);
    const realAbs = existsOnDisk ? fs.realpathSync(abs) : null;
    const rel = toRepoRel(realRoot, realAbs || abs);
    if (seenInputs.has(rel)) continue;
    seenInputs.add(rel);
    normalizedInputs.push({
      input: inputFile,
      rel,
      abs,
      realAbs,
      existsOnDisk
    });
  }

  // Per-source accumulator: sourceRel -> Map<testRel, { depth, path? }>
  const sourceMatches = new Map();
  for (const entry of normalizedInputs) {
    sourceMatches.set(entry.rel, new Map());
  }

  const seenInAnyProject = new Set();
  const projects = [];
  const projectMatchMap = new Map();
  const globalTestsSet = new Set();

  let hasteMapMs = 0;
  let resolveMs = 0;
  let graphMs = 0;
  let bfsMs = 0;
  let totalFileCount = 0;

  const silentConsole = createSilentConsole(warnings);

  for (let projectIdx = 0; projectIdx < selectedConfigs.length; projectIdx++) {
    const projectConfig = selectedConfigs[projectIdx];
    const projectName = getProjectName(projectConfig);
    const projectRootDir = toRepoRel(realRoot, projectConfig.rootDir || realRoot);

    const hasteStart = performance.now();
    const context = await jest.Runtime.createContext(projectConfig, {
      maxWorkers: discoveryWorkers,
      watchman: argv.watchman ?? false,
      watch: false,
      console: silentConsole
    });
    hasteMapMs += performance.now() - hasteStart;

    try {
      const snapshotResolver = await jest.buildSnapshotResolver(projectConfig);
      const resolver = new jest.DependencyResolver(context.resolver, context.hasteFS, snapshotResolver);
      const searchSource = new jest.SearchSource(context);

      const resolveStart = performance.now();
      const allProjectFiles = typeof context.hasteFS.getAbsoluteFileIterator === 'function'
        ? Array.from(context.hasteFS.getAbsoluteFileIterator())
        : context.hasteFS.getAllFiles();
      totalFileCount += allProjectFiles.length;

      const modules = allProjectFiles.map(file => ({
        file,
        dependencies: resolver.resolve(file, { skipNodeResolution: projectConfig.skipNodeResolution })
      }));
      resolveMs += performance.now() - resolveStart;

      const graphStart = performance.now();
      const graph = buildReverseGraph(modules);
      graphMs += performance.now() - graphStart;

      const projectMatchedTests = new Set();

      for (const entry of normalizedInputs) {
        let matchedAbs = null;
        if (entry.realAbs && context.hasteFS.exists(entry.realAbs)) {
          matchedAbs = entry.realAbs;
        } else if (context.hasteFS.exists(entry.abs)) {
          matchedAbs = entry.abs;
        }

        if (!matchedAbs) {
          continue;
        }

        seenInAnyProject.add(entry.rel);

        let targetAbs = matchedAbs;
        if (jest.isSnapshotPath(matchedAbs)) {
          const resolvedTest = snapshotResolver.resolveTestPath(matchedAbs);
          if (resolvedTest) {
            targetAbs = resolvedTest;
          }
        }

        const bfsStart = performance.now();
        const { distances, predecessors } = traverseReverseGraphWithPaths(graph, [targetAbs], maxDepth);
        bfsMs += performance.now() - bfsStart;

        const perSourceMap = sourceMatches.get(entry.rel);

        for (const [reachedAbs, depth] of distances) {
          if (!searchSource.isTestFilePath(reachedAbs)) {
            continue;
          }
          // For snapshot files resolved to a test file, verify the test exists in HasteFS or on disk
          if (reachedAbs === targetAbs && targetAbs !== matchedAbs && !context.hasteFS.exists(reachedAbs) && !fs.existsSync(reachedAbs)) {
            continue;
          }

          const testRel = toRepoRel(realRoot, reachedAbs);
          globalTestsSet.add(testRel);
          projectMatchedTests.add(testRel);

          const chain = explain
            ? reconstructPath(predecessors, reachedAbs).map(node => toRepoRel(realRoot, node))
            : undefined;

          const existingSource = perSourceMap.get(testRel);
          if (!existingSource || depth < existingSource.depth) {
            perSourceMap.set(testRel, { depth, path: chain });
          }

          const pmKey = `${projectIdx}::${entry.rel}::${testRel}`;
          const existingPm = projectMatchMap.get(pmKey);
          if (!existingPm || depth < existingPm.depth) {
            projectMatchMap.set(pmKey, {
              projectName,
              projectRootDir,
              source: entry.rel,
              test: testRel,
              depth,
              ...(explain ? { path: chain } : {})
            });
          }
        }
      }

      projects.push({
        name: projectName,
        rootDir: projectRootDir,
        fileCount: allProjectFiles.length,
        matchedTests: Array.from(projectMatchedTests).sort()
      });
    } finally {
      if (context && context.hasteMap && typeof context.hasteMap.end === 'function') {
        await context.hasteMap.end();
      }
    }
  }

  for (const entry of normalizedInputs) {
    if (!seenInAnyProject.has(entry.rel)) {
      if (!entry.existsOnDisk) {
        warnings.push(`Input file "${entry.rel}" does not exist on disk and was skipped by Jest discovery.`);
      } else {
        warnings.push(`Input file "${entry.rel}" was not found in Jest HasteFS (excluded by roots, modulePathIgnorePatterns, or haste configuration).`);
      }
    }
  }

  const bySource = {};
  for (const [sourceRel, testMap] of sourceMatches.entries()) {
    const tests = Array.from(testMap.keys()).sort();
    const distances = {};
    const paths = explain ? {} : undefined;
    for (const testRel of tests) {
      const info = testMap.get(testRel);
      distances[testRel] = info.depth;
      if (explain && info.path) {
        paths[testRel] = info.path;
      }
    }
    bySource[sourceRel] = {
      tests,
      distances,
      ...(explain ? { paths } : {})
    };
  }

  const totalMs = performance.now() - totalStart;
  const mem = process.memoryUsage();
  const resUsage = typeof process.resourceUsage === 'function' ? process.resourceUsage() : null;

  return {
    jestVersion: jest.version,
    projects,
    projectMatches: Array.from(projectMatchMap.values()),
    bySource,
    testsToRun: Array.from(globalTestsSet).sort(),
    warnings,
    metrics: {
      totalMs: Math.round(totalMs * 100) / 100,
      configMs: Math.round(configMs * 100) / 100,
      hasteMapMs: Math.round(hasteMapMs * 100) / 100,
      resolveMs: Math.round(resolveMs * 100) / 100,
      graphMs: Math.round(graphMs * 100) / 100,
      bfsMs: Math.round(bfsMs * 100) / 100,
      projectCount: selectedConfigs.length,
      fileCount: totalFileCount,
      rssBytes: mem.rss,
      maxRssKb: resUsage ? resUsage.maxRSS : null
    }
  };
}

async function main() {
  const [, , requestPath, responsePath] = process.argv;
  if (!requestPath || !responsePath) {
    process.exitCode = 1;
    return;
  }

  let payload;
  try {
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
    const result = await runDiscovery(request);
    payload = { ok: true, result };
  } catch (err) {
    payload = {
      ok: false,
      error: {
        code: err && err.code ? err.code : 'JEST_DISCOVERY_FAILED',
        message: (err && err.message) || String(err),
        hint: (err && err.hint) || null
      }
    };
  }

  fs.writeFileSync(responsePath, JSON.stringify(payload), 'utf8');
}

main();
