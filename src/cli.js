import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const BASE_BRANCH = 'main';
const LCOV_PATH = path.resolve('coverage/lcov.info');

function getChangedFiles() {
  const output = execSync(`git diff --name-only ${BASE_BRANCH}`).toString();
  return output
    .split('\n')
    .filter(f => f.trim().length > 0 && f.match(/\.(js|ts|jsx|tsx)$/));
}

function runRelatedTests(files) {
  if (files.length === 0) {
    console.log('✅ No changed source files found.');
    return;
  }

  console.log('🧪 Running tests related to changed files:\n', files.join('\n'));

  const command = `npx jest --findRelatedTests --coverage ${files.join(' ')}`;
  try {
    execSync(command, { stdio: 'inherit' });
  } catch (err) {
    console.error('❌ Some tests failed.');
    process.exit(1);
  }
}

function getChangedLines(filePath) {
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

function parseLcov() {
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

function reportUncoveredChangedLines(changedFiles) {
  if (!fs.existsSync(LCOV_PATH)) {
    console.error('❌ lcov.info not found. Make sure coverage ran correctly.');
    process.exit(1);
  }

  const uncoveredLines = parseLcov();

  console.log(`\n🔍 Checking coverage of changed lines vs branch: ${BASE_BRANCH}\n`);

  changedFiles.forEach(relPath => {
    const absPath = path.resolve(relPath);
    if (!uncoveredLines[absPath]) {
      console.log(`⚠️  No coverage info for: ${relPath}`);
      return;
    }

    const addedLines = getChangedLines(relPath);
    const fileUncovered = uncoveredLines[absPath];

    const uncoveredInDiff = addedLines.filter(line => fileUncovered.has(line));

    if (uncoveredInDiff.length > 0) {
      console.log(`🚨 ${relPath} - Uncovered changed lines: [${uncoveredInDiff.join(', ')}]`);
    } else {
      console.log(`✅ ${relPath} - All changed lines are covered`);
    }
  });
}

const changedFiles = getChangedFiles();
runRelatedTests(changedFiles);
reportUncoveredChangedLines(changedFiles);
