import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { exit } from 'process';
import { verifyBaseBranchExists, verifyGitRepoExists } from './gitUtils.js';
import {
  getJsOnlyFiles,
  separateSourceAndTestFiles,
  findTestFilesForSource,
  findTestFilesByImport,
  findRelatedTestFilesBySource
} from './fileUtils.js';

export function main(options) {
  try {
    // Check if current directory is a git repository
    verifyGitRepoExists();

    const BASE_BRANCH = options.base;
    const LCOV_PATH = options.lcov;
    const COVERAGE_LIMIT = parseFloat(options.limit);
    const SHOW_COVERED = options.showCovered === true || options.showCovered === 'true';
    const MODE = options.mode;
    const DEPTH = Number.parseInt(options.depth, 10) || 2;
    const CI = options.ci === true || options.ci === 'true';
    const CI_REPORT_PATH = options.ciReport
      ? path.resolve(options.ciReport)
      : path.resolve('coverage', 'mo3ta-coverage-report.md');

    console.log(`Options:\nBase Branch: ${BASE_BRANCH} \nLCOV Path: ${LCOV_PATH} \nCoverage Limit: ${COVERAGE_LIMIT} \nShow Covered Lines: ${SHOW_COVERED} \nMode: ${MODE} \nDepth: ${DEPTH} \nCI Mode: ${CI}`);

    const explicitFiles = getExplicitFiles(options);
    let changedFiles;

    if (explicitFiles.length > 0) {
      // A base branch is still needed to compute the changed lines of each file.
      verifyBaseBranchExists(BASE_BRANCH);
      console.log(`Scanning ${explicitFiles.length} explicitly provided file(s) (git changed-file detection skipped):\n${explicitFiles.join('\n')}`);
      changedFiles = explicitFiles;
    } else {
      changedFiles = getChangedFiles(BASE_BRANCH);
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
export function getExplicitFiles(options = {}) {
  const files = [];

  if (options.files !== undefined && options.files !== null && options.files !== false) {
    files.push(...normalizeExplicitFiles(options.files));
  }

  if (options.filesFrom) {
    files.push(...readExplicitFilesFromFile(options.filesFrom));
  }

  return Array.from(new Set(files));
}

export function getChangedFiles(BASE_BRANCH) {
  // Check if BASE_BRANCH exists (also rejects ref-like options before use)
  verifyBaseBranchExists(BASE_BRANCH);

  // Compare the merge base with HEAD so every file changed on this branch is
  // included, regardless of which author committed it.
  //
  // Git is always invoked with an argument array (never through a shell) so
  // refs and file paths can't inject commands, and output is de-duplicated
  // in JS instead of piping through `sort -u`.
  try {
    const gitFiles = (args) => execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();

    const mergeBase = gitFiles(['merge-base', 'HEAD', BASE_BRANCH]).trim();

    const seen = new Set();
    const changedFiles = [
      // Added or renamed files between the merge base and HEAD
      gitFiles(['diff', '--name-only', '--diff-filter=AM', `${mergeBase}..HEAD`]),
      // Unstaged changes in the working tree
      gitFiles(['diff', '--name-only', '--diff-filter=AM']),
      // Staged changes
      gitFiles(['diff', '--cached', '--name-only', '--diff-filter=AM'])
    ]
      .flatMap(output => output.split('\n'))
      .filter(f => f.trim().length > 0 && f.match(/\.(js|ts|jsx|tsx)$/))
      // Defensive: ignore dependency/build/coverage artifacts even if git tracked them
      .filter(f => !f.match(/(^|\/)(node_modules|coverage|dist|build)\/|(^|\/)\.git\//))
      // De-duplicate (replaces `sort -u`); insertion order keeps first-seen wins
      .filter(f => (seen.has(f) ? false : (seen.add(f), true)));

    changedFiles.sort();
    console.log(`Changed files:\n${changedFiles.join('\n')}`);
    return changedFiles;
  } catch (error) {
    console.error('Error getting changed files:', error.message || error);
    return [];
  }
}

let testsFailed = false;

function runJest(jestArgs) {
  console.log(`   Jest command: npx jest ${jestArgs.join(' ')}`);

  // The locally installed Jest entry point is invoked directly (no shell,
  // no npx), with an argument array, so file paths with spaces or special
  // characters can't break the invocation.
  try {
    const jestBin = path.resolve('node_modules', 'jest', 'bin', 'jest.js');
    execFileSync(process.execPath, [jestBin, ...jestArgs], { stdio: 'inherit' });
  } catch (err) {
    // Log and continue so the coverage report still runs and CI can
    // surface it. `main` exits non-zero at the end when this happened.
    testsFailed = true;
    console.error('❌ Tests failed:', err.message || err);
  }
}

function runRelatedTests(files, mode, depth = 2) {
  if (files.length === 0) {
    console.log('✅ No changed source files found.');
    exit(0);
  }

  console.log('🔍 Analyzing changed files for optimal test execution...');

  // Separate source files and test files
  const { sourceFiles, testFiles } = separateSourceAndTestFiles(files);

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
    const jestTargets = [...sourceFiles, ...testFiles];

    if (jestTargets.length === 0) {
      console.log('\n⚠️  No changed source or test files found to run.');
      exit(0);
    }

    console.log(`\n📝 Test strategy: full (Jest --findRelatedTests, unbounded traversal)`);
    console.log(`   Running tests related to ${sourceFiles.length} source file(s) + ${testFiles.length} changed test(s)`);
    console.log(`   ⚠️  If this expands to too many tests, switch to --mode smart`);
    console.log('   Files passed to Jest:');
    jestTargets.forEach(file => console.log(`     - ${file}`));

    runJest(['--findRelatedTests', '--passWithNoTests', '--coverage', ...jestTargets]);
    return;
  }

  // Fast: naming-convention mapping with a direct-import fallback.
  // Smart: naming-convention mapping plus a depth-limited reverse-dependency walk.
  const testFilesToRun = new Set(testFiles);

  sourceFiles.forEach(sourceFile => {
    let relatedTests;
    let matchType;

    if (mode === 'smart') {
      relatedTests = findRelatedTestFilesBySource(sourceFile, { maxDepth: depth });
      matchType = `naming + import graph, depth ≤ ${depth}`;
    } else {
      relatedTests = findTestFilesForSource(sourceFile);
      matchType = 'naming convention';

      if (relatedTests.length === 0) {
        relatedTests = findTestFilesByImport(sourceFile);
        if (relatedTests.length > 0) {
          matchType = 'import scan';
        }
      }
    }

    if (relatedTests.length > 0) {
      console.log(`   ✓ ${sourceFile} → ${relatedTests.length} test file(s) (${matchType})`);
      relatedTests.forEach(test => testFilesToRun.add(test));
    } else {
      console.log(`   ⚠ ${sourceFile} → No test file found`);
    }
  });

  const finalTestFiles = Array.from(testFilesToRun);

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

  runJest(['--passWithNoTests', '--coverage', ...finalTestFiles]);
}

function getChangedLines(filePath, BASE_BRANCH) {
  // Argument array + `--` separator keeps file paths (and the ref, already
  // validated in verifyBaseBranchExists) out of any shell interpretation.
  const diff = execFileSync('git', ['diff', '-U0', BASE_BRANCH, '--', filePath], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
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

export function parseLcov(LCOV_PATH) {
  const lcovRaw = fs.readFileSync(LCOV_PATH, 'utf8');
  const files = {};
  let currentFile = null;

  lcovRaw.split('\n').forEach(line => {
    if (line.startsWith('SF:')) {
      currentFile = path.resolve(line.substring(3).trim());
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

  const coverageByFile = parseLcov(LCOV_PATH);

  changedFiles = getJsOnlyFiles(changedFiles);

  if (changedFiles.length === 0) {
    if (!CI) {
      console.log('✅ No relevant files found for coverage check.');
    }
    return;
  }

  if (!CI) {
    console.log('Files with changed lines:', changedFiles.join('\n'));
  }

  let totalChanged = 0;
  let totalNotCovered = 0;
  const uncoveredByFile = [];
  const rows = [];

  changedFiles.forEach(relPath => {
    const absPath = path.resolve(relPath);
    const addedLines = getChangedLines(relPath, BASE_BRANCH);

    if (addedLines.length === 0) {
      if (!CI) {
        console.log(`ℹ️  ${absPath} - No changed lines detected.`);
      }
      return;
    }

    const fileCoverage = coverageByFile[absPath];
    if (!fileCoverage && !CI) {
      console.log(`⚠️  No coverage info for: ${absPath}`);
    }

    const {
      coveredLines,
      uncoveredLines
    } = classifyChangedLineCoverage(addedLines, fileCoverage);
    const trackedChangedLines = coveredLines.length + uncoveredLines.length;

    totalChanged += trackedChangedLines;
    totalNotCovered += uncoveredLines.length;

    if (uncoveredLines.length > 0) {
      uncoveredByFile.push({
        filePath: relPath,
        lines: uncoveredLines
      });
    }

    rows.push({
      filePath: relPath,
      covered: coveredLines.length,
      uncovered: uncoveredLines.length,
      trackedChangedLines,
      fileCoverage: trackedChangedLines > 0
        ? `${((coveredLines.length / trackedChangedLines) * 100).toFixed(2)}%`
        : '-',
      status: uncoveredLines.length > 0 ? '🚨' : trackedChangedLines > 0 ? '✅' : 'ℹ️'
    });

    if (!CI) {
      if (uncoveredLines.length > 0) {
        console.log(`🚨 ${absPath} - Uncovered changed lines: [${uncoveredLines.join(', ')}]`);
      } else if (trackedChangedLines > 0) {
        console.log(`✅ ${absPath} - All changed lines are covered`);
      }

      console.log(`   Total coverable changed lines: ${trackedChangedLines}, Covered: ${coveredLines.length}, Uncovered: ${uncoveredLines.length}`)
      if (SHOW_COVERED && coveredLines.length > 0) {
        console.log(`   Covered lines: [${coveredLines.join(', ')}]`);
      }
      if (trackedChangedLines > 0) {
        console.log(`   Coverage for changed lines: ${((coveredLines.length / trackedChangedLines) * 100).toFixed(2)}%`);
      } else {
        console.log(`   No coverable lines in this file's changed lines (e.g., imports, comments).`);
      }
    }
  });

  // Cumulative coverage check
  const { overallCoverage, passed, icon } = totalChanged > 0
    ? summarizeCoverageResult(totalChanged, totalNotCovered, COVERAGE_LIMIT)
    : { overallCoverage: null, passed: true, icon: '✅' };

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
