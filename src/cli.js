import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { exit } from 'process';
import { verifyBaseBranchExists, verifyGitRepoExists } from './gitUtils.js';

// Set when Jest exits non-zero. `main` resets it so a later in-process call
// does not inherit the previous failure. The CLI process still exits.
let testsFailed = false;
import {
  getJsOnlyFiles,
  separateSourceAndTestFiles,
  findTestFilesForSource,
  findTestFilesByImport,
  findRelatedTestFilesBySource
} from './fileUtils.js';

export function main(options) {
  // A single CLI process exits after one run. Reset anyway so an in-process
  // caller does not inherit a failure from an earlier invocation.
  testsFailed = false;
  try {
    // Check if current directory is a git repository
    verifyGitRepoExists();

    const BASE_BRANCH = options.base;
    const LCOV_PATH = options.lcov;
    const COVERAGE_LIMIT = parseFloat(options.limit);
    const SHOW_COVERED = options.showCovered === true || options.showCovered === 'true';
    const MODE = options.mode;
    const DEPTH = Number.parseInt(options.depth, 10) || 2;
    const DRY_RUN = options.dryRun === true || options.dryRun === 'true';
    const CI = options.ci === true || options.ci === 'true';
    const CI_REPORT_PATH = options.ciReport
      ? path.resolve(options.ciReport)
      : path.resolve('coverage', 'mo3ta-coverage-report.md');

    // In dry run, stdout must stay a clean one-path-per-line list, so
    // diagnostics go to stderr instead of stdout.
    const infoLog = DRY_RUN ? console.error : console.log;

    infoLog(`Options:\nBase Branch: ${BASE_BRANCH} \nLCOV Path: ${LCOV_PATH} \nCoverage Limit: ${COVERAGE_LIMIT} \nShow Covered Lines: ${SHOW_COVERED} \nMode: ${MODE} \nDepth: ${DEPTH} \nDry Run: ${DRY_RUN} \nCI Mode: ${CI}`);

    const explicitFiles = getExplicitFiles(options);
    let changedFiles;

    if (explicitFiles.length > 0) {
      // A base branch is still needed to compute the changed lines of each file.
      verifyBaseBranchExists(BASE_BRANCH);
      infoLog(`Scanning ${explicitFiles.length} explicitly provided file(s) (git changed-file detection skipped):\n${explicitFiles.join('\n')}`);
      changedFiles = explicitFiles;
    } else {
      changedFiles = getChangedFiles(BASE_BRANCH, infoLog);
    }

    if (DRY_RUN) {
      dryRun(changedFiles, MODE, DEPTH);
      return;
    }

    runRelatedTests(changedFiles, MODE, DEPTH);
    reportUncoveredChangedLines(changedFiles, LCOV_PATH, BASE_BRANCH, COVERAGE_LIMIT, SHOW_COVERED, CI, CI_REPORT_PATH);

    if (testsFailed) {
      console.error('\n❌ Finished with test failures (see Jest output above).');
      exit(1);
    }
  } catch (error) {
    console.error('❌ An unexpected error occurred:', error.message || error);
    exit(1);
  }
}


/**
 * Normalizes a user-provided file list into repo-relative paths.
 * Accepts an array or a comma-separated string, trims entries, removes
 * duplicates, converts absolute paths under `root` to relative ones, and
 * drops dependency/build artifacts.
 * @param {string|string[]} input
 * @param {string} [root]
 * @returns {string[]}
 */
