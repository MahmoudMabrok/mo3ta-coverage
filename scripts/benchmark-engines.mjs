#!/usr/bin/env node

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { performance } from 'perf_hooks';
import { fileURLToPath } from 'url';
import { resolveNativePlan } from '../src/engines/nativeEngine.js';
import { resolveJestPlan } from '../src/engines/jestEngine.js';
import { clearScanCaches } from '../src/fileUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

function parseCliArgs(argv) {
  const opts = {
    quick: false,
    modules: null,
    iterations: null,
    discoveryWorkers: 2
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--quick') {
      opts.quick = true;
    } else if (arg === '--modules' && argv[i + 1]) {
      opts.modules = Number.parseInt(argv[++i], 10);
    } else if (arg === '--iterations' && argv[i + 1]) {
      opts.iterations = Number.parseInt(argv[++i], 10);
    } else if (arg === '--discoveryWorkers' && argv[i + 1]) {
      opts.discoveryWorkers = Number.parseInt(argv[++i], 10);
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/benchmark-engines.mjs [--quick] [--modules N] [--iterations N] [--discoveryWorkers N]`);
      process.exit(0);
    }
  }

  const moduleCount = Number.isInteger(opts.modules) && opts.modules > 10
    ? opts.modules
    : (opts.quick ? 60 : 150);
  const iterations = Number.isInteger(opts.iterations) && opts.iterations > 0
    ? opts.iterations
    : (opts.quick ? 2 : 3);
  const discoveryWorkers = Number.isInteger(opts.discoveryWorkers) && opts.discoveryWorkers > 0
    ? opts.discoveryWorkers
    : 2;

  return { quick: opts.quick, moduleCount, iterations, discoveryWorkers };
}

function median(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function round2(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  return Math.round(n * 100) / 100;
}

function formatNum(n, suffix = '') {
  if (n === null || n === undefined) return 'n/a';
  return `${round2(n)}${suffix}`;
}

function writeFile(root, relPath, content) {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

function linkNodeModules(fixtureRoot) {
  const srcModules = path.join(REPO_ROOT, 'node_modules');
  const destModules = path.join(fixtureRoot, 'node_modules');
  if (!fs.existsSync(srcModules)) {
    throw new Error(`node_modules not found at ${srcModules}. Run npm install first.`);
  }
  fs.mkdirSync(destModules, { recursive: true });

  for (const entry of fs.readdirSync(srcModules)) {
    const src = path.join(srcModules, entry);
    const dest = path.join(destModules, entry);
    if (entry === 'jest') {
      // Copy the small `jest` wrapper package so realpath(jest/package.json) stays
      // inside the fixture and satisfies jestLoader's PACKAGE_ROOT leak guard.
      fs.cpSync(src, dest, { recursive: true });
    } else {
      fs.symlinkSync(src, dest, 'dir');
    }
  }
}

/**
 * Generates a realistic multi-package monorepo fixture with barrel re-exports,
 * tsconfig/moduleNameMapper aliases, multi-hop chains (depths 1-4), and tests.
 */
function createMonorepoFixture(moduleCount) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mo3ta-bench-'));
  linkNodeModules(tmpRoot);

  const cacheDir = path.join(tmpRoot, '.jest-cache');
  const coreCount = Math.max(12, Math.floor(moduleCount * 0.5));
  const appCount = Math.max(12, moduleCount - coreCount);

  writeFile(tmpRoot, 'package.json', JSON.stringify({
    name: 'bench-monorepo',
    private: true,
    workspaces: ['packages/*']
  }, null, 2));

  writeFile(tmpRoot, 'tsconfig.json', JSON.stringify({
    compilerOptions: {
      baseUrl: '.',
      paths: {
        '@bench/core': ['packages/core/src/index.js'],
        '@bench/core/*': ['packages/core/src/*'],
        '@bench/app/*': ['packages/app/src/*']
      }
    }
  }, null, 2));

  writeFile(tmpRoot, 'jest.config.cjs', `const path = require('path');
module.exports = {
  testEnvironment: 'node',
  cacheDirectory: ${JSON.stringify(cacheDir)},
  transform: {},
  testMatch: ['**/*.test.js'],
  moduleNameMapper: {
    '^@bench/core$': path.join(__dirname, 'packages/core/src/index.js'),
    '^@bench/core/(.*)$': path.join(__dirname, 'packages/core/src/$1'),
    '^@bench/app/(.*)$': path.join(__dirname, 'packages/app/src/$1')
  }
};
`);

  writeFile(tmpRoot, 'packages/core/package.json', JSON.stringify({
    name: '@bench/core',
    version: '1.0.0',
    main: 'src/index.js'
  }, null, 2));

  writeFile(tmpRoot, 'packages/app/package.json', JSON.stringify({
    name: '@bench/app',
    version: '1.0.0',
    main: 'src/index.js'
  }, null, 2));

  // Changed target file and multi-hop test chain (depths 1, 2, 3, and 4)
  writeFile(tmpRoot, 'packages/core/src/target.js', `function compute(x) { return x * 2 + 1; }\nmodule.exports = { compute };\n`);

  // Depth 1: direct import
  writeFile(tmpRoot, 'packages/core/src/target.test.js', `const { compute } = require('./target');\ntest('compute', () => expect(compute(2)).toBe(5));\n`);

  // Core filler modules + barrel exports
  const coreRequires = [`const target = require('./target');`];
  const coreSpread = [`  ...target`];
  for (let i = 0; i < coreCount; i++) {
    const dep = i > 0 ? `const prev = require('./mod${i - 1}');\n` : '';
    writeFile(tmpRoot, `packages/core/src/mod${i}.js`, `${dep}module.exports = { mod${i}: (v) => v + ${i} };\n`);
    if (i < 10) {
      coreRequires.push(`const mod${i} = require('./mod${i}');`);
      coreSpread.push(`  ...mod${i}`);
    }
    if (i % 4 === 0) {
      writeFile(tmpRoot, `packages/core/src/mod${i}.test.js`, `const m = require('./mod${i}');\ntest('mod${i}', () => expect(typeof m.mod${i}).toBe('function'));\n`);
    }
  }

  writeFile(tmpRoot, 'packages/core/src/index.js', `${coreRequires.join('\n')}\nmodule.exports = {\n${coreSpread.join(',\n')}\n};\n`);

  // Depth 2 (via local barrel)
  writeFile(tmpRoot, 'packages/core/src/barrel.test.js', `const { compute } = require('./index');\ntest('barrel compute', () => expect(compute(3)).toBe(7));\n`);

  // Depth 2 (via monorepo alias to barrel)
  writeFile(tmpRoot, 'packages/app/src/aliasDirect.test.js', `const { compute } = require('@bench/core');\ntest('alias direct', () => expect(compute(4)).toBe(9));\n`);

  // Depth 3: app/service -> @bench/core -> core/target
  writeFile(tmpRoot, 'packages/app/src/service.js', `const { compute } = require('@bench/core');\nmodule.exports = { runService: (n) => compute(n) + 10 };\n`);
  writeFile(tmpRoot, 'packages/app/src/service.test.js', `const { runService } = require('@bench/app/service');\ntest('service', () => expect(runService(2)).toBe(15));\n`);

  // Depth 4: app/controller -> app/service -> @bench/core -> core/target
  writeFile(tmpRoot, 'packages/app/src/controller.js', `const { runService } = require('./service');\nmodule.exports = { handle: (n) => runService(n) };\n`);
  writeFile(tmpRoot, 'packages/app/src/controller.test.js', `const { handle } = require('./controller');\ntest('controller', () => expect(handle(2)).toBe(15));\n`);

  // App filler modules
  for (let i = 0; i < appCount; i++) {
    const coreIdx = i % coreCount;
    const prevImport = i > 0 ? `const prev = require('./feature${i - 1}');\n` : '';
    writeFile(
      tmpRoot,
      `packages/app/src/feature${i}.js`,
      `const coreMod = require('@bench/core/mod${coreIdx}');\n${prevImport}module.exports = { feature${i}: (v) => coreMod.mod${coreIdx}(v) };\n`
    );
    if (i % 4 === 0) {
      writeFile(
        tmpRoot,
        `packages/app/src/feature${i}.test.js`,
        `const f = require('@bench/app/feature${i}');\ntest('feature${i}', () => expect(typeof f.feature${i}).toBe('function'));\n`
      );
    }
  }

  writeFile(tmpRoot, 'packages/app/src/index.js', `module.exports = { service: require('./service'), controller: require('./controller') };\n`);

  return {
    root: tmpRoot,
    cacheDir,
    changedFile: 'packages/core/src/target.js',
    totalFiles: coreCount + appCount + 12
  };
}

function clearJestCache(cacheDir) {
  fs.rmSync(cacheDir, { recursive: true, force: true });
}

function runNativeBenchmark(fixture, depth, iterations, { cold }) {
  const durations = [];
  let selectedCount = 0;

  for (let i = 0; i < iterations; i++) {
    if (cold || i === 0) {
      clearScanCaches();
    }
    const start = performance.now();
    const plan = resolveNativePlan({
      files: [fixture.changedFile],
      mode: 'smart',
      depth,
      root: fixture.root
    });
    durations.push(performance.now() - start);
    selectedCount = plan.testsToRun.length;
  }

  return {
    medianMs: median(durations),
    selectedCount,
    metrics: null
  };
}

function runJestEngineBenchmark(fixture, depth, iterations, discoveryWorkers, { cold }) {
  const totals = [];
  const configs = [];
  const hastes = [];
  const resolves = [];
  const graphs = [];
  const bfss = [];
  const rssKbs = [];
  let selectedCount = 0;

  if (!cold) {
    // Prime HasteMap cache once before warm samples
    clearJestCache(fixture.cacheDir);
    resolveJestPlan({
      files: [fixture.changedFile],
      mode: 'smart',
      depth,
      root: fixture.root,
      discoveryWorkers
    });
  }

  for (let i = 0; i < iterations; i++) {
    if (cold) {
      clearJestCache(fixture.cacheDir);
    }
    const start = performance.now();
    const plan = resolveJestPlan({
      files: [fixture.changedFile],
      mode: 'smart',
      depth,
      root: fixture.root,
      discoveryWorkers
    });
    const elapsed = performance.now() - start;
    totals.push(elapsed);
    selectedCount = plan.testsToRun.length;

    if (plan.metrics) {
      configs.push(plan.metrics.configMs);
      hastes.push(plan.metrics.hasteMapMs);
      resolves.push(plan.metrics.resolveMs);
      graphs.push(plan.metrics.graphMs);
      bfss.push(plan.metrics.bfsMs);
      if (plan.metrics.maxRssKb !== null && plan.metrics.maxRssKb !== undefined) {
        rssKbs.push(plan.metrics.maxRssKb);
      }
    }
  }

  return {
    medianMs: median(totals),
    selectedCount,
    metrics: {
      totalMs: median(totals),
      configMs: median(configs),
      hasteMapMs: median(hastes),
      resolveMs: median(resolves),
      graphMs: median(graphs),
      bfsMs: median(bfss),
      maxRssKb: median(rssKbs)
    }
  };
}

function runJestCliFindRelatedBenchmark(fixture, iterations, { cold }) {
  const jestBin = path.join(fixture.root, 'node_modules', 'jest', 'bin', 'jest.js');
  const durations = [];
  let selectedCount = 0;

  if (!cold) {
    clearJestCache(fixture.cacheDir);
    execFileSync(process.execPath, [
      jestBin,
      '--findRelatedTests',
      fixture.changedFile,
      '--listTests',
      '--json',
      '--watchman=false'
    ], {
      cwd: fixture.root,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8'
    });
  }

  for (let i = 0; i < iterations; i++) {
    if (cold) {
      clearJestCache(fixture.cacheDir);
    }
    const start = performance.now();
    const stdout = execFileSync(process.execPath, [
      jestBin,
      '--findRelatedTests',
      fixture.changedFile,
      '--listTests',
      '--json',
      '--watchman=false'
    ], {
      cwd: fixture.root,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8'
    });
    durations.push(performance.now() - start);
    const parsed = JSON.parse(stdout.trim());
    selectedCount = Array.isArray(parsed) ? parsed.length : 0;
  }

  return {
    medianMs: median(durations),
    selectedCount,
    metrics: null
  };
}

function printSummaryTable(rows) {
  const headers = [
    'Benchmark',
    'Temp',
    'Depth',
    'Median (ms)',
    'Tests',
    'configMs',
    'hasteMs',
    'resolveMs',
    'graphMs',
    'bfsMs',
    'maxRssKb'
  ];

  const strRows = rows.map(r => [
    r.label,
    r.temp,
    String(r.depth),
    formatNum(r.medianMs),
    String(r.selectedCount),
    formatNum(r.metrics?.configMs),
    formatNum(r.metrics?.hasteMapMs),
    formatNum(r.metrics?.resolveMs),
    formatNum(r.metrics?.graphMs),
    formatNum(r.metrics?.bfsMs),
    r.metrics?.maxRssKb !== null && r.metrics?.maxRssKb !== undefined ? String(Math.round(r.metrics.maxRssKb)) : 'n/a'
  ]);

  const widths = headers.map((h, idx) =>
    Math.max(h.length, ...strRows.map(row => row[idx].length))
  );

  const fmtLine = cols => cols.map((c, idx) => idx <= 1 ? c.padEnd(widths[idx]) : c.padStart(widths[idx])).join(' | ');
  const sep = widths.map(w => '-'.repeat(w)).join('-+-');

  console.log(fmtLine(headers));
  console.log(sep);
  for (const row of strRows) {
    console.log(fmtLine(row));
  }
}

function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  const fixture = createMonorepoFixture(opts.moduleCount);

  try {
    console.log(
      `Benchmarking mo3ta-coverage discovery engines (${opts.quick ? 'quick' : 'standard'}: ` +
      `${opts.moduleCount} modules across 2 packages, ${opts.iterations} iteration(s), discoveryWorkers=${opts.discoveryWorkers})`
    );
    console.log(`Fixture: ${fixture.root} (${fixture.totalFiles} files)\n`);

    const rows = [];

    for (const depth of [1, 2]) {
      rows.push({
        label: 'native',
        temp: 'cold',
        depth,
        ...runNativeBenchmark(fixture, depth, opts.iterations, { cold: true })
      });
      rows.push({
        label: 'native',
        temp: 'warm',
        depth,
        ...runNativeBenchmark(fixture, depth, opts.iterations, { cold: false })
      });
    }

    for (const depth of [1, 2, 3]) {
      rows.push({
        label: 'jest-engine',
        temp: 'cold',
        depth,
        ...runJestEngineBenchmark(fixture, depth, opts.iterations, opts.discoveryWorkers, { cold: true })
      });
      rows.push({
        label: 'jest-engine',
        temp: 'warm',
        depth,
        ...runJestEngineBenchmark(fixture, depth, opts.iterations, opts.discoveryWorkers, { cold: false })
      });
    }

    rows.push({
      label: 'jest --findRelatedTests',
      temp: 'cold',
      depth: '∞',
      ...runJestCliFindRelatedBenchmark(fixture, opts.iterations, { cold: true })
    });
    rows.push({
      label: 'jest --findRelatedTests',
      temp: 'warm',
      depth: '∞',
      ...runJestCliFindRelatedBenchmark(fixture, opts.iterations, { cold: false })
    });

    printSummaryTable(rows);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

main();
