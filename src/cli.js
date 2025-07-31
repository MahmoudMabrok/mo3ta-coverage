import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { exit } from 'process';

export function main(options) {
   // Check if current directory is a git repository
  try {
    execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' });
  } catch (err) {
    console.error(`❌ Not a git repository. Please run this tool inside a git repo. ${err.message}`);

    exit(1);
  }


  const BASE_BRANCH = options.base;
  const LCOV_PATH = options.lcov;
  const COVERAGE_LIMIT = parseFloat(options.limit);
  const SHOW_COVERED = options.showCovered === true || options.showCovered === 'true';
  const RUN_TESTS_ONLY = options.shallowTests === true || options.shallowTests === 'true';

  console.log(`Options:\nBase Branch: ${BASE_BRANCH} \nLCOV Path: ${LCOV_PATH} \nCoverage Limit: ${COVERAGE_LIMIT} \nShow Covered Lines: ${SHOW_COVERED} \nRun Tests Only: ${RUN_TESTS_ONLY}`);

  const changedFiles = getChangedFiles(BASE_BRANCH);
  runRelatedTests(changedFiles, RUN_TESTS_ONLY);
  reportUncoveredChangedLines(changedFiles, LCOV_PATH, BASE_BRANCH, COVERAGE_LIMIT, SHOW_COVERED);

}

function getChangedFiles(BASE_BRANCH) {
  const command = `(
    git log --pretty=format: --name-only --diff-filter=AM --author="$(git config user.name)" $(git merge-base HEAD ${BASE_BRANCH})..HEAD
    git diff --name-only --diff-filter=AM
    git diff --cached --name-only --diff-filter=AM
  ) | sort -u`;
  
  const output = execSync(command).toString();

  return output
    .split('\n')
    .filter(f => f.trim().length > 0 && f.match(/\.(js|ts|jsx|tsx)$/));
}

function runRelatedTests(files, runTestsOnly) {
  if (files.length === 0) {
    console.log('✅ No changed source files found.');

    exit(0);
  }

  let runRelatedFilesArgs = '';
  if (!runTestsOnly) {
    runRelatedFilesArgs = '--findRelatedTests';
  }

  console.log('🧪 Running tests related to the changed files:\n', files.join('\n'));

  // filter files to only those that are JavaScript or TypeScript files
  files = getJsOnlyFiles(files, runTestsOnly);

  if (files.length === 0) {
    console.log('✅ No relevant files found for testing.');
    
    exit(0);
  }

  // log files to be tested
  console.log('\nFiles to be tested:', files.join('\n'));

  const command = `npx jest ${runRelatedFilesArgs} --passWithNoTests --coverage ${files.join(' ')}`;
  try {
    execSync(command, { stdio: 'inherit' });
  } catch (err) {
    console.error('Error:', err.message || err);
    exit(1);
  }
}

function getJsOnlyFiles(files, runTestsOnly) {
  // Only include source code files, exclude test, config, and json files
  return files.filter(f => {
    // Exclude test files
    if (f.match(/(\.test|\.spec)\.(js|ts|jsx|tsx)$/)) return false;
    // skip non test files when running only test files
    if (runTestsOnly) return false;
    // Exclude config files
    if (f.match(/(jest|babel|webpack|tsconfig|eslint|prettier|rollup|vite|package)\.(js|ts|json)$/)) return false;
    // Exclude json files
    if (f.endsWith('.json')) return false;
    // Only include code files
    return f.endsWith('.js') || f.endsWith('.ts') || f.endsWith('.jsx') || f.endsWith('.tsx');
  });
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

function parseLcov(LCOV_PATH) {
  const lcovRaw = fs.readFileSync(LCOV_PATH, 'utf8');
  const files = {};
  let currentFile = null;

  lcovRaw.split('\n').forEach(line => {
    if (line.startsWith('SF:')) {
      currentFile = path.resolve(line.substring(3).trim());
      files[currentFile] = new Set();
    } else if (line.startsWith('DA:') && currentFile) {
      const [lineNo, hits] = line.substring(3).split(',').map(Number);
      if (hits === 0) {
        files[currentFile].add(lineNo);
      }
    }
  });

  return files;
}

function reportUncoveredChangedLines(changedFiles, LCOV_PATH, BASE_BRANCH, COVERAGE_LIMIT, SHOW_COVERED) {
  if (!fs.existsSync(LCOV_PATH)) {
    console.error('❌ lcov.info not found. Make sure coverage ran correctly.');
    process.exit(1);
  }

  const uncoveredLines = parseLcov(LCOV_PATH);

  console.log(`\n🔍 Checking coverage of changed lines vs branch: ${BASE_BRANCH}\n`);

  changedFiles = getJsOnlyFiles(changedFiles);

  if (changedFiles.length === 0) {
    console.log('✅ No relevant files found for coverage check.');
    return;
  }

  console.log('Files with changed lines:', changedFiles.join('\n'));

  let totalChanged = 0;
  let totalUncovered = 0;

  changedFiles.forEach(relPath => {
    const absPath = path.resolve(relPath);
    if (!uncoveredLines[absPath]) {
      console.log(`⚠️  No coverage info for: ${absPath}`);
      return;
    }

    const addedLines = getChangedLines(relPath, BASE_BRANCH);
    const fileUncovered = uncoveredLines[absPath];

    const uncoveredInDiff = addedLines.filter(line => fileUncovered.has(line));
    const coveredInDiff = addedLines.length - uncoveredInDiff.length;

    totalChanged += addedLines.length;
    totalUncovered += uncoveredInDiff.length;

    if (addedLines.length === 0) {
      console.log(`ℹ️  ${absPath} - No changed lines detected.`);
      return;
    }

    if (uncoveredInDiff.length > 0) {
      console.log(`🚨 ${absPath} - Uncovered changed lines: [${uncoveredInDiff.join(', ')}]`);
    } else {
      console.log(`✅ ${absPath} - All changed lines are covered`);
    }
    // Display covered lines if option is enabled
    const coveredLines = addedLines.filter(line => !fileUncovered.has(line));
    console.log(`   Total changed lines: ${addedLines.length}, Covered: ${coveredInDiff}, Uncovered: ${uncoveredInDiff.length}`);
    if (SHOW_COVERED) {
      console.log(`   Covered lines: [${coveredLines.join(', ')}]`);
    }
    console.log(`   Coverage for changed lines: ${((coveredInDiff / addedLines.length) * 100).toFixed(2)}%`);
  });

  // Cumulative coverage check
  if (totalChanged > 0) {
    const overallCoverage = (((totalChanged - totalUncovered) / totalChanged) * 100).toFixed(2);
    console.log(`\n🔢 Overall coverage for all changed lines: ${overallCoverage}% limit is ${COVERAGE_LIMIT}% with Uncovered: ${totalUncovered} (${totalChanged})`);
  }
}