export function normalizeExplicitFiles(input, root = process.cwd()) {
  const values = Array.isArray(input) ? input : [input];

  const files = values
    .flatMap(value => String(value ?? '').split(','))
    .map(file => file.trim())
    .filter(Boolean)
    .map(file => {
      const absolute = path.resolve(root, file);
      const relative = path.relative(root, absolute);
      // Keep paths outside the repo root as provided.
      if (relative.startsWith('..') || path.isAbsolute(relative)) return file;
      return relative;
    })
    .map(file => file.replace(/\\/g, '/'))
    .filter(file => !file.match(/(^|\/)(node_modules|coverage|dist|build)\/|(^|\/)\.git\//));

  return Array.from(new Set(files));
}

/**
 * Reads a newline-separated list of files (for example the output of
 * `git diff --name-only`) from disk.
 * @param {string} listPath
 * @param {string} [root]
 * @returns {string[]}
 */
export function readExplicitFilesFromFile(listPath, root = process.cwd()) {
  const absolute = path.resolve(root, listPath);
  const content = fs.readFileSync(absolute, 'utf8');
  return normalizeExplicitFiles(content.split(/\r?\n/), root);
}

/**
 * Resolves the files to scan from CLI options. Returns an empty array when
 * the user did not provide an explicit list.
 * @param {{files?: string|string[], filesFrom?: string}} options
 * @returns {string[]}
 */
export function getExplicitFiles(options = {}, root = process.cwd()) {
  const files = [];

  if (options.files !== undefined && options.files !== null && options.files !== false) {
    files.push(...normalizeExplicitFiles(options.files, root));
  }

  if (options.filesFrom) {
    files.push(...readExplicitFilesFromFile(options.filesFrom, root));
  }

  return Array.from(new Set(files));
}

/**
 * Lists changed JS/TS files vs `baseBranch` without logging or exiting.
 * Includes commits from every author since the merge base, plus staged and
 * unstaged edits. Throws when git itself fails.
 * @param {string} baseBranch
 * @param {string} [root]
 * @returns {string[]}
 */
export function listChangedSourceFiles(baseBranch, root = process.cwd()) {
  // Compare the merge base with HEAD so every file changed on this branch is
  // included, regardless of which author committed it.
  //
  // Git is always invoked with an argument array (never through a shell) so
  // refs and file paths can't inject commands, and output is de-duplicated
  // in JS instead of piping through `sort -u`.
  const gitFiles = (args) => execFileSync('git', args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'ignore']
  }).toString();

  const mergeBase = gitFiles(['merge-base', 'HEAD', baseBranch]).trim();

  const seen = new Set();
  const changedFiles = [
    // Added or modified files between the merge base and HEAD
    gitFiles(['diff', '--name-only', '--diff-filter=AM', `${mergeBase}..HEAD`]),
    // Unstaged changes in the working tree
    gitFiles(['diff', '--name-only', '--diff-filter=AM']),
    // Staged changes
    gitFiles(['diff', '--cached', '--name-only', '--diff-filter=AM'])
  ]
    .flatMap(output => output.split(/\r?\n/))
    .map(file => file.trim())
    .filter(file => file.length > 0 && file.match(/\.(js|ts|jsx|tsx)$/))
    // Defensive: ignore dependency/build/coverage artifacts even if git tracked them
    .filter(file => !file.match(/(^|\/)(node_modules|coverage|dist|build)\/|(^|\/)\.git\//))
    // De-duplicate (replaces `sort -u`); insertion order keeps first-seen wins
    .filter(file => (seen.has(file) ? false : (seen.add(file), true)));

  changedFiles.sort();
  return changedFiles;
}

export function getChangedFiles(BASE_BRANCH, log = console.log, root = process.cwd()) {
  // Check if BASE_BRANCH exists (also rejects ref-like options before use)
  verifyBaseBranchExists(BASE_BRANCH, root);

  try {
    const changedFiles = listChangedSourceFiles(BASE_BRANCH, root);
    log(`Changed files:\n${changedFiles.join('\n')}`);
    return changedFiles;
  } catch (error) {
    console.error('Error getting changed files:', error.message || error);
    return [];
  }
}

/**
 * Absolute path of the Jest binary the CLI invokes directly (no shell, no npx).
 * @param {string} [root]
 * @returns {string}
 */
export function resolveJestBin(root = process.cwd()) {
  return path.resolve(root, 'node_modules', 'jest', 'bin', 'jest.js');
}

function runJest(jestArgs) {
  console.log(`   Jest command: npx jest ${jestArgs.join(' ')}`);

  // The locally installed Jest entry point is invoked directly (no shell,
  // no npx), with an argument array, so file paths with spaces or special
  // characters can't break the invocation.
  try {
    const jestBin = resolveJestBin();
    execFileSync(process.execPath, [jestBin, ...jestArgs], { stdio: 'inherit' });
  } catch (err) {
    // Log and continue so the coverage report still runs and CI can
    // surface it. `main` exits non-zero at the end when this happened.
    testsFailed = true;
    console.error('❌ Tests failed:', err.message || err);
  }
}

/**
 * Resolves the test files a mode would run, without logging, running Jest, or exiting.
 * `testsToRun` keeps CLI insertion order (changed tests first, then matches).
 * Full mode cannot discover related tests without Jest; `testsToRun` is then
 * only the changed test files, and `jestTargets` is what `--findRelatedTests` receives.
 * @param {string[]} files
 * @param {string} mode
 * @param {number} [depth]
 * @param {string} [root]
 */
export function resolveTestPlan(files, mode, depth = 2, root = process.cwd()) {
  const { sourceFiles, testFiles } = separateSourceAndTestFiles(files);

  if (mode === 'full') {
    const jestTargets = [...sourceFiles, ...testFiles];
    return {
      mode,
      depth,
      sourceFiles,
      testFiles,
      mappings: [],
      testsToRun: [...testFiles],
      jestTargets,
      jestArgs: ['--findRelatedTests', '--passWithNoTests', '--coverage', ...jestTargets],
      delegatedToJest: true
    };
  }

  // Fast: naming-convention mapping with a direct-import fallback.
  // Smart: naming-convention mapping plus a depth-limited reverse-dependency walk.
  const testFilesToRun = new Set(testFiles);
  const mappings = [];

  sourceFiles.forEach(sourceFile => {
    let relatedTests;
    let matchType;

    if (mode === 'smart') {
      relatedTests = findRelatedTestFilesBySource(sourceFile, { maxDepth: depth, root });
      matchType = `naming + import graph, depth ≤ ${depth}`;
    } else {
      relatedTests = findTestFilesForSource(sourceFile, root);
      matchType = 'naming convention';

      if (relatedTests.length === 0) {
        relatedTests = findTestFilesByImport(sourceFile, root);
        if (relatedTests.length > 0) {
          matchType = 'import scan';
        }
      }
    }

    mappings.push({
      source: sourceFile,
      tests: [...relatedTests],
      matchType
    });
    relatedTests.forEach(test => testFilesToRun.add(test));
  });

  const testsToRun = Array.from(testFilesToRun);
  return {
    mode,
    depth,
    sourceFiles,
    testFiles,
    mappings,
    testsToRun,
    jestTargets: testsToRun,
    jestArgs: ['--passWithNoTests', '--coverage', ...testsToRun],
    delegatedToJest: false
  };
}

function runRelatedTests(files, mode, depth = 2) {
  if (files.length === 0) {
    console.log('✅ No changed source files found.');
    exit(0);
  }

  console.log('🔍 Analyzing changed files for optimal test execution...');

  const plan = resolveTestPlan(files, mode, depth);
  const { sourceFiles, testFiles } = plan;

  console.log(`\n📊 Changed files breakdown:`);
  console.log(`   Source files: ${sourceFiles.length}`);
  console.log(`   Test files: ${testFiles.length}`);
  if (sourceFiles.length > 0) {
    console.log('   Source file list:');
    sourceFiles.forEach(file => console.log(`     - ${file}`));
  }
  if (testFiles.length > 0) {
    console.log('   Changed test file list:');
    testFiles.forEach(file => console.log(`     - ${file}`));
  }

  // Full mode delegates discovery to Jest, so pass the changed files themselves.
  if (mode === 'full') {
    const jestTargets = plan.jestTargets;

    if (jestTargets.length === 0) {
      console.log('\n⚠️  No changed source or test files found to run.');
      exit(0);
    }

    console.log(`\n📝 Test strategy: full (Jest --findRelatedTests, unbounded traversal)`);
    console.log(`   Running tests related to ${sourceFiles.length} source file(s) + ${testFiles.length} changed test(s)`);
    console.log(`   ⚠️  If this expands to too many tests, switch to --mode smart`);
    console.log('   Files passed to Jest:');
    jestTargets.forEach(file => console.log(`     - ${file}`));

    runJest(plan.jestArgs);
    return;
  }

  plan.mappings.forEach(({ source, tests, matchType }) => {
    if (tests.length > 0) {
      console.log(`   ✓ ${source} → ${tests.length} test file(s) (${matchType})`);
    } else {
      console.log(`   ⚠ ${source} → No test file found`);
    }
  });

  const finalTestFiles = plan.testsToRun;

  if (finalTestFiles.length === 0) {
    console.log('\n⚠️  No test files found to run.');
    console.log('Consider creating test files for your changed source files.');
    exit(0);
  }

  console.log(`\n🧪 Running ${finalTestFiles.length} test file(s):\n`, finalTestFiles.join('\n'));
  console.log('   Files passed to Jest:');
  finalTestFiles.forEach(file => console.log(`     - ${file}`));

  if (mode === 'smart') {
    console.log(`\n📝 Test strategy: smart (naming + reverse imports, depth ≤ ${depth})`);
    console.log(`   Test files: ${finalTestFiles.length}`);
    console.log(`   Source files for coverage: ${sourceFiles.length}`);
  } else {
    console.log(`\n📝 Test strategy: fast (Direct execution, no Jest dependency traversal)`);
    console.log(`   Test files: ${finalTestFiles.length}`);
    console.log(`   Source files detected: ${sourceFiles.length}`);
  }

  runJest(plan.jestArgs);
}

/**
 * Dry run: only resolve the test files that the selected mode would run,
 * then print one path per line and exit without running Jest or checking
 * coverage. The stdout is clean enough for another tool to consume:
 *   node index.js --dryRun true --files src/a.js --base origin/main
 * Errors still go to stderr via the catch in main().
 *
 * @param {string[]} files - Changed source and test files (repo-relative)
 * @param {string} mode - Execution mode (fast, smart, or full)
 * @param {number} depth - Max reverse-dependency depth for smart mode
 */
export function dryRun(files, mode, depth = 2) {
  if (files.length === 0) {
    // Keep stdout a clean file list; informational messages go to stderr.
    console.error('✅ No changed source files found.');
    exit(0);
  }

  const plan = resolveTestPlan(files, mode, depth);

  // Full mode delegates discovery to Jest; without running it, the only
  // guaranteed output is the changed test files themselves.
  if (mode === 'full') {
    // Keep stdout clean (one path per line) for other tools; warn on stderr.
    console.error('⚠️  full mode relies on Jest --findRelatedTests; --dry-run prints only the changed test files.');
    plan.testFiles.forEach(file => console.log(file));
    exit(0);
  }

  [...plan.testsToRun].sort().forEach(file => console.log(file));
  exit(0);
}

export function getChangedLines(filePath, BASE_BRANCH, root = process.cwd()) {
  // Argument array + `--` separator keeps file paths (and the ref, already
  // validated in verifyBaseBranchExists) out of any shell interpretation.
  const diff = execFileSync('git', ['diff', '-U0', BASE_BRANCH, '--', filePath], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'ignore']
  }).toString();
  const lines = [];

  const hunkRegex = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  let match;
  while ((match = hunkRegex.exec(diff)) !== null) {
    const start = parseInt(match[1]);
    const count = match[2] ? parseInt(match[2]) : 1;
    for (let i = 0; i < count; i++) {
      lines.push(start + i);
    }
  }

  return lines;
}

