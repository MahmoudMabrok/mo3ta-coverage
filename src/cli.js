import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { exit } from 'process';
import { verifyBaseBranchExists, verifyGitRepoExists } from './gitUtils.js';
import { getJsOnlyFiles, separateSourceAndTestFiles, findTestFilesForSource } from './fileUtils.js';
import { findImportersForMany } from './importer.js';

function findReverseDepsForSourceFiles(sourceFiles, maxDepth) {
  if (sourceFiles.length === 0) return [];
  const importerResults = findImportersForMany(sourceFiles, maxDepth, {
    projectDir: process.cwd()
  });
  const testFilesForReverseDeps = new Set();
  const debugResults = [];

  importerResults.forEach((result, targetFile) => {
    const importers = result.importers.map(node => node.file);

    debugResults.push({
      targetFile,
      importerCount: importers.length,
      maxDepthReached: result.maxDepthReached,
      importers: result.importers.map(node => ({
        file: node.file,
        depth: node.depth,
        importedBy: node.importedBy
      }))
    });

    importers.forEach(file => {
      const tests = findTestFilesForSource(file);
      tests.forEach(test => testFilesForReverseDeps.add(test));
    });
  });

  return {
    reverseDepsTests: Array.from(testFilesForReverseDeps),
    debugResults
  };
}

export function main(options) {
  try {
    // Check if current directory is a git repository
    verifyGitRepoExists();

    const BASE_BRANCH = options.base;
    const LCOV_PATH = options.lcov;
    const COVERAGE_LIMIT = parseFloat(options.limit);
    const SHOW_COVERED = options.showCovered === true || options.showCovered === 'true';
    const MODE = options.mode;
    const MAX_DEPTH = options.maxDepth;

    console.log(`Options:\nBase Branch: ${BASE_BRANCH} \nLCOV Path: ${LCOV_PATH} \nCoverage Limit: ${COVERAGE_LIMIT} \nShow Covered Lines: ${SHOW_COVERED} \nMode: ${MODE} \nMax Depth: ${MAX_DEPTH}`);

    const changedFiles = getChangedFiles(BASE_BRANCH);
    runRelatedTests(changedFiles, MODE, MAX_DEPTH);
    reportUncoveredChangedLines(changedFiles, LCOV_PATH, BASE_BRANCH, COVERAGE_LIMIT, SHOW_COVERED);
  } catch (error) {
    console.error('❌ An unexpected error occurred:', error.message || error);
    exit(1);
  }
}


function getChangedFiles(BASE_BRANCH) {
  // Check if BASE_BRANCH exists
  verifyBaseBranchExists(BASE_BRANCH);

  const command = `(
    git log --pretty=format: --name-only --diff-filter=AM --author="$(git config user.name)" $(git merge-base HEAD ${BASE_BRANCH})..HEAD
    git diff --name-only --diff-filter=AM
    git diff --cached --name-only --diff-filter=AM
  ) | sort -u`;
  
  try {
    const output = execSync(command).toString();
    console.log(`Changed files:\n${output}`);
    return output
      .split('\n')
      .filter(f => f.trim().length > 0 && f.match(/\.(js|ts|jsx|tsx)$/));
  } catch (error) {
    console.error('Error getting changed files:', error.message || error);
    return [];
  }
}

