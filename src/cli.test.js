import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import {
  classifyChangedLineCoverage,
  formatMissedLinesSummary,
  getChangedFiles,
  getExplicitFiles,
  normalizeExplicitFiles,
  parseLcov,
  readExplicitFilesFromFile,
  summarizeCoverageResult
} from './cli.js';

function writeLcovFixture(records) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mo3ta-coverage-'));
  const sourceFile = path.join(tempDir, 'src/example.js');
  const lcovFile = path.join(tempDir, 'lcov.info');

  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, 'const x = 1;\nconst y = 2;\n');
  fs.writeFileSync(
    lcovFile,
    [
      'TN:',
      `SF:${sourceFile}`,
      ...records,
      'end_of_record'
    ].join('\n')
  );

  return { sourceFile, lcovFile };
}

describe('parseLcov', () => {
  it('records both coverableLines and uncoveredLines', () => {
    const { sourceFile, lcovFile } = writeLcovFixture(['DA:10,1', 'DA:11,0']);

    const result = parseLcov(lcovFile);

    expect(result[sourceFile].coverableLines.has(10)).toBe(true);
    expect(result[sourceFile].coverableLines.has(11)).toBe(true);
    expect(result[sourceFile].uncoveredLines.has(10)).toBe(false);
    expect(result[sourceFile].uncoveredLines.has(11)).toBe(true);
  });
});

describe('classifyChangedLineCoverage', () => {
  it('filters out changed lines not in LCOV (like imports)', () => {
    const { sourceFile, lcovFile } = writeLcovFixture(['DA:10,1']);
    const coverage = parseLcov(lcovFile)[sourceFile];

    const result = classifyChangedLineCoverage([11, 12, 13, 14], coverage);

    expect(result.coveredLines).toEqual([]);
    expect(result.uncoveredLines).toEqual([]);
  });

  it('ignores changed lines with no LCOV entry and classifies rest as covered or uncovered', () => {
    const { sourceFile, lcovFile } = writeLcovFixture(['DA:10,3', 'DA:11,0']);
    const coverage = parseLcov(lcovFile)[sourceFile];

    const result = classifyChangedLineCoverage([10, 11, 12, 13], coverage);

    expect(result.coveredLines).toEqual([10]);
    expect(result.uncoveredLines).toEqual([11]);
  });

  it('keeps existing behavior for normal covered and uncovered LCOV lines', () => {
    const { sourceFile, lcovFile } = writeLcovFixture(['DA:20,5', 'DA:21,0']);
    const coverage = parseLcov(lcovFile)[sourceFile];

    const result = classifyChangedLineCoverage([20, 21], coverage);

    expect(result.coveredLines).toEqual([20]);
    expect(result.uncoveredLines).toEqual([21]);
  });
});

describe('summarizeCoverageResult', () => {
  it('passes when overall coverage equals the configured limit', () => {
    const result = summarizeCoverageResult(5, 1, 80);

    expect(result.overallCoverage).toBe(80);
    expect(result.passed).toBe(true);
    expect(result.icon).toBe('✅');
  });

  it('fails when overall coverage is below the configured limit', () => {
    const result = summarizeCoverageResult(5, 2, 80);

    expect(result.overallCoverage).toBe(60);
    expect(result.passed).toBe(false);
    expect(result.icon).toBe('🚨');
  });
});

describe('formatMissedLinesSummary', () => {
  it('formats uncovered files and lines for the final summary', () => {
    const result = formatMissedLinesSummary([
      { filePath: 'src/a.js', lines: [10, 11] },
      { filePath: 'src/b.js', lines: [7] }
    ]);

    expect(result).toEqual([
      '',
      'Missed changed lines by file:',
      ` - ${path.resolve('src/a.js')}:10`,
      ` - ${path.resolve('src/a.js')}:11`,
      ` - ${path.resolve('src/b.js')}:7`
    ]);
  });

  it('returns no summary lines when no files have missed lines', () => {
    expect(formatMissedLinesSummary([])).toEqual([]);
  });
});