export function parseLcov(LCOV_PATH, root = process.cwd()) {
  const lcovRaw = fs.readFileSync(LCOV_PATH, 'utf8');
  const files = {};
  let currentFile = null;

  lcovRaw.split('\n').forEach(line => {
    if (line.startsWith('SF:')) {
      // Absolute SF paths stay absolute. Relative ones resolve against `root`,
      // which is the process cwd for the CLI.
      currentFile = path.resolve(root, line.substring(3).trim());
      files[currentFile] = {
        coverableLines: new Set(),
        uncoveredLines: new Set()
      };
    } else if (line.startsWith('DA:') && currentFile) {
      const [lineNo, hits] = line.substring(3).split(',').map(Number);
      files[currentFile].coverableLines.add(lineNo);
      if (hits === 0) {
        files[currentFile].uncoveredLines.add(lineNo);
      }
    }
  });

  return files;
}

export function classifyChangedLineCoverage(changedLines, fileCoverage) {
  const coverage = fileCoverage || {
    coverableLines: new Set(),
    uncoveredLines: new Set()
  };

  const coveredLines = [];
  const uncoveredLines = [];

  changedLines.forEach(line => {
    // Only classify lines that appear in LCOV (are coverable).
    // Lines not in LCOV (imports, non-executable lines) are filtered out.
    if (!coverage.coverableLines.has(line)) {
      return;
    }

    if (coverage.uncoveredLines.has(line)) {
      uncoveredLines.push(line);
    } else {
      coveredLines.push(line);
    }
  });

  return {
    coveredLines,
    uncoveredLines
  };
}