function runRelatedTests(files, mode, maxDepth) {
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

  // Find test files for changed source files
  const testFilesToRun = new Set(testFiles);
  const mappedTests = new Map(); // Track which tests map to which source files

  sourceFiles.forEach(sourceFile => {
    const relatedTests = findTestFilesForSource(sourceFile);
    if (relatedTests.length > 0) {
      console.log(`   ✓ ${sourceFile} → ${relatedTests.length} test file(s)`);
      relatedTests.forEach(test => {
        testFilesToRun.add(test);
        if (!mappedTests.has(test)) {
          mappedTests.set(test, []);
        }
        mappedTests.get(test).push(sourceFile);
      });
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

  if (mode === 'fast') {
    console.log(`\n📝 Test strategy: fast (Direct execution, no Jest dependency traversal)`);
    console.log(`   Test files: ${finalTestFiles.length}`);
    console.log(`   Source files detected: ${sourceFiles.length}`);
    console.log('   Files passed to Jest:');
    finalTestFiles.forEach(file => console.log(`     - ${file}`));
    const command = `npx jest --passWithNoTests --coverage ${finalTestFiles.join(' ')}`;
    console.log(`   Jest command: ${command}`);

    try {
      execSync(command, { stdio: 'inherit' });
    } catch (err) {
      console.error('❌ Tests failed:', err.message || err);
      exit(1);
    }
  } else if (mode === 'smart') {
    console.log(`\n📝 Test strategy: smart (Combine source and mapped test files, plus reverse deps up to depth ${maxDepth})`);
    console.log(`   Test files: ${finalTestFiles.length}`);
    console.log(`   Source files for coverage: ${sourceFiles.length}`);
    const { reverseDepsTests, debugResults } = findReverseDepsForSourceFiles(sourceFiles, maxDepth);
    const uniqueAllFiles = new Set([...sourceFiles, ...finalTestFiles, ...reverseDepsTests]);
    const allFiles = Array.from(uniqueAllFiles);
    console.log(`   Total files passed to Jest: ${allFiles.length}`);
    if (reverseDepsTests.length > 0) {
      console.log(`   Test files for files that import changes (reverse deps): ${reverseDepsTests.length}`);
    }
    if (debugResults.length > 0) {
      console.log('   Reverse dependency debug:');
      debugResults.forEach(({ targetFile, importerCount, maxDepthReached, importers }) => {
        console.log(`     - ${targetFile}: importers=${importerCount}, maxDepthReached=${maxDepthReached}`);
        importers.forEach(({ file, depth, importedBy }) => {
          console.log(`       depth=${depth} file=${file}${importedBy ? ` importedBy=${importedBy}` : ''}`);
        });
      });
    }
    console.log('   Files passed to Jest:');
    allFiles.forEach(file => console.log(`     - ${file}`));
    const command = `npx jest --passWithNoTests --coverage ${allFiles.join(' ')}`;
    console.log(`   Jest command: ${command}`);

    try {
      execSync(command, { stdio: 'inherit' });
    } catch (err) {
      console.error('❌ Tests failed:', err.message || err);
      exit(1);
    }
  } else {
    console.log(`\n📝 Test strategy: full (Run mapped tests through Jest --findRelatedTests)`);
    console.log(`   Running tests for ${sourceFiles.length} source file(s) + ${testFiles.length} changed test(s)`);
    console.log(`   Test files in Jest command: ${finalTestFiles.length}`);
    console.log(`   ⚠️  If this expands to too many tests, switch to --mode smart`);
    console.log('   Test files passed to Jest:');
    finalTestFiles.forEach(file => console.log(`     - ${file}`));
    const command = `npx jest --findRelatedTests --passWithNoTests --coverage ${finalTestFiles.join(' ')}`;
    console.log(`   Jest command: ${command}`);
    
    try {
      execSync(command, { stdio: 'inherit' });
    } catch (err) {
      console.error('❌ Tests failed:', err.message || err);
      exit(1);
    }
  }
}

function getChangedLines(filePath, BASE_BRANCH) {
  const diff = execSync(`git diff -U0 ${BASE_BRANCH} -- ${filePath}`).toString();
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

function reportUncoveredChangedLines(changedFiles, LCOV_PATH, BASE_BRANCH, COVERAGE_LIMIT, SHOW_COVERED) {
  if (!fs.existsSync(LCOV_PATH)) {
    console.error('❌ lcov.info not found. Make sure coverage ran correctly.');
    process.exit(1);
  }

  const coverageByFile = parseLcov(LCOV_PATH);

  console.log(`\n🔍 Checking coverage of changed lines vs branch: ${BASE_BRANCH}\n`);

  changedFiles = getJsOnlyFiles(changedFiles);

  if (changedFiles.length === 0) {
    console.log('✅ No relevant files found for coverage check.');
    return;
  }

  console.log('Files with changed lines:', changedFiles.join('\n'));

  let totalChanged = 0;
  let totalNotCovered = 0;
  const uncoveredByFile = [];

  changedFiles.forEach(relPath => {
    const absPath = path.resolve(relPath);
    const addedLines = getChangedLines(relPath, BASE_BRANCH);

    if (addedLines.length === 0) {
      console.log(`ℹ️  ${absPath} - No changed lines detected.`);
      return;
    }

    const fileCoverage = coverageByFile[absPath];
    if (!fileCoverage) {
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
  });

  // Cumulative coverage check
  if (totalChanged > 0) {
    const { overallCoverage, icon } = summarizeCoverageResult(totalChanged, totalNotCovered, COVERAGE_LIMIT);
    console.log(`\n${icon} Overall coverage for all changed lines: ${overallCoverage.toFixed(2)}% (limit: ${COVERAGE_LIMIT}%)`);
    console.log(`Not covered lines: ${totalNotCovered} out of ${totalChanged} changed lines`);
    formatMissedLinesSummary(uncoveredByFile).forEach(line => console.log(line));
  }
}