describe('normalizeExplicitFiles', () => {
  it('accepts a comma-separated string', () => {
    expect(normalizeExplicitFiles('src/a.js,src/b.ts')).toEqual([
      'src/a.js',
      'src/b.ts'
    ]);
  });

  it('accepts an array of paths', () => {
    expect(normalizeExplicitFiles(['src/a.js', 'src/b.ts'])).toEqual([
      'src/a.js',
      'src/b.ts'
    ]);
  });

  it('trims, drops empty entries, and removes duplicates', () => {
    expect(normalizeExplicitFiles(['  src/a.js  ', '', 'src/a.js', 'src/b.js'])).toEqual([
      'src/a.js',
      'src/b.js'
    ]);
  });

  it('converts absolute paths under the root to relative paths', () => {
    const root = path.resolve('/tmp/project');

    expect(normalizeExplicitFiles([path.join(root, 'src/a.js')], root)).toEqual([
      'src/a.js'
    ]);
  });

  it('drops dependency and build artifacts', () => {
    expect(normalizeExplicitFiles([
      'src/a.js',
      'node_modules/pkg/index.js',
      'coverage/lcov-report/x.js',
      'dist/bundle.js',
      'build/out.js'
    ])).toEqual(['src/a.js']);
  });
});

describe('readExplicitFilesFromFile', () => {
  it('reads a newline-separated list from disk', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mo3ta-files-'));
    const listPath = path.join(tempDir, 'files.txt');
    fs.writeFileSync(listPath, 'src/a.js\nsrc/b.ts\n\n');

    expect(readExplicitFilesFromFile(listPath, tempDir)).toEqual([
      'src/a.js',
      'src/b.ts'
    ]);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

describe('getExplicitFiles', () => {
  it('returns an empty list when no explicit options are provided', () => {
    expect(getExplicitFiles({})).toEqual([]);
  });

  it('combines --files and --filesFrom, removing duplicates', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mo3ta-files-'));
    const listPath = path.join(tempDir, 'files.txt');
    fs.writeFileSync(listPath, 'src/b.js\nsrc/a.js\n');

    expect(getExplicitFiles({
      files: ['src/a.js'],
      filesFrom: listPath
    })).toEqual(['src/a.js', 'src/b.js']);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

describe('getChangedFiles', () => {
  let tempDir;
  let originalCwd;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mo3ta-git-'));

    execSync('git init -b main -q', { cwd: tempDir });
    execSync('git config user.name "Base Author"', { cwd: tempDir });
    execSync('git config user.email "base@example.com"', { cwd: tempDir });

    fs.writeFileSync(path.join(tempDir, 'base.js'), 'export const base = 1;\n');
    execSync('git add base.js && git commit -q -m "base"', { cwd: tempDir });
    execSync('git checkout -q -b feature', { cwd: tempDir });

    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('includes changed files regardless of the commit author', () => {
    fs.writeFileSync(path.join(tempDir, 'by-other.js'), 'export const other = 1;\n');
    execSync('git add by-other.js && git -c user.name="Other Dev" -c user.email="other@example.com" commit -q -m "other author"', { cwd: tempDir });

    fs.writeFileSync(path.join(tempDir, 'by-me.js'), 'export const me = 1;\n');
    execSync('git add by-me.js && git commit -q -m "current author"', { cwd: tempDir });

    const result = getChangedFiles('main');

    expect(result).toEqual(['by-me.js', 'by-other.js']);
  });

  it('includes uncommitted and staged changes', () => {
    fs.writeFileSync(path.join(tempDir, 'base.js'), 'export const base = 2;\n');
    fs.writeFileSync(path.join(tempDir, 'staged.js'), 'export const b = 1;\n');
    execSync('git add staged.js', { cwd: tempDir });

    const result = getChangedFiles('main');

    expect(result).toEqual(['base.js', 'staged.js']);
  });
});