export function summarizeCoverageResult(totalChanged, totalNotCovered, coverageLimit) {
  if (totalChanged === 0) {
    return {
      overallCoverage: null,
      passed: true,
      icon: '✅'
    };
  }

  const overallCoverage = ((totalChanged - totalNotCovered) / totalChanged) * 100;
  const passed = overallCoverage >= coverageLimit;

  return {
    overallCoverage,
    passed,
    icon: passed ? '✅' : '🚨'
  };
}

export function buildMarkdownCoverageReport(rows, { overallCoverage, changedLinesLimit, totalChanged, totalNotCovered }) {
  const lines = [
    '# mo3ta-coverage report',
    '',
    '| Status | File | Changed coverable lines | Covered | Uncovered | Coverage |',
    '| --- | --- | ---: | ---: | ---: | ---: |'
  ];

  rows.forEach(({ filePath, covered, uncovered, trackedChangedLines, fileCoverage, status }) => {
    lines.push(
      `| ${status} | \`${filePath}\` | ${trackedChangedLines} | ${covered} | ${uncovered} | ${fileCoverage} |`
    );
  });

  if (totalChanged > 0) {
    lines.push(
      `| **Overall** | — | ${totalChanged} | ${totalChanged - totalNotCovered} | ${totalNotCovered} | ${overallCoverage}% |`
    );
    lines.push('');
    lines.push(
      `Overall coverage: **${overallCoverage}%** (limit: ${changedLinesLimit}%) — ` +
      `${totalChanged - totalNotCovered}/${totalChanged} changed lines covered, ${totalNotCovered} uncovered.`
    );
  } else {
    lines.push('');
    lines.push('**No coverable changed lines found.**');
  }

  return lines.join('\n');
}

export function writeMarkdownReport(markdown, reportPath) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, markdown + '\n', 'utf8');
}

export function formatMissedLinesSummary(uncoveredByFile) {
  if (uncoveredByFile.length === 0) {
    return [];
  }

  return [
    '',
    'Missed changed lines by file:',
    ...uncoveredByFile.flatMap(({ filePath, lines }) => {
      const absolutePath = path.resolve(filePath);

      return lines.map(line => ` - ${absolutePath}:${line}`);
    })
  ];
}

/**
 * Reads lcov and keeps only source files that participate in the coverage check.
 * Throws an error with code LCOV_NOT_FOUND when the report file is missing.
 * @param {string[]} changedFiles
 * @param {string} lcovPath
 * @param {string} [root]
 */
export function loadCoverageIndex(changedFiles, lcovPath, root = process.cwd()) {
  const resolvedLcov = path.resolve(root, lcovPath);
  if (!fs.existsSync(resolvedLcov)) {
    const error = new Error('lcov.info not found. Make sure coverage ran correctly.');
    error.code = 'LCOV_NOT_FOUND';
    error.lcovPath = resolvedLcov;
    throw error;
  }

  return {
    lcovPath: resolvedLcov,
    coverageByFile: parseLcov(resolvedLcov, root),
    relevantFiles: getJsOnlyFiles(changedFiles)
  };
}

/**
 * Classifies one file's changed lines against an lcov index.
 * Line numbers come from `git diff -U0 <base> -- <file>` (working tree vs the ref).
 * @param {string} relPath
 * @param {Record<string, {coverableLines: Set<number>, uncoveredLines: Set<number>}>} coverageByFile
 * @param {string} baseBranch
 * @param {string} [root]
 */
export function analyzeChangedFile(relPath, coverageByFile, baseBranch, root = process.cwd()) {
  const absolutePath = path.resolve(root, relPath);
  const changedLines = getChangedLines(relPath, baseBranch, root);
  const fileCoverage = coverageByFile[absolutePath];
  const { coveredLines, uncoveredLines } = classifyChangedLineCoverage(changedLines, fileCoverage);
  const trackedChangedLines = coveredLines.length + uncoveredLines.length;

  return {
    filePath: relPath,
    absolutePath,
    changedLines,
    coveredLines,
    uncoveredLines,
    trackedChangedLines,
    hasCoverageInfo: Boolean(fileCoverage),
    fileCoverage: trackedChangedLines > 0
      ? `${((coveredLines.length / trackedChangedLines) * 100).toFixed(2)}%`
      : '-',
    status: uncoveredLines.length > 0 ? '🚨' : trackedChangedLines > 0 ? '✅' : 'ℹ️'
  };
}

/**
 * Totals coverable changed lines the same way the CLI threshold does.
 * Files with an empty diff are ignored. Lines absent from lcov are not counted.
 * @param {ReturnType<typeof analyzeChangedFile>[]} fileResults
 * @param {number} coverageLimit
 */
export function summarizeChangedLineResults(fileResults, coverageLimit) {
  let totalChanged = 0;
  let totalNotCovered = 0;
  const uncoveredByFile = [];
  const rows = [];

  fileResults.forEach(result => {
    if (result.changedLines.length === 0) return;

    totalChanged += result.trackedChangedLines;
    totalNotCovered += result.uncoveredLines.length;

    if (result.uncoveredLines.length > 0) {
      uncoveredByFile.push({
        filePath: result.filePath,
        lines: result.uncoveredLines
      });
    }

    rows.push({
      filePath: result.filePath,
      covered: result.coveredLines.length,
      uncovered: result.uncoveredLines.length,
      trackedChangedLines: result.trackedChangedLines,
      fileCoverage: result.fileCoverage,
      status: result.status
    });
  });

  const summary = totalChanged > 0
    ? summarizeCoverageResult(totalChanged, totalNotCovered, coverageLimit)
    : { overallCoverage: null, passed: true, icon: '✅' };

  return {
    totalChanged,
    totalNotCovered,
    uncoveredByFile,
    rows,
    ...summary
  };
}

function reportUncoveredChangedLines(changedFiles, LCOV_PATH, BASE_BRANCH, COVERAGE_LIMIT, SHOW_COVERED, CI = false, CI_REPORT_PATH) {
  if (!fs.existsSync(LCOV_PATH)) {
    console.error('❌ lcov.info not found. Make sure coverage ran correctly.');
    process.exit(1);
  }

  if (CI) {
    // In CI mode keep the console output clean: results go in the markdown
    // table below and are also saved to a file for CI to read.
    console.error(`ℹ️  CI mode enabled. Coverage table will be saved to: ${CI_REPORT_PATH}`);
  } else {
    console.log(`\n🔍 Checking coverage of changed lines vs branch: ${BASE_BRANCH}\n`);
  }

  const { coverageByFile, relevantFiles } = loadCoverageIndex(changedFiles, LCOV_PATH);

  if (relevantFiles.length === 0) {
    if (!CI) {
      console.log('✅ No relevant files found for coverage check.');
    }
    return;
  }

  if (!CI) {
    console.log('Files with changed lines:', relevantFiles.join('\n'));
  }

  const fileResults = [];

  relevantFiles.forEach(relPath => {
    const result = analyzeChangedFile(relPath, coverageByFile, BASE_BRANCH);
    fileResults.push(result);

    if (result.changedLines.length === 0) {
      if (!CI) {
        console.log(`ℹ️  ${result.absolutePath} - No changed lines detected.`);
      }
      return;
    }

    if (!result.hasCoverageInfo && !CI) {
      console.log(`⚠️  No coverage info for: ${result.absolutePath}`);
    }

    if (!CI) {
      if (result.uncoveredLines.length > 0) {
        console.log(`🚨 ${result.absolutePath} - Uncovered changed lines: [${result.uncoveredLines.join(', ')}]`);
      } else if (result.trackedChangedLines > 0) {
        console.log(`✅ ${result.absolutePath} - All changed lines are covered`);
      }

      console.log(`   Total coverable changed lines: ${result.trackedChangedLines}, Covered: ${result.coveredLines.length}, Uncovered: ${result.uncoveredLines.length}`)
      if (SHOW_COVERED && result.coveredLines.length > 0) {
        console.log(`   Covered lines: [${result.coveredLines.join(', ')}]`);
      }
      if (result.trackedChangedLines > 0) {
        console.log(`   Coverage for changed lines: ${((result.coveredLines.length / result.trackedChangedLines) * 100).toFixed(2)}%`);
      } else {
        console.log(`   No coverable lines in this file's changed lines (e.g., imports, comments).`);
      }
    }
  });

  // Cumulative coverage check
  const {
    overallCoverage,
    passed,
    icon,
    totalChanged,
    totalNotCovered,
    rows,
    uncoveredByFile
  } = summarizeChangedLineResults(fileResults, COVERAGE_LIMIT);

  if (CI) {
    const report = buildMarkdownCoverageReport(rows, {
      overallCoverage: overallCoverage === null ? null : overallCoverage.toFixed(2),
      changedLinesLimit: COVERAGE_LIMIT,
      totalChanged,
      totalNotCovered
    });

    writeMarkdownReport(report, CI_REPORT_PATH);
    console.log(report);
    console.error(`📄 Coverage table saved to: ${CI_REPORT_PATH}`);
  }

  if (totalChanged > 0) {
    if (!CI) {
      console.log(`\n${icon} Overall coverage for all changed lines: ${overallCoverage.toFixed(2)}% (limit: ${COVERAGE_LIMIT}%)`);
      console.log(`Not covered lines: ${totalNotCovered} out of ${totalChanged} changed lines`);
      formatMissedLinesSummary(uncoveredByFile).forEach(line => console.log(line));
    }

    if (!passed) {
      process.exit(1);
    }
  }
}
